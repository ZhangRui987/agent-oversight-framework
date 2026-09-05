// ============================================================================
// calibrate-shadow-ratio.mjs
// 路径 A：监察操作级影子比阈值标定（下界）
//
// 目标：用 ResourceLedger 四类操作等价类各运行 N=50 次，测量执行开销分布，
//       用 MAD + k=3 标定影子比阈值的监察操作级下界。
//       生产级 Agent 任务级阈值应 >= 此值（LLM 消耗方差远大于进程开销方差）。
//
// 方法论（与路径 B 同构）：
//   - 每等价类运行 N=50 次，记录执行时长（hrtime 纳秒）+ 堆内存增量
//   - 基线 = 中位数（对齐 spec/10「同任务历史消耗中位数」定义）
//   - 异常检测阈值 = MAD × 1.4826（≈稳健 σ）× k=3
//   - 影子比阈值 = (median + k × MAD × 1.4826) / median = 1 + k × (MAD × 1.4826 / median)
//   - bootstrap 95% CI（重采样 2000 次）
//   - 5-fold 交叉验证（异常率稳定性检验）
//
// 度量口径：
//   - 主度量：执行时长（process.hrtime.bigint() → 纳秒 → 毫秒）
//   - 辅助度量：堆内存增量（process.memoryUsage().heapUsed）
//   - 操作计数：仅用于验证等价类划分正确性（确定性量，不参与标定）
//
// 运行方式：
//   node --experimental-transform-types calibrate-shadow-ratio.mjs
//   （或纯 mjs：node calibrate-shadow-ratio.mjs，因为本脚本不依赖 index.ts 的 TS 类型）
// ============================================================================

import { ResourceLedger, AppendOnlyAuditLog } from './index.ts';
import * as os from 'node:os';

// ---------- 配置 ----------
const N = 50;           // 每等价类运行次数
const K = 3;            // MAD 倍数（≈3σ 等价）
const BOOTSTRAP = 2000; // bootstrap 重采样次数
const FOLDS = 5;        // 交叉验证折数

// ---------- 等价类定义 ----------
// C1: 预算判定（record，有 budget 无 baseline）
// C2: 影子比判定（record，有 budget + baseline）
// C3: 记忆写入审计（auditMemoryWrite）
// C4: 周期型外联（record × periodicWindow 次）
// C5: 混合负载（C1 + C2 + C3 组合）

const equivalenceClasses = {
  C1_budget: {
    description: '预算判定：record 单次调用（含 budget、无 baseline）',
    opCount: 1,
    run: () => {
      const log = new AppendOnlyAuditLog();
      const ledger = new ResourceLedger(log);
      const budget = { taskId: 'c1', maxTokens: 8000, maxMemoryMb: 100, maxDurationMs: 5000 };
      const usage = { tokens: 5000, memoryMb: 50, durationMs: 1000 };
      ledger.record('c1', 'infer', usage, budget);
    },
  },
  C2_shadow: {
    description: '影子比判定：record 单次调用（含 budget + baseline）',
    opCount: 1,
    run: () => {
      const log = new AppendOnlyAuditLog();
      const ledger = new ResourceLedger(log);
      const budget = {
        taskId: 'c2',
        maxTokens: 20000,
        shadowRatioThreshold: 2.0,
        shadowBaseline: { tokens: 5000, durationMs: 1000 },
      };
      const usage = { tokens: 6000, durationMs: 800 };
      ledger.record('c2', 'infer', usage, budget);
    },
  },
  C3_memwrite: {
    description: '记忆写入审计：auditMemoryWrite 单次调用',
    opCount: 1,
    run: () => {
      const log = new AppendOnlyAuditLog();
      const ledger = new ResourceLedger(log);
      ledger.auditMemoryWrite('c3', 'memory', {
        action: 'append',
        target: 'memory',
        bytes: 128,
        fields: ['preference.user_style'],
      });
    },
  },
  C4_periodic: {
    description: '周期型外联：record × 8 次（触发间隔方差判定）',
    opCount: 8,
    run: () => {
      const log = new AppendOnlyAuditLog();
      const ledger = new ResourceLedger(log, 8); // periodicWindow=8
      const budget = { taskId: 'c4' };
      for (let i = 0; i < 8; i++) {
        ledger.record('c4', 'http-get', { egressBytes: 100 }, budget);
      }
    },
  },
  C5_mixed: {
    description: '混合负载：C1 + C2 + C3 各一次',
    opCount: 3,
    run: () => {
      const log = new AppendOnlyAuditLog();
      const ledger = new ResourceLedger(log);
      // C1
      ledger.record('c5', 'infer', { tokens: 5000, memoryMb: 50, durationMs: 1000 },
        { taskId: 'c5', maxTokens: 8000 });
      // C2
      ledger.record('c5', 'infer', { tokens: 6000, durationMs: 800 },
        { taskId: 'c5', shadowRatioThreshold: 2.0, shadowBaseline: { tokens: 5000, durationMs: 1000 } });
      // C3
      ledger.auditMemoryWrite('c5', 'persisted-config', {
        action: 'update',
        target: 'config',
        bytes: 256,
        fields: ['model.temperature'],
      });
    },
  },
};

