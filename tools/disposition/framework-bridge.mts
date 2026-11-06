#!/usr/bin/env node
/**
 * framework-bridge.mts —— 阶段 2b-2（集成层）：把处置记录写进框架**同一条** AppendOnlyAuditLog
 *
 * 定位：spec/13 #44 的最后一段。阶段 1/2a/2b-1 的台账是**独立**的链——信号在框架链里、
 *       处置在台账链里，两链互不覆盖，因此「删掉处置记录」不会破坏信号链，反之亦然。
 *       本模块把 `disposition` 变成框架链的第四种事件类型（前三种：entry_deny / exit_reject /
 *       ledger_signal），使处置与被处置信号**同链**：任一处置行被删改，其后所有事件的哈希都对不上。
 *
 * ⚠️ #44 仍不闭合：本模块只做到「同链 + 可核 + 可迁移」，不提供阻断/扣分，也不解决
 *    身份验真（actor 仍自报）与外部信任域（E5）。定级理由见 spec/13 与 README §1。
 *
 * ── 两条链规约的收敛关系（本节是理解全部代码的前提） ──────────────────────────
 *
 *   框架链（reference/.../index.ts）：
 *     hash = sha256(JSON.stringify({ seq, type, data, ts, prev }))
 *     —— ts 由 append 内部产生，键序固定为 seq/type/data/ts/prev（JS 对象字面量顺序）。
 *
 *   台账链（tools/disposition/ledger.mts，阶段 1 冻结）：
 *     hash = sha256(prev + "|" + JSON.stringify(body))，body 为 13 键扁平对象。
 *
 *   两者不可互相验证。本模块的收敛方式是**单一真相源 + 投影**，不是双写：
 *     1. 新写入只写框架链（`appendDispositionToChain`）；
 *     2. 台账 JSONL 是框架链的**投影**（`projectLedger`），按台账规约重算哈希后落盘；
 *     3. 于是 `verify_chain.py`（第三方 Python 参照实现）继续可验投影产物，
 *        而 `verifyChain()` 验的是真相源。两者互为交叉核验。
 *
 *   **禁止双写**：若同时写框架链与台账文件，二者必然漂移（一次失败即永久不一致），
 *   而「哪个是真的」没有答案。这条纪律由门禁第 50 项的反向测试守护。
 *
 * ── 两个时间戳，不可混用 ────────────────────────────────────────────────────
 *   框架事件外层 `ts`：链上时间。本模块写入时**显式传入**（默认取处置自报 ts），
 *                     目的是让同一输入序列产出同一哈希（可复现）。
 *   处置载荷 `data.ts`：处置自报时间。报表一律用它，且必须标注「自报值，不可验证」。
 *
 *   两者都存在，是因为它们的可信度不同：链 ts 只证明「本模块用过这个值」，
 *   data.ts 只证明「处置者这么说」。任何时延统计都只能用 data.ts（见 obligations.mts 注释）。
 *
 * ── 可复现性前提 ───────────────────────────────────────────────────────────
 *   框架 `AppendOnlyAuditLog.append` 原本内部硬编码 `Date.now()`，导致同序列两次运行
 *   链哈希必不相同。为此本次给 append 增加**可选** `ts` 参数（默认 Date.now()，既有调用
 *   行为不变）。不传 ts 时链哈希不可复现——这是修复前的旧行为，保留只为向后兼容。
 *
 * 用法：
 *   node --experimental-transform-types tools/disposition/check-bridge.mts --selftest
 *   node --experimental-transform-types tools/disposition/check-bridge.mts --demo
 */

import {
  AppendOnlyAuditLog,
  sha256 as sha256Framework,
} from '../../reference/runtimes/l2-runtime-oversight/index.ts';

import {
  bodyOf,
  chainHashOf,
  hashPrefix,
  validateInput,
  type DispositionBody,
  type LedgerRow,
} from './ledger.mts';

// ─────────────────────────────────────────────────────────────────────────────
// 0. 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 框架侧事件类型（框架既有三种 + 本模块新增一种）。 */
export const SIGNAL_EVENT_TYPE = 'ledger_signal';
export const DISPOSITION_EVENT_TYPE = 'disposition';

/**
 * 处置载荷键序（冻结）：= 台账 FIELD_ORDER 去掉 record_type / event_type。
 * 前两个字段由框架事件外层 `type` 承载，重复存放会让「同一条记录两处可写」，
 * 从而允许两处不一致——这正是要消灭的形态。
 */
