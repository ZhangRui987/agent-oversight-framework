/**
 * chain-core.mts —— 落盘事件链验证的**唯一实现**（库函数 + CLI 运行时）
 *
 * 为什么有这个文件：v2.72.6 及以前，同一套逻辑在
 *   tools/audit-panel/scenario/verify-chain.mts（CI / 文档 / 外锚 verifier 字段用）
 *   tools/audit-panel/rules/verify-chain.mts  （server 导入的库形态）
 * 各有一份完整实现，实测差异 191 行，且对「缺依据字段」的判定**相反**
 * （rules 允许 session_id 替代 source_scenario，scenario 不允许）。
 * 两个入口不可能同时正确 ⇒ v2.72.7 收口为一份：本文件是唯一实现，
 * 上面两个路径退化为「参数解析 / 再导出 + 入口守卫」，输出与判定不再有第二套。
 *
 * 验证内容（取原两版中更严的一侧）：
 *   1. 首行为 meta，且 event_count 与实际条数一致；
 *   2. 每条事件 chain_hash 可按 recipe 重算并匹配
 *      （与 meta.chain.recompute_recipe 一致：sha256(prev + "|" + JSON.stringify(body))，
 *        body = 本行去掉 chain_hash / chain_prev，保留文件原 key 顺序）；
 *   3. chain_prev 指向前一条的 chain_hash（首条为空串）；
 *   4. seq 连续无缺号；
 *   5. 每条事件有依据字段 rule_id / tc260_measures / efficiency_grade + 来源字段。
 *
 * 来源字段按**显式口径**判定，不猜、不做隐式 OR：
 *   'scenario' → 要求 source_scenario（V1 确定性事件流，data/events.jsonl，9 条，S1–S7）
 *   'session'  → 要求 session_id     （V2 real-agent 流，data/realagent-events.jsonl，14 条，
 *                                      实测 14/14 无 source_scenario）
 * verifyChainFile() 的第二参数为**必填、无默认值**：口径由调用方声明。
 * CLI 的 --source 缺省 scenario，与 CLI 默认文件 data/events.jsonl 绑定；用默认口径去验 V2 文件
 * 会明确报「缺少 source_scenario（口径 scenario）」而**不是**静默通过——默认值落在 fail-closed 一侧。
 *
 * 退出码（CLI）：0 = 验链通过（启用 --tamper-demo 时还要求演示确实检出篡改）；1 = 存在失败，
 * 或演示未能检出（链无防护力），或参数非法。演示**成功**时不改退出码：退出码回答「这条命令有没有
 * 完成它承诺的事」，若让成功的演示返回非 0，「演示成功」与「验链失败」就共用同一个信号。
 *
 * ⚠️ 本验证器验的是**落盘链**（覆盖落盘内容），不是框架运行期链。
 *    落盘链只能证明「文件未被事后篡改」，不能证明事件真实发生过、也不证明发生在合成时间点。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sha256 } from '../../../reference/runtimes/l2-runtime-oversight/index.ts';

/** 来源字段口径：两者互斥，由调用方显式声明。 */
export type SourceProfile = 'scenario' | 'session';

const SOURCE_FIELD: Record<SourceProfile, string> = {
  scenario: 'source_scenario',
  session: 'session_id',
};

const SOURCE_NOTE: Record<SourceProfile, string> = {
  scenario: 'scenario（每条事件须有 source_scenario）',
  session: 'session（每条事件须有 session_id）',
};

export interface VerifyOptions {
  /** 必填：本文件的来源字段口径。 */
  source: SourceProfile;
}

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
  sourceProfile: SourceProfile;
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

