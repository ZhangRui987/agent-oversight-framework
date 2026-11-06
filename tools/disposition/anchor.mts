#!/usr/bin/env node
/**
 * anchor.mts —— 外锚：哈希链**尾部截断**的唯一防线
 *
 * ── 它解决的是什么，不解决什么（先看这一节） ────────────────────────────────
 *
 *   哈希链能检出「中间被改」（哈希断）与「中间被删」（跳号），但**检不出尾部被截**：
 *   删掉最后 N 条后，剩余部分依然逐条自洽，`verifyChain()` 与 `verify_chain.py`
 *   都会 PASS。这不是实现缺陷，是链结构的固有边界（spec/10 10-D11）。
 *
 *   外锚的做法是：把「某时刻这条链有 count 条、末条哈希为 lastHash」记到**链外**。
 *   核验时先验链、再比锚——链可以自洽而不足数，但无法同时满足「自洽 + 与锚一致」。
 *
 *   ⚠️ 三条不得省略的边界：
 *     1. **锚与链在同一可写域时，不构成防篡改**。能改写链的一方通常也能改写锚文件；
 *        此时外锚提供的是「不一致可检出」与「回滚可检出」，不是「不可篡改」。
 *        真正的信任根是锚摘要的**域外发布**（Release 说明、第三方保管、纸质存档），
 *        那一步是运行程序，不是代码能自证的东西。
 *     2. **锚自身成链，但锚尾同样不可自证**。锚日志用 prev_anchor_hash 串起来，
 *        中间被改/被删可检出；删掉最新那条锚则看不出来。递归到末端只能靠域外发布
 *        切断——本项目把最新锚摘要写进 Release 说明，即为此。
 *     3. **锚只说「链当时长这样」，不说「谁写的」**。身份验真（E1/E5）不在主张范围。
 *
 * ── 判定五分（为什么不是「一致/不一致」两分） ───────────────────────────────
 *
 *   match        count 相等且末哈希相等 —— 锚有效，链未动
 *   grew         count 更多，且锚位置的哈希仍是 anchor.last_hash —— **正常增长**
 *                （两次锚之间的新增事件）。不是告警：把它当异常会产生大量误报，
 *                误报多了人就会关掉告警，这比没有告警更差。
 *   truncated    count 更少 —— 尾部被截（本模块存在的理由）
 *   forked       count 相同但末哈希不同，或 count 更多但锚位置哈希已变
 *                —— 历史被重写（含「截断后补等量伪造事件」这一最需要检出的形态）
 *   undecidable  只给了 {count, lastHash} 而没给「按位置取哈希」的能力，且 count 增长
 *                —— 无法确认前缀是否被改写，**如实说不知道**，不猜
 *
 * ── 与既有模块的关系 ────────────────────────────────────────────────────────
 *   本模块**不实现任何链**、不计算任何业务数据，只对 `{count, last_hash}` 做比较。
 *   链规则各自留在原地（框架链 / 台账链 / 面板链），避免「两套规格并行必然漂移」。
 *   锚哈希用 sha256(prev + "|" + JSON.stringify(body))，与台账/面板落盘链同一写法，
 *   使 Python 参照实现不需要第二套解析器。
 */

import { sha256 } from './ledger.mts';

// ─────────────────────────────────────────────────────────────────────────────
// 0. 冻结结构
// ─────────────────────────────────────────────────────────────────────────────

export const ANCHOR_VERSION = 1;

/** 被哈希覆盖的字段（键序冻结——哈希输入是 JSON.stringify，换序即换哈希）。 */
export const ANCHOR_BODY_ORDER = [
  'anchor_seq',
  'anchor_version',
  'chain_id',
  'count',
  'last_hash',
  'anchor_ts',
  'prev_anchor_hash',
] as const;

/** 落盘行的完整键序 = body 七键 + anchor_hash。 */
export const ANCHOR_FIELD_ORDER = [...ANCHOR_BODY_ORDER, 'anchor_hash'] as const;

