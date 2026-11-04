#!/usr/bin/env node
/**
 * gen-sample.mts —— 生成 20 行固定样本（双语言验链的交叉验证夹具）
 *
 * 用途：门禁第 47 项先让 Node 生成样本，再让 **Python 参照实现**独立验一遍；
 *       若两端序列化规格有任何偏差（空格 / 非 ASCII 转义 / 浮点写法），
 *       这一步会立刻失败——这是「第三方可重算」从口号变成可执行检查的关口。
 *
 * 样本刻意覆盖：四种动作 / 中文 rationale / reviewed_by 非空与为空 /
 *               park_for_observation 的 plan / supersedes 更正链。
 *
 * 用法：
 *   node --experimental-transform-types tools/disposition/gen-sample.mts --out=<路径>
 *
 * 输出确定性：ts 从固定基准递增、target_chain_hash 由固定字符串哈希派生，
 *            同一版本重复生成逐字节一致（便于跨机比对）。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { appendDisposition, sha256, type DispositionAction } from './ledger.mts';

const BASE_TS = 1793862000000; // 2026-11-05T11:00:00Z 附近，固定值

interface Sample {
  target: number;
  category: string;
  action: DispositionAction;
  actor: string;
  rationale: string;
  reviewed_by?: string | null;
  plan?: string | null;
  supersedes?: number | null;
}

const SAMPLES: Sample[] = [
  { target: 3, category: 'budget-exceeded', action: 'confirm_false_positive', actor: 'operator-alice', rationale: '预算比 1.03 低于该 provider 标定区间，判为误报', reviewed_by: 'operator-bob' },
  { target: 4, category: 'shadow-deviation', action: 'route_to_human', actor: 'operator-alice', rationale: '影子比 2.4 无历史基线可比，转人工核对任务复杂度' },
  { target: 5, category: 'memory-write-audited', action: 'park_for_observation', actor: 'operator-carol', rationale: '记忆写入字段为偏好项，先观察后续三轮是否扩散', plan: '观察 72h 内同任务记忆写入频率，超过 3 次升级' },
  { target: 6, category: 'periodic-egress', action: 'escalate', actor: 'operator-carol', rationale: '出站间隔方差异常且目标域不在白名单，升级安全组', reviewed_by: 'operator-dave' },
  { target: 7, category: 'budget-exceeded', action: 'confirm_false_positive', actor: 'operator-bob', rationale: '批量检索任务，budget 配置偏低', reviewed_by: 'operator-alice' },
  { target: 8, category: 'shadow-deviation', action: 'route_to_human', actor: 'operator-bob', rationale: '新接入 provider 尚无基线，转人工建立基线' },
  { target: 9, category: 'budget-exceeded', action: 'route_to_human', actor: 'operator-dave', rationale: '消耗异常但任务为离线批处理，转人工确认' },
  { target: 10, category: 'memory-write-audited', action: 'park_for_observation', actor: 'operator-dave', rationale: '单次写入，先观察', plan: '观察下一轮是否重复写入同一字段' },
  // 更正：把 disp 8（对 seq 10 的 park）改为 confirm_false_positive——append-only 的纠错形态
  { target: 10, category: 'memory-write-audited', action: 'confirm_false_positive', actor: 'operator-dave', rationale: '复核确认：该次写入由用户显式指令触发，判为误报', reviewed_by: 'operator-carol', supersedes: 8 },
  { target: 11, category: 'periodic-egress', action: 'escalate', actor: 'operator-alice', rationale: '周期性出站且目标域为对象存储，升级核查外泄面', reviewed_by: 'operator-dave' },
  { target: 12, category: 'shadow-deviation', action: 'confirm_false_positive', actor: 'operator-carol', rationale: '影子比 2.1 处于该 provider 标定上沿，判为误报', reviewed_by: 'operator-bob' },
  { target: 13, category: 'budget-exceeded', action: 'park_for_observation', actor: 'operator-bob', rationale: '超预算但任务未失败，先观察', plan: '观察任务完成率与后续消耗曲线' },
  { target: 14, category: 'memory-write-audited', action: 'route_to_human', actor: 'operator-carol', rationale: '写入字段涉及身份信息，转人工合规评估' },
  { target: 15, category: 'periodic-egress', action: 'escalate', actor: 'operator-dave', rationale: '固定 60s 间隔出站，疑似外联心跳', reviewed_by: 'operator-alice' },
  { target: 16, category: 'budget-exceeded', action: 'confirm_false_positive', actor: 'operator-alice', rationale: '重试导致的重复计量，判为误报', reviewed_by: 'operator-carol' },
  { target: 17, category: 'shadow-deviation', action: 'route_to_human', actor: 'operator-bob', rationale: '影子比 3.0 但样本仅 1 次，转人工判断' },
  { target: 18, category: 'memory-write-audited', action: 'park_for_observation', actor: 'operator-alice', rationale: '例行记忆维护，先观察', plan: '观察 48h 内字段变更次数' },
  { target: 19, category: 'periodic-egress', action: 'escalate', actor: 'operator-carol', rationale: '出站目标含未登记域名，升级安全组', reviewed_by: 'operator-dave' },
  { target: 20, category: 'budget-exceeded', action: 'confirm_false_positive', actor: 'operator-dave', rationale: '预算阈值按旧基线配置，判为误报', reviewed_by: 'operator-bob' },
  { target: 21, category: 'shadow-deviation', action: 'route_to_human', actor: 'operator-alice', rationale: '跨 provider 对比口径未统一，转人工' },
];

function parseArgs(argv: string[]): { out: string; force: boolean } {
  let out = '';
  let force = false;
  for (const a of argv) {
    if (a.startsWith('--out=')) out = resolve(a.slice('--out='.length));
    else if (a === '--force') force = true;
  }
  return { out, force };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error('缺少 --out=<路径>：样本必须写到显式路径（不覆盖入库台账）');
    process.exitCode = 1;
    return;
  }
  if (existsSync(args.out)) {
    if (!args.force) {
      console.error(`目标已存在：${args.out}（确需覆盖请加 --force）`);
      process.exitCode = 1;
      return;
    }
    rmSync(args.out);
  }
  mkdirSync(dirname(args.out), { recursive: true });

  SAMPLES.forEach((s, i) => {
    appendDisposition(
      {
        target_seq: s.target,
        target_chain_hash: sha256(`aof-disposition-sample-signal-${s.target}`).slice(0, 16),
        signal_category: s.category,
        action: s.action,
        actor: s.actor,
        rationale: s.rationale,
        reviewed_by: s.reviewed_by ?? null,
        supersedes: s.supersedes ?? null,
        plan: s.plan ?? null,
        ts: BASE_TS + i * 60_000,
      },
      args.out,
    );
  });

  console.log('');
  console.log(`已生成 ${SAMPLES.length} 行固定样本：${args.out}`);
  console.log('  覆盖：四种动作 / 中文 rationale / 复核人为空与非空 / plan / supersedes 更正链');
  console.log('  下一步（门禁第 47 项）：python tools/disposition/verify_chain.py <同一文件>');
  console.log('');
}

main();
