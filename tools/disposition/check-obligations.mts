#!/usr/bin/env node
/**
 * check-obligations.mts —— 义务注册表 ↔ 条款 ↔ 实现 三方一致性校验（门禁第 49 项）
 *
 * 为什么需要它：10-D4 的表格在 v2.67.0 里写了三个**实现中不存在**的类别名
 * （`memory-write-unauthorized` / `shadow-ratio-deviation` / `periodic-touch-hit`），
 * 而实现用的是 `memory-write-audited` / `shadow-deviation` / `periodic-egress`。
 * 条款与实现对不上时，fail-closed 会一边拦真实信号、一边放过条款里写的类别——
 * 这种不一致不会被任何现有检查发现，因为两边各自都「自洽」。
 *
 * 本脚本把三方钉在一起：
 *   注册表(obligations.json) ↔ 框架实现(index.ts 的 LedgerSignalKind) ↔ 条款(spec/10 双语 10-D4/10-D8)
 *
 * 用法：
 *   node --experimental-transform-types tools/disposition/check-obligations.mts           # 校验
 *   node --experimental-transform-types tools/disposition/check-obligations.mts --selftest # 反向测试
 *
 * 退出码：0 = 全通过；1 = 有失败。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRIORITY_SLA_HOURS,
  annotateSla,
  assertDeclared,
  computeCompleteness,
  loadObligations,
  type ObligationsDoc,
  type Priority,
  type SignalInput,
} from './obligations.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const F_REGISTRY = resolve(HERE, 'obligations.json');
const F_INDEX = resolve(ROOT, 'reference', 'runtimes', 'l2-runtime-oversight', 'index.ts');
const F_SPEC_ZH = resolve(ROOT, 'spec', '10-resource-ledger.md');
const F_SPEC_EN = resolve(ROOT, 'spec', '10-resource-ledger.en.md');

export interface Check {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
}

export interface Sources {
  registry: ObligationsDoc;
  /** 注册表加载是否抛错（C1 用）。 */
  registryError: string | null;
  kinds: string[];
  specZh: string;
  specEn: string;
}

const read = (p: string): string => readFileSync(p, 'utf-8');

// ─────────────────────────────────────────────────────────────────────────────
// 解析器
// ─────────────────────────────────────────────────────────────────────────────

/** 从 index.ts 抓 `export type LedgerSignalKind = ...;` 的字面量集合。 */
export function parseKindLiterals(src: string): string[] {
  const m = /export type LedgerSignalKind\s*=([\s\S]*?);/.exec(src);
  if (!m) return [];
  const body = m[1]!;
  const out: string[] = [];
  for (const hit of body.matchAll(/'([a-z][a-z0-9-]*)'/g)) out.push(hit[1]!);
  return out;
}

/** `24h` / `7d` → 小时。无法解析返回 NaN（由 C5 判失败，不静默当 0）。 */
export function parseDeadlineHours(cell: string): number {
  const t = cell.trim();
  const h = /^(\d+)\s*h$/i.exec(t);
  if (h) return Number(h[1]);
  const d = /^(\d+)\s*d$/i.exec(t);
  if (d) return Number(d[1]) * 24;
  return Number.NaN;
}

export interface D4Row {
  level: string;
  names: string[];
  hours: number;
}

