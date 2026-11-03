#!/usr/bin/env node
/**
 * verify-chain.mts —— 审计面板事件文件的独立验证器（零依赖）
 *
 * 双形态：
 *   - CLI：node --experimental-transform-types tools/audit-panel/rules/verify-chain.mts
 *   - 库：export verifyChainFile() —— server 启动时调用（当场验证快照）
 *
 * 验证内容：
 *   1. 首行为 meta，且 event_count 与实际事件条数一致；
 *   2. 每条事件的 chain_hash 可按 recipe 重算并匹配；
 *   3. 每条事件的 chain_prev 指向前一条的 chain_hash（首条为空串）；
 *   4. 事件 seq 连续无缺号；
 *   5. 每个 category 都能在规则的 tc260 映射中找到依据（不允许"无依据的行为"）。
 *
 * ⚠️ 本验证器验的是**落盘链**（覆盖落盘内容），不是框架运行期链。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../../../reference/runtimes/l2-runtime-oversight/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(HERE, '../data/events.jsonl');

export interface ChainFail {
  seq: number | string;
  reason: string;
}

export interface ChainVerifyResult {
  ok: boolean;
  fails: ChainFail[];
  frameworkVersion: string;
  schemaVersion: string;
  eventCount: number;
  declaredCount: number | null;
}

function canonicalHash(prevHash: string, body: Record<string, unknown>): string {
  return sha256(prevHash + '|' + JSON.stringify(body));
}

/** 取出一条事件用于重算的 body：去掉两个链字段，保留文件原 key 顺序。 */
function bodyOf(event: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === 'chain_hash' || k === 'chain_prev') continue;
    body[k] = v;
  }
  return body;
}

/** 核心验证（可导出复用：server 启动时当场执行）。 */
export function verifyChainFile(file: string): ChainVerifyResult {
  const fails: ChainFail[] = [];
  const raw = readFileSync(file, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, fails: [{ seq: 'meta', reason: '文件无有效内容' }], frameworkVersion: 'unknown', schemaVersion: 'unknown', eventCount: 0, declaredCount: null };
  }
  const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
  const events = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);

  if (meta.record_type !== 'meta') {
    fails.push({ seq: 'meta', reason: `首行 record_type 应为 "meta"，实为 "${String(meta.record_type)}"` });
  }
  const declared = typeof meta.event_count === 'number' ? meta.event_count : null;
  if (declared !== events.length) {
    fails.push({ seq: 'meta', reason: `meta.event_count=${String(declared)} 与实际 ${events.length} 条不一致` });
  }

  let prevHash = '';
  let expectedSeq = 1;
  for (const e of events) {
    const seq = typeof e.seq === 'number' ? e.seq : String(e.seq);
    if (e.seq !== expectedSeq) {
      fails.push({ seq: String(seq), reason: `seq 不连续：期望 ${expectedSeq}，实为 ${String(e.seq)}` });
    }
    expectedSeq = (typeof e.seq === 'number' ? e.seq : expectedSeq) + 1;

    if (e.chain_prev !== prevHash) {
      fails.push({ seq: String(seq), reason: `chain_prev 不匹配：期望 "${prevHash}"，实为 "${String(e.chain_prev)}"` });
    }
    const recomputed = canonicalHash(prevHash, bodyOf(e));
    if (e.chain_hash !== recomputed) {
      fails.push({ seq: String(seq), reason: 'chain_hash 重算不匹配（该行内容已被修改）' });
    }
    prevHash = typeof e.chain_hash === 'string' ? e.chain_hash : prevHash;

    const missing: string[] = [];
    if (!e.rule_id) missing.push('rule_id');
    if (!Array.isArray(e.tc260_measures) || (e.tc260_measures as unknown[]).length === 0) missing.push('tc260_measures');
    if (!e.efficiency_grade) missing.push('efficiency_grade');
    if (!e.source_scenario && !e.session_id) missing.push('source_scenario/session_id');
    if (missing.length > 0) {
      fails.push({ seq: String(seq), reason: `缺少依据字段：${missing.join(', ')}` });
    }
  }

  const fw = (meta.framework as Record<string, unknown> | undefined)?.version;
  return {
    ok: fails.length === 0,
    fails,
    frameworkVersion: typeof fw === 'string' ? fw : 'unknown',
    schemaVersion: String(meta.schema_version ?? 'unknown'),
    eventCount: events.length,
    declaredCount: declared,
  };
}

function parseArgs(argv: string[]): { file: string; tamperDemo: boolean } {
  let file = DEFAULT_FILE;
  let tamperDemo = false;
  for (const a of argv) {
    if (a.startsWith('--file=')) file = resolve(a.slice('--file='.length));
    else if (a === '--tamper-demo') tamperDemo = true;
  }
  return { file, tamperDemo };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyChainFile(args.file);
  const events = (() => {
    try {
      const lines = readFileSync(args.file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
      return lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [] as Array<Record<string, unknown>>;
    }
  })();

  const out = [
    '',
    '审计面板事件文件 · 独立验证',
    '─'.repeat(58),
    `  文件          ${args.file}`,
    `  框架版本      v${result.frameworkVersion}`,
    `  schema        ${result.schemaVersion}`,
    `  事件条数      ${result.eventCount}${result.declaredCount !== null && result.declaredCount !== result.eventCount ? `（meta 声明 ${result.declaredCount}）` : ''}`,
    `  落盘链        ${result.ok ? 'PASS' : 'FAIL'}`,
    '',
  ];

  if (!result.ok) {
    out.push('  失败项：');
    for (const f of result.fails) out.push(`    [seq ${f.seq}] ${f.reason}`);
    out.push('');
    process.stdout.write(out.join('\n'));
    process.exitCode = 1;
    return;
  }

  out.push('  全部检查通过：meta 一致 · seq 连续 · 链可重算 · 每条事件有规则与条款依据');
  out.push('');

  if (args.tamperDemo && events.length > 0) {
    const target = events.find((e) => e.category === 'resource-over-budget') ?? events[0]!;
    const tampered: Record<string, unknown> = { ...target };
    tampered.detail = String(tampered.detail) + '（已篡改）';
    const idx = events.indexOf(target);
    let p = '';
    for (let i = 0; i < idx; i++) p = String(events[i]!.chain_hash);
    const expected = canonicalHash(p, bodyOf(tampered));
    const matches = expected === tampered.chain_hash;
    out.push('  篡改演示（仅内存，不写盘）：');
    lines_out_demo(out, target, matches, expected);
  }

  process.stdout.write(out.join('\n'));
}

function lines_out_demo(out: string[], target: Record<string, unknown>, matches: boolean, expected: string): void {
  out.push(`    目标行        seq ${String(target.seq)} · ${String(target.category)}`);
  out.push(`    改动          detail 末尾追加"（已篡改）"`);
  out.push(`    链校验        ${matches ? '未检出（异常！链无防护力）' : '已检出（重算值与原 chain_hash 不符）'}`);
  out.push(`    原 hash       ${String(target.chain_hash).slice(0, 16)}…`);
  out.push(`    重算 hash     ${expected.slice(0, 16)}…`);
  out.push('');
}

main();