// ---------- 统计工具 ----------
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function mad(arr, med) {
  const deviations = arr.map((x) => Math.abs(x - med));
  return median(deviations);
}

// bootstrap 95% CI
function bootstrapCI(data, statFn, reps = BOOTSTRAP) {
  const stats = [];
  const n = data.length;
  for (let r = 0; r < reps; r++) {
    // 有放回重采样
    const sample = [];
    for (let i = 0; i < n; i++) {
      sample.push(data[Math.floor(Math.random() * n)]);
    }
    stats.push(statFn(sample));
  }
  stats.sort((a, b) => a - b);
  const lo = stats[Math.floor(reps * 0.025)];
  const hi = stats[Math.floor(reps * 0.975)];
  return { lo, hi };
}

// 计算影子比阈值 = 1 + K × (MAD × 1.4826 / median)
function shadowRatioThreshold(data) {
  const med = median(data);
  if (med === 0) return NaN;
  const m = mad(data, med);
  const robustSigma = m * 1.4826;
  return 1 + K * (robustSigma / med);
}

// 5-fold 交叉验证
function crossValidate(data, foldCount = FOLDS) {
  const shuffled = [...data];
  // 不 shuffle——保持确定性，仅做 sequential split
  const foldSize = Math.floor(shuffled.length / foldCount);
  const results = [];
  for (let f = 0; f < foldCount; f++) {
    const testStart = f * foldSize;
    const testEnd = f === foldCount - 1 ? shuffled.length : testStart + foldSize;
    const train = [...shuffled.slice(0, testStart), ...shuffled.slice(testEnd)];
    const test = shuffled.slice(testStart, testEnd);
    const trainThreshold = shadowRatioThreshold(train);
    const trainMed = median(train);
    // 在验证集上：多少比例的样本超过 trainThreshold？
    let exceedCount = 0;
    for (const v of test) {
      if (trainMed > 0 && v / trainMed > trainThreshold) exceedCount++;
    }
    const exceedRate = exceedCount / test.length;
    results.push({ trainThreshold, trainMed, exceedRate, foldIdx: f });
  }
  return results;
}

// ---------- 数据采集 ----------
function measureOnce(runFn) {
  // 热身：一次空跑（预热 JIT）
  runFn();

  // 强制 GC（如果可用——需要 --expose-gc flag）
  if (global.gc) global.gc();

  const memBefore = process.memoryUsage().heapUsed;
  const tStart = process.hrtime.bigint();
  runFn();
  const tEnd = process.hrtime.bigint();
  const memAfter = process.memoryUsage().heapUsed;

  const durationMs = Number(tEnd - tStart) / 1e6; // ns → ms
  const heapDeltaMb = (memAfter - memBefore) / 1e6; // bytes → MB
  return { durationMs, heapDeltaMb };
}

