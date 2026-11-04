#!/usr/bin/env node
/**
 * ledger.mts —— 处置台账（阶段 1：工具侧最小形态）
 *
 * 定位：spec/13 #44 登记的「检测—处置断链」在**工具侧**的最小补口。
 *       本模块只登记处置（谁、对哪条信号、做了什么、依据是什么），
 *       **不做任何阻断 / 扣分 / 拦截**——框架侧仍无处置通道，#44 未闭合。
 *
 * 设计依据：处置通道最小形态_设计稿_v2.md §4.1（payload）/ §4.3（链规格）。
 *
 * 三条硬约束（红线，见设计稿 §三）：
 *   1. 只登记不阻断：动作枚举不含 auto_block / auto_deduct；
 *   2. append-only：不删不改，纠错以新增 supersedes 记录表达；
 *   3. 时序不可信：ts 为自报 wall-clock，disp_seq 只证明写入顺序。
 *
 * 链规则（与面板落盘链同构）：chain_hash = sha256(prev + "|" + serialize(body))
 *   - body = 本行去掉 chain_hash / chain_prev 后的对象，键序为 FIELD_ORDER（冻结）；
 *   - 序列化：JS 用 JSON.stringify（无空格、非 ASCII 原样）；
 *     Python 参照实现须用 json.dumps(..., ensure_ascii=False, separators=(',', ':'))。
 *   - 冻结的原因：默认参数下 Python 会输出 ", " 与 \uXXXX 转义，跨语言复算必然失败。
 *
 * 用法：
 *   node --experimental-transform-types tools/disposition/ledger.mts append \
 *     --target-seq=7 --target-chain-hash=9b91e16ac287dfcd \
 *     --signal-category=budget-exceeded --action=escalate \
 *     --actor=operator-alice --reviewed-by=operator-bob \
 *     --rationale="预算比 1.56 超出该任务标定区间，升级人工核查"
 *   node --experimental-transform-types tools/disposition/ledger.mts list
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LEDGER_FILE = resolve(HERE, 'data/disposition.jsonl');

/** 冻结键序——改动即破坏已落盘链，必须另起版本并写迁移器。 */
export const FIELD_ORDER = [
  'record_type',
  'event_type',
  'disp_seq',
  'target_seq',
  'target_chain_hash',
  'signal_category',
  'action',
  'actor',
  'rationale',
  'reviewed_by',
  'supersedes',
  'plan',
  'ts',
] as const;

/** 动作枚举（冻结四项）。刻意不含阻断与扣分类动作（红线 1）。 */
export const ACTIONS = [
  'confirm_false_positive',
  'escalate',
  'route_to_human',
  'park_for_observation',
] as const;

export type DispositionAction = (typeof ACTIONS)[number];

/** 需要人工复核人的动作：关闭信号（confirm）与改变处置等级（escalate）。 */
const REVIEW_REQUIRED: ReadonlySet<DispositionAction> = new Set<DispositionAction>([
  'confirm_false_positive',
  'escalate',
]);

export interface DispositionBody {
  record_type: 'event';
  event_type: 'disposition';
  disp_seq: number;
  target_seq: number;
  target_chain_hash: string;
  signal_category: string;
  action: DispositionAction;
  actor: string;
  rationale: string;
  reviewed_by: string | null;
  supersedes: number | null;
  plan: string | null;
  ts: number;
}

export interface LedgerRow extends DispositionBody {
  chain_hash: string;
  chain_prev: string;
}

export type DispositionState = 'unhandled' | 'observing' | 'closed';

export interface TargetState {
  state: DispositionState;
  /** 生效的处置记录 disp_seq（无记录为 null）。 */
  disp_seq: number | null;
  action: DispositionAction | null;
  /** 状态判定依据（面板原样展示，避免把「有记录」读成「已处置」）。 */
  note: string;
}

export class LedgerValidationError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// 链计算（与 audit-panel/realagent/runner.mts 同一规则）
// ─────────────────────────────────────────────────────────────────────────────

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 按冻结键序重建 body——不依赖调用方对象的插入顺序。 */
export function bodyOf(row: DispositionBody | LedgerRow): DispositionBody {
  const body = {} as Record<string, unknown>;
  for (const k of FIELD_ORDER) body[k] = (row as Record<string, unknown>)[k];
  return body as unknown as DispositionBody;
}

export function chainHashOf(prevHash: string, body: DispositionBody): string {
  return sha256(prevHash + '|' + JSON.stringify(body));
}

