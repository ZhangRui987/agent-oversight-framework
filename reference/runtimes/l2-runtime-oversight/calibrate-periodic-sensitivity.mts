// ============================================================================
// calibrate-periodic-sensitivity.mts
// 周期检测方差阈值标定——敏感性分析
//
// v2.15.0 的主实验（calibrate-periodic-threshold.mts）只测了 5000ms ± 50ms 一种心跳。
// 本脚本扫描不同周期长度（1s/5s/30s/60s）与不同抖动幅度（1ms/50ms/200ms/500ms），
// 观察标定阈值如何随参数变化——为报告提供"阈值适用范围"的证据。
//
// 运行方式：
//   node --experimental-transform-types calibrate-periodic-sensitivity.mts
// ============================================================================

const N = 30;       // 每类序列数（敏感性扫描用较小 N，降采样加速）
const WINDOW = 8;

function gaussian(mean: number, std: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

function exponential(lambda: number): number {
  return -Math.log(1 - Math.random()) * lambda;
}

function intervalVariance(timestamps: number[]): number {
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) intervals.push(timestamps[i] - timestamps[i - 1]);
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  return intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
}

function percentile(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)];
}

// 为给定 period + jitter 生成序列并返回方差中位数与 P95
function simulatePeriodic(period: number, jitter: number): { median: number; p95: number } {
  const variances: number[] = [];
  for (let i = 0; i < N; i++) {
    const startTs = Date.now() + Math.floor(Math.random() * 100000);
    const ts: number[] = [];
    let current = startTs;
    for (let j = 0; j < WINDOW; j++) {
      current += period + gaussian(0, jitter);
      ts.push(Math.floor(current));
    }
    variances.push(intervalVariance(ts));
  }
  return { median: percentile(variances, 0.5), p95: percentile(variances, 0.95) };
}

function simulatePoisson(period: number): { median: number; p5: number } {
  const variances: number[] = [];
  for (let i = 0; i < N; i++) {
    const startTs = Date.now() + Math.floor(Math.random() * 100000);
    const ts: number[] = [];
    let current = startTs;
    for (let j = 0; j < WINDOW; j++) {
      current += exponential(period);
      ts.push(Math.floor(current));
    }
    variances.push(intervalVariance(ts));
  }
  return { median: percentile(variances, 0.5), p5: percentile(variances, 0.05) };
}

// 扫描参数
const periods = [1000, 5000, 30000, 60000]; // 1s / 5s / 30s / 60s
const jitters = [1, 10, 50, 200, 500]; // ms

console.log('='.repeat(80));
console.log('周期检测方差阈值——敏感性分析');
console.log(`参数：N=${N}/cell, WINDOW=${WINDOW}`);
console.log('='.repeat(80));

// 表头
console.log('\n周期(秒) | 抖动(ms) | 周期方差P95(ms²) | 泊松方差P5(ms²) | 分离比(P5/P95)');
console.log('-'.repeat(80));

const sensitivityData: any[] = [];

for (const period of periods) {
  const poisson = simulatePoisson(period);
  for (const jitter of jitters) {
    const periodic = simulatePeriodic(period, jitter);
    const separationRatio = poisson.p5 / periodic.p95; // >1 表示可区分
    const periodSec = (period / 1000).toFixed(0);
    console.log(
      `${periodSec.padStart(8)}s | ${String(jitter).padStart(8)} | ${periodic.p95.toFixed(0).padStart(16)} | ${poisson.p5.toFixed(0).padStart(15)} | ${separationRatio.toFixed(1).padStart(12)}`,
    );
    sensitivityData.push({
      period_ms: period,
      jitter_ms: jitter,
      periodic_p95_variance: periodic.p95,
      poisson_p5_variance: poisson.p5,
      separation_ratio: separationRatio,
    });
  }
  console.log('-'.repeat(80));
}

// 结论
console.log('\n结论：');
const allRatios = sensitivityData.map((d) => d.separation_ratio);
const minRatio = Math.min(...allRatios);
const minCell = sensitivityData.find((d) => d.separation_ratio === minRatio);
console.log(`最差分离比 = ${minRatio.toFixed(1)}（周期=${minCell!.period_ms}ms, 抖动=${minCell!.jitter_ms}ms）`);
console.log(`最差情况下：周期序列 P95 方差 = ${minCell!.periodic_p95_variance.toFixed(0)}ms²`);
console.log(`最差情况下：泊松序列 P5 方差 = ${minCell!.poisson_p5_variance.toFixed(0)}ms²`);

// 推荐：取所有 cell 中"周期 P95 方差的最大值"作为保守阈值
const maxPeriodicP95 = Math.max(...sensitivityData.map((d) => d.periodic_p95_variance));
const minPoissonP5 = Math.min(...sensitivityData.map((d) => d.poisson_p5_variance));
console.log(`\n跨所有参数的保守阈值上限（周期 P95 最大值）= ${maxPeriodicP95.toFixed(0)}ms²`);
console.log(`跨所有参数的保守阈值下限（泊松 P5 最小值）= ${minPoissonP5.toFixed(0)}ms²`);
console.log(`安全余量（下限/上限）= ${(minPoissonP5 / maxPeriodicP95).toFixed(1)}×`);

const output = { config: { N, WINDOW }, sensitivity: sensitivityData, summary: { maxPeriodicP95, minPoissonP5, minRatio } };
console.log('\n--- JSON_OUTPUT_START ---');
console.log(JSON.stringify(output, null, 2));
console.log('--- JSON_OUTPUT_END ---');