export interface AnchorRow {
  anchor_seq: number;
  anchor_version: number;
  chain_id: string;
  count: number;
  last_hash: string;
  anchor_ts: number;
  prev_anchor_hash: string;
  anchor_hash: string;
}

/** 链视图：核验方手里关于「当前链」的最小信息。 */
export interface ChainView {
  count: number;
  last_hash: string;
  /**
   * 1-based 位置 → 该位置事件的哈希；越界返回 null。
   * 不提供时，`count` 增长的情况下无法判断前缀是否被改写（会返回 undecidable）。
   */
  hashAt?: (seq: number) => string | null;
}

export class AnchorFormatError extends Error {
  readonly line: number;

  constructor(message: string, line = 0) {
    super(message);
    this.name = 'AnchorFormatError';
    this.line = line;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * chain_id 的形状限制：`:` 是外部摘要串的分隔符，出现在 id 里会让摘要不可解析。
 * 只允许小写字母/数字与 `._/-`，且不以分隔符开头。
 */
function assertChainId(id: unknown, ctx: string, line = 0): void {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._/-]*$/.test(id)) {
    throw new AnchorFormatError(
      `${ctx}：chain_id 非法（${JSON.stringify(id)}）——应匹配 [a-z0-9][a-z0-9._/-]*（不含 ":"，那是摘要串分隔符）`,
      line,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 构造与哈希
// ─────────────────────────────────────────────────────────────────────────────

/** 按冻结键序取 body——不依赖调用方对象的插入顺序。 */
export function anchorBodyOf(row: unknown): Record<string, unknown> {
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ANCHOR_BODY_ORDER) out[k] = src[k];
  return out;
}

export function anchorHashOf(prevAnchorHash: string, body: Record<string, unknown>): string {
  return sha256(prevAnchorHash + '|' + JSON.stringify(body));
}

export interface MakeAnchorOptions {
  chainId: string;
  /** 锚定时刻（wall-clock）。这是**记录性**字段，不参与任何可信度主张。 */
  anchorTs: number;
  /** 锚日志中的上一条（任意 chain_id）——锚自身成链，故链接的是整条日志的末行。 */
  prev?: AnchorRow | null;
}

/**
 * 由链视图生成一条锚。
 *
 * 拒绝条件都写成显式抛错而非静默纠正：锚一旦记错，后面所有核验都在错误前提下进行，
 * 而它恰恰是「唯一能检出截断」的那一环——不能有「大概是这个数」的空间。
 */
export function makeAnchor(view: ChainView, opts: MakeAnchorOptions): AnchorRow {
  assertChainId(opts.chainId, 'makeAnchor');
  if (!Number.isInteger(view.count) || view.count < 0) {
    throw new AnchorFormatError(`makeAnchor：count 必须是 ≥0 的整数，实为 ${String(view.count)}`);
  }
  if (view.count === 0 && view.last_hash !== '') {
    throw new AnchorFormatError(
      `makeAnchor：空链（count=0）的 last_hash 必须为空串，实为 ${JSON.stringify(view.last_hash)}`,
    );
  }
  if (view.count > 0 && !HEX64.test(view.last_hash)) {
    throw new AnchorFormatError(
      `makeAnchor：count=${view.count} 时 last_hash 必须是 64 位小写 hex，实为 ${JSON.stringify(view.last_hash)}`,
    );
  }
  if (!Number.isFinite(opts.anchorTs)) {
    throw new AnchorFormatError(`makeAnchor：anchorTs 必须是有限数，实为 ${String(opts.anchorTs)}`);
  }

  const prev = opts.prev ?? null;
  const body: Record<string, unknown> = {
    anchor_seq: prev === null ? 1 : prev.anchor_seq + 1,
    anchor_version: ANCHOR_VERSION,
    chain_id: opts.chainId,
    count: view.count,
    last_hash: view.count === 0 ? '' : view.last_hash,
    anchor_ts: opts.anchorTs,
    prev_anchor_hash: prev === null ? '' : prev.anchor_hash,
  };

  return { ...body, anchor_hash: anchorHashOf(body.prev_anchor_hash as string, body) } as AnchorRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 核验：链视图 vs 锚
// ─────────────────────────────────────────────────────────────────────────────

export type AnchorVerdict = 'match' | 'grew' | 'truncated' | 'forked' | 'undecidable';

export interface AnchorComparison {
  verdict: AnchorVerdict;
  /** 相对锚的条数差（负 = 比锚少了多少条）。 */
  delta: number;
  /** 锚位置上的哈希是否等于 anchor.last_hash；无能力判断时为 null。 */
  prefixMatches: boolean | null;
  detail: string;
}

/**
 * 比对链与锚。**调用前必须已单独验过链**（`verifyEventChain` / `verify_chain.py`）：
 * 本函数只回答「条数与末哈希是否还是锚记的那个」，链内部是否自洽不在其职责内。
 * 顺序写死为「先验链、再比锚」，是因为反过来的话，一条被改过的链可能恰好「与锚不符」，
 * 让人误以为是截断——原因与现象会被混为一谈。
 */
export function compareToAnchor(view: ChainView, anchor: AnchorRow): AnchorComparison {
  const delta = view.count - anchor.count;

  // 1) 比锚少 ⇒ 尾部被截。这是唯一不会被链自证覆盖的形态。
  if (delta < 0) {
    return {
      verdict: 'truncated',
      delta,
      prefixMatches: null,
      detail: `链只有 ${view.count} 条，锚记的是 ${anchor.count} 条：尾部被截去 ${-delta} 条`
        + '（链自身仍自洽——这正是必须靠外锚检出的原因）',
    };
  }

  // 2) 条数相同 ⇒ 末哈希决定 match/forked。
  if (delta === 0) {
    if (view.last_hash === anchor.last_hash) {
      return {
        verdict: 'match',
        delta: 0,
        prefixMatches: true,
        detail: `${view.count} 条，末哈希与锚一致（${anchor.last_hash.slice(0, 16)}…）`,
      };
    }
    return {
      verdict: 'forked',
      delta: 0,
      prefixMatches: false,
      detail: `条数同为 ${view.count}，但末哈希不同（链 ${view.last_hash.slice(0, 16)}… ≠ 锚 ${anchor.last_hash.slice(0, 16)}…）`
        + '——历史被重写或整体替换',
    };
  }

  // 3) 比锚多 ⇒ 要看「锚位置上的那条」是否还是锚记的那条。
  if (anchor.count === 0) {
    return {
      verdict: 'grew',
      delta,
      prefixMatches: true,
      detail: `锚定于空链，现有 ${view.count} 条（空链的前缀恒为空，不存在改写）`,
    };
  }

  if (view.hashAt === undefined) {
    return {
      verdict: 'undecidable',
      delta,
      prefixMatches: null,
      detail: `现有 ${view.count} 条 > 锚的 ${anchor.count} 条，但未提供按位置取哈希的能力：`
        + '无法确认第 ' + String(anchor.count) + ' 条是否仍是锚记的那条，故不判定',
    };
  }

  const at = view.hashAt(anchor.count);
  if (at === null) {
    return {
      verdict: 'undecidable',
      delta,
      prefixMatches: null,
      detail: `现有 ${view.count} 条，但取不到第 ${anchor.count} 条（越界）——视图与条数不自洽`,
    };
  }
  if (at === anchor.last_hash) {
    return {
      verdict: 'grew',
      delta,
      prefixMatches: true,
      detail: `锚后新增 ${delta} 条，锚位置（第 ${anchor.count} 条）哈希未变——正常增长，非异常`,
    };
  }
  return {
    verdict: 'forked',
    delta,
    prefixMatches: false,
    detail: `现有 ${view.count} 条，但第 ${anchor.count} 条已不是锚记的那条`
      + `（${at.slice(0, 16)}… ≠ ${anchor.last_hash.slice(0, 16)}…）——`
      + '典型形态是「截断后补进等量伪造事件」，条数看起来正常，只有锚能检出',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 锚日志：解析、验链、取最新
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 严格解析锚日志。任一行不合规即抛错——锚日志没有「尽力而为」的读法：
 * 跳过坏行等于给攻击者一个「把坏行塞进去让核验方跳过」的入口。
 */
export function parseAnchorLog(text: string): AnchorRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const rows: AnchorRow[] = [];
  let prevHash = '';

  for (const [i, line] of lines.entries()) {
    const ln = i + 1;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new AnchorFormatError(`第 ${ln} 行不是合法 JSON：${(err as Error).message}`, ln);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new AnchorFormatError(`第 ${ln} 行不是对象`, ln);
    }
    const keys = Object.keys(obj as Record<string, unknown>);
    if (keys.join(',') !== ANCHOR_FIELD_ORDER.join(',')) {
      throw new AnchorFormatError(
        `第 ${ln} 行键序/键集合不符：应为 [${ANCHOR_FIELD_ORDER.join(',')}]，实为 [${keys.join(',')}]`
          + '（键序即哈希输入，换序即换哈希）',
        ln,
      );
    }
    const row = obj as AnchorRow;
    if (row.anchor_seq !== rows.length + 1) {
      throw new AnchorFormatError(
        `第 ${ln} 行 anchor_seq=${String(row.anchor_seq)}，应为 ${rows.length + 1}（跳号=有锚被删）`,
        ln,
      );
    }
    if (row.anchor_version !== ANCHOR_VERSION) {
      throw new AnchorFormatError(
        `第 ${ln} 行 anchor_version=${String(row.anchor_version)}，本实现只认 ${ANCHOR_VERSION}`,
        ln,
      );
    }
    assertChainId(row.chain_id, `第 ${ln} 行`, ln);
    if (!Number.isInteger(row.count) || row.count < 0) {
      throw new AnchorFormatError(`第 ${ln} 行 count 非 ≥0 整数（${String(row.count)}）`, ln);
    }
    if (row.count === 0 ? row.last_hash !== '' : !HEX64.test(row.last_hash)) {
      throw new AnchorFormatError(`第 ${ln} 行 last_hash 与 count 不自洽（count=${row.count}）`, ln);
    }
    if (!Number.isFinite(row.anchor_ts)) {
      throw new AnchorFormatError(`第 ${ln} 行 anchor_ts 非有限数`, ln);
    }
    if (row.prev_anchor_hash !== prevHash) {
      throw new AnchorFormatError(
        `第 ${ln} 行 prev_anchor_hash 与上一行 anchor_hash 不符（锚链断裂——中间有锚被改或删）`,
        ln,
      );
    }
    const expect = anchorHashOf(prevHash, anchorBodyOf(row));
    if (expect !== row.anchor_hash) {
      throw new AnchorFormatError(
        `第 ${ln} 行 anchor_hash 复算不符（期望 ${expect.slice(0, 16)}…，实为 ${String(row.anchor_hash).slice(0, 16)}…）`,
        ln,
      );
    }
    prevHash = row.anchor_hash;
    rows.push(row);
  }
  return rows;
}

export interface AnchorLogVerdict {
  ok: boolean;
  badSeq: number | null;
  reason: string;
  rows: AnchorRow[];
  /** 每个 chain_id 的最新一条锚。 */
  latest: Map<string, AnchorRow>;
}

/**
 * 验锚日志：结构 + 锚链 + **同一 chain_id 的 count 单调不减**。
 *
 * 第三条容易被忽略：如果允许后面一条锚的 count 比前面小，则「先截断链、再补一条更小的锚」
 * 就能自圆其说——锚日志本身的单调性把这条路堵死（代价是历史锚永不删除，只能追加）。
 */
export function verifyAnchorLog(text: string): AnchorLogVerdict {
  let rows: AnchorRow[];
  try {
    rows = parseAnchorLog(text);
  } catch (err) {
    const e = err as AnchorFormatError;
    return {
      ok: false,
      badSeq: e.line > 0 ? e.line : null,
      reason: e.message,
      rows: [],
      latest: new Map(),
    };
  }

  const latest = new Map<string, AnchorRow>();
  for (const row of rows) {
    const prev = latest.get(row.chain_id);
    if (prev !== undefined && row.count < prev.count) {
      return {
        ok: false,
        badSeq: row.anchor_seq,
        reason: `锚 ${row.anchor_seq}（chain=${row.chain_id}）的 count=${row.count} 小于前一条锚的 ${prev.count}`
          + '——锚日志对同一链必须单调不减（否则「截断后补一条更小的锚」即可自圆其说）',
        rows,
        latest,
      };
    }
    latest.set(row.chain_id, row);
  }
  return { ok: true, badSeq: null, reason: `${rows.length} 条锚，覆盖 ${latest.size} 条链，锚链自洽`, rows, latest };
}

/** 每行一条 JSON（与台账/事件流同形），便于逐行 diff。 */
export function renderAnchorLine(row: AnchorRow): string {
  return JSON.stringify(row) + '\n';
}

export function renderAnchorLog(rows: AnchorRow[]): string {
  return rows.map(renderAnchorLine).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 域外发布：摘要串
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 外发摘要串——**这是唯一能切断「锚尾也不可自证」的那一步的载体**。
 *
 * 一串短文本，可以贴进 Release 说明、邮件、工单、纸质记录。任何拿到它的人，
 * 日后可用它核验「链是否被截到这一条之前」。刻意做成单行、无空格、可肉眼比对长度。
 */
export function externalDigest(row: AnchorRow): string {
  return `aof-anchor/v${row.anchor_version}:${row.chain_id}:${row.anchor_seq}:${row.count}:${row.last_hash}:${row.anchor_hash.slice(0, 16)}`;
}

/**
 * 反向：从摘要串还原一条「可用于比对」的锚（不含 anchor_ts / prev_anchor_hash，
 * 因此它**不能**被追加进锚日志——只用于「拿外发串核对当前链」这一种用途）。
 */
export function parseExternalDigest(text: string): {
  chain_id: string;
  anchor_seq: number;
  count: number;
  last_hash: string;
  anchor_hash_prefix: string;
} {
  const parts = text.trim().split(':');
  if (parts.length !== 6 || parts[0] !== `aof-anchor/v${ANCHOR_VERSION}`) {
    throw new AnchorFormatError(`摘要串格式不符（应为 aof-anchor/v${ANCHOR_VERSION}:<chain>:<seq>:<count>:<last_hash>:<hash16>）：${text}`);
  }
  const [, chainId, seq, count, lastHash, prefix] = parts as [string, string, string, string, string, string];
  assertChainId(chainId, 'parseExternalDigest');
  if (!/^\d+$/.test(seq) || !/^\d+$/.test(count)) {
    throw new AnchorFormatError(`摘要串的 seq/count 不是整数：${text}`);
  }
  if (lastHash !== '' && !HEX64.test(lastHash)) {
    throw new AnchorFormatError(`摘要串的 last_hash 不是 64 位小写 hex：${text}`);
  }
  if (!/^[0-9a-f]{16}$/.test(prefix)) {
    throw new AnchorFormatError(`摘要串的锚哈希前缀不是 16 位小写 hex：${text}`);
  }
  return { chain_id: chainId, anchor_seq: Number(seq), count: Number(count), last_hash: lastHash, anchor_hash_prefix: prefix };
}
