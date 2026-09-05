// ============================================================================
// calibrate-periodic-threshold.mts
// 周期检测方差阈值标定实验
//
// 目标：标定 ResourceLedger 周期型外联检测的间隔方差阈值（默认 1ms² 占位）。
//       闭合 G5 剩余差距 (a) 的周期检测部分。
//
// 方法论：
//   - 构造 5 类不同间隔特征的外联序列（真周期/抖动周期/泊松随机/突发/混合）
//   - 每类生成 N=50 个序列（每序列 8 个时间戳 = periodicWindow）
//   - 计算每个序列的实测间隔方差
//   - 标定能区分"应触发"（C1/C2）与"不应触发"（C3/C4）的方差阈值
//   - 方法：ROC 曲线找最优阈值（Youden's J），bootstrap 95% CI
//
// 与影子比实验的区别：
//   - 影子比测量的是"同一操作重复执行"的消耗分布（一维统计）
//   - 周期检测标定的是"不同间隔序列"的分类边界（二分类问题）
//   - 因此用 ROC / AUC / Youden's J 而非 MAD+k×σ
//
// 运行方式：
//   node --experimental-transform-types calibrate-periodic-threshold.mts
// ============================================================================

import * as os from 'node:os';

// ---------- 配置 ----------
const N = 50;           // 每类序列数
const WINDOW = 8;       // periodicWindow（与 index.ts 默认一致）
const BASE_PERIOD_MS = 5000; // 基准周期 5 秒（模拟 C2 心跳）
const BOOTSTRAP = 2000; // bootstrap 重采样次数

// ---------- 随机数生成器 ----------
// Box-Muller 变换：标准正态随机数
function gaussian(mean: number, std: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

// 指数分布随机数（泊松过程的间隔）
function exponential(lambda: number): number {
  return -Math.log(1 - Math.random()) * lambda;
}

// ---------- 序列生成器 ----------
// 每个序列返回 8 个时间戳（模拟 Date.now() 输出）

// C1 真周期：固定间隔，加入 Date.now() 分辨率噪声（±1ms）
function genTruePeriodic(): number[] {
  const startTs = Date.now() + Math.floor(Math.random() * 100000);
  const timestamps: number[] = [];
  for (let i = 0; i < WINDOW; i++) {
    // Date.now() 精度噪声：±1ms
    const clockNoise = Math.floor(Math.random() * 3) - 1;
    timestamps.push(startTs + i * BASE_PERIOD_MS + clockNoise);
  }
  return timestamps;
}

// C2 抖动周期：5000ms ± 50ms 高斯抖动（模拟真实网络心跳）
function genJitteredPeriodic(): number[] {
  const startTs = Date.now() + Math.floor(Math.random() * 100000);
  const timestamps: number[] = [];
  let current = startTs;
  for (let i = 0; i < WINDOW; i++) {
    const jitter = gaussian(0, 50);
    current += BASE_PERIOD_MS + jitter;
    timestamps.push(Math.floor(current));
  }
  return timestamps;
}

// C3 泊松随机：指数分布间隔（模拟正常网络请求）
function genPoisson(): number[] {
  const startTs = Date.now() + Math.floor(Math.random() * 100000);
  const timestamps: number[] = [];
  let current = startTs;
  for (let i = 0; i < WINDOW; i++) {
    current += exponential(BASE_PERIOD_MS);
    timestamps.push(Math.floor(current));
  }
  return timestamps;
}

// C4 突发模式：长静默 + 短突发（模拟人类操作）
function genBurst(): number[] {
  const startTs = Date.now() + Math.floor(Math.random() * 100000);
  const timestamps: number[] = [];
  let current = startTs;
  for (let i = 0; i < WINDOW; i++) {
    // 70% 概率短间隔（100-500ms 突发），30% 概率长静默（10-60秒）
    if (Math.random() < 0.7) {
      current += Math.floor(Math.random() * 400 + 100);
    } else {
      current += Math.floor(Math.random() * 50000 + 10000);
    }
    timestamps.push(current);
  }
  return timestamps;
}

// C5 混合：50% 周期 + 50% 随机（边界情形）
function genMixed(): number[] {
  const startTs = Date.now() + Math.floor(Math.random() * 100000);
  const timestamps: number[] = [];
  let current = startTs;
  for (let i = 0; i < WINDOW; i++) {
    if (Math.random() < 0.5) {
      current += BASE_PERIOD_MS + gaussian(0, 100);
    } else {
      current += exponential(BASE_PERIOD_MS);
    }
    timestamps.push(Math.floor(current));
  }
  return timestamps;
}

// ---------- 间隔方差计算（与 index.ts 逻辑一致） ----------
function intervalVariance(timestamps: number[]): { variance: number; mean: number } {
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
  return { variance, mean };
}

// ---------- 统计工具 ----------
function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function percentile(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)];
}