/** 读出 meta 行与事件行（CLI 的篡改演示需要原样事件）。 */
export function readEventFile(file: string): {
  meta: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
} {
  const lines = readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return {
    meta: JSON.parse(lines[0]!) as Record<string, unknown>,
    events: lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** 核心验证（server 启动时当场调用它验证快照）。 */
export function verifyChainFile(file: string, opts: VerifyOptions): ChainVerifyResult {
  const source = opts.source;
  const needField = SOURCE_FIELD[source];
  const empty: ChainVerifyResult = {
    ok: false,
    fails: [],
    frameworkVersion: 'unknown',
    schemaVersion: 'unknown',
    eventCount: 0,
    declaredCount: null,
    sourceProfile: source,
  };

  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return { ...empty, fails: [{ seq: 'meta', reason: `无法读取文件：${file}` }] };
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { ...empty, fails: [{ seq: 'meta', reason: `文件无有效内容（缺 meta 行或无非空事件行）：${file}` }] };
  }

  const fails: ChainFail[] = [];
  const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
  const events = lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);

  // 1. meta 自描述一致性
  if (meta.record_type !== 'meta') {
    fails.push({ seq: 'meta', reason: `首行 record_type 应为 "meta"，实为 "${String(meta.record_type)}"` });
  }
  const declared = typeof meta.event_count === 'number' ? meta.event_count : null;
  if (declared !== events.length) {
    fails.push({ seq: 'meta', reason: `meta.event_count=${String(declared)} 与实际 ${events.length} 条不一致` });
  }

  // 2/3/4/5. 逐条验链 + 依据字段
  let prev = '';
  let expectedSeq = 1;
  for (const e of events) {
    const seq = typeof e.seq === 'number' ? e.seq : String(e.seq);

    if (e.seq !== expectedSeq) {
      fails.push({ seq, reason: `seq 不连续：期望 ${expectedSeq}，实为 ${String(e.seq)}` });
    }
    expectedSeq = (typeof e.seq === 'number' ? e.seq : expectedSeq) + 1;

    if (e.chain_prev !== prev) {
      fails.push({ seq, reason: `chain_prev 不匹配：期望 "${prev}"，实为 "${String(e.chain_prev)}"` });
    }

    const recomputed = canonicalHash(prev, bodyOf(e));
    if (e.chain_hash !== recomputed) {
      fails.push({
        seq,
        reason: `chain_hash 重算不匹配（该行内容已被修改）：\n      落盘 ${String(e.chain_hash)}\n      重算 ${recomputed}`,
      });
    }
    // 断链处只报一次：chain_hash 缺失/非字符串时保留上一值，不制造后续 chain_prev 的二次误报。
    prev = typeof e.chain_hash === 'string' ? e.chain_hash : prev;

    const missing: string[] = [];
    if (!e.rule_id) missing.push('rule_id');
    if (!Array.isArray(e.tc260_measures) || (e.tc260_measures as unknown[]).length === 0) missing.push('tc260_measures');
    if (!e.efficiency_grade) missing.push('efficiency_grade');
    if (!e[needField]) missing.push(needField);
    if (missing.length > 0) {
      fails.push({
        seq: String(seq),
        reason: `缺少依据字段：${missing.join(', ')}（口径 ${source}；面板将展示无依据的行为）`,
      });
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
    sourceProfile: source,
  };
}

/** 篡改演示：在内存里改一条真实事件，看链是否检出（不写盘）。 */
function tamperDemoOf(events: Array<Record<string, unknown>>): {
  target: Record<string, unknown>;
  rehashed: string;
  detected: boolean;
} | null {
  if (events.length === 0) return null;
  const target = events.find((e) => e.category === 'resource-over-budget') ?? events[0]!;
  const tampered: Record<string, unknown> = { ...target };
  tampered.detail = String(tampered.detail) + '（已篡改）';

  const idx = events.indexOf(target);
  let p = '';
  for (let i = 0; i < idx; i++) p = String(events[i]!.chain_hash);

  const rehashed = canonicalHash(p, bodyOf(tampered));
  return { target, rehashed, detected: rehashed !== tampered.chain_hash };
}

interface CliArgs {
  file: string;
  tamperDemo: boolean;
  source: SourceProfile;
  error: string | null;
}

function parseArgs(argv: string[], defaultFile: string): CliArgs {
  const args: CliArgs = { file: defaultFile, tamperDemo: false, source: 'scenario', error: null };
  for (const a of argv) {
    if (a.startsWith('--file=')) args.file = resolve(a.slice('--file='.length));
    else if (a === '--tamper-demo') args.tamperDemo = true;
    else if (a.startsWith('--source=')) {
      const v = a.slice('--source='.length);
      if (v === 'scenario' || v === 'session') args.source = v;
      else args.error = `--source 只接受 scenario | session，收到 "${v}"`;
    } else args.error = `未知参数 "${a}"（可用：--file=<路径> / --tamper-demo / --source=scenario|session）`;
  }
  return args;
}

/**
 * CLI 入口（两个对外路径共用它）。
 * @param argv   process.argv.slice(2)
 * @param defaultFile 未传 --file 时的默认文件（由调用方按自己的目录解析）
 */
export function runChainCli(argv: string[], defaultFile: string): void {
  const args = parseArgs(argv, defaultFile);
  if (args.error) {
    process.stderr.write(`\n参数错误：${args.error}\n\n`);
    process.exitCode = 1;
    return;
  }

  const result = verifyChainFile(args.file, { source: args.source });
  const declaredGap = result.declaredCount !== null && result.declaredCount !== result.eventCount;

  const out = [
    '',
    '审计面板事件文件 · 独立验证',
    '─'.repeat(58),
    `  文件          ${args.file}`,
    `  框架版本      v${result.frameworkVersion}`,
    `  schema        ${result.schemaVersion}`,
    `  事件条数      ${result.eventCount}${declaredGap ? `（meta 声明 ${String(result.declaredCount)}）` : ''}`,
    `  依据口径      ${SOURCE_NOTE[result.sourceProfile]}`,
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

  // —— 篡改演示：证明这条链不是装饰 ——
  // 退出码语义见文件头：检出成功不改退出码；未检出必须退出 1。
  if (args.tamperDemo) {
    let demo: ReturnType<typeof tamperDemoOf> = null;
    try {
      demo = tamperDemoOf(readEventFile(args.file).events);
    } catch {
      demo = null;
    }

    if (!demo) {
      out.push('  篡改演示（仅内存，不写盘）：');
      out.push('    无法执行：文件中没有可用的真实事件行。');
      out.push('    演示结论      未执行 —— 演示未完成，本命令退出码 1。');
      out.push('');
      process.exitCode = 1;
      process.stdout.write(out.join('\n'));
      return;
    }

    out.push('  篡改演示（仅内存，不写盘）：');
    out.push(`    目标行        seq ${String(demo.target.seq)} · ${String(demo.target.category)}（文件里的真实事件，非构造行）`);
    out.push(`    改动          detail 末尾追加"（已篡改）"`);
    out.push(`    链校验        ${demo.detected ? '已检出（重算值与原 chain_hash 不符）' : '未检出（异常！链无防护力）'}`);
    out.push(`    若落盘        ${demo.detected ? '验链判 FAIL，退出码 1' : '验链仍判 PASS —— 这条链拦不住改动'}`);
    out.push(`    原 hash       ${String(demo.target.chain_hash).slice(0, 16)}…`);
    out.push(`    重算 hash     ${demo.rehashed.slice(0, 16)}…`);
    out.push('');
    out.push(
      demo.detected
        ? '    演示结论      检出成功（预期结果）。本命令退出码 0 = 验链通过 且 演示符合预期，不是"未检出"。'
        : '    演示结论      未检出 —— 链无防护力，本命令退出码 1。',
    );
    out.push('');

    if (!demo.detected) process.exitCode = 1;
  }

  process.stdout.write(out.join('\n'));
}
