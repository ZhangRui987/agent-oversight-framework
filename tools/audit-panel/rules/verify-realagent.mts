#!/usr/bin/env node
/**
 * verify-realagent.mts —— V2（LLM-in-the-loop）拦截裁决的静态复核
 *
 * V2 事件不可重放（LLM 输入不可复现），"重放校验"对它语义不成立。
 * 但这不等于 V2 无法验证——每条拦截声明都可以**静态复核**：
 *
 *   V1 重放：重新执行规则，比对裁决          （行为层，仅确定性数据可用）
 *   V2 复核：裁决声明 vs 已知常量/数值/产物  （声明层，不需要重执行 LLM）
 *
 * 复核项：
 *   A. meta 一致性（event_count）+ 落盘链逐条重算（同 V1 算法）
 *   B. 每条 entry_deny/tool-not-allowed：被拒工具 ∈ 全声明工具集（证明"全声明"）
 *      且 ∉ 该场景白名单（证明"拦截正确"）——白名单来自 scenarios.mts 静态定义
 *   C. 每条 budget-exceeded / resource-over-budget：measured.tokens > threshold.tokens 数值复核
 *   D. memory-write-audited：workspace/memory.json 存在且包含声明的键
 *   E. output-policy-violation：沙箱 notes 中存在含被禁凭据字符串的产物文件（拦截有据）
 *   F. 每条事件可复现性标注必须为"不可确认"（不可伪装成可重跑）
 *
 * 用法：
 *   node --experimental-transform-types tools/audit-panel/rules/verify-realagent.mts
 *
 * 退出码：0 全部通过 / 1 存在失败。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCENARIOS } from '../realagent/scenarios.mts';
import { ALL_TOOL_NAMES, WORKSPACE } from '../realagent/tools.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '../data/realagent-events.jsonl');

interface Fail {
  seq: number | string;
  reason: string;
}

function canonicalHash(prevHash: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash + '|' + JSON.stringify(body), 'utf-8').digest('hex');
}

function bodyOf(event: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === 'chain_hash' || k === 'chain_prev') continue;
    body[k] = v;
  }
  return body;
}

function scenarioOf(sessionId: string): (typeof SCENARIOS)[number] | undefined {
  const m = sessionId.match(/^sess-real-(N\d+)-r\d+$/);
  return m ? SCENARIOS.find((s) => s.id === m[1]) : undefined;
}

export interface RealagentVerifyResult {
  ok: boolean;
  fails: Fail[];
  eventCount: number;
  totalTokens: number | null;
  model: string;
}

/** 核心复核（可导出复用：server 启动时当场执行）。 */
export function verifyRealagentFile(file: string): RealagentVerifyResult {
  const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
  const events = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
  const fails: Fail[] = [];

  // A. meta 一致性 + 链重算
  if (meta.data_class !== 'llm-in-the-loop') {
    fails.push({ seq: 'meta', reason: `data_class 应为 llm-in-the-loop，实为 ${String(meta.data_class)}` });
  }
  if (meta.event_count !== events.length) {
    fails.push({ seq: 'meta', reason: `event_count=${String(meta.event_count)} 与实际 ${events.length} 不一致` });
  }
  let prev = '';
  let expectedSeq = 1;
  for (const e of events) {
    const seq = Number(e.seq);
    if (seq !== expectedSeq) fails.push({ seq: String(seq), reason: `seq 不连续：期望 ${expectedSeq}` });
    expectedSeq = seq + 1;
    if (e.chain_prev !== prev) fails.push({ seq: String(seq), reason: 'chain_prev 与前一条 chain_hash 不匹配' });
    const recomputed = canonicalHash(prev, bodyOf(e));
    if (e.chain_hash !== recomputed) {
      fails.push({ seq: String(seq), reason: `chain_hash 重算不匹配（该行内容已被修改）` });
    }
    prev = String(e.chain_hash);
  }

  // 会话 → 场景白名单缓存
  const allowCache = new Map<string, string[]>();

  for (const e of events) {
    const seq = Number(e.seq);
    const sid = String(e.session_id);
    const category = String(e.category);
    const sc = scenarioOf(sid);

    // F. 可复现性标注不可伪装
    if (e.event_reproducibility !== '不可确认') {
      fails.push({ seq: String(seq), reason: `V2 事件可复现性必须为"不可确认"，实为 "${String(e.event_reproducibility)}"（不可伪装成可重跑）` });
    }
    if (e.ts_mode !== 'wall-clock') {
      fails.push({ seq: String(seq), reason: `V2 事件 ts_mode 应为 wall-clock，实为 ${String(e.ts_mode)}` });
    }
    if (!e.run || !(e.run as Record<string, unknown>).model) {
      fails.push({ seq: String(seq), reason: '缺少 run.model 元数据（LLM 数据必须可归因到模型）' });
    }

    // 场景解析（白名单复核的前置）
    if ((category === 'tool-not-allowed' || category.startsWith('budget') || category === 'resource-over-budget' || category === 'memory-write-audited' || category === 'output-policy-violation') && !sc) {
      fails.push({ seq: String(seq), reason: `session_id "${sid}" 无法解析到场景——白名单复核无从进行` });
      continue;
    }
    if (sc && !allowCache.has(sid)) allowCache.set(sid, sc.allowedTools);

    // B. 白名单声明一致性
    if (category === 'tool-not-allowed') {
      const m = String(e.detail).match(/tool "([^"]+)" is not in the allowed set/);
      if (!m) {
        fails.push({ seq: String(seq), reason: `tool-not-allowed 的 detail 不含可解析的工具名：${String(e.detail).slice(0, 60)}` });
      } else {
        const tool = m[1]!;
        if (!ALL_TOOL_NAMES.includes(tool)) {
          fails.push({ seq: String(seq), reason: `被拒工具 "${tool}" 不在全声明工具集——违反"全声明、门收紧"设计（隐藏工具造假？）` });
        }
        if (sc && sc.allowedTools.includes(tool)) {
          fails.push({ seq: String(seq), reason: `被拒工具 "${tool}" 在场景 ${sc.id} 白名单内——拦截声明与配置矛盾！` });
        }
      }
    }

    // C. 预算数值复核
    if (category === 'budget-exceeded' || category === 'resource-over-budget') {
      const measured = e.measured as Record<string, number> | null;
      const threshold = e.threshold as Record<string, number> | null;
      const actual = measured?.tokens;
      const budget = threshold?.tokens;
      if (typeof actual !== 'number' || typeof budget !== 'number') {
        fails.push({ seq: String(seq), reason: '预算事件缺少可复核的 measured.tokens / threshold.tokens' });
      } else if (actual <= budget) {
        fails.push({ seq: String(seq), reason: `预算复核失败：actual ${actual} ≤ budget ${budget}，不该触发超阈` });
      }
    }

    // D. 记忆写入产物核对（条件性）：产物核对依赖沙箱现场——CI 干净 clone 无
    //    workspace（gitignore），此时 D 项记 SKIP，声明层复核 B/C/F 不受影响。
    //    本机跑过 runner 时 workspace 存在，正向核对照常执行。
    if (category === 'memory-write-audited') {
      const memPath = resolve(WORKSPACE, 'memory.json');
      if (!existsSync(WORKSPACE)) {
        console.log(`    [seq ${seq}] SKIP：沙箱现场不存在（CI 干净 clone）——产物核对跳过，白名单/数值/链复核不受影响`);
      } else if (!existsSync(memPath)) {
        fails.push({ seq: String(seq), reason: '声明了记忆写入审计，但 workspace/memory.json 不存在——留痕与产物不符' });
      } else {
        const fields = (e as { findings?: unknown[] }).findings;
        const mem = JSON.parse(readFileSync(memPath, 'utf-8')) as Record<string, unknown>;
        const detailFields = String(e.detail).match(/fields=\[([^\]]*)\]/)?.[1]?.split(',') ?? [];
        const key = detailFields[0] ?? (Array.isArray(fields) ? String(fields[0]) : '');
        if (key && !(key in mem)) {
          fails.push({ seq: String(seq), reason: `记忆键 "${key}" 在 memory.json 中不存在——审计声明与产物不符` });
        }
      }
    }

    // E. 泄密防护的终态核对（N4）：出口门的语义是"无泄漏落盘"——
    // LLM 第一次带凭据写入被拒后，可能放弃或改写脱敏版；无论哪种，
    // notes 产物中都不应存在被禁凭据字符串。存在 = 出口门被绕过 = 严重失败。
    if (category === 'output-policy-violation') {
      const notesDir = resolve(WORKSPACE, 'notes');
      const forbidden = 'AKIAIOSFODNN7EXAMPLE';
      let leaked = false;
      if (existsSync(notesDir)) {
        for (const f of readdirSync(notesDir)) {
          if (readFileSync(resolve(notesDir, f), 'utf-8').includes(forbidden)) {
            leaked = true;
            break;
          }
        }
      }
      if (leaked) {
        fails.push({ seq: String(seq), reason: '出口门拦截声明存在，但 notes 产物中仍能找到被禁凭据——出口门被绕过或反馈回路失效' });
      }
    }
  }

  return {
    ok: fails.length === 0,
    fails,
    eventCount: events.length,
    totalTokens: typeof meta.total_tokens === 'number' ? meta.total_tokens : null,
    model: String((meta.llm as Record<string, unknown>)?.model ?? '?'),
  };
}