export const CHAIN_DATA_ORDER = [
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

export interface ChainDispositionData {
  disp_seq: number;
  target_seq: number;
  target_chain_hash: string;
  signal_category: string;
  action: string;
  actor: string;
  rationale: string;
  reviewed_by: string | null;
  supersedes: number | null;
  plan: string | null;
  ts: number;
}

/** 框架链事件（落盘/内存同形）。 */
export interface FrameworkEvent {
  seq: number;
  type: string;
  data: unknown;
  ts: number;
  hash: string;
}

/** 鸭子接口：与框架 append 同形（多一个可选 ts）。 */
export interface AuditSink {
  append(type: string, data: unknown, ts?: number): { seq: number; hash: string } | null;
}

export class ChainWriteError extends Error {}
export class ChainShapeError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ChainRecorder —— 包装框架链路，记录可投影的事件流
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把框架 AppendOnlyAuditLog 包一层，保留事件流的可读副本。
 *
 * 与 audit-panel/scenario/export-events.mts 的 RecordingAuditLog **同模式不同用途**：
 * 那个用于把场景投影给面板（只读展示），本类用于承载真实处置写入（写入口）。
 * 两者都**不重实现链**——哈希一律由框架 AppendOnlyAuditLog 计算，
 * 避免「两套规格并行必然漂移」（仓库既有纪律）。门禁第 50 项比对两者同序列产出同哈希。
 */
export class ChainRecorder implements AuditSink {
  private readonly inner = new AppendOnlyAuditLog();
  readonly recorded: FrameworkEvent[] = [];

  append(type: string, data: unknown, ts?: number): { seq: number; hash: string } | null {
    // 时间戳在本层定一次并向下传：若让 inner 自己取 Date.now()，recorded 里记的 ts
    // 与链内实际使用的 ts 可能差 1ms ⇒ verifyEventChain 会误报「哈希不匹配」。
    const effectiveTs = ts ?? Date.now();
    const r = this.inner.append(type, data, effectiveTs);
    // append 返回 null 表示写入失败（框架视为失租信号）——此时不记录，保持与链一致。
    if (r) {
      this.recorded.push({ seq: r.seq, type, data, ts: effectiveTs, hash: r.hash });
    }
    return r;
  }

  verifyChain(): boolean {
    return this.inner.verifyChain();
  }

  get lastSeq(): number {
    return this.inner.lastSeq;
  }
}

/**
 * 独立复算事件流哈希——**这是「可外置核验」的那一半**。
 *
 * 框架 `verifyChain()` 只能在持有进程内验；一旦链落盘成 JSONL，第三方手里只有数据，
 * 需要一个纯函数能重算。本函数按框架同一规约（五键 + JSON.stringify）复算，因此
 * 「链是否被改」不再依赖运行中的对象。
 *
 * ⚠️ 只证明「文件未事后被改」，不证明「写入者是谁」——信任域边界见 README §6。
 */
export function verifyEventChain(events: FrameworkEvent[]): {
  ok: boolean;
  badSeq: number | null;
  reason: string;
} {
  let prev = '';
  let expectSeq = 1;
  for (const e of events) {
    if (e.seq !== expectSeq) {
      return {
        ok: false,
        badSeq: e.seq,
        reason: `seq 不连续：期望 ${expectSeq}，实为 ${e.seq}（删除事件会留下跳号）`,
      };
    }
    const expect = sha256Framework(
      JSON.stringify({ seq: e.seq, type: e.type, data: e.data, ts: e.ts, prev }),
    );
    if (expect !== e.hash) {
      return { ok: false, badSeq: e.seq, reason: `哈希不匹配：seq=${e.seq} 的内容与 prev=${prev.slice(0, 16)}… 不符` };
    }
    prev = e.hash;
    expectSeq += 1;
  }
  return { ok: true, badSeq: null, reason: `全链 ${events.length} 条一致` };
}

/**
 * 链摘要（`{count, lastHash}`）——**尾部截断的唯一防线**。
 *
 * 哈希链能检出「中间被改」「中间被删」（后者留下跳号），但**检不出尾部被截掉**：
 * 删掉最后 N 条后剩余部分依然自洽。这不是实现缺陷，是链结构的固有边界。
 * 因此 append-only 链必须配一个「外部锚」：把 `{count, lastHash}` 记到链外
 * （另一进程、发布产物、或第三方保管），核验时比对摘要而不是只验链。
 *
 * 不做外锚时，任何「链完整」的结论都只对「未被截断」的假设成立——
 * 报告里必须把这句写出来，否则等于声称一条它没有的性质。
 */
export function chainDigest(events: FrameworkEvent[]): { count: number; lastHash: string } {
  return {
    count: events.length,
    lastHash: events.length > 0 ? events[events.length - 1]!.hash : '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 载荷构造与形状校验
// ─────────────────────────────────────────────────────────────────────────────/** 按冻结键序重建载荷——不依赖调用方对象插入顺序。 */
export function chainDataOf(
  record: Omit<DispositionBody, 'record_type' | 'event_type'>,
): ChainDispositionData {
  const out: Record<string, unknown> = {};
  for (const k of CHAIN_DATA_ORDER) out[k] = (record as unknown as Record<string, unknown>)[k];
  return out as unknown as ChainDispositionData;
}

/**
 * 载荷形状校验：键集合**与**键序都必须等于 CHAIN_DATA_ORDER。
 *
 * 为什么连键序也校验：框架链的哈希覆盖 `JSON.stringify(data)`，而 JS 保留插入顺序。
 * 同一份内容换个键序就是另一个哈希——投影时若不校验，会静默产出一条「内容对但哈希错」
 * 的台账行，而 verify_chain.py 会 FAIL 得莫名其妙。
 */
export function assertChainDataShape(data: unknown, ctx: string): ChainDispositionData {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ChainShapeError(`${ctx}：处置载荷必须是对象`);
  }
  const keys = Object.keys(data as Record<string, unknown>);
  if (keys.length !== CHAIN_DATA_ORDER.length) {
    throw new ChainShapeError(
      `${ctx}：载荷键数 ${keys.length}，应为 ${CHAIN_DATA_ORDER.length}（[${CHAIN_DATA_ORDER.join(',')}]）`,
    );
  }
  for (let i = 0; i < CHAIN_DATA_ORDER.length; i += 1) {
    if (keys[i] !== CHAIN_DATA_ORDER[i]) {
      throw new ChainShapeError(
        `${ctx}：载荷第 ${i + 1} 键为 "${keys[i]}"，应为 "${CHAIN_DATA_ORDER[i]}"（键序漂移即视为改写）`,
      );
    }
  }
  return data as ChainDispositionData;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 写入（唯一写入口）
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainAppendResult {
  data: ChainDispositionData;
  /** 框架链上的位置——**这是强引用目标**，后续处置用它做 target_seq。 */
  framework: { seq: number; hash: string };
  /** 该记录在台账视图中的等价行（哈希按台账规约重算，供即时展示）。 */
  projected: LedgerRow;
}

/**
 * 把一条处置写进框架链。
 *
 * 顺序不可颠倒：**先校验、后写链**。校验（含 10-D4 未登记类别 fail-closed）若在写链之后，
 * 一次非法写入就会永久留在链上——append-only 下无法删除，只能靠 supersedes 掩盖，
 * 而「掩盖」恰恰是治理文档最忌讳的动作。
 *
 * @param existing 台账视图中的既有处置行（用于 disp_seq 分配与 supersedes 校验）
 * @param opts.ts 链上时间。默认取处置自报 ts，保证同输入序列可复现同哈希。
 */
export function appendDispositionToChain(
  sink: AuditSink,
  input: Omit<DispositionBody, 'record_type' | 'event_type' | 'disp_seq'>,
  existing: LedgerRow[],
  opts: { ts?: number } = {},
): ChainAppendResult {
  const normalized = validateInput(input, existing);
  const dispSeq = existing.reduce((max, r) => Math.max(max, Number(r.disp_seq) || 0), 0) + 1;
  const data = chainDataOf({ ...normalized, disp_seq: dispSeq } as Omit<
    DispositionBody,
    'record_type' | 'event_type'
  >);

  const written = sink.append(DISPOSITION_EVENT_TYPE, data, opts.ts ?? normalized.ts);
  if (written === null) {
    throw new ChainWriteError(
      '框架链拒写（append 返回 null，框架视为失租信号）——处置未登记，调用方须显式失败',
    );
  }

  const body = bodyOf({ record_type: 'event', event_type: 'disposition', ...data } as DispositionBody);
  const projected: LedgerRow = { ...body, chain_hash: chainHashOf('', body), chain_prev: '' };

  return { data, framework: { seq: written.seq, hash: written.hash }, projected };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 投影：框架链 → 台账视图（不是双写，是派生）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从框架事件流投影出台账行（按台账链规约重算 chain_hash）。
 *
 * 投影**不改变**真相源：删掉投影文件不影响链；重跑投影应逐字节一致。
 * 这一性质由 selftest 的「投影幂等」用例守护。
 */
export function projectLedger(events: FrameworkEvent[]): LedgerRow[] {
  const disps = events
    .filter((e) => e.type === DISPOSITION_EVENT_TYPE)
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const rows: LedgerRow[] = [];
  let prev = '';
  let expectDispSeq = 1;
  for (const ev of disps) {
    const data = assertChainDataShape(ev.data, `框架事件 seq=${ev.seq}`);
    if (data.disp_seq !== expectDispSeq) {
      throw new ChainShapeError(
        `框架事件 seq=${ev.seq} 的 disp_seq=${data.disp_seq}，按写入顺序应为 ${expectDispSeq}`
          + '（投影要求 disp_seq 连续——跳号意味着有处置记录被删）',
      );
    }
    const body = bodyOf({
      record_type: 'event',
      event_type: 'disposition',
      ...data,
    } as DispositionBody);
    const row: LedgerRow = { ...body, chain_hash: chainHashOf(prev, body), chain_prev: prev };
    rows.push(row);
    prev = row.chain_hash;
    expectDispSeq += 1;
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 迁移：阶段 1 台账 → 框架链（匹配失败绝不丢弃）
// ─────────────────────────────────────────────────────────────────────────────

export type MigrationReason =
  | 'hash_prefix_match'
  | 'no_signal_of_category'
  | 'hash_prefix_mismatch'
  | 'ambiguous';

export interface MigrationEntry {
  disp_seq: number;
  stage1: {
    target_seq: number;
    target_chain_hash: string;
    signal_category: string;
  };
  matched: boolean;
  /** 匹配到的框架事件位置；未匹配为 null。 */
  framework: { seq: number; hash: string } | null;
  reason: MigrationReason;
  /** 同类别候选事件数——用来区分「源里根本没有」与「有但对不上」。 */
  candidates: number;
  /** 未匹配时保留原始引用，供人工回查；匹配成功也保留，供对照。 */
  original_ref: string;
}

export interface MigrationMap {
  generated_by: string;
  rule: string;
  total: number;
  matched: number;
  unmapped: number;
  entries: MigrationEntry[];
}

/**
 * 迁移匹配规则（**已修正** README §7 的原始三元组，见 ERRATA-L2-SPEC D-S2）：
 *
 *   原规则用 `(target_seq, signal_category, sha256(detail) 前 16 hex)` 三元组，
 *   但第三元从未落盘——台账 13 键里没有 detail，也没有其哈希。
 *   若不改键序（已冻结，改了旧链全失效），这个元在物理上不可得。
 *
 *   实际可执行的规则是**二元组 + 前缀证明**：
 *     候选 = 框架事件中 type=ledger_signal 且 data.kind === signal_category
 *     匹配 = 该事件 hash 的前 16 位 === target_chain_hash
 *   `target_seq` 只作记录（跨链 seq 空间不同，不能当匹配依据）。
 *
 * 匹配失败分四种，全部保留原行并注明原因——「无法迁移」不等于「可以丢弃」。
 */
export function migrateLedger(rows: LedgerRow[], events: FrameworkEvent[]): MigrationMap {
  const signals = events.filter((e) => e.type === SIGNAL_EVENT_TYPE);
  const entries: MigrationEntry[] = rows.map((row) => {
    const sameCategory = signals.filter((e) => {
      const d = e.data as Record<string, unknown> | null;
      return d !== null && typeof d === 'object' && d.kind === row.signal_category;
    });
    const hits = sameCategory.filter((e) => hashPrefix(e.hash) === row.target_chain_hash);

    const base = {
      disp_seq: row.disp_seq,
      stage1: {
        target_seq: row.target_seq,
        target_chain_hash: row.target_chain_hash,
        signal_category: row.signal_category,
      },
      candidates: sameCategory.length,
      original_ref: `stage1:target_seq=${row.target_seq}#${row.target_chain_hash}`,
    };

    if (hits.length === 1) {
      const ev = hits[0]!;
      return {
        ...base,
        matched: true,
        framework: { seq: ev.seq, hash: ev.hash },
        reason: 'hash_prefix_match' as const,
      };
    }
    if (hits.length > 1) {
      return { ...base, matched: false, framework: null, reason: 'ambiguous' as const };
    }
    return {
      ...base,
      matched: false,
      framework: null,
      reason: (sameCategory.length === 0
        ? 'no_signal_of_category'
        : 'hash_prefix_mismatch') as MigrationReason,
    };
  });

  const matched = entries.filter((e) => e.matched).length;
  return {
    generated_by: 'tools/disposition/framework-bridge.mts',
    rule: 'type=ledger_signal ∧ data.kind===signal_category ∧ hash[0:16]===target_chain_hash（二元组，D-S2 修正）',
    total: entries.length,
    matched,
    unmapped: entries.length - matched,
    entries,
  };
}

/** 迁移映射的落盘形态（JSON 文本，键序固定便于 diff）。 */
export function renderMigrationMap(map: MigrationMap): string {
  return JSON.stringify(map, null, 2) + '\n';
}
