#!/usr/bin/env node
/**
 * replay.mts —— 审计重放校验（V1 核心模块：让面板成为"审计"而不是"看板"）
 *
 * 作用：对 events.jsonl 里的每条拦截/信号，用**同一版本框架的组件独立重建执行**，
 *       比对三方一致性：
 *         日志记录的 category == 事件自带 replay.expect == 重放器重新执行得到的 category
 *       任何一方不一致，都说明：日志被改过 / 导出器投影出错 / 或框架判定逻辑变了。
 *
 * 与"只读展示"的区别：Langfuse 类工具渲染日志说了什么；本模块验证日志说的**是否为真**——
 * 用同一套规则重新裁决一遍，对不上即告警。这是"审计"与"看板"的分界线。
 *
 * 输入来源：事件自带的 replay 字段（判定输入 + 预期裁决，导出器写入、随链落盘——
 * 篡改重放输入同样会被 verify-chain 检出）。重放不靠"猜当时的 guard 配置"。
 *
 * 策略谓词不可序列化，故契约里是声明式描述（forbidden-substring 等），由本模块重建。
 *
 * 用法：
 *   node --experimental-transform-types tools/audit-panel/rules/replay.mts
 *   node --experimental-transform-types tools/audit-panel/rules/replay.mts --file=<路径>
 *   node --experimental-transform-types tools/audit-panel/rules/replay.mts --disposition=<台账路径>
 *
 * 退出码：0 全部一致 / 1 存在不一致。
 * 孤儿信号不再导致非零退出（v2 起）：孤儿是诚实边界，不是重放错误——数量由输出与面板呈现。
 *
 * 已知边界（输出中会标注）：
 *   - S6（integrity-check-failed）的 integrityCheck 是注入钩子（框架默认恒真，G4 未闭合），
 *     重放仅验证"钩子返回 false 时分支可达且判定正确"，不证明真实完整性校验有效。
 *   - ledger_signal 是审计信号而非裁决，重放比的是信号 kind 序列；
 *     处置由**独立台账**（tools/disposition/）登记，框架侧仍无处置事件类型（spec/13 #44 未解）。
 *     孤儿判定 = 「台账中无生效处置」，并派生三态（未处置 / 观察中 / 已闭合）；
 *     台账链校验失败时不采信其内容（全部按未处置报告），避免用不可信记录掩盖缺口。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from '../cli-entry.mts';

import {
  ConfigReviewer,
  EntryGuard,
  ExitGuard,
  ResourceLedger,
} from '../../../reference/runtimes/l2-runtime-oversight/index.ts';
import {
  DEFAULT_LEDGER_FILE as DEFAULT_DISPOSITION_FILE,
  indexLedger,
  readLedger,
  stateOf,
  type DispositionAction,
  type DispositionState,
} from '../../disposition/ledger.mts';
import { verifyLedgerFile } from '../../disposition/verify-chain.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, '../data/events.jsonl');

// ─────────────────────────────────────────────────────────────────────────────
// 声明式谓词 → 可执行谓词（与导出器场景中的写法逐字一致）
// ─────────────────────────────────────────────────────────────────────────────

type ArgPolicyDecl = { type: 'forbidden-substring'; value: string; stringify: 'json' };
type OutputPolicyDecl = { type: 'forbidden-substring'; value: string };

function buildArgPolicy(decl: ArgPolicyDecl) {
  if (decl.type !== 'forbidden-substring' || decl.stringify !== 'json') {
    throw new Error(`未知的参数策略声明：${JSON.stringify(decl)}`);
  }
  return {
    check: (args: unknown) => !JSON.stringify(args).includes(decl.value),
    reason: () => `forbidden substring "${decl.value}" in JSON(args)`,
    name: `replay:${decl.type}`,
  };
}

function buildOutputPolicy(decl: OutputPolicyDecl, tool: string) {
  if (decl.type !== 'forbidden-substring') {
    throw new Error(`未知的输出策略声明：${JSON.stringify(decl)}`);
  }
  return {
    name: `replay:${decl.type}`,
    tools: new Set([tool]),
    check: (result: { output?: unknown }) => !String(result.output).includes(decl.value),
    reason: () => `forbidden substring "${decl.value}" in output`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 重放执行器
// ─────────────────────────────────────────────────────────────────────────────

/** 丢弃型 audit：重放过程不得往任何真实日志写东西。 */
const nullAudit = { append: () => null };

