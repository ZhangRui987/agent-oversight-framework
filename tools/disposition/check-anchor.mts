#!/usr/bin/env node
/**
 * check-anchor.mts —— 外锚自检 + 反向测试 + 仓库实锚核验（门禁第 51 项）
 *
 * 分工（与第 50 项的关系要看清）：
 *   50 = 链结构（同链写入 / 篡改检出 / 投影可验 / 迁移不丢行 / 可复现）
 *   51 = 链的**外部见证**（尾部截断 / 同条数换史 / 前缀重写 / 锚链自洽 / 域外摘要）
 *   50 的 B19 断言「尾部截断链自证检不出」；51 是那句话的补口，而不是删掉它。
 *
 * 三类检查项，性质不同，不得混着读：
 *   · 判定类（A2–A7）：喂进构造好的链视图，断言 `compareToAnchor` 给出**指定判定**。
 *     它们本身就是「检测器是否有效」的测试，不依赖 fixture 变异。
 *   · 拒收类（A9/A11/A13/A14）：断言非法锚日志被抛错拒绝——负向断言自带判别力。
 *   · 状态类（A1/A8/A10/A12）：读 fixture 断言当前状态，**由反向测试证明能 FAIL**。
 *
 * 用法：
 *   node --experimental-transform-types tools/disposition/check-anchor.mts             # 校验（fixture）
 *   node --experimental-transform-types tools/disposition/check-anchor.mts --selftest   # 反向测试
 *   node --experimental-transform-types tools/disposition/check-anchor.mts --verify-repo # 核验仓库实锚
 *   node --experimental-transform-types tools/disposition/check-anchor.mts --reanchor    # 重新锚定
 *   node --experimental-transform-types tools/disposition/check-anchor.mts --demo        # 人类可读演示
 *   node --experimental-transform-types tools/disposition/check-anchor.mts --emit-digests  # 机器可读的锚与摘要串（喂给发布校验）
 *   node --experimental-transform-types tools/disposition/check-anchor.mts --publish-lines # 待追加的发布记录行（版本取自 VERSION）
 *
 * 退出码：0 = 全通过；1 = 有失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChainRecorder, verifyEventChain, type FrameworkEvent } from './framework-bridge.mts';
import { buildFixture } from './check-bridge.mts';
import {
  ANCHOR_FIELD_ORDER,
  AnchorFormatError,
  compareToAnchor,
  externalDigest,
  makeAnchor,
  parseAnchorLog,
  parseExternalDigest,
  renderAnchorLine,
  renderAnchorLog,
  verifyAnchorLog,
  type AnchorComparison,
  type AnchorRow,
  type ChainView,
} from './anchor.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const ANCHOR_LOG_FILE = resolve(HERE, 'data/anchor.jsonl');

/** 固定时间基准：本脚本的 fixture 不读真实时钟（仅 --reanchor 例外，那是在记历史）。 */
const BASE = 1794000000000;

// ─────────────────────────────────────────────────────────────────────────────
// 0. 被锚定的仓库产物（链规则各自留在原地，本模块只读 {count, last_hash}）
// ─────────────────────────────────────────────────────────────────────────────

interface AnchoredChain {
  chainId: string;
  file: string;
  /** 该产物自带的验链器——锚不重实现链，链内自洽必须由它自己的验证器回答。 */
  verifier: string[];
  /** 读取链视图前如何筛行：面板事件流首行是 meta。 */
  filter: 'panel-events' | 'all';
  label: string;
}

const ANCHORED_CHAINS: AnchoredChain[] = [
  {
    chainId: 'audit-panel/events-v1',
    file: 'tools/audit-panel/data/events.jsonl',
    verifier: ['tools/audit-panel/scenario/verify-chain.mts'],
    filter: 'panel-events',
    label: '审计面板 V1 事件流（确定性重生成）',
  },
  {
    chainId: 'disposition/stage1-ledger',
    file: 'tools/disposition/data/disposition.jsonl',
    verifier: ['tools/disposition/verify-chain.mts', '--file=tools/disposition/data/disposition.jsonl'],
    filter: 'all',
    label: '处置台账（阶段 1 独立链）',
  },
];

type Row = Record<string, unknown>;

