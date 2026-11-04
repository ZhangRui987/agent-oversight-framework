#!/usr/bin/env node
/**
 * runner.mts —— V2 real-agent 主循环：真实 LLM Agent 在三件套全程包裹下执行任务
 *
 * 每一次工具调用都走完同一条 V1 管线：
 *   LLM 决策 → EntryGuard.check → [allow] 执行本地工具 → ResourceLedger.record
 *   → ExitGuard.check → [accept] 结果回给 LLM 继续决策
 * 拒绝（deny / reject）同样回给 LLM——它被拒后的反应（换路径 / 放弃 / 重复尝试）
 * 是本轮最有研究价值的行为数据，全部随链留痕。
 *
 * 数据耐久性（v2.61.0 起）：
 *   - 运行历史归档：每次运行开始时，上一份正式产物原样归档至
 *     data/history/realagent-run{N}-{stamp}.jsonl（N = 该产物的 run_seq）。
 *     LLM 行为的多次运行差异（本轮放弃写入 / 上轮拒绝重试）由此可回溯对比；
 *     --only 单场景运行同样先归档——覆盖事故（v2.60.1 实测踩过）结构性不可能。
 *   - 增量落盘：事件按场景粒度增量写入 .tmp 暂存（每场景投影后立即 flush），
 *     全部场景结束后合成 meta + events 写正式文件并清除 .tmp。
 *     中途失败时：已完成场景完整保留；中断场景的残留事件由失败处理器尽力投影；
 *     残留 .tmp 由下一次运行自动归档为 realagent-incomplete-{stamp}.jsonl。
 *   - history/ 在 .gitignore（本地研究素材，不入库）：V2 数据为自测性质行为记录，
 *     是否对外发布多次运行对比属独立决策，不随每次运行静默膨胀仓库。
 *
 * 诚实边界（硬编码进产物，不可关闭）：
 *   - ts_mode = "wall-clock"：保留真实时间戳（无法合成——LLM 输入不可复现）。
 *   - 每条事件 event_reproducibility = "不可确认"。
 *   - 本数据是自测性质的行为记录，不支撑任何效能断言（V2 规划 §6）。
 *
 * key：环境变量 OVERSIGHT_LLM_API_KEY 优先，兜底 tools/audit-panel/.env（不入 git）。
 *
 * 用法：
 *   node --experimental-transform-types tools/audit-panel/realagent/runner.mts              # 全部场景
 *   node --experimental-transform-types tools/audit-panel/realagent/runner.mts --only=N1    # 单场景
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AppendOnlyAuditLog,
  ConfigReviewer,
  EntryGuard,
  ExitGuard,
  ResourceLedger,
} from '../../../reference/runtimes/l2-runtime-oversight/index.ts';
import { RULE_BY_CATEGORY } from '../rules/rule-map.mts';
import { chat, resolveLlmConfig, type ChatMessage, type ToolSchema } from './llm.mts';
import { TOOLS, ALL_TOOL_NAMES, ensureWorkspace, WORKSPACE } from './tools.mts';
import { SCENARIOS, SYSTEM_PROMPT, type Scenario } from './scenarios.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, '../data/realagent-events.jsonl');
const TMP_PATH = OUT_PATH + '.tmp';
const HISTORY_DIR = resolve(HERE, '../data/history');
const VERSION_PATH = resolve(HERE, '../../../VERSION');
const AGENT_ID = 'real-agent-llm';
const CALLER_ID = 'real-agent';

function stamp(): string {
  // 2026-11-04T06:00:01.123Z → 20261104-060001（文件名安全，秒级唯一性足够）
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/** 上一份正式产物的 run_seq（无文件或旧格式无此字段时视为 0）。 */
function prevRunSeq(): number {
  try {
    const first = readFileSync(OUT_PATH, 'utf-8').split('\n')[0]!;
    return Number((JSON.parse(first) as { run_seq?: number }).run_seq ?? 0);
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 录制型审计日志（与 V1 export-events.mts 同形：鸭子接口 + 保留框架真哈希链）
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedEvent {
  seq: number;
  type: string;
  data: unknown;
  hash: string;
  sessionId: string;
  wallClockTs: number;
}

class RecordingAuditLog {
  private readonly inner = new AppendOnlyAuditLog();
  readonly recorded: RecordedEvent[] = [];
  constructor(private readonly sessionId: string) {}
  append(type: string, data: unknown): { seq: number; hash: string } | null {
    const r = this.inner.append(type, data);
    if (r) this.recorded.push({ seq: r.seq, type, data, hash: r.hash, sessionId: this.sessionId, wallClockTs: Date.now() });
    return r;
  }
  verifyChain(): boolean {
    return this.inner.verifyChain();
  }
  get length(): number {
    return this.recorded.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent 循环
// ─────────────────────────────────────────────────────────────────────────────

interface RunStats {
  scenario: string;
  sessionId: string;
  turns: number;
  totalTokens: number;
  denies: number;
  rejects: number;
  signals: number;
  finalOutcome: string;
}

function toolSchemas(names: string[]): ToolSchema[] {
  return names.map((n) => TOOLS[n]!.schema);
}

async function runScenario(
  sc: Scenario,
  runSeq: number,
  sessionId: string,
  audit: RecordingAuditLog,
  results: RunStats[],
): Promise<void> {
  const taskId = `task-real-${sc.id}-${runSeq}`;
  const before = audit.length; // 本场景事件起点（切片统计用；audit 为跨场景共享实例）
  const turnTokensOf = new Map<number, number>();

  // 三件套注入（与 V1 同构：全工具声明给 LLM，白名单在门上收紧）
  const entryGuard = new EntryGuard(
    new Set(sc.allowedTools),
    [],
    audit,
    undefined,
    undefined,
  );
  const outputPolicies: ConstructorParameters<typeof ExitGuard>[1] = sc.outputForbiddenSubstring
    ? [
        {
          name: 'no-secret-echo',
          tools: new Set(ALL_TOOL_NAMES),
          check: (result) => !String(result.output).includes(sc.outputForbiddenSubstring!),
          reason: () => 'output contains a credential-shaped string (output policy)',
        },
      ]
    : [];
  const exitGuard = new ExitGuard({ maxTokens: sc.maxTokens }, outputPolicies, () => true, audit);
  const ledger = new ResourceLedger(audit);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + '\n\n' + sc.systemExtra },
    { role: 'user', content: sc.task },
  ];

  let totalTokens = 0;
  let finalOutcome = 'max-turns-reached';
  let cumulativeTokens = 0; // run 级累计（喂给账本做预算比）

  for (let turn = 1; turn <= sc.maxTurns; turn++) {
    const r = await chat(messages, toolSchemas(ALL_TOOL_NAMES));
    totalTokens += r.usage.totalTokens;
    cumulativeTokens += r.usage.totalTokens;
    turnTokensOf.set(turn, r.usage.totalTokens);

    if (r.toolCalls.length === 0) {
      finalOutcome = 'final-answer';
      messages.push({ role: 'assistant', content: r.content ?? '' });
      break;
    }

    messages.push({ role: 'assistant', content: r.content ?? '', tool_calls: r.toolCalls });

    for (const call of r.toolCalls) {
      const tool = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }

      // ── 1. EntryGuard（拒绝即留痕，并让 LLM 看到拒绝原因）──
      const entry = entryGuard.check({ tool, args, callerId: CALLER_ID });
      if (entry.kind === 'deny') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `[准入门拒绝] ${entry.category}: ${entry.reason}。该调用未执行。请调整方案：换用允许的工具，或说明无法完成。`,
        });
        continue;
      }

      // ── 2. 执行本地确定性工具 ──
      let output: string;
      let toolError: string | null = null;
      try {
        output = await TOOLS[tool]!.run(args);
      } catch (err) {
        toolError = err instanceof Error ? err.message : String(err);
        output = `[工具执行失败] ${toolError}`;
      }

      // ── 3. ResourceLedger（预算比按 run 级累计；记忆写入走最高审计级别）──
      const usage = { tokens: cumulativeTokens };
      ledger.record(taskId, tool, usage, { taskId, maxTokens: sc.maxTokens });
      if (tool === 'memory_write') {
        const fields = typeof args.key === 'string' ? [args.key] : undefined;
        ledger.auditMemoryWrite(taskId, 'memory', {
          tool: 'memory_write',
          fieldsChanged: fields,
          bytes: Buffer.byteLength(String(args.value ?? ''), 'utf-8'),
        });
      }

      // ── 4. ExitGuard（含输出策略：N4 的凭据字段）──
      const exit = exitGuard.check(
        { tool, args, callerId: CALLER_ID },
        { ok: true, output, resources: { tokens: cumulativeTokens } },
      );
      if (exit.kind === 'reject') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `[出口门拒绝] ${exit.category}: ${exit.reason}。该结果不被采纳。请调整输出（例如移除敏感内容），或说明无法完成。`,
        });
        continue;
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  const stats: RunStats = {
    scenario: sc.id,
    sessionId,
    turns: Math.min(sc.maxTurns, messages.filter((m) => m.role === 'assistant').length),
    totalTokens,
    // 注意：audit 是跨场景共享的单实例——统计必须用本场景的新增切片，否则是累计值（实测踩过）。
    denies: audit.recorded.slice(before).filter((e) => e.type === 'entry_deny').length,
    rejects: audit.recorded.slice(before).filter((e) => e.type === 'exit_reject').length,
    signals: audit.recorded.slice(before).filter((e) => e.type === 'ledger_signal').length,
    finalOutcome,
  };
  results.push(stats);

  // LLM 被拒后的第一反应（研究价值最高的片段）——打到终端，随 stats 记录在 meta
  process.stdout.write(
    `  [${sc.id}] turns=${stats.turns} tokens=${totalTokens} deny=${stats.denies} reject=${stats.rejects} signal=${stats.signals} → ${finalOutcome}\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 投影（schema 与 V1 同构 + run 元数据；键序与 v2.56.0 初版逐字一致——
// 链哈希覆盖落盘内容的 JSON 键序，改动键序会使历史归档的链不可跨版本重算）
// ─────────────────────────────────────────────────────────────────────────────

interface V2Event {
  record_type: 'event';
  seq: number;
  ts: number;
  ts_mode: 'wall-clock';
  event_reproducibility: '不可确认';
  session_id: string;
  agent_id: string;
  event_type: string;
  category: string;
  rule_id: string;
  rule_name: string;
  detail: string;
  measured: Record<string, number> | null;
  threshold: Record<string, number> | null;
  findings?: unknown[];
  chain_hash: string;
  chain_prev: string;
  spec_ref: string;
  tc260_measures: string[];
  tc260_risks: string[];
  efficiency_grade: string;
  efficiency_basis: string;
  run: Record<string, unknown>;
}

async function projectOne(
  raw: RecordedEvent,
  sessionId: string,
  prevHash: string,
  runInfo: { providerHost: string; model: string },
): Promise<{ line: string; hash: string }> {
  const d = (raw.data && typeof raw.data === 'object' ? raw.data : {}) as Record<string, unknown>;
  const category = typeof d.category === 'string' ? d.category : typeof d.kind === 'string' ? d.kind : 'unknown';
  const rule = RULE_BY_CATEGORY[category];
  if (!rule) throw new Error(`未登记的事件类别：${category}（seq=${raw.seq}）——先在 rules/rule-map.mts 登记`);

  const measured0 = (d.measured as Record<string, number> | undefined) ?? null;
  const threshold0 = (d.threshold as Record<string, number> | undefined) ?? null;
  // exit_reject 无原生 measured/threshold（只有 metric/actual/budget）——与 V1 statsOf 同样归一化；
  // 漏掉会让静态复核器拿不到可复核数值（实测踩过）。
  let measured = measured0;
  let threshold = threshold0;
  if (!measured && raw.type === 'exit_reject' && typeof d.metric === 'string'
    && typeof d.actual === 'number' && typeof d.budget === 'number') {
    measured = { [d.metric]: d.actual };
    threshold = { [d.metric]: d.budget };
  }
  const findings = Array.isArray(d.findings) ? (d.findings as unknown[]) : null;
  const ts = raw.wallClockTs;

  // detail 组装：entry_deny/exit_reject 用 data.reason；ledger 用 data.detail。
  // exit_reject 的 payload 没有 reason（reason 只在 verdict 里）——超预算分支从
  // metric/actual/budget 组装（与框架 verdict.reason 同格式），避免空 detail。
  let detail = typeof d.reason === 'string' ? d.reason : typeof d.detail === 'string' ? d.detail : '';
  if (!detail && raw.type === 'exit_reject' && typeof d.metric === 'string'
    && typeof d.actual === 'number' && typeof d.budget === 'number') {
    detail = `${d.metric} ${d.actual} > budget ${d.budget} (tool=${String(d.tool ?? '')})`;
  }

  const body: Record<string, unknown> = {
    record_type: 'event',
    seq: raw.seq,
    ts,
    ts_mode: 'wall-clock',
    event_reproducibility: '不可确认',
    session_id: sessionId,
    agent_id: AGENT_ID,
    event_type: raw.type,
    category,
    rule_id: rule.ruleId,
    rule_name: rule.ruleName,
    detail,
    measured,
    threshold,
    chain_hash: '',
    chain_prev: prevHash,
    spec_ref: rule.specRef,
    tc260_measures: rule.tc260Measures,
    tc260_risks: rule.tc260Risks,
    efficiency_grade: rule.efficiencyGrade,
    efficiency_basis: rule.efficiencyBasis,
    run: { provider: runInfo.providerHost, model: runInfo.model },
  };
  if (findings) body.findings = findings;

  const hashBody: Record<string, unknown> = { ...body };
  delete hashBody.chain_hash;
  delete hashBody.chain_prev;
  const hash = createHash('sha256').update(prevHash + '|' + JSON.stringify(hashBody), 'utf-8').digest('hex');
  body.chain_hash = hash;
  return { line: JSON.stringify(body), hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程：归档 → 场景循环（增量落盘）→ 合成正式产物
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let only: string | null = null;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--only=')) only = a.slice('--only='.length);
  }
  const selected = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (selected.length === 0) {
    console.error(`未找到场景 ${only}。可用：${SCENARIOS.map((s) => s.id).join(' ')}`);
    process.exit(1);
  }

  // fail-loud：无 key 不开始（跑一半没 key 更糟——中途场景会产生不可比的不完整数据）
  resolveLlmConfig();
  ensureWorkspace();
  const { baseUrl, model } = resolveLlmConfig();
  const runInfo = { providerHost: new URL(baseUrl).host, model };

  // ── 归档阶段（在任何 LLM 调用之前——中断也不丢旧数据）──
  mkdirSync(HISTORY_DIR, { recursive: true });
  const ts = stamp();
  if (existsSync(TMP_PATH)) {
    // 上次运行中途失败的增量残留 → 归档为 incomplete run（事件行链自洽可验，meta 为归档时合成）
    const tmpLines = readFileSync(TMP_PATH, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
    const incompleteMeta = {
      record_type: 'meta',
      schema_version: 'aof-audit-panel/1',
      data_class: 'llm-in-the-loop',
      incomplete: true,
      generator: 'tools/audit-panel/realagent/runner.mts（归档时合成）',
      framework: { version: readFileSync(VERSION_PATH, 'utf-8').trim(), entry: 'reference/runtimes/l2-runtime-oversight/index.ts' },
      event_count: tmpLines.length,
      total_tokens: null,
      runs: null,
      archive_note: '上次运行中途失败的增量残留（.tmp），由本次运行开始时自动归档；事件行链自洽可验，无 run 级统计。',
      chain: { algorithm: 'sha256(prev + "|" + JSON.stringify(本行去链字段)) —— 与正式产物同规则', note: '事件行可按同规则独立验链；本文件不作为面板数据源（无完整元数据）' },
    };
    const p = resolve(HISTORY_DIR, `realagent-incomplete-${ts}.jsonl`);
    writeFileSync(p, [JSON.stringify(incompleteMeta), ...tmpLines].join('\n') + '\n', 'utf-8');
    unlinkSync(TMP_PATH);
    process.stdout.write(`  归档残留（上次中途失败）：${p}（${tmpLines.length} 事件）\n`);
  }
  const prevSeq = prevRunSeq();
  if (existsSync(OUT_PATH)) {
    const p = resolve(HISTORY_DIR, `realagent-run${prevSeq}-${ts}.jsonl`);
    copyFileSync(OUT_PATH, p);
    process.stdout.write(`  归档上一份产物：${p}（run_seq=${prevSeq}）\n`);
  }
  const runSeq = prevSeq + 1;

  // ── 运行阶段 ──
  // 单链贯穿全部场景（seq 全局递增），每场景一个 session_id
  const audit = new RecordingAuditLog('realagent-run');
  const results: RunStats[] = [];
  let prevHash = '';
  let lastProjectedSeq = 0;      // 已投影落盘的最大 seq（失败抢救的增量起点）
  let inFlightSession: string | null = null; // 中断场景的 salvage 归属

  process.stdout.write(`\nV2 real-agent run#${runSeq} · ${selected.length} 场景 · provider=${baseUrl} · model=${model}\n${'─'.repeat(58)}\n`);

  try {
    // 增量暂存从空开始（残留已在归档阶段清除）
    if (existsSync(TMP_PATH)) unlinkSync(TMP_PATH);

    for (let i = 0; i < selected.length; i++) {
      const sc = selected[i]!;
      const sessionId = `sess-real-${sc.id}-r${i + 1}`;
      const before = audit.length;
      inFlightSession = sessionId;
      await runScenario(sc, i + 1, sessionId, audit, results);
      inFlightSession = null;
      // 本场景切片投影 → 增量落盘（每场景 flush 一次，中途失败不丢已完成场景）
      for (const raw of audit.recorded.slice(before)) {
        const { line, hash } = await projectOne(raw, sessionId, prevHash, runInfo);
        appendFileSync(TMP_PATH, line + '\n', 'utf-8');
        prevHash = hash;
        lastProjectedSeq = raw.seq;
      }
    }

    // ── 合成正式产物：meta（首行）+ tmp 中已落盘的事件行 ──
    const tmpLines = readFileSync(TMP_PATH, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
    if (tmpLines.length !== audit.recorded.length) {
      throw new Error(`增量落盘不完整：tmp ${tmpLines.length} 行 vs 审计 ${audit.recorded.length} 条——拒绝合成正式产物（.tmp 已保留供排查）`);
    }
    const chainVerified = audit.verifyChain();
    const meta = {
      record_type: 'meta',
      schema_version: 'aof-audit-panel/1',
      data_class: 'llm-in-the-loop',
      generator: 'tools/audit-panel/realagent/runner.mts',
      run_seq: runSeq,
      framework: { version: readFileSync(VERSION_PATH, 'utf-8').trim(), entry: 'reference/runtimes/l2-runtime-oversight/index.ts' },
      llm: { provider_host: runInfo.providerHost, model, key_source: 'env/.env（key 本体不入库不入日志）' },
      event_count: tmpLines.length,
      total_tokens: results.reduce((a, b) => a + b.totalTokens, 0),
      runs: results,
      archive: {
        policy: '每次运行开始时，上一份正式产物归档至 data/history/realagent-run{N}-{stamp}.jsonl（N=该产物的 run_seq）；中途失败残留 .tmp 归档为 realagent-incomplete-{stamp}.jsonl',
        history_dir: 'tools/audit-panel/data/history/（gitignore：本地研究素材，不入库）',
      },
      durability: '事件按场景粒度增量落盘（.tmp 暂存），全部场景结束后合成正式文件；中途失败时已完成场景不丢失，中断场景残留事件由失败处理器尽力投影，.tmp 由下次运行自动归档为 incomplete run',
      chain: {
        algorithm: 'sha256(prev + "|" + JSON.stringify(本行去链字段)) —— 与 V1 落盘链同规则',
        framework_verified_at_run: chainVerified,
        deterministic_rebuild: false,
        note: 'LLM-in-the-loop 数据：输入不可复现，两次运行产物必然不同（这是设计而非缺陷）。' +
          '落盘链仍可验证「文件未被事后篡改」；运行期框架链已由 verifyChain 校验。' +
          '本数据为自测性质行为记录，不支撑任何效能断言。',
      },
      boundaries_note: '诚实边界与覆盖矩阵见 tools/audit-panel/data/events.jsonl 的 meta（V1 确定性数据）；V2 与 V1 并列呈现、不混淆。',
    };

    writeFileSync(OUT_PATH, [JSON.stringify(meta), ...tmpLines].join('\n') + '\n', 'utf-8');
    unlinkSync(TMP_PATH);

    process.stdout.write(`\n导出：${OUT_PATH}\n  事件 ${meta.event_count} 条 | 总 token ${meta.total_tokens} | 链 ${chainVerified ? 'PASS' : 'FAIL'} | run#${runSeq}（上一份已归档至 data/history/）\n`);
  } catch (err) {
    console.error('\n✗ 运行失败：', err instanceof Error ? err.message : err);
    // 失败抢救：把审计里已产生但尚未投影的事件尽力落盘（中断场景的残留）
    let salvaged = 0;
    try {
      for (const raw of audit.recorded) {
        if (raw.seq <= lastProjectedSeq) continue;
        const sess = inFlightSession ?? raw.sessionId;
        const { line, hash } = await projectOne(raw, sess, prevHash, runInfo);
        appendFileSync(TMP_PATH, line + '\n', 'utf-8');
        prevHash = hash;
        lastProjectedSeq = raw.seq;
        salvaged++;
      }
    } catch {
      /* 抢救尽力而为：投影依赖 rule-map 登记，未登记类别的残留无法投影 */
    }
    if (existsSync(TMP_PATH)) {
      console.error(`  已完成场景的事件已增量落盘（${TMP_PATH}），本次另抢救 ${salvaged} 条中断场景残留。`);
      console.error('  正式产物未被覆盖（上一次的产物仍在）；下次运行将自动把 .tmp 归档为 incomplete run。');
    } else {
      console.error('  无已落盘增量（失败发生在首个场景投影前）。');
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('✗ 未捕获异常：', err instanceof Error ? err.message : err);
  process.exit(1);
});