function replayEntry(spec: Record<string, unknown>): { category: string; findings?: unknown[] } {
  const allowed = new Set(spec.allowed as string[]);
  const argPolicies: ConstructorParameters<typeof EntryGuard>[1] = [];
  if (spec.argPolicy) {
    const p = buildArgPolicy(spec.argPolicy as ArgPolicyDecl);
    argPolicies.push({
      name: p.name,
      tools: new Set([spec.tool as string]),
      check: p.check,
      reason: p.reason,
    });
  }
  const guard = new EntryGuard(
    allowed,
    argPolicies,
    nullAudit,
    spec.configReview ? new ConfigReviewer() : undefined,
    spec.configReview ? new Set([spec.tool as string]) : undefined,
  );
  const verdict = guard.check({
    tool: spec.tool as string,
    args: spec.args ?? null,
    callerId: 'replay-agent',
  });
  if (verdict.kind === 'allow') return { category: '__allow__' };
  return { category: verdict.category, findings: (verdict as { findings?: unknown[] }).findings };
}

function replayExit(spec: Record<string, unknown>): { category: string } {
  const outputPolicies: ConstructorParameters<typeof ExitGuard>[1] = [];
  if (spec.outputPolicy) {
    outputPolicies.push(buildOutputPolicy(spec.outputPolicy as OutputPolicyDecl, spec.tool as string));
  }
  const guard = new ExitGuard(
    (spec.budget ?? {}) as { maxTokens?: number },
    outputPolicies,
    spec.integrityHook === 'always-false' ? () => false : () => true,
    nullAudit,
  );
  const verdict = guard.check(
    { tool: spec.tool as string, args: null, callerId: 'replay-agent' },
    spec.result as { ok: boolean; output?: unknown; resources?: { tokens?: number } },
  );
  return { category: verdict.kind === 'accept' ? '__accept__' : verdict.category };
}