// ROC 曲线 + Youden's J 最优阈值
// positive = 应触发（C1, C2），negative = 不应触发（C3, C4）
// C5 是边界情形，不参与阈值标定但报告分类结果
function findOptimalThreshold(
  positiveVariances: number[],
  negativeVariances: number[],
): { optimalThreshold: number; youdenJ: number; tpr: number; fpr: number; auc: number; roc: Array<{ threshold: number; tpr: number; fpr: number }> } {
  // 收集所有候选阈值（正负样本的方差值 + 中间值）
  const allValues = [...positiveVariances, ...negativeVariances].sort((a, b) => a - b);
  const candidateThresholds: number[] = [];
  for (let i = 0; i < allValues.length - 1; i++) {
    candidateThresholds.push((allValues[i] + allValues[i + 1]) / 2);
  }

  const roc: Array<{ threshold: number; tpr: number; fpr: number; youdenJ: number }> = [];

  for (const threshold of candidateThresholds) {
    // 方差 <= threshold → 判定为周期性（触发信号）
    const tp = positiveVariances.filter((v) => v <= threshold).length;
    const fn = positiveVariances.filter((v) => v > threshold).length;
    const fp = negativeVariances.filter((v) => v <= threshold).length;
    const tn = negativeVariances.filter((v) => v > threshold).length;

    const tpr = tp / (tp + fn); // 真阳性率（召回率）
    const fpr = fp / (fp + tn); // 假阳性率（误报率）
    const youdenJ = tpr - fpr;

    roc.push({ threshold, tpr, fpr, youdenJ });
  }

  // 找 Youden's J 最大的点
  roc.sort((a, b) => b.youdenJ - a.youdenJ);
  const best = roc[0];

  // AUC（梯形法）
  const sortedRoc = [...roc].sort((a, b) => a.fpr - b.fpr);
  let auc = 0;
  for (let i = 1; i < sortedRoc.length; i++) {
    const dx = sortedRoc[i].fpr - sortedRoc[i - 1].fpr;
    const avgY = (sortedRoc[i].tpr + sortedRoc[i - 1].tpr) / 2;
    auc += dx * avgY;
  }

  return {
    optimalThreshold: best.threshold,
    youdenJ: best.youdenJ,
    tpr: best.tpr,
    fpr: best.fpr,
    auc,
    roc: roc.sort((a, b) => a.threshold - b.threshold).map(({ youdenJ, ...rest }) => rest),
  };
}

// bootstrap 95% CI for optimal threshold
function bootstrapThreshold(
  positiveVariances: number[],
  negativeVariances: number[],
  reps: number = BOOTSTRAP,
): { lo: number; hi: number; median: number } {
  const thresholds: number[] = [];
  for (let r = 0; r < reps; r++) {
    // 有放回重采样
    const posSample = positiveVariances.map(() => positiveVariances[Math.floor(Math.random() * positiveVariances.length)]);
    const negSample = negativeVariances.map(() => negativeVariances[Math.floor(Math.random() * negativeVariances.length)]);
    const result = findOptimalThreshold(posSample, negSample);
    thresholds.push(result.optimalThreshold);
  }
  thresholds.sort((a, b) => a - b);
  return {
    lo: thresholds[Math.floor(reps * 0.025)],
    hi: thresholds[Math.floor(reps * 0.975)],
    median: median(thresholds),
  };
}

