// ============================================================================
// calibrate-periodic-coverage-bound.mts
// 周期检测默认阈值 10000ms² 覆盖边界补充实验（v2.15.6）
//
// 目的：精确标定 10000ms² 在 5s 心跳场景下对不同抖动幅度的实际检出率，
// 为 CALIBRATION-REPORT-PERIODIC.md §5.4 与 index.ts 注释提供实测数字。
// 豆包审查建议 7（明确覆盖边界）的支撑数据。
//
// 运行方式：
//   node --experimental-transform-types calibrate-periodic-coverage-bound.mts
// ============================================================================

const N = 200;       // 每抖动档 200 个序列，确保检出率估计稳定
const WINDOW = 8;
const THRESHOLD = 10000; // ms²，当前默认阈值

function gaussian(mean: number, std: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
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
function simulatePeriodic(period: number, jitter: number): number[] {
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
  return variances;
}

// 扫描 5s 心跳下不同抖动幅度
const PERIOD = 5000;
const jitters = [10, 25, 50, 75, 100, 125, 150, 200, 300, 500];

console.log('='.repeat(90));
console.log(`周期检测默认阈值 10000ms² 覆盖边界实验（5s 心跳）`);
console.log(`参数：N=${N}/cell, WINDOW=${WINDOW}, threshold=${THRESHOLD}ms²`);
console.log('='.repeat(90));

console.log('\n抖动(ms) | 方差中位数 | P5 | P50 | P95 | P99 | 检出率(≤阈值) | 阈值是否覆盖(P95≤阈值)');
console.log('-'.repeat(90));

const results: any[] = [];

for (const jitter of jitters) {
  const variances = simulatePeriodic(PERIOD, jitter);
  const p5 = percentile(variances, 0.05);
  const p50 = percentile(variances, 0.5);
  const p95 = percentile(variances, 0.95);
  const p99 = percentile(variances, 0.99);
  const detected = variances.filter(v => v <= THRESHOLD).length;
  const detectionRate = detected / N;
  const covers = p95 <= THRESHOLD;

  console.log(
    `${String(jitter).padStart(8)} | ` +
    `${p50.toFixed(0).padStart(10)} | ` +
    `${p5.toFixed(0).padStart(12)} | ` +
    `${p50.toFixed(0).padStart(12)} | ` +
    `${p95.toFixed(0).padStart(12)} | ` +
    `${p99.toFixed(0).padStart(12)} | ` +
    `${(detectionRate * 100).toFixed(1).padStart(10)}% | ` +
    `${covers ? '✅ 是' : '❌ 否'}`,
  );

  results.push({
    jitter_ms: jitter,
    p5, p50, p95, p99,
    detection_rate: detectionRate,
    threshold_covers_p95: covers,
  });
}

// 关键结论
console.log('\n' + '='.repeat(90));
console.log('关键结论：');
const maxCovered = results.filter(r => r.threshold_covers_p95).map(r => r.jitter_ms);
const maxCoveredJitter = Math.max(...maxCovered);
const firstNonCovered = results.find(r => !r.threshold_covers_p95);
console.log(`默认阈值 10000ms² 在 5s 心跳下 P95 覆盖上界：抖动 ≤ ${maxCoveredJitter}ms`);
if (firstNonCovered) {
  console.log(`首个未覆盖档：抖动 ${firstNonCovered.jitter_ms}ms（P95=${firstNonCovered.p95.toFixed(0)}ms²，检出率 ${(firstNonCovered.detection_rate * 100).toFixed(1)}%）`);
}
const at200ms = results.find(r => r.jitter_ms === 200);
if (at200ms) {
  console.log(`5s+200ms 抖动场景：P95=${at200ms.p95.toFixed(0)}ms²，检出率仅 ${(at200ms.detection_rate * 100).toFixed(1)}%（远低于 95%）`);
}
const at100ms = results.find(r => r.jitter_ms === 100);
if (at100ms) {
  console.log(`5s+100ms 抖动场景：P95=${at100ms.p95.toFixed(0)}ms²，检出率 ${(at100ms.detection_rate * 100).toFixed(1)}%`);
}

console.log('\n--- JSON_OUTPUT_START ---');
console.log(JSON.stringify({ config: { N, WINDOW, period_ms: PERIOD, threshold_ms2: THRESHOLD }, results }, null, 2));
console.log('--- JSON_OUTPUT_END ---');
