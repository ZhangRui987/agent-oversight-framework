#!/usr/bin/env node
/**
 * demo-converge.mts —— V1 孤儿信号收敛的端到端演示
 *
 * 做什么：读取面板 V1 产物（tools/audit-panel/data/events.jsonl）里的 3 条 ledger_signal，
 *        在**独立**的处置台账里登记三条处置，演示「孤儿清单可收敛」。
 *
 * ⚠️ 这是演示数据，不是真实运维处置：
 *    - actor 为 demo-operator，rationale 一律以「演示数据」开头；
 *    - ts 按固定偏移生成（3h / 26h / 71h），**不代表真实处置时效**（红线 6：时序不可信）。
 *
 * 为什么刻意不写三条「已闭合」：confirm_false_positive 可以一键关掉任何信号，
 * 若三条全闭合，「孤儿归零」会被读成「缺口已解」。演示按设计稿 §6 固定为
 *   2 条闭合（escalate / confirm_false_positive）+ 1 条未闭合（route_to_human——
 *   转交人工不等于处置完成）。
 *
 * 用法：
 *   node --experimental-transform-types tools/disposition/demo-converge.mts [--force]
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LEDGER_FILE,
  appendDisposition,
  indexLedger,
  readLedger,
  stateOf,
  type DispositionAction,
} from './ledger.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS_FILE = resolve(HERE, '../audit-panel/data/events.jsonl');
const OUT_FILE = DEFAULT_LEDGER_FILE;

interface SignalEvent {
  seq: number;
  category: string;
  detail: string;
  ts: number;
  chain_hash: string;
}

/** 三条处置：与设计稿 §6 的验收形态逐条对应。 */
const PLAN: Array<{
  targetSeq: number;
  action: DispositionAction;
  actor: string;
  reviewed_by: string | null;
  rationale: string;
  /** 相对信号 ts 的偏移（毫秒）——演示值，不可当真实时延引用。 */
  offsetMs: number;
}> = [
  {
    targetSeq: 7,
    action: 'escalate',
    actor: 'demo-operator',
    reviewed_by: 'demo-reviewer',
    rationale: '演示数据：预算比 4.16 远超该任务配置（8000 → 12480 tokens），升级人工核查（非真实运维处置）',
    offsetMs: 3 * 3600_000,
  },
  {
    targetSeq: 8,
    action: 'confirm_false_positive',
    actor: 'demo-operator',
    reviewed_by: 'demo-reviewer',
    rationale: '演示数据：影子比 4.16 与任务批量检索特征一致，复核判为误报（非真实运维处置）',
    offsetMs: 26 * 3600_000,
  },
  {
    targetSeq: 9,
    action: 'route_to_human',
    actor: 'demo-operator',
    reviewed_by: null,
    rationale: '演示数据：记忆写入涉及偏好字段，转人工确认留存策略（非真实运维处置）',
    offsetMs: 71 * 3600_000,
  },
];

function loadSignals(): SignalEvent[] {
  if (!existsSync(EVENTS_FILE)) {
    console.error(`缺少 ${EVENTS_FILE}——请先运行 scenario/export-events.mts`);
    process.exit(1);
  }
  const lines = readFileSync(EVENTS_FILE, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  return lines
    .slice(1)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.event_type === 'ledger_signal')
    .map((e) => ({
      seq: Number(e.seq),
      category: String(e.category),
      detail: String(e.detail),
      ts: Number(e.ts),
      chain_hash: String(e.chain_hash),
    }));
}

function main(): void {
  const force = process.argv.slice(2).includes('--force');
  if (existsSync(OUT_FILE)) {
    if (!force) {
      console.error(`台账已存在：${OUT_FILE}（重跑演示请加 --force，会删除并重建）`);
      process.exitCode = 1;
      return;
    }
    rmSync(OUT_FILE);
  }

  const signals = loadSignals();
  const bySeq = new Map(signals.map((s) => [s.seq, s]));

  for (const p of PLAN) {
    const sig = bySeq.get(p.targetSeq);
    if (!sig) {
      console.error(`V1 产物中没有 seq=${p.targetSeq} 的 ledger_signal——演示前提不成立`);
      process.exitCode = 1;
      return;
    }
    appendDisposition(
      {
        target_seq: sig.seq,
        target_chain_hash: sig.chain_hash.slice(0, 16),
        signal_category: sig.category,
        action: p.action,
        actor: p.actor,
        rationale: p.rationale,
        reviewed_by: p.reviewed_by,
        supersedes: null,
        plan: null,
        ts: sig.ts + p.offsetMs,
      },
      OUT_FILE,
    );
  }

  const rows = readLedger(OUT_FILE);
  const index = indexLedger(rows);
  const states = signals.map((s) => ({ seq: s.seq, category: s.category, ...stateOf(s.seq, index) }));
  const closed = states.filter((s) => s.state === 'closed').length;
  const observing = states.filter((s) => s.state === 'observing').length;
  const unhandled = states.filter((s) => s.state === 'unhandled').length;

  console.log('');
  console.log('V1 孤儿信号收敛演示（演示数据，非真实运维处置）');
  console.log('─'.repeat(66));
  console.log(`  台账          ${OUT_FILE}`);
  console.log(`  信号来源      ${EVENTS_FILE}`);
  console.log('');
  console.log(`  处置前        孤儿 ${signals.length} 条（全部未处置）`);
  for (const s of states) {
    console.log(`  [seq ${String(s.seq).padStart(2)}] ${s.category.padEnd(22)} ${s.state.padEnd(10)} ${s.note}（disp ${s.disp_seq ?? '—'}）`);
  }
  console.log('');
  console.log(`  处置后        已闭合 ${closed} · 观察中 ${observing} · 未处置 ${unhandled}（合计 ${states.length}）`);
  console.log('');

  // 自检：演示形态必须与设计稿 §6 一致——不得三条全闭合
  if (closed !== 2 || observing !== 0 || unhandled !== 1) {
    console.error('✗ 演示形态不符合设计稿 §6（期望 2 已闭合 + 0 观察中 + 1 未处置）');
    process.exitCode = 1;
    return;
  }
  console.log('  ✓ 形态符合设计稿 §6：孤儿从 3 → 1，且未出现「三条全闭合」的错觉');
  console.log('  ⚠️ 处置记录存在 ≠ 处置有效；时延为自报值，不可验证。');
  console.log('');
}

main();
