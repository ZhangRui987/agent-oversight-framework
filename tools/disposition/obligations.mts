#!/usr/bin/env node
/**
 * obligations.mts —— 处置义务注册表与 SLA 判定（spec/10 §10-D4 / §10-D5 的实现对应物）
 *
 * 定位：把 10-D4 的「每类信号必须声明谁处置、多长时限」从条款变成**可加载、可校验、
 *       可 fail-closed** 的数据，并把 10-D5 的两个二阶信号（undisposed_rate /
 *       overdue_rate）算出来。
 *
 * 三条刻意约束（都是为了不制造「看起来对」的假指标）：
 *
 *   1. **now 必须显式传入。** 不取 Date.now() 默认值——否则同一份数据在不同时刻
 *      得到不同 overdue 数，输出不可复现，也无法在门禁里做确定性断言。
 *
 *   2. **信号全集必须显式传入。** 不提供「从台账推断分母」的便捷函数：台账只知道
 *      「被处置过的 target_seq」，用它当分母会把 rate 算成 0 或 >1。10-D5 的分母是
 *      **信号总数**，只有持有信号全集的一方知道。
 *
 *   3. **本模块不 import ledger.mts。** 三态由调用方传入（结构化类型），避免
 *      ledger ↔ obligations 循环依赖；也避免把「三态怎么算」在这里写第二遍。
 *
 * 优先级与时限的对应关系写死在 PRIORITY_SLA_HOURS，加载时校验——手改 JSON 把
 * P0 写成 168h 会直接抛错，而不是悄悄放宽最高级别的时限。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OBLIGATIONS_FILE = resolve(HERE, 'obligations.json');

export type Priority = 'P0' | 'P1' | 'P2';

/** 级别 → 时限（小时）的唯一权威对应。改这里等于改条款，须同步 spec/10 与版本递增。 */
export const PRIORITY_SLA_HOURS: Readonly<Record<Priority, number>> = Object.freeze({
  P0: 24,
  P1: 72,
  P2: 168,
});

export interface Obligation {
  priority: Priority;
  sla_hours: number;
  owner_role: string;
  reversibility: string;
  rationale: string;
}

export interface ObligationsDoc {
  schema_version: number;
  introduced_in: string;
  clause: string;
  calibration_status: string;
  calibration_owner: string;
  calibration_note: string;
  fail_closed: string;
  categories: Record<string, Obligation>;
}

export class ObligationError extends Error {}

/**
 * 加载并校验义务注册表。
 * 校验项：schema_version / 非空 categories / priority 合法 / sla_hours 与 priority 一致 /
 *        owner_role 与 rationale 非空。任一不满足即抛错（配置错误不该被静默容忍）。
 */
export function loadObligations(file: string = DEFAULT_OBLIGATIONS_FILE): ObligationsDoc {
  const raw = readFileSync(file, 'utf-8');
  const doc = JSON.parse(raw) as ObligationsDoc;

  const fail = (msg: string): never => {
    throw new ObligationError(`义务注册表 ${file}：${msg}`);
  };

  if (doc.schema_version !== 1) fail(`schema_version 必须为 1（实为 ${String(doc.schema_version)}）`);
  if (!doc.categories || typeof doc.categories !== 'object') fail('缺少 categories 对象');

  const names = Object.keys(doc.categories);
  if (names.length === 0) fail('categories 为空——空注册表会让所有写入被 fail-closed，等同于关闭通道');

  for (const name of names) {
    const o = doc.categories[name];
    if (!o || typeof o !== 'object') fail(`类别 ${name} 的条目不是对象`);
    if (!(o.priority in PRIORITY_SLA_HOURS)) {
      fail(`类别 ${name} 的 priority "${String(o.priority)}" 不在 P0/P1/P2 内`);
    }
    const expected = PRIORITY_SLA_HOURS[o.priority];
    if (o.sla_hours !== expected) {
      fail(
        `类别 ${name} 的 sla_hours=${String(o.sla_hours)} 与 priority=${o.priority} 的权威值 ${expected}h 不一致` +
          '——级别与时限的对应关系不得逐类改写（要改须同时改 spec/10 §10-D4 与版本递增）',
      );
    }
    if (typeof o.owner_role !== 'string' || o.owner_role.trim() === '') {
      fail(`类别 ${name} 缺少 owner_role——10-D4 要求声明「谁处置」`);
    }
    if (typeof o.rationale !== 'string' || o.rationale.trim() === '') {
      fail(`类别 ${name} 缺少 rationale——分级依据必须可复核`);
    }
  }

  return doc;
}