// ---------- 主流程 ----------
function main() {
  const env = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    date: new Date().toISOString(),
    cpuCount: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    exposeGC: typeof global.gc === 'function',
    runtimeFlags: process.execArgv.join(' '),
  };

  console.log('='.repeat(70));
  console.log('影子比阈值标定实验 —— 路径 A：监察操作级下界');
  console.log('='.repeat(70));
  console.log(JSON.stringify(env, null, 2));
  console.log(`参数：N=${N}/类, K=${K}, bootstrap=${BOOTSTRAP}, folds=${FOLDS}`);
  console.log('-'.repeat(70));

  const results = {};

  for (const [cls, def] of Object.entries(equivalenceClasses)) {
    console.log(`\n[${cls}] ${def.description}`);

    const durations = [];
    const heapDeltas = [];

    // 额外热身 5 次（让 JIT 充分优化）
    for (let i = 0; i < 5; i++) def.run();

    for (let i = 0; i < N; i++) {
      const m = measureOnce(def.run);
      durations.push(m.durationMs);
      heapDeltas.push(m.heapDeltaMb);
    }

    // ---- 时长标定 ----
    const durMed = median(durations);
    const durMAD = mad(durations, durMed);
    const durRobustSigma = durMAD * 1.4826;
    const durThreshold = shadowRatioThreshold(durations);
    const durCI = bootstrapCI(durations, shadowRatioThreshold);
    const durCV = crossValidate(durations);

    // ---- 堆内存标定 ----
    const heapMed = median(heapDeltas);
    const heapMAD = mad(heapDeltas, heapMed);
    const heapRobustSigma = heapMAD * 1.4826;
    const heapThreshold = shadowRatioThreshold(heapDeltas);
    const heapCI = bootstrapCI(heapDeltas, shadowRatioThreshold);
    const heapCV = crossValidate(heapDeltas);

    results[cls] = {
      description: def.description,
      opCount: def.opCount,
      duration: {
        raw: durations,
        median_ms: durMed,
        MAD_ms: durMAD,
        robustSigma_ms: durRobustSigma,
        shadowRatioThreshold: durThreshold,
        bootstrapCI_95: durCI,
        crossValidation: durCV.map((c) => ({
          fold: c.foldIdx,
          trainThreshold: c.trainThreshold,
          exceedRate: c.exceedRate,
        })),
        cvExceedRate_mean: durCV.reduce((s, c) => s + c.exceedRate, 0) / durCV.length,
        cvExceedRate_std: Math.sqrt(
          durCV.reduce((s, c) => s + (c.exceedRate - durCV.reduce((s2, c2) => s2 + c2.exceedRate, 0) / durCV.length) ** 2, 0) / durCV.length,
        ),
        min_ms: Math.min(...durations),
        max_ms: Math.max(...durations),
      },
      heap: {
        raw: heapDeltas,
        median_MB: heapMed,
        MAD_MB: heapMAD,
        robustSigma_MB: heapRobustSigma,
        shadowRatioThreshold: heapThreshold,
        bootstrapCI_95: heapCI,
        cvExceedRate_mean: heapCV.reduce((s, c) => s + c.exceedRate, 0) / heapCV.length,
        min_MB: Math.min(...heapDeltas),
        max_MB: Math.max(...heapDeltas),
      },
    };

    console.log(`  时长  中位数=${durMed.toFixed(4)}ms  MAD=${durMAD.toFixed(4)}ms  σ_robust=${durRobustSigma.toFixed(4)}ms`);
    console.log(`        影子比阈值=${durThreshold.toFixed(4)}  (95% CI: ${durCI.lo.toFixed(4)}–${durCI.hi.toFixed(4)})`);
    console.log(`        交叉验证平均异常率=${(results[cls].duration.cvExceedRate_mean * 100).toFixed(1)}%`);
    console.log(`  堆内存 中位数=${heapMed.toFixed(6)}MB  MAD=${heapMAD.toFixed(6)}MB`);
    console.log(`        影子比阈值=${heapThreshold.toFixed(4)}  (95% CI: ${heapCI.lo.toFixed(4)}–${heapCI.hi.toFixed(4)})`);
  }

  // ---- 汇总 ----
  console.log('\n' + '='.repeat(70));
  console.log('汇总：监察操作级影子比阈值下界');
  console.log('='.repeat(70));
  console.log('等价类 | 时长阈值 (点) | 时长 CI | 堆内存阈值 (点) | 堆内存 CI');
  console.log('-'.repeat(70));
  for (const [cls, r] of Object.entries(results)) {
    console.log(
      `${cls.padEnd(14)} | ${r.duration.shadowRatioThreshold.toFixed(4).padStart(8)} | ` +
      `${r.duration.bootstrapCI_95.lo.toFixed(4)}–${r.duration.bootstrapCI_95.hi.toFixed(4).padEnd(8)} | ` +
      `${r.heap.shadowRatioThreshold.toFixed(4).padStart(8)} | ` +
      `${r.heap.bootstrapCI_95.lo.toFixed(4)}–${r.heap.bootstrapCI_95.hi.toFixed(4)}`,
    );
  }

  // 全等价类合并（跨类的综合下界）
  const allDurThresholds = Object.values(results).map((r) => r.duration.shadowRatioThreshold);
  const allHeapThresholds = Object.values(results).map((r) => r.heap.shadowRatioThreshold);
  const combinedDur = median(allDurThresholds);
  const combinedHeap = median(allHeapThresholds);
  const maxDur = Math.max(...allDurThresholds);
  const maxHeap = Math.max(...allHeapThresholds);

  console.log('-'.repeat(70));
  console.log(`综合下界（时长中位数）= ${combinedDur.toFixed(4)}`);
  console.log(`综合下界（时长最保守）= ${maxDur.toFixed(4)}`);
  console.log(`综合下界（堆内存中位数）= ${combinedHeap.toFixed(4)}`);
  console.log(`综合下界（堆内存最保守）= ${maxHeap.toFixed(4)}`);

  // 输出 JSON 供报告使用
  const output = {
    env,
    config: { N, K, BOOTSTRAP, FOLDS },
    results,
    summary: {
      durationMedian: combinedDur,
      durationMax: maxDur,
      heapMedian: combinedHeap,
      heapMax: maxHeap,
    },
  };
  console.log('\n--- JSON_OUTPUT_START ---');
  console.log(JSON.stringify(output, null, 2));
  console.log('--- JSON_OUTPUT_END ---');
}

main();