// ---------- 主流程 ----------
function main() {
  const env = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    date: new Date().toISOString(),
    cpuCount: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    runtimeFlags: process.execArgv.join(' '),
  };

  console.log('='.repeat(70));
  console.log('周期检测方差阈值标定实验');
  console.log('='.repeat(70));
  console.log(JSON.stringify(env, null, 2));
  console.log(`参数：N=${N}/类, WINDOW=${WINDOW}, BOOTSTRAP=${BOOTSTRAP}`);
  console.log(`基准周期：${BASE_PERIOD_MS}ms（模拟 C2 心跳）`);
  console.log('-'.repeat(70));

  // ---------- 生成数据 ----------
  const datasets = {
    C1_truePeriodic: { gen: genTruePeriodic, label: '应触发', description: '固定间隔 + Date.now() ±1ms 噪声' },
    C2_jitteredPeriodic: { gen: genJitteredPeriodic, label: '应触发', description: '5000ms ± 50ms 高斯抖动（真实网络心跳）' },
    C3_poisson: { gen: genPoisson, label: '不应触发', description: '指数分布间隔（正常网络请求）' },
    C4_burst: { gen: genBurst, label: '不应触发', description: '长静默 + 短突发（人类操作模式）' },
    C5_mixed: { gen: genMixed, label: '边界', description: '50% 周期 + 50% 随机' },
  };

  const results: Record<string, { variances: number[]; means: number[]; description: string; label: string }> = {};

  for (const [cls, def] of Object.entries(datasets)) {
    const variances: number[] = [];
    const means: number[] = [];
    for (let i = 0; i < N; i++) {
      const ts = def.gen();
      const { variance, mean } = intervalVariance(ts);
      variances.push(variance);
      means.push(mean);
    }
    results[cls] = { variances, means, description: def.description, label: def.label };

    const varMedian = median(variances);
    const varMin = Math.min(...variances);
    const varMax = Math.max(...variances);
    const varP5 = percentile(variances, 0.05);
    const varP95 = percentile(variances, 0.95);

    console.log(`\n[${cls}] ${def.description} (${def.label})`);
    console.log(`  方差中位数=${varMedian.toFixed(2)}ms²  范围=${varMin.toFixed(2)}–${varMax.toFixed(2)}ms²`);
    console.log(`  P5=${varP5.toFixed(2)}  P95=${varP95.toFixed(2)}  均值间隔=${median(means).toFixed(0)}ms`);
  }

  // ---------- ROC 标定 ----------
  // Positive（应触发）= C1 + C2
  // Negative（不应触发）= C3 + C4
  console.log('\n' + '='.repeat(70));
  console.log('ROC 标定：正类=C1+C2（应触发），负类=C3+C4（不应触发）');
  console.log('='.repeat(70));

  const positiveVariances = [...results.C1_truePeriodic.variances, ...results.C2_jitteredPeriodic.variances];
  const negativeVariances = [...results.C3_poisson.variances, ...results.C4_burst.variances];

  const rocResult = findOptimalThreshold(positiveVariances, negativeVariances);
  const bootstrapResult = bootstrapThreshold(positiveVariances, negativeVariances);

  console.log(`\n最优阈值（Youden's J）= ${rocResult.optimalThreshold.toFixed(2)}ms²`);
  console.log(`  TPR=${(rocResult.tpr * 100).toFixed(1)}%  FPR=${(rocResult.fpr * 100).toFixed(1)}%  J=${rocResult.youdenJ.toFixed(4)}`);
  console.log(`  AUC=${rocResult.auc.toFixed(4)}`);
  console.log(`  Bootstrap 95% CI: ${bootstrapResult.lo.toFixed(2)}–${bootstrapResult.hi.toFixed(2)}ms²（中位数 ${bootstrapResult.median.toFixed(2)}）`);

  // ---------- 在边界情形 C5 上的表现 ----------
  console.log('\n' + '-'.repeat(70));
  console.log('边界情形 C5（50% 周期 + 50% 随机）在标定阈值下的分类：');
  const c5Triggered = results.C5_mixed.variances.filter((v) => v <= rocResult.optimalThreshold).length;
  const c5NotTriggered = N - c5Triggered;
  console.log(`  触发=${c5Triggered}/${N} (${(c5Triggered / N * 100).toFixed(1)}%)  不触发=${c5NotTriggered}/${N}`);

  // ---------- 各类在标定阈值下的分类结果 ----------
  console.log('\n' + '-'.repeat(70));
  console.log('各类别在标定阈值下的分类汇总：');
  console.log('类别 | 期望 | 触发率 | 方差中位数');
  console.log('-'.repeat(70));
  for (const [cls, r] of Object.entries(results)) {
    const triggered = r.variances.filter((v) => v <= rocResult.optimalThreshold).length;
    const rate = (triggered / N * 100).toFixed(1);
    console.log(`${cls.padEnd(22)} | ${r.label.padEnd(8)} | ${rate.padStart(6)}% | ${median(r.variances).toFixed(2)}ms²`);
  }

  // ---------- 与默认阈值 1ms² 的对比 ----------
  console.log('\n' + '-'.repeat(70));
  console.log('与当前默认阈值 1ms² 的对比：');
  console.log('-'.repeat(70));
  console.log('类别 | 期望 | 1ms² 触发率 | 标定值触发率');
  console.log('-'.repeat(70));
  for (const [cls, r] of Object.entries(results)) {
    const triggeredDefault = r.variances.filter((v) => v <= 1).length;
    const triggeredCalib = r.variances.filter((v) => v <= rocResult.optimalThreshold).length;
    console.log(
      `${cls.padEnd(22)} | ${r.label.padEnd(8)} | ${(triggeredDefault / N * 100).toFixed(1).padStart(6)}% | ${(triggeredCalib / N * 100).toFixed(1).padStart(6)}%`,
    );
  }

  // ---------- 汇总输出 ----------
  console.log('\n' + '='.repeat(70));
  console.log('标定结论');
  console.log('='.repeat(70));
  console.log(`标定值：${rocResult.optimalThreshold.toFixed(2)}ms²（Youden's J 最优，AUC=${rocResult.auc.toFixed(4)}）`);
  console.log(`95% CI：${bootstrapResult.lo.toFixed(2)}–${bootstrapResult.hi.toFixed(2)}ms²`);
  console.log(`当前默认：1.00ms²`);
  console.log(`结论：${rocResult.optimalThreshold > 1 ? '默认阈值过紧（漏报真周期/抖动周期），建议上调' : rocResult.optimalThreshold < 1 ? '默认阈值过松（误报随机序列），建议下调' : '默认阈值恰好最优'}`);

  const output = {
    env,
    config: { N, WINDOW, BASE_PERIOD_MS, BOOTSTRAP },
    results: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, {
        description: v.description,
        label: v.label,
        variance_median: median(v.variances),
        variance_min: Math.min(...v.variances),
        variance_max: Math.max(...v.variances),
        variance_p5: percentile(v.variances, 0.05),
        variance_p95: percentile(v.variances, 0.95),
        mean_median: median(v.means),
        raw_variances: v.variances,
      }]),
    ),
    roc: {
      optimalThreshold: rocResult.optimalThreshold,
      youdenJ: rocResult.youdenJ,
      tpr: rocResult.tpr,
      fpr: rocResult.fpr,
      auc: rocResult.auc,
      bootstrapCI_95: bootstrapResult,
    },
    c5_at_threshold: {
      triggered: c5Triggered,
      notTriggered: c5NotTriggered,
      triggerRate: c5Triggered / N,
    },
  };
  console.log('\n--- JSON_OUTPUT_START ---');
  console.log(JSON.stringify(output, null, 2));
  console.log('--- JSON_OUTPUT_END ---');
}

main();