/** 取某类别的义务；未登记返回 null（由调用方决定抛错还是报告）。 */
export function obligationOf(doc: ObligationsDoc, category: string): Obligation | null {
  return Object.prototype.hasOwnProperty.call(doc.categories, category)
    ? doc.categories[category]!
    : null;
}

/**
 * 10-D4 fail-closed 判定：未声明义务的类别不得进入采集 / 不得写入台账。
 * 供 ledger.validateInput 调用——这是「没有处置通道的信号只是噪声」在写入口的落点。
 */
export function assertDeclared(doc: ObligationsDoc, category: string): Obligation {
  const o = obligationOf(doc, category);
  if (!o) {
    const known = Object.keys(doc.categories).sort().join(' / ');
    throw new ObligationError(
      `signal_category "${category}" 未在义务注册表登记（10-D4：未声明义务的信号类别不得进入生产采集）。` +
        `已登记：${known}。新增类别须同时改 obligations.json、spec/10 §10-D4 表格与 LedgerSignalKind。`,
    );
  }
  return o;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10-D5 完整性聚合
// ─────────────────────────────────────────────────────────────────────────────

export type SignalState = 'unhandled' | 'observing' | 'closed';

/** 调用方必须提供的信号全集条目——seq / 类别 / 信号自身 ts / 三态。 */
export interface SignalInput {
  seq: number;
  category: string;
  signal_ts: number;
  state: SignalState;
}

export interface SignalSlaRow extends SignalInput {
  priority: Priority;
  sla_hours: number;
  owner_role: string;
  /** 自报 elapsed（小时，可为负：时钟倒挂）。 */
  elapsed_hours: number;
  /** 仅当 state=unhandled 且 elapsed_hours > sla_hours 时为真。 */
  overdue: boolean;
  /** 时钟倒挂标记——不计入 overdue，但必须显式计数，不得静默丢弃。 */
  clock_skew: boolean;
}

export interface Completeness {
  /** 可判定（类别已登记）的信号数——两个 rate 的分母。 */
  n_signals_declared: number;
  /** 类别未登记、无法判 SLA 的信号数。>0 时 rate 标 provisional。 */
  n_signals_undeclared: number;
  n_undisposed: number;
  n_overdue: number;
  /** n_undisposed / n_signals_declared；分母为 0 时为 null（不是 0）。 */
  undisposed_rate: number | null;
  /** n_overdue / n_signals_declared；分母为 0 时为 null。 */
  overdue_rate: number | null;
  /** 存在未登记类别时置真——提醒读者 rate 未覆盖全部信号。 */
  provisional: boolean;
  /** 时钟倒挂条数（elapsed < 0），自报 ts 不可信的直接证据。 */
  clock_skew: number;
  basis: string;
  note: string;
}

/**
 * 给每条信号标注 SLA 与 overdue。now 必传（毫秒），不得省略。
 * 未登记类别的信号不参与 SLA 判定，但**不会被丢弃**——原样进入 undeclared。
 */
export function annotateSla(
  signals: readonly SignalInput[],
  doc: ObligationsDoc,
  now: number,
): { rows: SignalSlaRow[]; undeclared: SignalInput[] } {
  if (!Number.isFinite(now) || now <= 0) {
    throw new ObligationError('now 必须是正整数毫秒时间戳（显式传入，不取 Date.now() 默认值）');
  }

  const rows: SignalSlaRow[] = [];
  const undeclared: SignalInput[] = [];

  for (const s of signals) {
    const o = obligationOf(doc, s.category);
    if (!o) {
      undeclared.push(s);
      continue;
    }
    const elapsedHours = (now - s.signal_ts) / 3_600_000;
    const clockSkew = elapsedHours < 0;
    rows.push({
      ...s,
      priority: o.priority,
      sla_hours: o.sla_hours,
      owner_role: o.owner_role,
      elapsed_hours: elapsedHours,
      overdue: s.state === 'unhandled' && !clockSkew && elapsedHours > o.sla_hours,
      clock_skew: clockSkew,
    });
  }

  return { rows, undeclared };
}

/**
 * 10-D5 两个二阶信号。
 * 参数是 annotateSla 的产物 + undeclared 计数——不接受「台账行」，
 * 因为台账行既不含信号 ts 也不含未处置信号。
 */
export function computeCompleteness(
  rows: readonly SignalSlaRow[],
  undeclaredCount: number,
): Completeness {
  const nDeclared = rows.length;
  const nUndeclared = undeclaredCount;
  const nUndisposed = rows.filter((r) => r.state === 'unhandled').length;
  const nOverdue = rows.filter((r) => r.overdue).length;
  const skew = rows.filter((r) => r.clock_skew).length;

  const rate = (k: number): number | null => (nDeclared === 0 ? null : k / nDeclared);

  return {
    n_signals_declared: nDeclared,
    n_signals_undeclared: nUndeclared,
    n_undisposed: nUndisposed,
    n_overdue: nOverdue,
    undisposed_rate: rate(nUndisposed),
    overdue_rate: rate(nOverdue),
    provisional: nUndeclared > 0,
    clock_skew: skew,
    basis:
      `分母 = 直接传入的信号全集中「类别已登记」的条数（${nDeclared}）；` +
      `未登记类别 ${nUndeclared} 条未计入分母、单列。` +
      '台账自身不得充任分母——它只含被处置过的信号，用它算会把 rate 压向 0。',
    note:
      '二阶信号度量的是监察行为，不是被监察行为。undisposed_rate 归零不等于风险消除（10-D5 限制 1）；' +
      'overdue_rate 依赖自报 ts 与仅证写入顺序的 disp_seq，标「自报值，不可验证」（限制 2）；' +
      '两者均不替代原始信号（限制 3）。',
  };
}

/**
 * 四段时效中可分离的那一段。
 * 台账只有「信号 ts」与「处置 ts」两个时间点，因此只能算出
 * 「信号 → 首条生效处置」的跨度；MTTD / 确认 → 动作 / 动作 → 关闭三段不可分离。
 * 这个函数返回的**不是** MTTR——命名成 measureSignalToDisposition 就是为了防止混报。
 */
export function measureSignalToDisposition(
  rows: readonly SignalSlaRow[],
  firstDispositionTs: ReadonlyMap<number, number>,
): { p50: number | null; p90: number | null; n: number; negative: number; note: string } {
  const spans: number[] = [];
  let negative = 0;
  for (const r of rows) {
    const ts = firstDispositionTs.get(r.seq);
    if (typeof ts !== 'number') continue;
    const delta = ts - r.signal_ts;
    if (delta < 0) {
      negative += 1;
      continue;
    }
    spans.push(delta);
  }
  spans.sort((a, b) => a - b);
  const pick = (p: number): number | null =>
    spans.length === 0 ? null : spans[Math.min(Math.max(Math.ceil((p / 100) * spans.length) - 1, 0), spans.length - 1)]!;
  return {
    p50: pick(50),
    p90: pick(90),
    n: spans.length,
    negative,
    note:
      '本值 = 信号 ts → 首条生效处置 ts，**不是 MTTR**。' +
      'MTTD / 人工确认 / 处置动作 / 关闭四段无法从台账分离（10-D5 限制 2：禁止合成单一平均值）。' +
      'ts 为自报 wall-clock，跨机时钟差未校正。',
  };
}