function readJsonl(file: string): Row[] {
  const text = readFileSync(file, 'utf-8');
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try {
        return JSON.parse(l) as Row;
      } catch (err) {
        throw new Error(`${file} 第 ${i + 1} 行不是合法 JSON：${(err as Error).message}`);
      }
    });
}

function viewOfRows(rows: Row[]): ChainView {
  const hashes = rows.map((r) => String(r.chain_hash ?? ''));
  return {
    count: hashes.length,
    last_hash: hashes.length > 0 ? hashes[hashes.length - 1]! : '',
    hashAt: (seq) => (seq >= 1 && seq <= hashes.length ? hashes[seq - 1]! : null),
  };
}

function viewOfEvents(events: FrameworkEvent[]): ChainView {
  return {
    count: events.length,
    last_hash: events.length > 0 ? events[events.length - 1]!.hash : '',
    hashAt: (seq) => (seq >= 1 && seq <= events.length ? events[seq - 1]!.hash : null),
  };
}

function viewOfChain(chain: AnchoredChain): ChainView {
  const rows = readJsonl(resolve(ROOT, chain.file));
  const picked = chain.filter === 'panel-events' ? rows.filter((r) => r.record_type === 'event') : rows;
  return viewOfRows(picked);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. fixture
// ─────────────────────────────────────────────────────────────────────────────

export interface AnchorFixture {
  /** 真实代码路径产出的框架链（5 条：3 信号 + 2 处置）。 */
  events: FrameworkEvent[];
  /** 本链的锚（count = events.length）。 */
  anchor: AnchorRow;
  /** 另一条链的锚，用于验证锚日志能承载多条链且锚链连续。 */
  foreign: AnchorRow;
  /** 锚日志全文（两条）。 */
  log: string;
  /** 域外发布的摘要串——**这是切断「锚尾也不可自证」的那一环**。 */
  published: string;
}

export function buildAnchorFixture(): AnchorFixture {
  const events = buildFixture().events;
  const view = viewOfEvents(events);

  const foreign = makeAnchor(
    { count: 3, last_hash: 'a'.repeat(64) },
    { chainId: 'demo/other-chain', anchorTs: BASE },
  );
  const anchor = makeAnchor(view, { chainId: 'demo/framework-chain', anchorTs: BASE + 1, prev: foreign });

  return {
    events,
    anchor,
    foreign,
    log: renderAnchorLog([foreign, anchor]),
    published: externalDigest(anchor),
  };
}

const clone = (f: AnchorFixture): AnchorFixture => JSON.parse(JSON.stringify(f)) as AnchorFixture;

/**
 * 用「同一批写入、改掉某条载荷」的方式重建一条**自洽但历史不同**的链。
 * 这是「截断后补等量伪造事件」的最小真实模型：条数一样、末哈希不同、链本身验得过。
 */
function rebuild(
  mutate: (data: Record<string, unknown>, index: number) => void,
): { events: FrameworkEvent[]; valid: boolean } {
  const f = buildFixture();
  const rec = new ChainRecorder();
  f.writes.forEach((w, i) => {
    const data = JSON.parse(JSON.stringify(w.data)) as Record<string, unknown>;
    mutate(data, i);
    rec.append(w.type, data, w.ts);
  });
  const events = rec.recorded.slice();
  return { events, valid: verifyEventChain(events).ok };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 检查项
// ─────────────────────────────────────────────────────────────────────────────

export interface Check {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
}

export function runAnchorChecks(f: AnchorFixture): Check[] {
  const checks: Check[] = [];
  const add = (id: string, name: string, ok: boolean, detail: string) => {
    checks.push({ id, name, ok, detail });
  };
  const view = viewOfEvents(f.events);
  const say = (c: AnchorComparison) => `${c.verdict}（delta=${c.delta}）${c.detail}`;

  // A1 一致时判定 match，且锚日志能严格回读自己写出的锚
  {
    let roundtrip = false;
    let rtErr = '';
    try {
      const back = parseAnchorLog(f.log);
      roundtrip = back.length === 2 && back[1]!.anchor_hash === f.anchor.anchor_hash;
    } catch (err) {
      rtErr = (err as Error).message;
    }
    const c = compareToAnchor(view, f.anchor);
    add(
      'A1',
      '链与锚一致 → match；锚日志可被严格解析器原样回读',
      c.verdict === 'match' && roundtrip,
      c.verdict === 'match' && roundtrip
        ? `${f.events.length} 条，末哈希 ${f.anchor.last_hash.slice(0, 16)}…；回读 anchor_hash 一致`
        : `判定=${c.verdict}；回读=${roundtrip ? 'OK' : rtErr || '不一致'}`,
    );
  }

  // A2 尾部截断 1 条 → truncated（B19 认定的盲区，这里必须被检出）
  {
    const c = compareToAnchor(viewOfEvents(f.events.slice(0, -1)), f.anchor);
    add('A2', '尾部截断 1 条 → truncated（链自身仍自洽，仅锚能检出）', c.verdict === 'truncated', say(c));
  }

  // A3 截到空 → 仍判 truncated，且能算出少了多少条
  {
    const c = compareToAnchor(viewOfEvents([]), f.anchor);
    add(
      'A3',
      '整条链被清空 → truncated 且 delta 等于原条数',
      c.verdict === 'truncated' && c.delta === -f.events.length,
      say(c),
    );
  }

  // A4 截断后补进等量伪造事件（条数相同、历史不同、链自洽）→ forked
  {
    const forged = rebuild((d, i) => {
      if (i === 0) d.detail = `${String(d.detail)}（伪造）`;
    });
    const c = compareToAnchor(viewOfEvents(forged.events), f.anchor);
    add(
      'A4',
      '截断后补等量伪造事件（条数相同、链自洽）→ forked（条数一致不足以自证）',
      c.verdict === 'forked' && forged.valid && forged.events.length === f.events.length,
      `${say(c)}；伪造链自洽=${forged.valid}、条数=${forged.events.length}（与原链相同）`,
    );
  }

  // A5 前缀被改写且条数增长 → forked（不能因「条数变多」就当正常增长）
  {
    const forged = rebuild((d, i) => {
      if (i === 0) d.detail = `${String(d.detail)}（早期事件被替换）`;
    });
    const rec = new ChainRecorder();
    for (const e of forged.events) rec.append(e.type, e.data, e.ts);
    rec.append('ledger_signal', { kind: 'periodic-egress', detail: '锚后新增' }, BASE + 9000);
    const c = compareToAnchor(viewOfEvents(rec.recorded), f.anchor);
    add(
      'A5',
      '早期历史被改写且条数增长 → forked（按锚位置取哈希比对，不看条数）',
      c.verdict === 'forked' && c.prefixMatches === false && c.delta === 1,
      say(c),
    );
  }

  // A6 只给摘要不给按位置取哈希 + 条数增长 → undecidable（不猜）
  {
    const c = compareToAnchor({ count: f.events.length + 2, last_hash: 'f'.repeat(64) }, f.anchor);
    add(
      'A6',
      '摘要-only 视图遇条数增长 → undecidable（缺前缀证据时不假装知道）',
      c.verdict === 'undecidable' && c.prefixMatches === null,
      say(c),
    );
  }

  // A7 锚后正常新增、未重锚 → grew（不是告警：误报会让人关掉告警）
  {
    const rec = new ChainRecorder();
    for (const e of f.events) rec.append(e.type, e.data, e.ts);
    rec.append('ledger_signal', { kind: 'periodic-egress', detail: '锚后新增' }, BASE + 9001);
    const c = compareToAnchor(viewOfEvents(rec.recorded), f.anchor);
    add(
      'A7',
      '锚后正常新增事件 → grew（正常增长，不报篡改）',
      c.verdict === 'grew' && c.prefixMatches === true && c.delta === 1,
      say(c),
    );
  }

  // A8 锚日志自洽 + 能取出每条链的最新锚
  {
    const v = verifyAnchorLog(f.log);
    const latest = v.latest.get('demo/framework-chain');
    const latestOther = v.latest.get('demo/other-chain');
    const ok = v.ok
      && v.rows.length === 2
      && latest?.anchor_hash === f.anchor.anchor_hash
      && latestOther?.anchor_hash === f.foreign.anchor_hash
      && v.rows[1]!.prev_anchor_hash === f.foreign.anchor_hash;
    add(
      'A8',
      '锚日志自洽（prev_anchor_hash 逐条链接）且 latest 取到两条链各自的末锚',
      ok,
      ok ? `2 条锚 / ${v.latest.size} 条链；锚链链接一致` : v.ok ? '锚链或 latest 不一致' : v.reason,
    );
  }

  // A9 改锚日志中间一行（不重算哈希）→ 解析抛错并指到该行
  // 自建两条锚而不读 f.log：拒收类检查的输入必须可控，否则日志在别处被改坏时
  // 这里会因为「没有第二行」而抛 TypeError，把「检查没过」变成「脚本崩了」。
  {
    const a1 = makeAnchor({ count: 2, last_hash: '1'.repeat(64) }, { chainId: 'demo/tamper', anchorTs: BASE });
    const a2 = makeAnchor({ count: 4, last_hash: '2'.repeat(64) }, { chainId: 'demo/tamper', anchorTs: BASE + 1, prev: a1 });
    const lines = renderAnchorLog([a1, a2]).trim().split('\n');
    const row = JSON.parse(lines[1]!) as AnchorRow;
    row.count = row.count + 1;
    lines[1] = JSON.stringify(row);
    let threw = false;
    let line = 0;
    let msg = '';
    try {
      parseAnchorLog(lines.join('\n') + '\n');
    } catch (err) {
      threw = err instanceof AnchorFormatError;
      line = (err as AnchorFormatError).line;
      msg = (err as Error).message;
    }
    add(
      'A9',
      '改动锚日志中间一行 → 解析抛错且行号定位到该行',
      threw && line === 2,
      threw ? `第 ${line} 行：${msg.slice(0, 60)}` : '未抛错——锚链可被静默改写',
    );
  }

  // A10 域外摘要串必须能对上当前最新锚（这一环是「锚尾不可自证」的唯一出口）
  {
    let parsed: ReturnType<typeof parseExternalDigest> | null = null;
    let err = '';
    try {
      parsed = parseExternalDigest(f.published);
    } catch (e) {
      err = (e as Error).message;
    }
    const ok = parsed !== null
      && parsed.count === f.anchor.count
      && parsed.last_hash === f.anchor.last_hash
      && parsed.anchor_hash_prefix === f.anchor.anchor_hash.slice(0, 16);
    add(
      'A10',
      '域外摘要串 == 最新锚（count / 末哈希 / 锚哈希前缀三项全等）',
      ok,
      ok ? f.published.slice(0, 96) + '…' : err || '摘要串与最新锚不一致——域外见证失效',
    );
  }

  // A11 同一链的锚 count 回退 → 拒收（否则「截断后补一条更小的锚」即可自圆其说）
  // 注意两条锚必须同属**一条链**，否则不是回退而是「另一条链的首次锚定」——
  // 这个错我犯过一次，是 A11 自己报出来的（构造写错会让检查恒 PASS，等于没检查）。
  {
    const first = makeAnchor(view, { chainId: 'demo/framework-chain', anchorTs: BASE });
    const regressed = makeAnchor({ count: 2, last_hash: 'b'.repeat(64) }, {
      chainId: 'demo/framework-chain',
      anchorTs: BASE + 2,
      prev: first,
    });
    const v = verifyAnchorLog(renderAnchorLog([first, regressed]));
    add(
      'A11',
      '同一链的后一条锚 count 更小 → 拒收（锚日志 count 必须单调不减）',
      !v.ok && v.badSeq === 2,
      v.ok ? '未拒收——可构造「截断后补小锚」' : `第 ${v.badSeq} 条被拒：${v.reason.slice(0, 60)}`,
    );
  }

  // A12 摘要串可逆：解析回同一组值；锚一变串必变
  {
    const p = parseExternalDigest(f.published);
    const other = makeAnchor(view, { chainId: 'demo/framework-chain', anchorTs: BASE + 3, prev: f.foreign });
    const differs = externalDigest(other) !== f.published;
    add(
      'A12',
      '摘要串可解析回同一组值；换一条锚则串必变（串本身即见证）',
      p.count === f.anchor.count && p.last_hash === f.anchor.last_hash && differs,
      `解析 count=${p.count} / 末哈希 ${p.last_hash.slice(0, 12)}…；换锚后串${differs ? '已变' : '未变'}`,
    );
  }

  // A13 键序漂移 / 多余键 → 拒收（键序即哈希输入）。同样自建输入，理由同 A9。
  {
    const base = makeAnchor({ count: 1, last_hash: '3'.repeat(64) }, { chainId: 'demo/order', anchorTs: BASE });
    const obj = JSON.parse(renderAnchorLine(base)) as Record<string, unknown>;
    const swapped: Record<string, unknown> = {};
    for (const k of [ANCHOR_FIELD_ORDER[1]!, ANCHOR_FIELD_ORDER[0]!, ...ANCHOR_FIELD_ORDER.slice(2)]) {
      swapped[k] = obj[k];
    }
    const wrapped = { ...obj, extra: 1 };
    const tryParse = (row: unknown): string => {
      try {
        parseAnchorLog(JSON.stringify(row) + '\n');
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const e1 = tryParse(swapped);
    const e2 = tryParse(wrapped);
    add(
      'A13',
      '锚行键序漂移或出现多余键 → 拒收',
      e1.includes('键序') && e2.includes('键序'),
      e1 && e2 ? `换序：${e1.slice(0, 40)}；多余键：${e2.slice(0, 40)}` : '存在未被拒的形态',
    );
  }

  // A14 空链锚：count=0 必须与空 last_hash 成对；不配对即拒建
  {
    let built = false;
    let rejected = false;
    try {
      const a = makeAnchor({ count: 0, last_hash: '' }, { chainId: 'demo/empty', anchorTs: BASE });
      built = a.last_hash === '' && a.count === 0;
    } catch {
      built = false;
    }
    try {
      makeAnchor({ count: 0, last_hash: 'c'.repeat(64) }, { chainId: 'demo/empty', anchorTs: BASE });
    } catch {
      rejected = true;
    }
    add('A14', '空链锚：count=0 与空 last_hash 必须成对（不配对即拒建）', built && rejected, built && rejected ? '配对建锚成功；不配对被拒' : `建锚=${built} 拒建=${rejected}`);
  }

  return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 输出
// ─────────────────────────────────────────────────────────────────────────────

function report(checks: Check[]): void {
  const bad = checks.filter((c) => !c.ok);
  console.log('');
  console.log('处置通道 · 外锚（尾部截断的唯一防线）自检');
  console.log('─'.repeat(76));
  for (const c of checks) {
    console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.id} ${c.name}`);
    console.log(`       ${c.detail}`);
  }
  console.log('─'.repeat(76));
  console.log(`合计 ${checks.length} 项：PASS ${checks.length - bad.length} / FAIL ${bad.length}`);
  console.log('');
}

/** 反向测试：每条变异断言「指定检查项」命中（不是「任意一项 FAIL」）。 */
function selftest(): number {
  const base = buildAnchorFixture();
  const baseChecks = runAnchorChecks(base);
  const baseBad = baseChecks.filter((c) => !c.ok);
  console.log(`[基线] PASS=${baseChecks.length - baseBad.length} FAIL=${baseBad.length}`);
  if (baseBad.length > 0) {
    for (const c of baseBad) console.log(`  FAIL ${c.id} ${c.name} → ${c.detail}`);
    console.log('基线不通过，自检无意义。');
    return 1;
  }

  const cases: Array<{ label: string; expect: string; mutate: (f: AnchorFixture) => void }> = [
    {
      label: 'S1 改锚的 last_hash（锚被伪造）',
      expect: 'A1',
      mutate: (f) => {
        f.anchor.last_hash = (f.anchor.last_hash.startsWith('0') ? '1' : '0') + f.anchor.last_hash.slice(1);
      },
    },
    {
      label: 'S2 删掉事件链末条（尾部截断）',
      expect: 'A1',
      mutate: (f) => {
        f.events.splice(f.events.length - 1, 1);
      },
    },
    {
      label: 'S3 改锚日志第一行 anchor_hash（锚链被断）',
      expect: 'A8',
      mutate: (f) => {
        const lines = f.log.trim().split('\n');
        const row = JSON.parse(lines[0]!) as AnchorRow;
        row.anchor_hash = (row.anchor_hash.startsWith('0') ? '1' : '0') + row.anchor_hash.slice(1);
        lines[0] = JSON.stringify(row);
        f.log = lines.join('\n') + '\n';
      },
    },
    {
      label: 'S4 删掉锚日志末行（锚尾被截——日志内部看不出来，latest 消失）',
      expect: 'A8',
      mutate: (f) => {
        const lines = f.log.trim().split('\n');
        f.log = lines.slice(0, -1).join('\n') + '\n';
      },
    },
    {
      label: 'S5 改域外摘要串的 count（对方手上那张纸被改）',
      expect: 'A10',
      mutate: (f) => {
        f.published = f.published.replace(/:(\d+):([0-9a-f]{64}):/, (_m, n: string) => `:${Number(n) + 1}:`
          + `${'d'.repeat(64)}:`);
      },
    },
    {
      label: 'S6 锚日志换成「同链更大 count 的伪造锚」（latest 与锚不符）',
      expect: 'A8',
      mutate: (f) => {
        const forged = makeAnchor({ count: 99, last_hash: 'e'.repeat(64) }, {
          chainId: 'demo/framework-chain',
          anchorTs: BASE + 5,
          prev: f.foreign,
        });
        f.log = renderAnchorLog([f.foreign, forged]);
      },
    },
  ];

  let bad = 0;
  for (const [i, c] of cases.entries()) {
    const f = clone(base);
    c.mutate(f);
    const rows = runAnchorChecks(f);
    const hit = rows.filter((r) => !r.ok).map((r) => r.id);
    const ok = hit.includes(c.expect);
    console.log(
      `[${ok ? 'PASS' : 'FAIL'}] 反测 ${i + 1}：${c.label} → 命中[${hit.join(',') || '无'}]（应含 ${c.expect}）`,
    );
    if (!ok) {
      bad += 1;
      const row = rows.find((r) => r.id === c.expect);
      console.log(`       期望项 ${c.expect} 未命中：${row ? row.detail : '不存在'}`);
    }
  }

  const total = cases.length;
  console.log(`\nselftest PASS=${total - bad} FAIL=${bad}（基线 ${baseChecks.length} 项 + 反测 ${total} 项）`);
  return bad === 0 ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 仓库实锚：核验 / 重锚 / 演示
// ─────────────────────────────────────────────────────────────────────────────

function runVerifier(cmd: string[]): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-transform-types', resolve(ROOT, cmd[0]!), ...cmd.slice(1)], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  // 诊断只取验证器自己的话：node 的 ExperimentalWarning 会占满末尾 160 字符，
  // 把真正的 FAIL 行挤掉——那时人会以为「没输出 = 通过了」。
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !/ExperimentalWarning|trace-warnings|^\(node:/.test(l))
    .join(' | ');
  return { ok: r.status === 0, out };
}

function verifyRepo(): number {
  if (!existsSync(ANCHOR_LOG_FILE)) {
    console.log(`FAIL 缺少锚日志 ${ANCHOR_LOG_FILE}（首次使用请跑 --reanchor）`);
    return 1;
  }
  const text = readFileSync(ANCHOR_LOG_FILE, 'utf-8');
  const v = verifyAnchorLog(text);
  console.log('');
  console.log('仓库实锚核验');
  console.log('─'.repeat(76));
  if (!v.ok) {
    console.log(`[FAIL] 锚日志自身不合规（第 ${v.badSeq ?? '?'} 条）：${v.reason}`);
    return 1;
  }
  console.log(`[PASS] 锚日志自洽：${v.rows.length} 条锚，覆盖 ${v.latest.size} 条链`);
  console.log('       ⚠️ 锚尾被整体删掉在日志内部看不出来——只能比域外摘要串（下方最后一行）。');

  let bad = 0;
  for (const chain of ANCHORED_CHAINS) {
    const anchor = v.latest.get(chain.chainId);
    if (anchor === undefined) {
      console.log(`[FAIL] ${chain.chainId}：锚日志里没有该链的锚`);
      bad += 1;
      continue;
    }
    // 链内自洽必须由该产物自己的验证器回答——锚只说条数与末哈希。
    const ver = runVerifier(chain.verifier);
    let cmp: AnchorComparison | null = null;
    let cmpErr = '';
    try {
      cmp = compareToAnchor(viewOfChain(chain), anchor);
    } catch (err) {
      cmpErr = (err as Error).message;
    }
    const ok = ver.ok && cmp !== null && cmp.verdict === 'match';
    if (!ok) bad += 1;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${chain.chainId} — ${chain.label}`);
    console.log(`       链验证器=${ver.ok ? 'PASS' : ver.out.slice(-160)}`);
    console.log(`       锚比对=${cmp === null ? cmpErr : `${cmp.verdict} · ${cmp.detail}`}`);
    console.log(`       锚：${externalDigest(anchor)}`);
  }

  console.log('─'.repeat(76));
  console.log(bad === 0
    ? '实锚核验通过。域外发布这一步不在代码内——发布值见上方 aof-anchor/v1 行。'
    : `${bad} 条链未通过：若确为链已变更（发版/重生成），跑 --reanchor 追加新锚并在发版说明里更新摘要串。`);
  console.log('');
  return bad === 0 ? 0 : 1;
}

function reanchor(): number {
  const prevText = existsSync(ANCHOR_LOG_FILE) ? readFileSync(ANCHOR_LOG_FILE, 'utf-8') : '';
  const v = verifyAnchorLog(prevText);
  if (!v.ok) {
    console.log(`FAIL 现有锚日志不合规，拒绝在其后追加（第 ${v.badSeq ?? '?'} 条）：${v.reason}`);
    return 1;
  }
  const rows = v.rows.slice();
  let prev: AnchorRow | null = rows.length > 0 ? rows[rows.length - 1]! : null;
  let added = 0;

  for (const chain of ANCHORED_CHAINS) {
    const view = viewOfChain(chain);
    const latest = v.latest.get(chain.chainId);
    if (latest !== undefined) {
      const cmp = compareToAnchor(view, latest);
      if (cmp.verdict === 'match') {
        console.log(`[跳过] ${chain.chainId}：最新锚已一致（${latest.count} 条）`);
        continue;
      }
      console.log(`[重锚] ${chain.chainId}：${cmp.verdict} · ${cmp.detail}`);
    } else {
      console.log(`[新锚] ${chain.chainId}：首次锚定 ${view.count} 条`);
    }
    const row = makeAnchor(view, { chainId: chain.chainId, anchorTs: Date.now(), prev });
    rows.push(row);
    prev = row;
    added += 1;
    console.log(`       → anchor_seq=${row.anchor_seq} count=${row.count}`);
    console.log(`         ${externalDigest(row)}`);
  }

  if (added === 0) {
    console.log('无需重锚。');
    return 0;
  }
  mkdirSync(dirname(ANCHOR_LOG_FILE), { recursive: true });
  writeFileSync(ANCHOR_LOG_FILE, renderAnchorLog(rows), 'utf-8');
  console.log(`\n已追加 ${added} 条锚 → ${ANCHOR_LOG_FILE}`);
  console.log('⚠️ 域外发布：把上面的 aof-anchor/v1 串写进 Release 说明（或交给第三方保管），');
  console.log('   否则锚尾仍处同一可写域，"锚被整体删除"依旧不可检出。');
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.1 机器可读输出：喂给发布校验（scripts/check_anchor_publish.py）
// ─────────────────────────────────────────────────────────────────────────────
//
// 为什么由 Node 输出、而不是让 Python 自己读 anchor.jsonl：
//   摘要串的形状（字段顺序、last_hash 长度、前缀 16 位）是**锚格式的一部分**，
//   而锚日志的解析规则（键序冻结 / 锚链 / 同链单调）已经在 parseAnchorLog 里。
//   若 Python 再实现一遍，就有了两套规格——本仓库的老教训是「两套规格并行必然漂移」。
//   这里只把**已由严格解析器验过**的锚行翻成一行 JSON，Python 侧只做字符串比对。

interface DigestRow {
  chain_id: string;
  anchor_seq: number;
  count: number;
  last_hash: string;
  anchor_hash: string;
  digest: string;
  latest: boolean;
}

function loadVerifiedAnchors(): { ok: true; rows: AnchorRow[]; latest: Map<string, AnchorRow> } | { ok: false; why: string } {
  if (!existsSync(ANCHOR_LOG_FILE)) {
    return { ok: false, why: `缺少锚日志 ${ANCHOR_LOG_FILE}（首次使用请跑 --reanchor）` };
  }
  const v = verifyAnchorLog(readFileSync(ANCHOR_LOG_FILE, 'utf-8'));
  return v.ok ? { ok: true, rows: v.rows, latest: v.latest } : { ok: false, why: `锚日志不合规（第 ${v.badSeq ?? '?'} 条）：${v.reason}` };
}

/** 每行一条 JSON（stdout 只放数据，诊断走 stderr——否则调用方的 json.loads 会被警告行噎住）。 */
function emitDigests(): number {
  const got = loadVerifiedAnchors();
  if (!got.ok) {
    console.error(`FAIL ${got.why}`);
    return 1;
  }
  for (const row of got.rows) {
    const latest = got.latest.get(row.chain_id);
    const out: DigestRow = {
      chain_id: row.chain_id,
      anchor_seq: row.anchor_seq,
      count: row.count,
      last_hash: row.last_hash,
      anchor_hash: row.anchor_hash,
      digest: externalDigest(row),
      latest: latest !== undefined && latest.anchor_seq === row.anchor_seq,
    };
    console.log(JSON.stringify(out));
  }
  return 0;
}

/** 待追加到 published-anchors.jsonl 的行（键序 = 冻结顺序，手抄必出错的那一步机器代做）。 */
function publishLines(): number {
  const got = loadVerifiedAnchors();
  if (!got.ok) {
    console.error(`FAIL ${got.why}`);
    return 1;
  }
  const version = readFileSync(resolve(ROOT, 'VERSION'), 'utf-8').trim();
  for (const chain of ANCHORED_CHAINS) {
    const row = got.latest.get(chain.chainId);
    if (row === undefined) {
      console.error(`FAIL ${chain.chainId} 无锚（先跑 --reanchor）`);
      return 1;
    }
    // 键序必须与 check_anchor_publish.py 的 FIELDS 一致：JSON.stringify 按插入序输出。
    console.log(JSON.stringify({
      published_version: version,
      chain_id: row.chain_id,
      anchor_seq: row.anchor_seq,
      digest: externalDigest(row),
    }));
  }
  return 0;
}

function demo(): number {
  const f = buildAnchorFixture();
  const view = viewOfEvents(f.events);
  console.log('');
  console.log(`链：${view.count} 条，末哈希 ${view.last_hash.slice(0, 24)}…`);
  console.log(`锚：count=${f.anchor.count} last_hash=${f.anchor.last_hash.slice(0, 24)}…`);
  console.log('');
  console.log('五种形态（同一函数判定，不靠人眼看）');
  console.log('─'.repeat(76));

  const cases: Array<[string, ChainView]> = [
    ['原样', view],
    ['尾部截断 1 条', viewOfEvents(f.events.slice(0, -1))],
    ['全部清空', viewOfEvents([])],
    ['锚后正常新增', (() => {
      const rec = new ChainRecorder();
      for (const e of f.events) rec.append(e.type, e.data, e.ts);
      rec.append('ledger_signal', { kind: 'periodic-egress', detail: '新增' }, BASE + 9002);
      return viewOfEvents(rec.recorded);
    })()],
    ['等长换史（截断后补伪造）', viewOfEvents(rebuild((d, i) => {
      if (i === 0) d.detail = `${String(d.detail)}（伪造）`;
    }).events)],
  ];
  for (const [label, v] of cases) {
    const c = compareToAnchor(v, f.anchor);
    console.log(`  ${label.padEnd(22)} → ${c.verdict.padEnd(11)} delta=${String(c.delta).padStart(3)}`);
    console.log(`      ${c.detail}`);
  }
  console.log('');
  console.log(`域外发布串：${f.published}`);
  console.log('');
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 入口
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    process.exitCode = selftest();
  } else if (argv.includes('--verify-repo')) {
    process.exitCode = verifyRepo();
  } else if (argv.includes('--reanchor')) {
    process.exitCode = reanchor();
  } else if (argv.includes('--emit-digests')) {
    process.exitCode = emitDigests();
  } else if (argv.includes('--publish-lines')) {
    process.exitCode = publishLines();
  } else if (argv.includes('--demo')) {
    process.exitCode = demo();
  } else {
    const checks = runAnchorChecks(buildAnchorFixture());
    report(checks);
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
