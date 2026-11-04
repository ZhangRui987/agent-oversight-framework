#!/usr/bin/env node
/**
 * verify-chain.mts —— 处置台账独立验证器（Node 侧）
 *
 * 验什么（与 verify_chain.py 逐条对齐，两语言结果必须一致）：
 *   1. 键序冻结：每行键序 == FIELD_ORDER + ["chain_hash","chain_prev"]
 *   2. 链可重算：chain_hash == sha256(prev + "|" + JSON.stringify(body))
 *   3. 链连续：chain_prev == 上一行 chain_hash（首行为空串）
 *   4. 序号连续：disp_seq == 行号（从 1 起，不重号）
 *   5. 字段合法：动作枚举 / seq 正整数 / 16 hex 前缀 / 非空字段
 *   6. 复核规则：confirm_false_positive 与 escalate 的 reviewed_by 必填且 ≠ actor
 *   7. 更正规则：supersedes 指向已存在、同 target_seq、未被二次更正的行
 *
 * 边界：本验证器只证明「台账文件未被事后改写」。它不能证明处置者身份、
 *       也不能证明处置发生在时限内——ts 是自报值（设计稿 §三 红线 6）。
 *
 * 用法：
 *   node --experimental-transform-types tools/disposition/verify-chain.mts
 *   node --experimental-transform-types tools/disposition/verify-chain.mts --file=<路径>
 *
 * 退出码：0 通过 / 1 存在失败项。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIONS,
  DEFAULT_LEDGER_FILE,
  FIELD_ORDER,
  bodyOf,
  chainHashOf,
  readLedger,
  type LedgerRow,
} from './ledger.mts';

export interface LedgerFail {
  dispSeq: number | string;
  reason: string;
}

export interface LedgerVerifyResult {
  ok: boolean;
  fails: LedgerFail[];
  rows: number;
  file: string;
  present: boolean;
  /** 台账尾行 chain_hash（面板展示用）。 */
  head: string;
}

const EXPECTED_KEYS = [...FIELD_ORDER, 'chain_hash', 'chain_prev'];

function isPositiveInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 核心验证（可导出：server 启动时当场执行）。 */
export function verifyLedgerFile(file: string = DEFAULT_LEDGER_FILE): LedgerVerifyResult {
  const fails: LedgerFail[] = [];
  if (!existsSync(file)) {
    return { ok: false, fails: [{ dispSeq: '-', reason: '台账文件不存在' }], rows: 0, file, present: false, head: '' };
  }

  let rows: LedgerRow[];
  try {
    rows = readLedger(file);
  } catch (err) {
    return {
      ok: false,
      fails: [{ dispSeq: '-', reason: err instanceof Error ? err.message : String(err) }],
      rows: 0,
      file,
      present: true,
      head: '',
    };
  }

  let prev = '';
  const seen = new Map<number, LedgerRow>();
  const superseded = new Map<number, number>();

  rows.forEach((row, i) => {
    const seq = typeof row.disp_seq === 'number' ? row.disp_seq : String(row.disp_seq);
    const push = (reason: string): void => {
      fails.push({ dispSeq: seq, reason });
    };

    // 1. 键序冻结（顺序本身是链的一部分，被重排即视为改写）
    const keys = Object.keys(row);
    if (keys.length !== EXPECTED_KEYS.length || keys.some((k, idx) => k !== EXPECTED_KEYS[idx])) {
      push(`键序不符冻结规格：实际 [${keys.join(',')}]`);
    }

    // 2-3. 链
    if (row.chain_prev !== prev) push(`chain_prev 应为 "${prev}"，实为 "${String(row.chain_prev)}"`);
    const recomputed = chainHashOf(prev, bodyOf(row));
    if (row.chain_hash !== recomputed) push('chain_hash 重算不匹配（该行内容已被修改）');
    prev = typeof row.chain_hash === 'string' ? row.chain_hash : prev;

    // 4. 序号连续
    if (row.disp_seq !== i + 1) push(`disp_seq 应连续（期望 ${i + 1}，实为 ${String(row.disp_seq)}）`);

    // 5. 字段合法
    if (row.record_type !== 'event' || row.event_type !== 'disposition') {
      push(`record_type/event_type 应为 event/disposition，实为 ${String(row.record_type)}/${String(row.event_type)}`);
    }
    if (!ACTIONS.includes(row.action)) push(`action "${String(row.action)}" 不在冻结枚举内`);
    if (!isPositiveInt(row.target_seq)) push('target_seq 应为正整数');
    if (!/^[0-9a-f]{16}$/.test(String(row.target_chain_hash))) push('target_chain_hash 应为 16 位小写 hex');
    if (!nonEmpty(row.signal_category)) push('signal_category 为空');
    if (!nonEmpty(row.actor)) push('actor 为空');
    if (!nonEmpty(row.rationale)) push('rationale 为空');
    if (!isPositiveInt(row.ts)) push('ts 应为正整数毫秒');

    // 6. 复核规则
    if (row.action === 'confirm_false_positive' || row.action === 'escalate') {
      if (!nonEmpty(row.reviewed_by)) push(`action "${row.action}" 缺 reviewed_by`);
      else if (row.reviewed_by === row.actor) push('reviewed_by 等于 actor（自审自批）');
    }

    // 7. plan 使用范围
    if (row.action === 'park_for_observation') {
      if (!nonEmpty(row.plan)) push('park_for_observation 缺 plan');
    } else if (row.plan !== null) {
      push(`plan 仅用于 park_for_observation，action "${String(row.action)}" 下应为 null`);
    }

    // 8. 更正引用
    if (row.supersedes !== null) {
      const target = seen.get(row.supersedes);
      if (typeof row.supersedes !== 'number' || !target) {
        push(`supersedes 指向不存在的 disp_seq=${String(row.supersedes)}`);
      } else {
        if (target.target_seq !== row.target_seq) {
          push(`supersedes=${row.supersedes} 的 target_seq=${target.target_seq} 与本次 ${row.target_seq} 不一致`);
        }
        if (superseded.has(row.supersedes)) {
          push(`disp_seq=${row.supersedes} 已被 ${superseded.get(row.supersedes)} 更正过（分叉更正）`);
        }
        superseded.set(row.supersedes, row.disp_seq);
      }
    }

    seen.set(row.disp_seq, row);
  });

  const head = rows.length > 0 ? String(rows[rows.length - 1]!.chain_hash) : '';
  return { ok: fails.length === 0, fails, rows: rows.length, file, present: true, head };
}

function main(): void {
  let file = DEFAULT_LEDGER_FILE;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--file=')) file = resolve(a.slice('--file='.length));
  }
  const r = verifyLedgerFile(file);

  const out = [
    '',
    '处置台账 · 独立验证（Node）',
    '─'.repeat(58),
    `  文件          ${r.file}`,
    `  记录条数      ${r.rows}`,
    `  台账链        ${r.ok ? 'PASS' : 'FAIL'}`,
    '',
  ];
  if (!r.ok) {
    out.push('  失败项：');
    for (const f of r.fails) out.push(`    [disp ${String(f.dispSeq)}] ${f.reason}`);
    out.push('');
    process.stdout.write(out.join('\n'));
    process.exitCode = 1;
    return;
  }
  out.push('  全部通过：键序冻结 · 链可重算 · disp_seq 连续 · 复核与更正规则合法');
  out.push('  边界：只证明台账未被事后改写；处置者身份与处置时效不可验证（ts 为自报值）。');
  out.push('');
  process.stdout.write(out.join('\n'));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
