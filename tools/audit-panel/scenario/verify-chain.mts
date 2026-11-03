#!/usr/bin/env node
/**
 * verify-chain.mts —— 审计面板事件文件的独立验证器（零依赖）
 *
 * 作用：兑现 export-events.mts 在 meta.chain.recompute_recipe 中的承诺——
 *       任何人拿 events.jsonl 都能按同一规则重算链哈希，不需要相信导出器。
 *
 * 验证内容：
 *   1. 首行为 meta，且 event_count 与实际事件条数一致；
 *   2. 每条事件的 chain_hash 可按 recipe 重算并匹配；
 *   3. 每条事件的 chain_prev 指向前一条的 chain_hash（首条为空串）；
 *   4. 事件 seq 连续无缺号；
 *   5. 每个 category 都能在规则的 tc260 映射中找到依据（不允许"无依据的行为"）。
 *
 * 用法：
 *   node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts
 *   node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --file=<路径>
 *   node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --tamper-demo
 *
 * 退出码：0 全部通过 / 1 存在失败。
 *
 * ⚠️ 本验证器验的是**落盘链**（覆盖落盘内容），不是框架运行期链。
 *    落盘链只能证明"文件未被事后篡改"，不能证明事件真实发生过、也不证明发生在合成时间点。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../../../reference/runtimes/l2-runtime-oversight/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, '../data/events.jsonl');

interface Fail {
  seq: number | string;
  reason: string;
}

function canonicalHash(prevHash: string, body: Record<string, unknown>): string {
  return sha256(prevHash + '|' + JSON.stringify(body));
}

/** 取出一条事件用于重算的 body：去掉两个链字段，保留文件原 key 顺序。 */
function bodyOf(event: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === 'chain_hash' || k === 'chain_prev') continue;
    body[k] = v;
  }
  return body;
}

function parseArgs(argv: string[]): { file: string; tamperDemo: boolean } {
  let file = DEFAULT_FILE;
  let tamperDemo = false;
  for (const a of argv) {
    if (a.startsWith('--file=')) file = resolve(a.slice('--file='.length));
    else if (a === '--tamper-demo') tamperDemo = true;
  }
  return { file, tamperDemo };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const raw = readFileSync(args.file, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    throw new Error(`文件无有效内容：${args.file}`);
  }

  const fails: Fail[] = [];
  const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
  const events = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);

  // 1. meta 自描述一致性
  if (meta.record_type !== 'meta') {
    fails.push({ seq: 'meta', reason: `首行 record_type 应为 "meta"，实为 "${String(meta.record_type)}"` });
  }
  const declared = meta.event_count;
  if (declared !== events.length) {
    fails.push({ seq: 'meta', reason: `meta.event_count=${String(declared)} 与实际 ${events.length} 条不一致` });
  }

  // 2/3/4. 逐条验链
  let prev = '';
  let expectedSeq = 1;
  for (const e of events) {
    const seq = typeof e.seq === 'number' ? e.seq : String(e.seq);

    if (e.seq !== expectedSeq) {
      fails.push({ seq, reason: `seq 不连续：期望 ${expectedSeq}，实为 ${String(e.seq)}` });
    }
    expectedSeq = (typeof e.seq === 'number' ? e.seq : expectedSeq) + 1;

    if (e.chain_prev !== prev) {
      fails.push({ seq, reason: `chain_prev 不匹配：期望 "${prev}"，实为 "${String(e.chain_prev)}"` });
    }

    const recomputed = canonicalHash(prev, bodyOf(e));
    if (e.chain_hash !== recomputed) {
      fails.push({
        seq,
        reason: `chain_hash 重算不匹配（该行内容已被修改）：\n      落盘 ${String(e.chain_hash)}\n      重算 ${recomputed}`,
      });
    }
    prev = typeof e.chain_hash === 'string' ? e.chain_hash : '';
  }

  // 5. 每条事件必须有规则与条款依据
  for (const e of events) {
    const missing: string[] = [];
    if (!e.rule_id) missing.push('rule_id');
    if (!Array.isArray(e.tc260_measures) || (e.tc260_measures as unknown[]).length === 0) missing.push('tc260_measures');
    if (!e.efficiency_grade) missing.push('efficiency_grade');
    if (!e.source_scenario) missing.push('source_scenario');
    if (missing.length > 0) {
      fails.push({ seq: String(e.seq), reason: `缺少依据字段：${missing.join(', ')}（面板将展示无依据的行为）` });
    }
  }

  // —— 输出 ——
  const ok = fails.length === 0;
  const linesOut = [
    '',
    '审计面板事件文件 · 独立验证',
    '─'.repeat(58),
    `  文件          ${args.file}`,
    `  框架版本      v${String((meta.framework as Record<string, unknown> | undefined)?.version ?? 'unknown')}`,
    `  schema        ${String(meta.schema_version ?? 'unknown')}`,
    `  事件条数      ${events.length}${declared === events.length ? '' : `（meta 声明 ${String(declared)}）`}`,
    `  落盘链        ${ok ? 'PASS' : 'FAIL'}`,
    '',
  ];

  if (!ok) {
    linesOut.push('  失败项：');
    for (const f of fails) linesOut.push(`    [seq ${f.seq}] ${f.reason}`);
    linesOut.push('');
    process.stdout.write(linesOut.join('\n'));
    process.exitCode = 1;
    return;
  }

  linesOut.push('  全部检查通过：meta 一致 · seq 连续 · 链可重算 · 每条事件有规则与条款依据');
  linesOut.push('');

  // —— 篡改演示：证明这条链不是装饰 ——
  if (args.tamperDemo) {
    const target = events.find((e) => e.category === 'resource-over-budget') ?? events[0]!;
    const tampered: Record<string, unknown> = { ...target };
    tampered.detail = String(tampered.detail) + '（已篡改）';

    // 找到它在链上的位置，从该条起重算
    const idx = events.indexOf(target);
    let p = '';
    for (let i = 0; i < idx; i++) p = String(events[i]!.chain_hash);

    const expected = canonicalHash(p, bodyOf(tampered));
    const matches = expected === tampered.chain_hash;

    linesOut.push('  篡改演示（仅内存，不写盘）：');
    linesOut.push(`    目标行        seq ${String(target.seq)} · ${String(target.category)}`);
    linesOut.push(`    改动          detail 末尾追加"（已篡改）"`);
    linesOut.push(`    链校验        ${matches ? '未检出（异常！链无防护力）' : '已检出（重算值与原 chain_hash 不符）'}`);
    linesOut.push(`    原 hash       ${String(target.chain_hash).slice(0, 16)}…`);
    linesOut.push(`    重算 hash     ${expected.slice(0, 16)}…`);
    linesOut.push('');
  }

  process.stdout.write(linesOut.join('\n'));
}

main();