function replayLedger(spec: Record<string, unknown>): { kinds: string[] } {
  const audit = { append: () => null };
  const ledger = new ResourceLedger(audit);
  const kinds: string[] = [];
  for (const call of spec.calls as Array<Record<string, unknown>>) {
    if (call.op === 'record') {
      const signals = ledger.record(
        call.taskId as string,
        call.tool as string,
        call.usage as { tokens?: number },
        call.budget as never,
      );
      for (const s of signals) kinds.push(s.kind);
    } else if (call.op === 'auditMemoryWrite') {
      const sig = ledger.auditMemoryWrite(
        call.taskId as string,
        call.target as 'memory',
        call.writeDetail as { tool: string },
      );
      kinds.push(sig.kind);
    } else {
      throw new Error(`未知的账本调用 op：${String(call.op)}`);
    }
  }
  return { kinds };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { file: string; dispositionFile: string } {
  let file = DEFAULT_FILE;
  let dispositionFile = DEFAULT_DISPOSITION_FILE;
  for (const a of argv) {
    if (a.startsWith('--file=')) file = resolve(a.slice('--file='.length));
    else if (a.startsWith('--disposition=')) dispositionFile = resolve(a.slice('--disposition='.length));
  }
  return { file, dispositionFile };
}

export interface ReplayOutcome {
  seq: number;
  scenario: string;
  kind: string;
  logged: string;
  replayed: string;
  match: boolean;
  note?: string;
  extra?: string;
}

/** 单条账本信号的处置状态（面板与 CLI 共用同一份派生结果）。 */
export interface SignalDispositionState {
  seq: number;
  category: string;
  detail: string;
  state: DispositionState;
  disp_seq: number | null;
  action: DispositionAction | null;
  note: string;
  /** target_chain_hash 与信号链哈希前 16 位不一致（疑似错位引用）。 */
  hashMismatch: boolean;
}

export interface DispositionSummary {
  file: string;
  present: boolean;
  chainOk: boolean;
  rows: number;
  superseded: number;
  counts: { total: number; closed: number; observing: number; unhandled: number };
  /** 处置引用的链哈希与信号不符（疑似错位引用）——这些记录不计入闭合。 */
  mismatched: number;
  actions: Record<string, number>;
  warning: string | null;
}

export interface ReplayFileResult {
  ok: boolean;
  outcomes: ReplayOutcome[];
  failFast: string[];
  /** 未处置的信号（含「已转人工但未闭合」）——孤儿清单。 */
  orphans: Array<{ seq: number; category: string; detail: string }>;
  /** 全部账本信号的三态（供面板逐条展示）。 */
  signals: SignalDispositionState[];
  disposition: DispositionSummary;
  frameworkVersion: string;
  matched: number;
  total: number;
}

/** 核心重放（可导出复用：server 启动时当场执行）。 */
export function replayFile(file: string, dispositionFile: string = DEFAULT_DISPOSITION_FILE): ReplayFileResult {
  const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
  const events = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);

  const outcomes: ReplayOutcome[] = [];
  const failFast: string[] = [];

  for (const e of events) {
    const seq = Number(e.seq);
    const replay = e.replay as Record<string, unknown> | undefined;
    const logged = String(e.category);

    if (!replay) {
      outcomes.push({ seq, scenario: String(e.source_scenario), kind: '-', logged, replayed: '-', match: false, note: '事件无 replay 规格' });
      failFast.push(`seq ${seq} 缺少 replay 规格`);
      continue;
    }

    try {
      if (replay.kind === 'entry') {
        const r = replayEntry(replay);
        const extra = Array.isArray(r.findings)
          ? `findings=${r.findings.length}${r.findings.length === (e.findings as unknown[] | undefined)?.length ? '' : '（与日志不符！）'}`
          : undefined;
        outcomes.push({ seq, scenario: String(e.source_scenario), kind: 'entry', logged, replayed: r.category, match: r.category === logged && r.category === replay.expect, extra });
        if (r.category !== logged) failFast.push(`seq ${seq} entry 重放裁决 ${r.category} ≠ 日志 ${logged}`);
      } else if (replay.kind === 'exit') {
        const r = replayExit(replay);
        const note = replay.integrityHook === 'always-false'
          ? 'integrityCheck 为注入钩子：仅验证分支可达性（G4 未闭合）'
          : undefined;
        outcomes.push({ seq, scenario: String(e.source_scenario), kind: 'exit', logged, replayed: r.category, match: r.category === logged && r.category === replay.expect, note });
        if (r.category !== logged) failFast.push(`seq ${seq} exit 重放裁决 ${r.category} ≠ 日志 ${logged}`);
      } else if (replay.kind === 'ledger') {
        const r = replayLedger(replay);
        const expect = replay.expect as string[];
        const kindsMatch = r.kinds.length === expect.length && r.kinds.every((k, i) => k === expect[i]);
        const loggedKinds = events.filter((x) => x.source_scenario === e.source_scenario && x.event_type === 'ledger_signal').map((x) => String(x.category));
        const loggedMatch = loggedKinds.length === expect.length && loggedKinds.every((k, i) => k === expect[i]);
        outcomes.push({
          seq, scenario: String(e.source_scenario), kind: 'ledger',
          logged: loggedKinds.join(','), replayed: r.kinds.join(','),
          match: kindsMatch && loggedMatch,
          note: kindsMatch && loggedMatch ? undefined : `重放信号序 [${r.kinds}] vs 声明 [${expect}] vs 日志 [${loggedKinds}]`,
        });
        if (!kindsMatch) failFast.push(`seq ${seq} ledger 重放信号序与声明不符：[${r.kinds}] vs [${expect}]`);
        if (!loggedMatch) failFast.push(`seq ${seq} ledger 日志信号序与声明不符：[${loggedKinds}] vs [${expect}]`);
      } else {
        failFast.push(`seq ${seq} 未知 replay.kind：${String(replay.kind)}`);
      }
    } catch (err) {
      failFast.push(`seq ${seq} 重放执行异常：${err instanceof Error ? err.message : String(err)}`);
      outcomes.push({ seq, scenario: String(e.source_scenario), kind: String(replay.kind), logged, replayed: '__error__', match: false, note: '重放执行异常' });
    }
  }

  // —— 处置状态与孤儿清单（v2 起改为 target 引用匹配）——
  // 非孤儿 ⇔ 处置台账中存在生效记录（未被 superseded）、target_seq 指向该信号，
  //          且 target_chain_hash 与信号 chain_hash 前 16 位一致（防错位引用）。
  // 台账链校验失败 ⇒ 不采信其内容，全部按未处置报告：宁可多报孤儿，不可用不可信记录掩盖缺口。
  const ledgerVerify = verifyLedgerFile(dispositionFile);
  const ledgerRows = ledgerVerify.ok ? readLedger(dispositionFile) : [];
  const index = indexLedger(ledgerRows);

  const ledgerEvents = events.filter((e) => e.event_type === 'ledger_signal');
  const signals: SignalDispositionState[] = ledgerEvents.map((e) => {
    const seq = Number(e.seq);
    const base = stateOf(seq, index);
    const row = index.current.get(seq) ?? null;
    const expected = String(e.chain_hash ?? '').slice(0, 16);
    const hashMismatch = row !== null && row.target_chain_hash !== expected;
    let note = base.note;
    if (hashMismatch) note = `处置引用的链哈希 ${row!.target_chain_hash} 与信号 ${expected} 不符（疑似错位引用）`;
    else if (!ledgerVerify.present) note = '台账未创建，按未处置报告';
    else if (!ledgerVerify.ok) note = '台账链校验失败，处置状态不可采信';
    return {
      seq,
      category: String(e.category),
      detail: String(e.detail),
      state: hashMismatch ? 'unhandled' : base.state,
      disp_seq: base.disp_seq,
      action: base.action,
      note,
      hashMismatch,
    };
  });

  const orphans = signals
    .filter((s) => s.state === 'unhandled')
    .map((s) => ({ seq: s.seq, category: s.category, detail: s.detail }));

  const counts = {
    total: signals.length,
    closed: signals.filter((s) => s.state === 'closed').length,
    observing: signals.filter((s) => s.state === 'observing').length,
    unhandled: signals.filter((s) => s.state === 'unhandled').length,
  };
  const actions: Record<string, number> = {};
  for (const row of index.current.values()) actions[row.action] = (actions[row.action] ?? 0) + 1;

  const disposition: DispositionSummary = {
    file: dispositionFile,
    present: ledgerVerify.present,
    chainOk: ledgerVerify.ok,
    rows: ledgerVerify.rows,
    superseded: index.superseded.size,
    counts,
    mismatched: signals.filter((s) => s.hashMismatch).length,
    actions,
    warning: !ledgerVerify.present
      ? '处置台账未创建——全部信号按未处置报告'
      : !ledgerVerify.ok
        ? `处置台账链校验失败：${ledgerVerify.fails.map((f) => f.reason).join('；')}`
        : null,
  };

  const matched = outcomes.filter((o) => o.match).length;
  const fw = (meta.framework as Record<string, unknown> | undefined)?.version;
  return {
    ok: failFast.length === 0,
    outcomes,
    failFast,
    orphans,
    signals,
    disposition,
    frameworkVersion: typeof fw === 'string' ? fw : 'unknown',
    matched,
    total: outcomes.length,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const r = replayFile(args.file, args.dispositionFile);
  const { outcomes, failFast, orphans } = r;

  const out = [
    '',
    '审计重放校验（独立重执行 · 与看板的分界线）',
    '─'.repeat(58),
    `  文件            ${args.file}`,
    `  框架版本        v${r.frameworkVersion}`,
    `  判定条目        ${outcomes.length}（ledger 场景按信号组比对）`,
    '',
  ];

  for (const o of outcomes) {
    const flag = o.match ? 'MATCH  ' : 'MISMATCH';
    out.push(`  [seq ${String(o.seq).padStart(2)}] ${o.scenario.padEnd(3)} ${o.kind.padEnd(7)} ${flag} 日志=[${o.logged}] 重放=[${o.replayed}]${o.extra ? '  ' + o.extra : ''}${o.note ? '\n         ↳ ' + o.note : ''}`);
  }

  out.push('');
  out.push(`  重放一致性      ${r.matched}/${r.total}${r.matched === r.total ? '  ✓' : '  ✗'}`);

  const d = r.disposition;
  const ledgerState = !d.present ? '未创建' : d.chainOk ? `PASS（${d.rows} 条）` : 'FAIL（链校验不通过，处置不采信）';
  out.push(`  处置台账        ${ledgerState} · ${d.file}`);
  out.push(`  处置三态        已闭合 ${d.counts.closed} · 观察中 ${d.counts.observing} · 未处置 ${d.counts.unhandled}（合计 ${d.counts.total}）`);
  out.push(`  孤儿信号        ${orphans.length} 条（未处置；含「已转人工未闭合」）`);
  for (const s of r.signals) {
    out.push(`    [seq ${String(s.seq).padStart(2)}] ${s.category} — ${s.state}（${s.note}${s.disp_seq ? ` · disp ${s.disp_seq}` : ''}）`);
  }
  if (d.warning) out.push(`  ⚠️ ${d.warning}`);
  if (d.mismatched > 0) out.push(`  ⚠️ ${d.mismatched} 条处置引用的链哈希与信号不符（疑似错位引用），未计入闭合`);
  out.push('  边界           框架侧仍无处置事件类型（spec/13 #44 未解）；本台账为工具侧补口，不构成 #44 闭合。');
  out.push('');

  if (failFast.length > 0) {
    out.push('  失败明细：');
    for (const f of failFast) out.push(`    - ${f}`);
    out.push('');
  }

  process.stdout.write(out.join('\n'));
  if (failFast.length > 0) process.exitCode = 1;
}

// 本模块被 server import（replayFile）；顶层无条件执行会让 server 启动时打印整段重放报告，
// 并在失败时把 exitCode=1 留给 server 进程。v2.72.7 起只在被直接执行时运行 CLI。
if (isEntryPoint(import.meta.url)) main();