/** 信号链哈希的前 16 hex——台账只存前缀，完整值留在事件文件里。 */
export function hashPrefix(chainHash: string): string {
  return String(chainHash).slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// 读写
// ─────────────────────────────────────────────────────────────────────────────

export function readLedger(file: string = DEFAULT_LEDGER_FILE): LedgerRow[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as LedgerRow;
      } catch (err) {
        throw new LedgerValidationError(
          `第 ${i + 1} 行不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 字段校验（append 前强制执行；verify 时以同一套规则复核落盘内容）
// ─────────────────────────────────────────────────────────────────────────────

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 校验一条待写入处置（不含 disp_seq / ts 的分配）。
 * 返回规范化后的 body（null 显式化，避免 undefined 进入 JSON）。
 */
export function validateInput(
  input: Omit<DispositionBody, 'record_type' | 'event_type' | 'disp_seq'>,
  existing: LedgerRow[],
): Omit<DispositionBody, 'record_type' | 'event_type' | 'disp_seq'> {
  const fail = (msg: string): never => {
    throw new LedgerValidationError(msg);
  };

  if (!ACTIONS.includes(input.action)) {
    fail(`action "${String(input.action)}" 不在冻结枚举 [${ACTIONS.join(' / ')}] 内`);
  }
  if (!isPositiveInt(input.target_seq)) fail('target_seq 必须是正整数（被处置信号的 seq）');
  if (!/^[0-9a-f]{16}$/.test(String(input.target_chain_hash))) {
    fail('target_chain_hash 必须是 16 位小写 hex（信号 chain_hash 的前 16 位）');
  }
  if (!nonEmpty(input.signal_category)) fail('signal_category 不能为空');
  if (!nonEmpty(input.actor)) fail('actor 不能为空（阶段 1 为自报标识，不验真）');
  if (!nonEmpty(input.rationale)) fail('rationale 不能为空——无依据的处置等于没处置');
  if (!isPositiveInt(input.ts)) fail('ts 必须是正整数毫秒时间戳（wall-clock 自报值）');

  const reviewedBy = input.reviewed_by ?? null;
  if (REVIEW_REQUIRED.has(input.action)) {
    if (!nonEmpty(reviewedBy)) {
      fail(`action "${input.action}" 必须填写 reviewed_by（人工复核人）`);
    }
    if (reviewedBy === input.actor) {
      fail('reviewed_by 不得等于 actor——自审自批不构成复核');
    }
  }

  const plan = input.plan ?? null;
  if (input.action === 'park_for_observation') {
    if (!nonEmpty(plan)) fail('action "park_for_observation" 必须填写 plan（观察方案，#15 预案占位）');
  } else if (plan !== null) {
    fail(`plan 仅用于 park_for_observation，action "${input.action}" 下必须为 null`);
  }

  const supersedes = input.supersedes ?? null;
  if (supersedes !== null) {
    if (!isPositiveInt(supersedes)) fail('supersedes 必须为 null 或正整数 disp_seq');
    const target = existing.find((r) => r.disp_seq === supersedes);
    if (!target) fail(`supersedes 指向的 disp_seq=${supersedes} 不存在`);
    if (target.target_seq !== input.target_seq) {
      fail(`supersedes 指向的处置针对 seq=${target.target_seq}，与本次 target_seq=${input.target_seq} 不一致`);
    }
    if (existing.some((r) => r.supersedes === supersedes)) {
      fail(`disp_seq=${supersedes} 已被 ${existing.filter((r) => r.supersedes === supersedes).map((r) => r.disp_seq).join(',')} 更正过，不得分叉更正`);
    }
  }

  return {
    target_seq: input.target_seq,
    target_chain_hash: String(input.target_chain_hash),
    signal_category: input.signal_category,
    action: input.action,
    actor: input.actor.trim(),
    rationale: input.rationale.trim(),
    reviewed_by: nonEmpty(reviewedBy) ? reviewedBy.trim() : null,
    supersedes,
    plan: nonEmpty(plan) ? plan.trim() : null,
    ts: input.ts,
  };
}

export interface AppendResult {
  row: LedgerRow;
  file: string;
}

/** 追加一条处置。append-only：本函数不提供 update / delete。 */
export function appendDisposition(
  input: Omit<DispositionBody, 'record_type' | 'event_type' | 'disp_seq'>,
  file: string = DEFAULT_LEDGER_FILE,
): AppendResult {
  const existing = readLedger(file);
  const normalized = validateInput(input, existing);
  const prev = existing.length > 0 ? String(existing[existing.length - 1]!.chain_hash) : '';
  const dispSeq = existing.reduce((max, r) => Math.max(max, Number(r.disp_seq) || 0), 0) + 1;

  const body = bodyOf({
    record_type: 'event',
    event_type: 'disposition',
    disp_seq: dispSeq,
    ...normalized,
  } as DispositionBody);

  const row: LedgerRow = { ...body, chain_hash: chainHashOf(prev, body), chain_prev: prev };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + '\n', 'utf-8');
  return { row, file };
}

// ─────────────────────────────────────────────────────────────────────────────
// 三态派生（供 replay / 面板复用）
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerIndex {
  /** 最新且未被 superseded 的处置，按 target_seq 索引。 */
  current: Map<number, LedgerRow>;
  /** 被任何行 supersedes 过的 disp_seq。 */
  superseded: Set<number>;
  /** 全部行数（含被更正行）。 */
  total: number;
}

export function indexLedger(rows: LedgerRow[]): LedgerIndex {
  const superseded = new Set<number>();
  for (const r of rows) {
    if (typeof r.supersedes === 'number') superseded.add(r.supersedes);
  }
  const current = new Map<number, LedgerRow>();
  for (const r of rows) {
    if (superseded.has(r.disp_seq)) continue;
    const prev = current.get(r.target_seq);
    if (!prev || r.disp_seq > prev.disp_seq) current.set(r.target_seq, r);
  }
  return { current, superseded, total: rows.length };
}

/**
 * 单条信号的三态。
 * 关键语义：route_to_human 归入「未处置」——转交不等于处置完成，
 * 否则「已转人工」会被读成「已闭合」（红线 7：处置 ≠ 有效）。
 */
export function stateOf(targetSeq: number, index: LedgerIndex): TargetState {
  const row = index.current.get(targetSeq);
  if (!row) return { state: 'unhandled', disp_seq: null, action: null, note: '无处置记录' };
  if (row.action === 'route_to_human') {
    return { state: 'unhandled', disp_seq: row.disp_seq, action: row.action, note: '已转人工，未闭合' };
  }
  if (row.action === 'park_for_observation') {
    return { state: 'observing', disp_seq: row.disp_seq, action: row.action, note: '观察中（预案见 plan）' };
  }
  if (!nonEmpty(row.reviewed_by)) {
    return { state: 'unhandled', disp_seq: row.disp_seq, action: row.action, note: '复核人缺失，不构成闭合' };
  }
  return { state: 'closed', disp_seq: row.disp_seq, action: row.action, note: '已闭合' };
}

/** 最近秩分位数（n=0 返回 null；避免插值引入无法复核的小数）。 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = 'true';
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const file = args.file ? resolve(args.file) : DEFAULT_LEDGER_FILE;

  if (cmd === 'list' || cmd === undefined) {
    const rows = readLedger(file);
    const idx = indexLedger(rows);
    console.log('');
    console.log('处置台账 · ' + file);
    console.log('─'.repeat(62));
    if (rows.length === 0) {
      console.log('  （空台账——尚无任何处置记录）');
    } else {
      console.log(`  记录 ${rows.length} 条（当前生效 ${idx.current.size} 条 · 已被更正 ${idx.superseded.size} 条）`);
      for (const r of rows) {
        const mark = idx.superseded.has(r.disp_seq) ? '（已更正）' : '';
        const review = r.reviewed_by ? `复核=${r.reviewed_by}` : '复核=—';
        console.log(
          `  [${String(r.disp_seq).padStart(2)}] seq ${String(r.target_seq).padStart(2)} ${r.action.padEnd(20)} ${r.actor} ${review}${mark}`,
        );
        console.log(`        ${r.rationale}`);
      }
    }
    console.log('');
    return;
  }

  if (cmd === 'append') {
    const ts = args.ts ? Number(args.ts) : Date.now();
    const { row } = appendDisposition(
      {
        target_seq: Number(args['target-seq']),
        target_chain_hash: args['target-chain-hash'] ?? '',
        signal_category: args['signal-category'] ?? '',
        action: (args.action ?? '') as DispositionAction,
        actor: args.actor ?? '',
        rationale: args.rationale ?? '',
        reviewed_by: args['reviewed-by'] ?? null,
        supersedes: args.supersedes ? Number(args.supersedes) : null,
        plan: args.plan ?? null,
        ts,
      },
      file,
    );
    console.log('');
    console.log(`已登记处置 disp_seq=${row.disp_seq} → seq ${row.target_seq} · ${row.action}`);
    console.log(`  actor=${row.actor} reviewed_by=${row.reviewed_by ?? '—'} · ts=${fmtDate(row.ts)}（自报值）`);
    console.log(`  chain_hash=${row.chain_hash}`);
    console.log(`  台账：${file}`);
    console.log('');
    return;
  }

  console.error(`未知子命令 "${String(cmd)}"。可用：append / list`);
  process.exitCode = 1;
}

// 仅在作为脚本执行时跑 CLI——被 replay / server 导入时不得有副作用。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
