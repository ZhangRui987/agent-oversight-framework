#!/usr/bin/env node
/**
 * check-bridge.mts —— 集成层（2b-2）自检 + 反向测试（门禁第 50 项）
 *
 * 校验对象：`framework-bridge.mts` 关于「处置与被处置信号同链」的全部主张。
 * 每条主张都对应一个可失败的检查项——不能失败的主张不算主张。
 *
 * 与第 49 项的分工：
 *   49 = 取值域（类别名 / 时限 / 聚合行为）
 *   50 = 链结构（同链写入 / 篡改检出 / 投影可验 / 迁移不丢行 / 可复现）
 *
 * 用法：
 *   node --experimental-transform-types tools/disposition/check-bridge.mts            # 校验
 *   node --experimental-transform-types tools/disposition/check-bridge.mts --selftest  # 反向测试
 *   node --experimental-transform-types tools/disposition/check-bridge.mts --demo      # 人类可读演示
 *
 * 退出码：0 = 全通过；1 = 有失败。
 */

import { AppendOnlyAuditLog } from '../../reference/runtimes/l2-runtime-oversight/index.ts';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHAIN_DATA_ORDER,
  ChainRecorder,
  ChainShapeError,
  ChainWriteError,
  DISPOSITION_EVENT_TYPE,
  SIGNAL_EVENT_TYPE,
  appendDispositionToChain,
  assertChainDataShape,
  chainDigest,
  migrateLedger,
  projectLedger,
  verifyEventChain,
  type FrameworkEvent,
} from './framework-bridge.mts';
import { bodyOf, chainHashOf, readLedger, type LedgerRow } from './ledger.mts';

/** 固定时间基准（与面板 AOF_PANEL_NOW 同一值）：本脚本不读真实时钟。 */
const BASE = 1794000000000;

export interface Check {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
}

