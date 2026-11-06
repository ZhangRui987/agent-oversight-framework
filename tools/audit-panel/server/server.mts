#!/usr/bin/env node
/**
 * server.mts —— 审计面板服务端（node:http 单文件，零依赖，四个只读端点）
 *
 * 端点：
 *   GET /                → 三视图单页（web/index.html + web/app.js）
 *   GET /api/timeline    → meta + 全部事件（时间线数据源）
 *   GET /api/evidence    → 按规则聚合的证据卡（三层分级：事件可复现性 / 规则效能 / 条款）
 *   GET /api/boundaries  → 诚实边界（meta.boundaries + 覆盖矩阵 + 链状态）
 *   GET /api/export      → CSV 下载（列名与数据契约一致，带 UTF-8 BOM——Excel 中文不乱码）
 *
 * 设计纪律：
 *   - 零依赖：仅 node: 内置模块。数据从 data/events.jsonl 只读加载，启动后驻内存。
 *   - 只读服务：不写任何文件、不执行重放（重放属 CLI 工具 rules/replay.mts；
 *     面板如实标注"重放校验请运行命令行"，不伪造"已在页面上验证过"的状态）。
 *   - 数据不新鲜即明示：响应头 X-Data-Generated-At-Mode 携带 meta 的 ts 模式；
 *     页脚显示 meta.framework.version（由导出器从 VERSION 实测，非手写）。
 *
 * 用法：
 *   node --experimental-transform-types tools/audit-panel/server/server.mts
 *   node --experimental-transform-types tools/audit-panel/server/server.mts --port=8080
 *
 * 然后浏览器打开 http://127.0.0.1:7727
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReportHtml } from './report.mts';
import { verifyChainFile } from '../rules/verify-chain.mts';
import { replayFile } from '../rules/replay.mts';
import { verifyRealagentFile } from '../rules/verify-realagent.mts';
import { indexLedger, readLedger, stateOf } from '../../disposition/ledger.mts';
import { verifyLedgerFile } from '../../disposition/verify-chain.mts';
import {
  annotateSla,
  computeCompleteness,
  loadObligations,
  measureSignalToDisposition,
  type ObligationsDoc,
  type SignalInput,
} from '../../disposition/obligations.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_ROOT = resolve(HERE, '..');
const DATA_FILE = join(PANEL_ROOT, 'data', 'events.jsonl');
const REALAGENT_FILE = join(PANEL_ROOT, 'data', 'realagent-events.jsonl');
const DISPOSITION_FILE = resolve(PANEL_ROOT, '..', 'disposition', 'data', 'disposition.jsonl');
const WEB_ROOT = join(PANEL_ROOT, 'web');
const DEFAULT_PORT = 7727;

// ─────────────────────────────────────────────────────────────────────────────
// 数据加载（只读一次，驻内存）
// ─────────────────────────────────────────────────────────────────────────────

export interface Meta {
  record_type: string;
  schema_version: string;
  framework: { version: string; entry: string };
  gates_count: number | null;
  session_id: string;
  agent_id: string;
  event_count: number;
  chain: Record<string, unknown>;
  scenarios: Array<Record<string, unknown>>;
  coverage: Record<string, unknown>;
  boundaries: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface PanelEvent {
  record_type: string;
  seq: number;
  event_type: string;
  category: string;
  rule_id: string;
  rule_name: string;
  source_scenario: string;
  detail: string;
  measured: Record<string, number> | null;
  threshold: Record<string, number> | null;
  findings?: unknown[];
  spec_ref: string;
  tc260_measures: string[];
  tc260_risks: string[];
  efficiency_grade: string;
  efficiency_basis: string;
  replay?: Record<string, unknown>;
  chain_hash: string;
  chain_prev: string;
  [k: string]: unknown;
}

function loadData(): { meta: Meta; events: PanelEvent[] } {
  const raw = readFileSync(DATA_FILE, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const meta = JSON.parse(lines[0]!) as Meta;
  const events = lines.slice(1).map((l) => JSON.parse(l) as PanelEvent);
  if (meta.record_type !== 'meta') throw new Error('events.jsonl 首行不是 meta 记录');
  if (meta.event_count !== events.length) {
    throw new Error(`meta.event_count(${meta.event_count}) 与实际事件数(${events.length}) 不一致——请先重跑导出器`);
  }
  return { meta, events };
}

let data: { meta: Meta; events: PanelEvent[] };
try {
  data = loadData();
} catch (err) {
  console.error('✗ 数据加载失败：', err instanceof Error ? err.message : err);
  console.error('  请先运行：node --experimental-transform-types tools/audit-panel/scenario/export-events.mts');
  process.exit(1);
}

/** V2 real-agent 数据源（可选：文件不存在则该视图提示先生成）。 */
let realagent: { meta: Meta; events: PanelEvent[] } | null = null;
try {
  const raw = readFileSync(REALAGENT_FILE, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const meta = JSON.parse(lines[0]!) as Meta;
  const events = lines.slice(1).map((l) => JSON.parse(l) as PanelEvent);
  if (meta.event_count === events.length) realagent = { meta, events };
} catch {
  /* realagent 数据尚未生成——面板如实显示"未生成" */
}

// ─────────────────────────────────────────────────────────────────────────────
// 当场验证（启动时快照）：面板不只展示数据，还在每次启动时自证一遍。
// 与"重放不进服务"的旧决策不矛盾——那反对的是展示会漂移的缓存数字；
// 这里是启动时快照 + 明确标注执行时间，服务不重启结果不变，谁质疑当场重启验证。
// ─────────────────────────────────────────────────────────────────────────────

const verifiedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const bootVerification = {
  verifiedAt,
  chain: { ...verifyChainFile(DATA_FILE), file: 'data/events.jsonl (V1 确定性)' },
  replay: { ...replayFile(DATA_FILE, DISPOSITION_FILE), file: 'data/events.jsonl (V1 确定性)' },
  disposition: {
    ...verifyLedgerFile(DISPOSITION_FILE),
    file: 'tools/disposition/data/disposition.jsonl',
  },
  realagentVerify: realagent
    ? { ...verifyRealagentFile(REALAGENT_FILE), file: 'data/realagent-events.jsonl (V2)' }
    : { ok: false, fails: [{ seq: '-', reason: 'V2 数据未生成' }], file: 'data/realagent-events.jsonl (V2)', eventCount: 0, totalTokens: null as number | null, model: '-' },
};
// 台账可选：未创建不拖垮「当场验证」，但一旦存在就必须链校验通过才算全绿。
const allVerified =
  bootVerification.chain.ok &&
  bootVerification.replay.ok &&
  bootVerification.realagentVerify.ok &&
  (!bootVerification.disposition.present || bootVerification.disposition.ok);

// ─────────────────────────────────────────────────────────────────────────────
// 处置台账视图（只读消费 tools/disposition/ 的产物）
// ─────────────────────────────────────────────────────────────────────────────

export interface DispositionEntry {
  disp_seq: number;
  target_seq: number;
  target_chain_hash: string;
  signal_category: string;
  action: string;
  actor: string;
  reviewed_by: string | null;
  supersedes: number | null;
  plan: string | null;
  rationale: string;
  ts: number;
  chain_hash: string;
  /** 该记录是否仍是生效记录（未被 supersedes）。 */
  effective: boolean;
  /** 生效记录的三态；被更正的记录标记 superseded。 */
  state: 'closed' | 'observing' | 'unhandled' | 'superseded';
  stateNote: string;
  signal_detail: string | null;
  /** 自报时延（处置 ts − 信号 ts）；时钟倒挂时为负，统计时剔除并计数。 */
  latency_ms: number | null;
}

/** 信号级视图（10-D4/D5 的合法载体）：每条信号一行，含 SLA 判定与 overdue 标记。 */
export interface SignalRow {
  seq: number;
  category: string;
  signal_ts: number;
  state: 'unhandled' | 'observing' | 'closed';
  priority: string;
  /** 未登记类别的信号无 SLA，为 null（不得填 0 冒充「零时限」）。 */
  sla_hours: number | null;
  owner_role: string;
  elapsed_hours: number;
  overdue: boolean;
  clock_skew: boolean;
  disp_seq: number | null;
}

export interface DispositionView {
  file: string;
  present: boolean;
  chainOk: boolean;
  rows: number;
  superseded: number;
  mismatched: number;
  counts: { total: number; closed: number; observing: number; unhandled: number };
  actions: Record<string, number>;
  latency: { p50: number | null; p90: number | null; n: number; negative: number; note: string };
  warning: string | null;
  entries: DispositionEntry[];
  /** 信号级行（每类信号的 SLA 与超期判定）。 */
  signals: SignalRow[];
  /** 10-D5 两个二阶信号 + 基准时刻与分母口径。 */
  completeness: {
    n_signals_declared: number;
    n_signals_undeclared: number;
    n_undisposed: number;
    n_overdue: number;
    undisposed_rate: number | null;
    overdue_rate: number | null;
    provisional: boolean;
    clock_skew: number;
    basis: string;
    note: string;
    now: number;
    now_iso: string;
    now_source: string;
  };
  /** 义务注册表元信息（标定状态必须与数值同行展示）。 */
  obligations: {
    file: string;
    calibration_status: string;
    calibration_owner: string;
    calibration_note: string;
    categories: Record<string, { priority: string; sla_hours: number; owner_role: string }>;
    error: string | null;
  };
  boundary: string;
}

function buildDispositionView(): DispositionView {
  const summary = bootVerification.replay.disposition;
  const chain = bootVerification.disposition;
  const rows = chain.present && chain.ok ? readLedger(DISPOSITION_FILE) : [];
  const index = indexLedger(rows);
  const signals = new Map(
    data.events.filter((e) => e.event_type === 'ledger_signal').map((e) => [Number(e.seq), e]),
  );
  // ── 10-D4 / 10-D5：义务注册表 + 基准时刻 + 信号全集
  // now 的选取：默认取实时，但必须允许固定——否则同一份数据在不同时刻算出不同 overdue 数，
  // 输出不可复现，也无法做确定性断言。
  const nowEnv = process.env.AOF_PANEL_NOW;
  const nowFixed = nowEnv !== undefined && Number.isFinite(Number(nowEnv)) && Number(nowEnv) > 0;
  const now = nowFixed ? Number(nowEnv) : Date.now();
  const nowSource = nowFixed
    ? 'AOF_PANEL_NOW（固定基准，可复现）'
    : 'Date.now()（实时视图：不同时刻访问，overdue 数可能变化）';

  let obligationsDoc: ObligationsDoc | null = null;
  let obligationsError: string | null = null;
  try {
    obligationsDoc = loadObligations();
  } catch (err) {
    obligationsError = (err as Error).message;
  }

  // 信号全集来源是面板事件流（ledger_signal），**不是**台账：
  // 台账只含「被处置过的」seq，拿它当分母会把两个 rate 结构性压向 0。
  const signalInputs: SignalInput[] = [];
  for (const [seq, e] of signals) {
    signalInputs.push({
      seq,
      category: String((e as unknown as { category?: unknown }).category ?? ''),
      signal_ts: Number(e.ts),
      state: stateOf(seq, index).state,
    });
  }

  const annotated = obligationsDoc
    ? annotateSla(signalInputs, obligationsDoc, now)
    : { rows: [], undeclared: signalInputs };
  const completeness = computeCompleteness(annotated.rows, annotated.undeclared.length);

  const signalRows: SignalRow[] = [
    ...annotated.rows.map((r) => ({
      seq: r.seq,
      category: r.category,
      signal_ts: r.signal_ts,
      state: r.state,
      priority: r.priority as string,
      sla_hours: r.sla_hours,
      owner_role: r.owner_role,
      elapsed_hours: r.elapsed_hours,
      overdue: r.overdue,
      clock_skew: r.clock_skew,
      disp_seq: index.current.get(r.seq)?.disp_seq ?? null,
    })),
    // 未登记类别的信号不丢弃：SLA 标 null 单列，provisional 会置真。
    ...annotated.undeclared.map((u) => ({
      seq: u.seq,
      category: u.category,
      signal_ts: u.signal_ts,
      state: u.state,
      priority: '未登记',
      sla_hours: null,
      owner_role: '—',
      elapsed_hours: (now - u.signal_ts) / 3_600_000,
      overdue: false,
      clock_skew: false,
      disp_seq: index.current.get(u.seq)?.disp_seq ?? null,
    })),
  ].sort((a, b) => a.seq - b.seq);

  // 每条信号「首条」生效处置的 ts（按 disp_seq 最小，非按 ts 最小——ts 是自报值可能倒挂）。
  const firstDisp = new Map<number, { disp_seq: number; ts: number }>();
  for (const r of rows) {
    const cur = firstDisp.get(r.target_seq);
    if (!cur || r.disp_seq < cur.disp_seq) firstDisp.set(r.target_seq, { disp_seq: r.disp_seq, ts: r.ts });
  }
  const latency = measureSignalToDisposition(
    annotated.rows,
    new Map([...firstDisp].map(([k, v]) => [k, v.ts])),
  );

  const supersededBy = new Map<number, number>();
  for (const r of rows) {
    if (typeof r.supersedes === 'number') supersededBy.set(r.supersedes, r.disp_seq);
  }

  const entries: DispositionEntry[] = rows.map((r) => {
    const current = index.current.get(r.target_seq);
    const effective = current?.disp_seq === r.disp_seq;
    const st = effective ? stateOf(r.target_seq, index) : null;
    const sig = signals.get(r.target_seq);
    return {
      disp_seq: r.disp_seq,
      target_seq: r.target_seq,
      target_chain_hash: r.target_chain_hash,
      signal_category: r.signal_category,
      action: r.action,
      actor: r.actor,
      reviewed_by: r.reviewed_by,
      supersedes: r.supersedes,
      plan: r.plan,
      rationale: r.rationale,
      ts: r.ts,
      chain_hash: r.chain_hash,
      effective,
      state: effective ? st!.state : 'superseded',
      stateNote: effective ? st!.note : `已被 disp ${supersededBy.get(r.disp_seq) ?? '?'} 更正`,
      signal_detail: sig ? String(sig.detail) : null,
      latency_ms: sig ? r.ts - Number(sig.ts) : null,
    };
  });

  return {
    file: 'tools/disposition/data/disposition.jsonl',
    present: summary.present,
    chainOk: summary.chainOk,
    rows: summary.rows,
    superseded: summary.superseded,
    mismatched: summary.mismatched,
    counts: summary.counts,
    actions: summary.actions,
    latency: {
      p50: latency.p50,
      p90: latency.p90,
      n: latency.n,
      negative: latency.negative,
      note: latency.note,
    },
    warning: summary.warning,
    entries,
    signals: signalRows,
    completeness: {
      ...completeness,
      now,
      now_iso: new Date(now).toISOString(),
      now_source: nowSource,
    },
    obligations: {
      file: 'tools/disposition/obligations.json',
      calibration_status: obligationsDoc?.calibration_status ?? 'unknown',
      calibration_owner: obligationsDoc?.calibration_owner ?? 'unknown',
      calibration_note: obligationsDoc?.calibration_note ?? '',
      categories: Object.fromEntries(
        Object.entries(obligationsDoc?.categories ?? {}).map(([k, v]) => [
          k,
          { priority: v.priority, sla_hours: v.sla_hours, owner_role: v.owner_role },
        ]),
      ),
      error: obligationsError,
    },
    boundary:
      '处置记录存在 ≠ 处置有效。孤儿归零只说明「有人点过按钮」，不说明缺口已解；' +
      'undisposed_rate 归零同理（10-D5 限制 1）。10-D4/10-D5 已有机器实现，但处置记录仍在独立台账、' +
      '未并入框架同一 AppendOnlyAuditLog（阶段 2b-2），spec/13 #44 仍记「部分解」，不构成闭合。' +
      '时限 24h / 72h / 168h 为工程占位、未标定（由 #33 承接）——本页任何时效数字只能读作分布，' +
      '不得写作「达标」或「超期率符合要求」。',
  };
}

const dispositionView = buildDispositionView();

// ─────────────────────────────────────────────────────────────────────────────
// 证据卡聚合（三层分级）
// ─────────────────────────────────────────────────────────────────────────────

interface EvidenceCard {
  rule_id: string;
  rule_name: string;
  event_count: number;
  categories: string[];
  spec_ref: string;
  tc260_measures: string[];
  tc260_risks: string[];
  efficiency_grade: string;
  efficiency_basis: string;
  /** 事件级可复现性：本面板全部事件由确定性场景导出，可重跑（export-events.mts）。 */
  event_reproducibility: string;
  /** 条款级：G 类官方条款，只支撑义务、不支撑效能。 */
  clause_grade: 'G';
}

function buildEvidence(): EvidenceCard[] {
  const byRule = new Map<string, EvidenceCard>();
  for (const e of data.events) {
    let card = byRule.get(e.rule_id);
    if (!card) {
      card = {
        rule_id: e.rule_id,
        rule_name: e.rule_name,
        event_count: 0,
        categories: [],
        spec_ref: e.spec_ref,
        tc260_measures: e.tc260_measures,
        tc260_risks: e.tc260_risks,
        efficiency_grade: e.efficiency_grade,
        efficiency_basis: e.efficiency_basis,
        event_reproducibility: '可重跑（export-events.mts 确定性场景，两次运行逐字节一致）',
        clause_grade: 'G',
      };
      byRule.set(e.rule_id, card);
    }
    card.event_count += 1;
    if (!card.categories.includes(e.category)) card.categories.push(e.category);
  }

  // R5 审计链没有事件形态——从 meta.chain 补一张卡（如实标注来源）。
  byRule.set('R5', {
    rule_id: 'R5',
    rule_name: '审计链完整性（AppendOnlyAuditLog）',
    event_count: 0,
    categories: [],
    spec_ref: 'spec/02-architecture E3/E5；PRODUCTION-GAPS G2/G4',
    tc260_measures: ['二、6(3) 日志管理（防篡改）', '二、6(4) 安全审计', '二、3(3) 留存人工审批日志（防篡改、可校验）'],
    tc260_risks: ['一、9(2) 日志缺失'],
    efficiency_grade: 'C',
    efficiency_basis:
      'SHA-256 哈希链已实现（G2 演示级闭合，等长篡改必检出）；未闭合：无密钥与外部锚定，进程被攻陷时整链可重算（G4/E5）。' +
      '不得表述为"防篡改"。本卡无事件计数——链是结构属性，不是事件。',
    event_reproducibility: 'verify-chain.mts 可重跑（落盘链逐条重算）',
    clause_grade: 'G',
  });

  return [...byRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV 导出（列名与数据契约一致；UTF-8 BOM 保证 Excel 中文不乱码）
// ─────────────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'source', 'seq', 'ts', 'ts_mode', 'event_reproducibility', 'session_id', 'agent_id', 'event_type', 'category',
  'rule_id', 'rule_name', 'scenario_or_session', 'detail', 'measured', 'threshold',
  'findings', 'chain_hash', 'chain_prev', 'spec_ref', 'tc260_measures', 'tc260_risks',
  'efficiency_grade', 'efficiency_basis', 'replay_kind', 'model',
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 单事件 → CSV 行。V1 与 V2 合并导出（source 列区分），列名全量统一。 */
function csvRow(e: PanelEvent, source: 'v1-deterministic' | 'v2-llm'): string[] {
  const isV1 = source === 'v1-deterministic';
  const run = (e.run ?? {}) as Record<string, unknown>;
  return [
    source, e.seq, e.ts, e.ts_mode,
    isV1 ? '可重跑（确定性场景）' : String(e.event_reproducibility ?? '不可确认'),
    e.session_id, e.agent_id, e.event_type, e.category,
    e.rule_id, e.rule_name,
    isV1 ? e.source_scenario : e.session_id,
    e.detail, e.measured, e.threshold,
    e.findings ?? null, e.chain_hash, e.chain_prev, e.spec_ref, e.tc260_measures,
    e.tc260_risks, e.efficiency_grade, e.efficiency_basis,
    e.replay ? (e.replay as Record<string, unknown>).kind : null,
    isV1 ? null : (run.model ?? null),
  ];
}

function buildCsv(): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const e of data.events) rows.push(csvRow(e, 'v1-deterministic').map(csvEscape).join(','));
  if (realagent) {
    for (const e of realagent.events) rows.push(csvRow(e, 'v2-llm').map(csvEscape).join(','));
  }
  // BOM：Excel 识别 UTF-8 的前提，缺失即乱码。
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 服务
// ─────────────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function sendJson(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body, null, 1), 'utf-8');
  res.writeHead(code, {
    'Content-Type': MIME['.json'],
    'Content-Length': buf.length,
    'X-Data-Framework-Version': `v${data.meta.framework.version}`,
    'X-Data-Ts-Mode': String(data.meta.ts_mode ?? 'synthetic-fixed'),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

function sendFile(res: import('node:http').ServerResponse, path: string): void {
  if (!existsSync(path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const buf = readFileSync(path);
  const ext = path.slice(path.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': buf.length });
  res.end(buf);
}

const evidenceCache = buildEvidence();
const csvCache = buildCsv();

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]!;

  switch (url) {
    case '/':
    case '/index.html':
      return sendFile(res, join(WEB_ROOT, 'index.html'));
    case '/app.js':
      return sendFile(res, join(WEB_ROOT, 'app.js'));
    case '/api/timeline':
      return sendJson(res, 200, { meta: data.meta, events: data.events });
    case '/api/realagent':
      if (!realagent) {
        return sendJson(res, 404, {
          error: 'real-agent 数据尚未生成。运行：node --experimental-transform-types tools/audit-panel/realagent/runner.mts（需 OVERSIGHT_LLM_API_KEY）',
        });
      }
      return sendJson(res, 200, { meta: realagent.meta, events: realagent.events });
    case '/api/verification':
      return sendJson(res, 200, { ...bootVerification, allVerified });
    case '/api/disposition':
      return sendJson(res, 200, dispositionView);
    case '/api/evidence':
      return sendJson(res, 200, { cards: evidenceCache, chain: data.meta.chain });
    case '/api/boundaries':
      return sendJson(res, 200, {
        boundaries: data.meta.boundaries,
        coverage: data.meta.coverage,
        scenarios: data.meta.scenarios,
      });
    case '/api/export': {
      const buf = Buffer.from(csvCache, 'utf-8');
      res.writeHead(200, {
        'Content-Type': MIME['.csv'],
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="audit-events-v${data.meta.framework.version}.csv"`,
      });
      return res.end(buf);
    }
    case '/report': {
      // 打印友好审计报告：浏览器打开后 Ctrl+P 存 PDF（零依赖 PDF 路径）。
      const html = Buffer.from(buildReportHtml(data, realagent, bootVerification), 'utf-8');
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length });
      return res.end(html);
    }
    default:
      return sendFile(res, normalize(join(WEB_ROOT, url)));
  }
});

let port = DEFAULT_PORT;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--port=')) port = Number(a.slice('--port='.length)) || DEFAULT_PORT;
}

server.listen(port, '127.0.0.1', () => {
  const v = bootVerification;
  console.log('');
  console.log('Agent 行为审计面板 · V1 + V2');
  console.log('─'.repeat(58));
  console.log(`  数据        V1 ${data.meta.event_count} 条（确定性）| V2 ${realagent ? realagent.meta.event_count + ' 条（LLM-in-the-loop）' : '未生成'}`);
  console.log(`  框架        v${data.meta.framework.version} | 门禁 ${data.meta.gates_count ?? '?'} 项`);
  console.log(`  当场验证    链 ${v.chain.ok ? 'PASS' : 'FAIL'} · 重放 ${v.replay.matched}/${v.replay.total} · V2 复核 ${v.realagentVerify.ok ? 'PASS' : 'FAIL'}（${verifiedAt}）`);
  const dv = dispositionView;
  const dispState = !dv.present
    ? '未创建'
    : dv.chainOk
      ? `链 PASS · 已闭合 ${dv.counts.closed} / 观察中 ${dv.counts.observing} / 未处置 ${dv.counts.unhandled}`
      : '链 FAIL（处置不采信）';
  console.log(`  处置台账    ${dispState}`);
  console.log(`  地址        http://127.0.0.1:${port}`);
  console.log(`  报告        http://127.0.0.1:${port}/report （浏览器 Ctrl+P 存 PDF）`);
  console.log('');
  console.log('  上述验证为本服务启动时快照；质疑时重跑服务或用 CLI 独立复核：');
  console.log('    node --experimental-transform-types tools/audit-panel/rules/verify-chain.mts');
  console.log('    node --experimental-transform-types tools/audit-panel/rules/replay.mts');
  console.log('    node --experimental-transform-types tools/audit-panel/rules/verify-realagent.mts');
  console.log('');
});