/** 解析 10-D4 表格（中英同构：| P0 | 类别… | 时限 | 标定状态 |）。 */
export function parseD4Table(md: string): D4Row[] {
  const start = md.indexOf('### 10-D4');
  if (start === -1) return [];
  const end = md.indexOf('### 10-D5', start);
  const block = end === -1 ? md.slice(start) : md.slice(start, end);

  const rows: D4Row[] = [];
  for (const line of block.split('\n')) {
    if (!/^\|\s*P[0-2]\s*\|/.test(line)) continue;
    const cells = line.split('|');
    const level = cells[1]!.trim();
    const nameCell = cells[2] ?? '';
    const names = [...nameCell.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
    rows.push({ level, names, hours: parseDeadlineHours(cells[3] ?? '') });
  }
  return rows;
}

/** 取 10-D8 表里某条款的整行。找不到返回 null。 */
export function parseD8Row(md: string, clauseId: string): string | null {
  const start = md.indexOf('### 10-D8');
  if (start === -1) return null;
  const end = md.indexOf('### 10-D9', start);
  const block = end === -1 ? md.slice(start) : md.slice(start, end);
  for (const line of block.split('\n')) {
    if (line.startsWith(`| ${clauseId} `)) return line;
  }
  return null;
}

/** 中文表：含「已实现」且不含「未实现」；英文表：含 **implemented** 且不含 not implemented。 */
export function d8SaysImplemented(row: string | null, lang: 'zh' | 'en'): boolean {
  if (row === null) return false;
  if (lang === 'zh') return row.includes('已实现') && !row.includes('未实现');
  return row.includes('**implemented**') && !row.includes('not implemented');
}

export function loadSources(): Sources {
  let registry: ObligationsDoc;
  let registryError: string | null = null;
  try {
    registry = loadObligations(F_REGISTRY);
  } catch (err) {
    registryError = (err as Error).message;
    registry = { categories: {} } as ObligationsDoc;
  }
  return {
    registry,
    registryError,
    kinds: parseKindLiterals(read(F_INDEX)),
    specZh: read(F_SPEC_ZH),
    specEn: read(F_SPEC_EN),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 校验主体
// ─────────────────────────────────────────────────────────────────────────────

const sorted = (a: Iterable<string>): string[] => [...a].sort();

export function runChecks(src: Sources): Check[] {
  const out: Check[] = [];
  const regCats = Object.keys(src.registry.categories ?? {});

  // C1 注册表自身合法（加载期已校验 priority↔sla 对应、owner_role、rationale）
  out.push({
    id: 'C1',
    name: '义务注册表可加载且内部自洽（priority↔sla / owner_role / rationale）',
    ok: src.registryError === null && regCats.length > 0,
    detail: src.registryError ?? `${regCats.length} 个类别`,
  });

  // C2 注册表类别集合 == 框架 LedgerSignalKind 集合
  {
    const a = sorted(regCats);
    const b = sorted(new Set(src.kinds));
    const ok = a.length > 0 && b.length > 0 && a.join(',') === b.join(',');
    out.push({
      id: 'C2',
      name: '注册表类别集合 == index.ts LedgerSignalKind 集合',
      ok,
      detail: ok ? a.join(' / ') : `注册表[${a.join(',')}] vs 实现[${b.join(',')}]`,
    });
  }

  // C3 / C4 条款表格类别集合 == 注册表集合（中英各自）
  const regSet = sorted(regCats);
  for (const [id, lang, md] of [
    ['C3', 'zh', src.specZh],
    ['C4', 'en', src.specEn],
  ] as const) {
    const rows = parseD4Table(md);
    const tableCats = sorted(new Set(rows.flatMap((r) => r.names)));
    const ok = rows.length === 3 && tableCats.join(',') === regSet.join(',');
    const missing = regSet.filter((x) => !tableCats.includes(x));
    const extra = tableCats.filter((x) => !regSet.includes(x));
    out.push({
      id,
      name: `10-D4 表格类别集合（${lang}）== 注册表集合`,
      ok,
      detail: ok
        ? `${rows.length} 级 / ${tableCats.length} 类`
        : `缺[${missing.join(',') || '—'}] 多[${extra.join(',') || '—'}] 行数=${rows.length}`,
    });
  }

  // C5 中英逐级时限一致，且等于 PRIORITY_SLA_HOURS 权威值
  {
    const zh = parseD4Table(src.specZh);
    const en = parseD4Table(src.specEn);
    const bad: string[] = [];
    for (const r of zh) {
      const expect = PRIORITY_SLA_HOURS[r.level as Priority];
      if (r.hours !== expect) bad.push(`zh ${r.level}: ${r.hours}h != ${expect}h`);
      const mirror = en.find((x) => x.level === r.level);
      if (!mirror) bad.push(`en 缺 ${r.level} 行`);
      else if (mirror.hours !== r.hours) bad.push(`${r.level}: zh ${r.hours}h != en ${mirror.hours}h`);
    }
    for (const r of en) {
      const expect = PRIORITY_SLA_HOURS[r.level as Priority];
      if (r.hours !== expect) bad.push(`en ${r.level}: ${r.hours}h != ${expect}h`);
    }
    const ok = bad.length === 0 && zh.length === 3 && en.length === 3;
    out.push({
      id: 'C5',
      name: '10-D4 逐级时限：中英一致且等于 PRIORITY_SLA_HOURS（24/72/168）',
      ok,
      detail: ok ? 'P0=24h P1=72h P2=168h' : bad.join('; ') || '行数异常',
    });
  }

  // C6 10-D8 里 10-D4 / 10-D5 中英均标「已实现」
  {
    const bad: string[] = [];
    for (const clause of ['10-D4', '10-D5']) {
      if (!d8SaysImplemented(parseD8Row(src.specZh, clause), 'zh')) bad.push(`zh ${clause} 未标已实现`);
      if (!d8SaysImplemented(parseD8Row(src.specEn, clause), 'en')) bad.push(`en ${clause} 未标 implemented`);
    }
    out.push({
      id: 'C6',
      name: '10-D8 实现状态：10-D4 / 10-D5 中英均记为已实现',
      ok: bad.length === 0,
      detail: bad.length === 0 ? '10-D4 / 10-D5 = 已实现' : bad.join('; '),
    });
  }

  // C7 聚合行为：空集 null / 全超时 1 / 时钟倒挂不计 overdue / 未声明类别不入分母
  {
    const bad: string[] = [];
    const reg = src.registry;
    const NOW = 1_800_000_000_000;
    const H = 3_600_000;

    // 空集：rate 必须是 null，不能是 0
    const empty = computeCompleteness([], 0);
    if (empty.undisposed_rate !== null) bad.push(`空集 undisposed_rate=${String(empty.undisposed_rate)}（应为 null）`);
    if (empty.overdue_rate !== null) bad.push(`空集 overdue_rate=${String(empty.overdue_rate)}（应为 null）`);

    // 全超时：1 条 P0 unhandled、信号在 25h 前 → overdue_rate = 1
    const all: SignalInput[] = [{ seq: 1, category: 'memory-write-audited', signal_ts: NOW - 25 * H, state: 'unhandled' }];
    const a = annotateSla(all, reg, NOW);
    const ac = computeCompleteness(a.rows, a.undeclared.length);
    if (ac.overdue_rate !== 1) bad.push(`P0 25h 未处置 overdue_rate=${String(ac.overdue_rate)}（应为 1）`);

    // 未到时限：P0 在 23h 前 → 不 overdue
    const fresh = annotateSla([{ seq: 2, category: 'memory-write-audited', signal_ts: NOW - 23 * H, state: 'unhandled' }], reg, NOW);
    if (fresh.rows[0]!.overdue) bad.push('P0 23h 被判 overdue（时限 24h 未到）');

    // 已闭合即使超时也不算 overdue（10-D5：overdue 只统计仍 unhandled）
    const closed = annotateSla([{ seq: 3, category: 'memory-write-audited', signal_ts: NOW - 100 * H, state: 'closed' }], reg, NOW);
    if (closed.rows[0]!.overdue) bad.push('closed 状态被判 overdue（应仅统计 unhandled）');

    // 时钟倒挂：signal_ts 在未来 → clock_skew=true 且 overdue=false
    const skew = annotateSla([{ seq: 4, category: 'budget-exceeded', signal_ts: NOW + 5 * H, state: 'unhandled' }], reg, NOW);
    if (!skew.rows[0]!.clock_skew) bad.push('未来 ts 未被标 clock_skew');
    if (skew.rows[0]!.overdue) bad.push('未来 ts 被判 overdue（倒挂不得计入超期）');
    const sc = computeCompleteness(skew.rows, 0);
    if (sc.clock_skew !== 1) bad.push(`clock_skew 计数=${sc.clock_skew}（应为 1）`);

    // 未声明类别：单列、不入分母、provisional=true
    const mixed = annotateSla(
      [
        { seq: 5, category: 'budget-exceeded', signal_ts: NOW - 1 * H, state: 'closed' },
        { seq: 6, category: 'no-such-category', signal_ts: NOW - 1 * H, state: 'unhandled' },
      ],
      reg,
      NOW,
    );
    if (mixed.undeclared.length !== 1) bad.push(`未声明类别未单列（undeclared=${mixed.undeclared.length}）`);
    const mc = computeCompleteness(mixed.rows, mixed.undeclared.length);
    if (mc.n_signals_declared !== 1) bad.push(`未声明类别被计入分母（declared=${mc.n_signals_declared}）`);
    if (!mc.provisional) bad.push('存在未声明类别但 provisional=false');

    // now 必传：0 应抛错
    let threw = false;
    try {
      annotateSla([], reg, 0);
    } catch {
      threw = true;
    }
    if (!threw) bad.push('now=0 未抛错（now 必须显式传入）');

    out.push({
      id: 'C7',
      name: '10-D5 聚合行为：空集 null / 超时 1 / 闭合不计 / 倒挂标脏 / 未声明不入分母 / now 必传',
      ok: bad.length === 0,
      detail: bad.length === 0 ? '9 条断言通过' : bad.join('; '),
    });
  }

  // C8 fail-closed：未声明类别必须被拒
  {
    let rejected = false;
    let accepted = false;
    try {
      assertDeclared(src.registry, 'no-such-category');
    } catch {
      rejected = true;
    }
    try {
      assertDeclared(src.registry, regCats[0] ?? '');
      accepted = regCats.length > 0;
    } catch {
      accepted = false;
    }
    out.push({
      id: 'C8',
      name: '10-D4 fail-closed：未声明类别拒写、已声明类别放行',
      ok: rejected && accepted,
      detail: rejected && accepted ? '双向正确' : `拒写=${rejected} 放行=${accepted}`,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出与自检
// ─────────────────────────────────────────────────────────────────────────────

function printReport(checks: Check[]): void {
  const bad = checks.filter((c) => !c.ok);
  console.log('');
  console.log('义务注册表 · 条款 · 实现 三方一致性（spec/10 10-D4 / 10-D5）');
  console.log('─'.repeat(76));
  for (const c of checks) {
    console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.id} ${c.name}`);
    console.log(`       ${c.detail}`);
  }
  console.log('─'.repeat(76));
  console.log(`合计 ${checks.length} 项：PASS ${checks.length - bad.length} / FAIL ${bad.length}`);
  console.log('');
}

/** 反向测试：每组变异都断言「指定检查项」被命中，而不是「任意一项 FAIL」—— */
/** 否则一条变异被别的检查顺带拦住，就以为该检查有判别力（D-5 同类陷阱）。 */
function selftest(): number {
  const base = loadSources();
  const baseChecks = runChecks(base);
  const baseBad = baseChecks.filter((c) => !c.ok);
  console.log(`[基线] PASS=${baseChecks.length - baseBad.length} FAIL=${baseBad.length}`);
  if (baseBad.length > 0) {
    for (const c of baseBad) console.log(`  FAIL ${c.id} ${c.name} → ${c.detail}`);
    console.log('基线不通过，自检无意义。');
    return 1;
  }

  const clone = (s: Sources): Sources => ({
    registry: JSON.parse(JSON.stringify(s.registry)) as ObligationsDoc,
    registryError: s.registryError,
    kinds: [...s.kinds],
    specZh: s.specZh,
    specEn: s.specEn,
  });

  const cases: Array<{ label: string; expect: string; mutate: (s: Sources) => void }> = [
    {
      label: 'S1 注册表塞入实现不存在的类别 auto-block',
      expect: 'C2',
      mutate: (s) => {
        s.registry.categories['auto-block'] = {
          priority: 'P0',
          sla_hours: 24,
          owner_role: 'x',
          reversibility: 'y',
          rationale: 'z',
        };
      },
    },
    {
      label: 'S2 注册表删掉 periodic-egress',
      expect: 'C2',
      mutate: (s) => {
        delete s.registry.categories['periodic-egress'];
      },
    },
    {
      label: 'S3 中文 10-D4 表格写回老名字 memory-write-unauthorized',
      expect: 'C3',
      mutate: (s) => {
        s.specZh = s.specZh.replace('`memory-write-audited`', '`memory-write-unauthorized`');
      },
    },
    {
      label: 'S4 英文 10-D4 的 P1 时限写成 48h',
      expect: 'C5',
      mutate: (s) => {
        s.specEn = s.specEn.replace('| 72h |', '| 48h |');
      },
    },
    {
      label: 'S5 中文 10-D8 的 10-D4 改回「未实现」',
      expect: 'C6',
      mutate: (s) => {
        s.specZh = s.specZh.replace(
          '| 10-D4 义务与时限 | 已定 | **已实现**',
          '| 10-D4 义务与时限 | 已定 | **未实现**',
        );
      },
    },
    {
      label: 'S6 注册表把 P0 的 sla_hours 改成 168',
      expect: 'C1',
      mutate: (s) => {
        for (const k of Object.keys(s.registry.categories)) {
          if (s.registry.categories[k]!.priority === 'P0') s.registry.categories[k]!.sla_hours = 168;
        }
        s.registryError = '模拟：priority/sla 不一致';
      },
    },
    {
      label: 'S7 index.ts 删掉 memory-write-audited 这个 kind',
      expect: 'C2',
      mutate: (s) => {
        s.kinds = s.kinds.filter((k) => k !== 'memory-write-audited');
      },
    },
    {
      label: 'S8 注册表某类别 owner_role 置空',
      expect: 'C1',
      mutate: (s) => {
        s.registry.categories['budget-exceeded']!.owner_role = '   ';
        s.registryError = '模拟：owner_role 为空';
      },
    },
  ];

  let bad = 0;
  for (const [i, c] of cases.entries()) {
    const s = clone(base);
    c.mutate(s);
    const rows = runChecks(s);
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

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  process.exitCode = selftest();
} else {
  const checks = runChecks(loadSources());
  printReport(checks);
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}