export interface Fixture {
  events: FrameworkEvent[];
  rows: LedgerRow[];
  /** 重放用：按写入顺序的 (type, data, ts)。 */
  writes: Array<{ type: string; data: unknown; ts: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. 构造基线（走真实代码路径，不手写事件）
// ─────────────────────────────────────────────────────────────────────────────

function signalOf(kind: string, detail: string, ts: number): unknown {
  return { kind, taskId: 'task-1', detail, measured: { n: 1 }, threshold: { n: 0 }, ts };
}

export function buildFixture(opts: { withTs?: boolean } = {}): Fixture {
  const withTs = opts.withTs !== false;
  const rec = new ChainRecorder();
  const writes: Array<{ type: string; data: unknown; ts: number }> = [];

  const put = (type: string, data: unknown, n: number) => {
    const t = BASE + n;
    const r = withTs ? rec.append(type, data, t) : rec.append(type, data);
    if (r === null) throw new Error(`基线构造失败：${type} 写入被拒`);
    writes.push({ type, data, ts: t });
  };

  put(SIGNAL_EVENT_TYPE, signalOf('budget-exceeded', 'tokens 12480 > budget 8000 (tool=search)', BASE), 0);
  put(SIGNAL_EVENT_TYPE, signalOf('shadow-deviation', 'tokens shadow ratio 1.56 > 1.5 (baseline=8000, actual=12480, tool=search)', BASE), 10);
  put(SIGNAL_EVENT_TYPE, signalOf('memory-write-audited', 'memory/writing-style.md write audited (highest level): tool=fs', BASE), 20);

  const sig = rec.recorded.slice(0, 3);
  let rows: LedgerRow[] = [];

  const disps = [
    {
      target_seq: sig[0]!.seq,
      target_chain_hash: sig[0]!.hash.slice(0, 16),
      signal_category: 'budget-exceeded',
      action: 'escalate' as const,
      actor: 'operator-alice',
      rationale: '预算比 1.56 超出该任务标定区间，升级人工核查',
      reviewed_by: 'operator-bob',
      supersedes: null,
      plan: null,
      ts: BASE + 1000,
    },
    {
      target_seq: sig[1]!.seq,
      target_chain_hash: sig[1]!.hash.slice(0, 16),
      signal_category: 'shadow-deviation',
      action: 'confirm_false_positive' as const,
      actor: 'operator-alice',
      rationale: '影子比 1.56 与任务批量检索特征一致，复核判为误报',
      reviewed_by: 'operator-bob',
      supersedes: null,
      plan: null,
      ts: BASE + 2000,
    },
  ];

  for (const [i, d] of disps.entries()) {
    const before = rows;
    const res = appendDispositionToChain(rec, d, before, withTs ? { ts: BASE + 1000 * (i + 1) } : {});
    // 写链后立即投影，保证 existing 与链一致（禁止双写的写法体现）
    rows = projectLedger(rec.recorded);
    if (rows.length !== before.length + 1 || res.projected.disp_seq !== rows.length) {
      throw new Error(`基线构造失败：第 ${i + 1} 条处置投影不一致`);
    }
    writes.push({ type: DISPOSITION_EVENT_TYPE, data: res.data, ts: BASE + 1000 * (i + 1) });
  }

  return { events: rec.recorded.slice(), rows, writes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 检查项
// ─────────────────────────────────────────────────────────────────────────────

const clone = (f: Fixture): Fixture => JSON.parse(JSON.stringify(f)) as Fixture;

export function runChecks(f: Fixture): Check[] {
  const checks: Check[] = [];
  const add = (id: string, name: string, ok: boolean, detail: string) => {
    checks.push({ id, name, ok, detail });
  };

  const disps = f.events.filter((e) => e.type === DISPOSITION_EVENT_TYPE);

  // 投影是多数检查项的共同前提。变异后的 fixture 可能投影失败（例如被删过一条处置），
  // 此时不能抛出去把整个自检打断——那样「期望某项 FAIL」就永远测不到。
  // 改为把失败原因记为状态，由依赖投影的检查项各自 FAIL。
  let projected: LedgerRow[] = [];
  let projectError: string | null = null;
  try {
    projected = projectLedger(f.events);
  } catch (err) {
    projectError = (err as Error).message;
  }

  // B1 同链：五条事件一条链，且独立复算（落盘路径）也一致
  {
    const v = verifyEventChain(f.events);
    const seqsOk = f.events.every((e, i) => e.seq === i + 1);
    const plain = new AppendOnlyAuditLog();
    const rec = new ChainRecorder();
    for (const w of f.writes) {
      plain.append(w.type, w.data, w.ts);
      rec.append(w.type, w.data, w.ts);
    }
    // 包装层与裸链路必须逐条同哈希——否则「两套规格并行漂移」从这一层开始
    const sameAsPlain = f.events.length === f.writes.length
      && f.events.every((e, i) => e.hash === rec.recorded[i]!.hash);
    add(
      'B1',
      '处置与信号同处一条 AppendOnlyAuditLog，seq 连续且可独立复算',
      v.ok && seqsOk && sameAsPlain,
      v.ok && seqsOk && sameAsPlain
        ? `${f.events.length} 条事件（信号 ${f.events.length - disps.length} + 处置 ${disps.length}），全链一致`
        : `复算=${v.reason}；seq连续=${seqsOk}；裸链同哈希=${sameAsPlain}`,
    );
  }

  // B2 载荷键序 = CHAIN_DATA_ORDER（键序漂移即视为改写）
  {
    const bad = disps.filter(
      (e) => Object.keys(e.data as Record<string, unknown>).join(',') !== CHAIN_DATA_ORDER.join(','),
    );
    add(
      'B2',
      '链上处置载荷键序等于冻结的 CHAIN_DATA_ORDER（11 键）',
      disps.length > 0 && bad.length === 0,
      bad.length === 0
        ? `${disps.length} 条处置载荷键序一致（${CHAIN_DATA_ORDER.length} 键）`
        : `${bad.length} 条键序漂移，首条 seq=${bad[0]!.seq}`,
    );
  }

  // B3 投影行与链上载荷逐字段一致（投影不是重写）
  // 注意：比对对象是 fixture 携带的 f.rows，不是当场重算的 projected——
  // 后者永远与链自洽，测不出「投影被改过」这一形态（反测 S1/S2/S5 即为此设）。
  {
    const mismatch: string[] = [];
    if (f.rows.length !== disps.length) mismatch.push(`行数 ${f.rows.length} ≠ 处置事件 ${disps.length}`);
    for (let i = 0; i < Math.min(f.rows.length, disps.length); i += 1) {
      const r = f.rows[i]!;
      const d = disps[i]!.data as Record<string, unknown>;
      for (const k of CHAIN_DATA_ORDER) {
        const a = (r as unknown as Record<string, unknown>)[k];
        if (a !== d[k]) mismatch.push(`第 ${i + 1} 行 ${k}: 投影 ${String(a)} ≠ 链 ${String(d[k])}`);
      }
      if (r.record_type !== 'event' || r.event_type !== 'disposition') mismatch.push(`第 ${i + 1} 行承载字段错误`);
    }
    add(
      'B3',
      '投影行 11 项载荷与链上逐字段相等（含 null 显式化）',
      mismatch.length === 0,
      mismatch.length === 0 ? `${f.rows.length} 行逐字段一致` : mismatch.slice(0, 3).join('；'),
    );
  }

  // B4 投影链按台账规约自洽（第三方 Python 验链的前提）
  {
    const bad: string[] = [];
    for (const [i, r] of f.rows.entries()) {
      const prev = i === 0 ? '' : f.rows[i - 1]!.chain_hash;
      if (r.chain_prev !== prev) bad.push(`第 ${i + 1} 行 chain_prev 不符`);
      const expect = chainHashOf(prev, bodyOf(r));
      if (r.chain_hash !== expect) bad.push(`第 ${i + 1} 行 chain_hash 复算不符`);
      if (r.disp_seq !== i + 1) bad.push(`第 ${i + 1} 行 disp_seq=${r.disp_seq}，应连续`);
    }
    add(
      'B4',
      '投影可按台账冻结规约复算（verify_chain.py 的同一套规则）',
      bad.length === 0,
      bad.length === 0 ? `${f.rows.length} 行哈希链自洽` : bad.slice(0, 3).join('；'),
    );
  }

  // B5 投影幂等（派生而非双写：重跑必须逐字节一致）
  {
    let a = '';
    let b = '';
    let err = '';
    try {
      a = JSON.stringify(projectLedger(f.events));
      b = JSON.stringify(projectLedger(f.events));
    } catch (e) {
      err = (e as Error).message;
    }
    const ok = err === '' && a === b;
    add('B5', '投影幂等（同一事件流两次投影逐字节相同）', ok, ok ? `${a.length} 字节一致` : err || '两次投影不同');
  }

  // B6 篡改处置载荷 → 独立复算必须检出（同链的核心价值）
  {
    const t = clone(f);
    const idx = t.events.findIndex((e) => e.type === DISPOSITION_EVENT_TYPE);
    const target = t.events[idx]!;
    (target.data as Record<string, unknown>).rationale = '（被改写的依据）';
    const v = verifyEventChain(t.events);
    add(
      'B6',
      '改写处置载荷的依据文本 → 复算检出且定位到该条',
      !v.ok && v.badSeq === target.seq,
      !v.ok ? `检出 seq=${v.badSeq}（期望 ${target.seq}）：${v.reason.slice(0, 48)}` : '未检出——同链主张不成立',
    );
  }

  // B7 删除中间一条处置 → 跳号检出（检出点必然落在被删位置的后一条）
  {
    const t = clone(f);
    const idx = t.events.findIndex((e) => e.type === DISPOSITION_EVENT_TYPE);
    const removed = t.events.splice(idx, 1)[0]!;
    const v = verifyEventChain(t.events);
    const next = f.events[idx + 1]!;
    add(
      'B7',
      '删除中间一条处置 → 检出，断点报在被删位置的后一条（链结构决定，非实现选择）',
      !v.ok && v.badSeq === next.seq,
      !v.ok
        ? `检出 seq=${v.badSeq}（删的是 ${removed.seq}，后一条是 ${next.seq}）：${v.reason.slice(0, 40)}`
        : '未检出',
    );
  }

  // B8 键序漂移 → 形状校验抛错
  {
    const d = disps[0]!.data as Record<string, unknown>;
    const swapped: Record<string, unknown> = {};
    const keys = Object.keys(d);
    swapped[keys[1]!] = d[keys[1]!];
    swapped[keys[0]!] = d[keys[0]!];
    for (const k of keys.slice(2)) swapped[k] = d[k];
    let threw = false;
    let msg = '';
    try {
      assertChainDataShape(swapped, '反测');
    } catch (err) {
      threw = err instanceof ChainShapeError;
      msg = (err as Error).message;
    }
    add('B8', '载荷键序漂移 → assertChainDataShape 抛错', threw, threw ? msg.slice(0, 70) : '未抛错');
  }

  // B9 disp_seq 跳号 → 投影抛错（删除处置不得被静默容忍）
  {
    const t = clone(f);
    const d = t.events.find((e) => e.type === DISPOSITION_EVENT_TYPE)!;
    (d.data as Record<string, unknown>).disp_seq = 9;
    let threw = false;
    let msg = '';
    try {
      projectLedger(t.events);
    } catch (err) {
      threw = err instanceof ChainShapeError;
      msg = (err as Error).message;
    }
    add('B9', 'disp_seq 跳号 → 投影抛错（不静默接受被删过的链）', threw, threw ? msg.slice(0, 70) : '未抛错');
  }

  // B10 未登记类别 → 拒写且链长度不变（fail-closed 且不污染链）
  {
    const rec = new ChainRecorder();
    for (const w of f.writes) rec.append(w.type, w.data, w.ts);
    const before = rec.recorded.length;
    let threw = false;
    let msg = '';
    try {
      appendDispositionToChain(
        rec,
        {
          target_seq: 1,
          target_chain_hash: 'a'.repeat(16),
          signal_category: 'auto-block',
          action: 'escalate',
          actor: 'operator-alice',
          rationale: '未登记类别',
          reviewed_by: 'operator-bob',
          supersedes: null,
          plan: null,
          ts: BASE + 9000,
        },
        f.rows,
        { ts: BASE + 9000 },
      );
    } catch (err) {
      threw = true;
      msg = (err as Error).message;
    }
    add(
      'B10',
      '未在义务注册表登记的类别 → 拒写且链长度不变',
      threw && rec.recorded.length === before,
      threw
        ? `拒写；链长度 ${before} → ${rec.recorded.length}（未污染）：${msg.slice(0, 40)}`
        : '未拒写——写入口失守',
    );
  }

  // B11 自审自批 → 拒写
  {
    let threw = false;
    let msg = '';
    try {
      appendDispositionToChain(
        new ChainRecorder(),
        {
          target_seq: 1,
          target_chain_hash: 'b'.repeat(16),
          signal_category: 'budget-exceeded',
          action: 'escalate',
          actor: 'operator-alice',
          rationale: '自审自批',
          reviewed_by: 'operator-alice',
          supersedes: null,
          plan: null,
          ts: BASE + 9001,
        },
        [],
        { ts: BASE + 9001 },
      );
    } catch (err) {
      threw = true;
      msg = (err as Error).message;
    }
    add('B11', 'reviewed_by === actor（自审自批）→ 拒写', threw, threw ? msg.slice(0, 70) : '未拒写');
  }

  // B12 链拒写（append 返回 null）→ 显式失败，不静默当作已登记
  {
    const nullSink = { append: () => null };
    let threw = false;
    try {
      appendDispositionToChain(
        nullSink,
        {
          target_seq: 1,
          target_chain_hash: 'c'.repeat(16),
          signal_category: 'budget-exceeded',
          action: 'escalate',
          actor: 'operator-alice',
          rationale: '链拒写',
          reviewed_by: 'operator-bob',
          supersedes: null,
          plan: null,
          ts: BASE + 9002,
        },
        [],
        { ts: BASE + 9002 },
      );
    } catch (err) {
      threw = err instanceof ChainWriteError;
    }
    add('B12', '框架链拒写 → 抛 ChainWriteError（不静默成功）', threw, threw ? '已抛错' : '未抛错');
  }

  // B13 迁移：同链引用可完整匹配
  {
    const map = migrateLedger(f.rows, f.events);
    const allMatched = map.total > 0 && map.unmapped === 0 && map.entries.every((e) => e.matched);
    add(
      'B13',
      '迁移：台账引用来自同一链 → 全部匹配且记录框架位置',
      allMatched,
      allMatched
        ? `${map.matched}/${map.total} 匹配，如 disp_seq=${map.entries[0]!.disp_seq} → 框架 seq=${map.entries[0]!.framework!.seq}`
        : `matched=${map.matched}/${map.total}，未匹配原因：${map.entries.filter((e) => !e.matched).map((e) => `${e.disp_seq}:${e.reason}`).join(',')}`,
    );
  }

  // B14 迁移：前缀不符 → unmapped 且保留原引用（不丢弃）
  {
    const rows = clone(f).rows;
    rows[0]!.target_chain_hash = '0'.repeat(16);
    const map = migrateLedger(rows, f.events);
    const e0 = map.entries[0]!;
    add(
      'B14',
      '迁移：target_chain_hash 前缀不符 → 标 unmapped 且保留原引用',
      !e0.matched && e0.reason === 'hash_prefix_mismatch' && e0.original_ref.includes('stage1:'),
      `matched=${e0.matched} reason=${e0.reason} candidates=${e0.candidates} original_ref=${e0.original_ref}`,
    );
  }

  // B15 迁移：源中无该类别 → 原因可区分（不是笼统 unmapped）
  {
    const rows = clone(f).rows;
    rows[0]!.signal_category = 'periodic-egress';
    const map = migrateLedger(rows, f.events);
    const e0 = map.entries[0]!;
    add(
      'B15',
      '迁移：框架链中无该类别信号 → reason=no_signal_of_category',
      !e0.matched && e0.reason === 'no_signal_of_category' && e0.candidates === 0,
      `matched=${e0.matched} reason=${e0.reason} candidates=${e0.candidates}`,
    );
  }

  // B16 迁移：多候选同前缀（64 位碰撞）→ 标 ambiguous，不任选一条
  {
    const ev: FrameworkEvent[] = [
      { seq: 1, type: SIGNAL_EVENT_TYPE, data: { kind: 'budget-exceeded', detail: 'x' }, ts: BASE, hash: 'a'.repeat(16) + '1'.repeat(48) },
      { seq: 2, type: SIGNAL_EVENT_TYPE, data: { kind: 'budget-exceeded', detail: 'y' }, ts: BASE + 1, hash: 'a'.repeat(16) + '2'.repeat(48) },
    ];
    const row = clone(f).rows[0]!;
    row.signal_category = 'budget-exceeded';
    row.target_chain_hash = 'a'.repeat(16);
    const map = migrateLedger([row], ev);
    const e0 = map.entries[0]!;
    add(
      'B16',
      '迁移：两条候选共享 16 位前缀 → 标 ambiguous（不任选一条）',
      !e0.matched && e0.reason === 'ambiguous' && e0.candidates === 2,
      `matched=${e0.matched} reason=${e0.reason} candidates=${e0.candidates}`,
    );
  }

  // B17 可复现：注入 ts 则逐条同哈希；不注入则不可复现（证明注入是必要的）
  {
    const a = buildFixture({ withTs: true });
    const b = buildFixture({ withTs: true });
    const deterministic = a.events.length === b.events.length
      && a.events.every((e, i) => e.hash === b.events[i]!.hash && e.ts === b.events[i]!.ts);

    const c = buildFixture({ withTs: false });
    const end = Date.now() + 6;
    while (Date.now() < end) { /* 保证跨毫秒，避免同 ms 误判为可复现 */ }
    const d = buildFixture({ withTs: false });
    const notDet = c.events.some((e, i) => e.hash !== d.events[i]!.hash || e.ts !== d.events[i]!.ts);

    add(
      'B17',
      '注入 ts ⇒ 逐条同哈希；不注入 ⇒ 不可复现（证明 append 的 ts 参数是必需的）',
      deterministic && notDet,
      `注入=${deterministic ? '可复现' : '仍不可复现'}；不注入=${notDet ? '不可复现' : '意外可复现'}`,
    );
  }

  // B18 处置事件不挤占投影：非处置事件一律不进台账视图
  {
    const nonDisp = f.events.filter((e) => e.type !== DISPOSITION_EVENT_TYPE).length;
    const ok = projectError === null && projected.length === f.events.length - nonDisp;
    add('B18', '投影只取 disposition 事件，entry_deny / exit_reject / ledger_signal 不入台账', ok, projectError !== null ? `投影失败：${projectError.slice(0, 60)}` : ok ? `跳过 ${nonDisp} 条非处置事件` : `行数 ${projected.length} ≠ 处置事件数 ${f.events.length - nonDisp}`);
  }

  // B19 尾部截断：链自证**检不出**（固有边界），只有摘要外锚能检出。
  // 这条不是「已经解决」，而是把边界钉成可复现的事实——报告不得声称它能检出尾部截断。
  {
    const t = clone(f);
    t.events.splice(t.events.length - 1, 1); // 删最后一条（处置）
    const v = verifyEventChain(t.events);
    const anchoredBefore = chainDigest(f.events);
    const anchoredAfter = chainDigest(t.events);
    const selfBlind = v.ok; // 期望 true：自洽，故检不出
    const anchorCatches = anchoredBefore.count !== anchoredAfter.count
      || anchoredBefore.lastHash !== anchoredAfter.lastHash;
    add(
      'B19',
      '尾部截断：链自证检不出（固有边界），须由 {count,lastHash} 外锚方可检出',
      selfBlind && anchorCatches,
      `链复算=${v.ok ? 'PASS（故检不出）' : 'FAIL'}；外锚 ${anchoredBefore.count}→${anchoredAfter.count} 条、末哈希${anchorCatches ? '已变（可检出）' : '未变'}`,
    );
  }

  return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 输出与自检
// ─────────────────────────────────────────────────────────────────────────────

function report(checks: Check[]): void {
  const bad = checks.filter((c) => !c.ok);
  console.log('');
  console.log('处置通道 · 集成层（同链）自检');
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
  const base = buildFixture();
  const baseChecks = runChecks(base);
  const baseBad = baseChecks.filter((c) => !c.ok);
  console.log(`[基线] PASS=${baseChecks.length - baseBad.length} FAIL=${baseBad.length}`);
  if (baseBad.length > 0) {
    for (const c of baseBad) console.log(`  FAIL ${c.id} ${c.name} → ${c.detail}`);
    console.log('基线不通过，自检无意义。');
    return 1;
  }

  const cases: Array<{ label: string; expect: string; mutate: (f: Fixture) => void }> = [
    {
      label: 'S1 投影行 chain_hash 末位改为 0',
      expect: 'B4',
      mutate: (f) => {
        const h = f.rows[0]!.chain_hash;
        f.rows[0]!.chain_hash = h.slice(0, -1) + (h.endsWith('0') ? '1' : '0');
      },
    },
    {
      label: 'S2 投影行 action 改成链上没有的值（投影被重写的形态）',
      expect: 'B3',
      mutate: (f) => {
        (f.rows[0] as unknown as Record<string, unknown>).action = 'route_to_human';
      },
    },
    {
      label: 'S3 从事件流删掉一条处置事件',
      expect: 'B1',
      mutate: (f) => {
        const i = f.events.findIndex((e) => e.type === DISPOSITION_EVENT_TYPE);
        f.events.splice(i, 1);
      },
    },
    {
      label: 'S4 链上处置事件的 ts 改 +1（内容未动，位置被挪）',
      expect: 'B1',
      mutate: (f) => {
        const e = f.events.find((x) => x.type === DISPOSITION_EVENT_TYPE)!;
        e.ts += 1;
      },
    },
    {
      label: 'S5 投影行 target_seq 改成链上没有的值',
      expect: 'B3',
      mutate: (f) => {
        f.rows[1]!.target_seq = 99;
      },
    },
    {
      label: 'S6 投影行 disp_seq 改成不连续值',
      expect: 'B4',
      mutate: (f) => {
        f.rows[1]!.disp_seq = 7;
      },
    },
  ];

  let bad = 0;
  for (const [i, c] of cases.entries()) {
    const f = clone(base);
    c.mutate(f);
    const rows = runChecks(f);
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

/** 人类可读演示：链上有什么、投影出什么、真实台账迁移会怎样。 */
function demo(): number {
  const f = buildFixture();
  console.log('');
  console.log(`框架链（同一 AppendOnlyAuditLog）：${f.events.length} 条`);
  console.log('─'.repeat(76));
  for (const e of f.events) {
    const tag = e.type === DISPOSITION_EVENT_TYPE ? '处置' : '信号';
    const extra = e.type === DISPOSITION_EVENT_TYPE
      ? `disp_seq=${(e.data as Record<string, unknown>).disp_seq} → target seq=${(e.data as Record<string, unknown>).target_seq} · ${(e.data as Record<string, unknown>).action}`
      : `${(e.data as Record<string, unknown>).kind}`;
    console.log(`  seq ${String(e.seq).padStart(2)} [${tag}] ${extra}`);
    console.log(`         hash=${e.hash.slice(0, 24)}…`);
  }
  const v = verifyEventChain(f.events);
  console.log(`  复算：${v.ok ? 'PASS' : 'FAIL'} — ${v.reason}`);

  console.log('');
  console.log(`投影台账（可交 verify_chain.py 验）：${f.rows.length} 行`);
  console.log('─'.repeat(76));
  for (const r of f.rows) {
    console.log(`  [${r.disp_seq}] seq ${r.target_seq} ${r.action} · ${r.signal_category} · 复核=${r.reviewed_by ?? '—'}`);
    console.log(`        chain_hash=${r.chain_hash.slice(0, 24)}…`);
  }

  const real = readLedger();
  const map = migrateLedger(real, f.events);
  console.log('');
  console.log(`入库台账迁移到本链（${real.length} 行，真实数据）：`);
  console.log('─'.repeat(76));
  for (const e of map.entries) {
    console.log(`  disp_seq=${e.disp_seq} ${e.matched ? '→ 框架 seq=' + e.framework!.seq : `→ unmapped（${e.reason}，候选 ${e.candidates}）`}`);
    console.log(`        original_ref=${e.original_ref}`);
  }
  console.log(`  合计 ${map.total} 行：匹配 ${map.matched} / 未匹配 ${map.unmapped}（未匹配一律保留，不丢弃）`);
  console.log('');
  return 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  const emitArg = argv.find((a) => a.startsWith('--emit-ledger='));

  if (argv.includes('--selftest')) {
    process.exitCode = selftest();
  } else if (argv.includes('--demo')) {
    process.exitCode = demo();
  } else if (emitArg !== undefined) {
    // 把投影台账落盘，交给 verify_chain.py（Python 参照实现）做**跨语言**复核。
    // 这是门禁第 50 项的实质：同链产物必须能被第三方那条独立实现验过，
    // 否则「可核验」只是本语言内部的自洽。
    const path = emitArg.slice('--emit-ledger='.length);
    const rows = buildFixture().rows;
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(resolve(path), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    console.log(`emitted rows=${rows.length} → ${path}`);
  } else {
    const checks = runChecks(buildFixture());
    report(checks);
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  }
}

// 仅在作为脚本执行时跑 CLI——被 check-anchor.mts 导入 buildFixture 时不得有副作用
// （否则 `import` 本身就会按对方的 argv 做一遍自检并置 exitCode）。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