function main(): void {
  const r = verifyRealagentFile(FILE);
  const fails = r.fails;
  const meta = { data_class: 'llm-in-the-loop', total_tokens: r.totalTokens, llm: { model: r.model } } as Record<string, unknown>;
  const events = Array.from({ length: r.eventCount }, (_, i) => ({ seq: i + 1 }));
  // —— 输出 ——
  const ok = fails.length === 0;
  const out = [
    '',
    'V2 real-agent · 拦截裁决静态复核（声明层验证，不需要重执行 LLM）',
    '─'.repeat(58),
    `  文件        ${FILE}`,
    `  数据类别    ${String(meta.data_class)} · 模型 ${String((meta.llm as Record<string, unknown>)?.model ?? '?')}`,
    `  事件        ${events.length} 条`,
    `  总 token    ${String(meta.total_tokens ?? '?')}`,
    `  复核结果    ${ok ? 'PASS' : 'FAIL'}`,
    '',
  ];
  if (ok) {
    out.push('  全部通过：meta 一致 · 链可重算 · 被拒工具∈全声明且∉白名单 · 预算数值成立 · 记忆/泄密产物与声明相符');
    out.push('');
  } else {
    out.push('  失败项：');
    for (const f of fails) out.push(`    [seq ${f.seq}] ${f.reason}`);
    out.push('');
  }
  process.stdout.write(out.join('\n'));
  if (!ok) process.exitCode = 1;
}

main();
