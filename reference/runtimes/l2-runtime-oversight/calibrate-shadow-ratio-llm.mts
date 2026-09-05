// ============================================================================
// calibrate-shadow-ratio-llm.mts
// 路径 B：Agent 任务级影子比阈值标定
//
// 目标：用真实 LLM API（智谱 GLM-4）同一 prompt 调用 N=50 次，
//       采集真实 token 消耗（prompt_tokens + completion_tokens），
//       用与路径 A 同构的方法论（MAD + k=3 + bootstrap CI + 5-fold CV）
//       标定 Agent 任务级影子比阈值。
//
// 实验设计：
//   - 2 个 prompt 等价类（短 prompt / 长 prompt），各 N=50 次
//   - 短 prompt：简单问答（token 消耗小）
//   - 长 prompt：复杂推理（token 消耗大）
//   - 影子比 = 每次总 token 数 / 该等价类中位数
//   - 阈值 = 1 + 3 × MAD × 1.4826 / median
//
// 环境变量：
//   ZHIPU_API_KEY  智谱 API key
//   ZHIPU_MODEL    模型名（默认 glm-4）
//
// 运行：
//   ZHIPU_API_KEY=xxx node --experimental-transform-types calibrate-shadow-ratio-llm.mts
// ============================================================================

// ---------- 配置 ----------
const API_KEY = process.env.ZHIPU_API_KEY;
const MODEL = process.env.ZHIPU_MODEL || 'glm-4';
const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const N = 50;
const K = 3;
const BOOTSTRAP = 2000;
const FOLDS = 5;

if (!API_KEY) {
  console.error('ERROR: ZHIPU_API_KEY 环境变量未设置');
  process.exit(1);
}

// ---------- Prompt 等价类 ----------
const promptClasses = {
  P1_short: {
    description: '短 prompt：简单问答（低 token 消耗）',
    messages: [
      {
        role: 'user',
        content: '什么是递归？请用一句话解释。',
      },
    ],
    maxTokens: 100,
  },
  P2_long: {
    description: '长 prompt：复杂推理（高 token 消耗）',
    messages: [
      {
        role: 'user',
        content: `请分析以下三个 AI 治理方案各自的优缺点，并给出你推荐的方案及理由。

方案 A：严格的规则引擎——所有 AI 决策必须通过预定义的规则集验证后才能执行。规则由人工专家维护，每季度更新一次。

方案 B：基于大模型的实时监察——用另一个独立的大模型实时审查 AI 的每个决策，异常时阻断。监察模型与被监察模型来自不同供应商。

方案 C：混合架构——低风险决策由规则引擎处理，高风险决策由大模型监察。风险等级由任务分类器判定。

请从以下维度分析：(1) 响应延迟 (2) 误报率 (3) 可维护性 (4) 对抗攻击的鲁棒性 (5) 成本`,
      },
    ],
    maxTokens: 500,
  },
};

// ---------- 统计工具（与路径 A 完全同构） ----------
function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function mad(arr: number[], med: number): number {
  const deviations = arr.map((x) => Math.abs(x - med));
  return median(deviations);
}

function bootstrapCI(data: number[], statFn: (d: number[]) => number, reps: number = BOOTSTRAP) {
  const stats: number[] = [];
  const n = data.length;
  for (let r = 0; r < reps; r++) {
    const sample: number[] = [];
    for (let i = 0; i < n; i++) {
      sample.push(data[Math.floor(Math.random() * n)]);
    }
    stats.push(statFn(sample));
  }
  stats.sort((a, b) => a - b);
  return {
    lo: stats[Math.floor(reps * 0.025)],
    hi: stats[Math.floor(reps * 0.975)],
  };
}

function shadowRatioThreshold(data: number[]): number {
  const med = median(data);
  if (med === 0) return NaN;
  const m = mad(data, med);
  const robustSigma = m * 1.4826;
  return 1 + K * (robustSigma / med);
}

function crossValidate(data: number[], foldCount: number = FOLDS) {
  const foldSize = Math.floor(data.length / foldCount);
  const results: Array<{ foldIdx: number; trainThreshold: number; exceedRate: number }> = [];
  for (let f = 0; f < foldCount; f++) {
    const testStart = f * foldSize;
    const testEnd = f === foldCount - 1 ? data.length : testStart + foldSize;
    const train = [...data.slice(0, testStart), ...data.slice(testEnd)];
    const test = data.slice(testStart, testEnd);
    const trainThreshold = shadowRatioThreshold(train);
    const trainMed = median(train);
    let exceedCount = 0;
    for (const v of test) {
      if (trainMed > 0 && v / trainMed > trainThreshold) exceedCount++;
    }
    results.push({
      foldIdx: f,
      trainThreshold,
      exceedRate: exceedCount / test.length,
    });
  }
  return results;
}

// ---------- API 调用 ----------
async function callOnce(messages: any[], maxTokens: number): Promise<{
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  success: boolean;
}> {
  const tStart = process.hrtime.bigint();

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7, // 一致参数，让方差来自模型而非配置
      }),
    });

    const tEnd = process.hrtime.bigint();
    const durationMs = Number(tEnd - tStart) / 1e6;

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }

    const data: any = await resp.json();
    const usage = data.usage || {};

    return {
      totalTokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      durationMs,
      success: true,
    };
  } catch (err: any) {
    const tEnd = process.hrtime.bigint();
    return {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: Number(tEnd - tStart) / 1e6,
      success: false,
    };
  }
}

// ---------- 主流程 ----------
async function main() {
  const os = await import('node:os');
  const env = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    date: new Date().toISOString(),
    cpuCount: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    model: MODEL,
    apiProvider: '智谱 (open.bigmodel.cn)',
    temperature: 0.7,
  };

  console.log('='.repeat(70));
  console.log('影子比阈值标定实验 —— 路径 B：Agent 任务级标定');
  console.log('='.repeat(70));
  console.log(JSON.stringify(env, null, 2));
  console.log(`参数：N=${N}/类, K=${K}, bootstrap=${BOOTSTRAP}, folds=${FOLDS}`);
  console.log('-'.repeat(70));

  const results: any = {};

  for (const [cls, def] of Object.entries(promptClasses)) {
    console.log(`\n[${cls}] ${def.description}`);
    console.log(`  开始调用 ${MODEL} × ${N} 次...`);

    const totalTokens: number[] = [];
    const promptTokens: number[] = [];
    const completionTokens: number[] = [];
    const durations: number[] = [];
    const failures: number[] = []; // 记录失败次数

    for (let i = 0; i < N; i++) {
      process.stdout.write(`  ${i + 1}/${N}...`);
      const result = await callOnce(def.messages, def.maxTokens);

      if (result.success) {
        totalTokens.push(result.totalTokens);
        promptTokens.push(result.promptTokens);
        completionTokens.push(result.completionTokens);
        durations.push(result.durationMs);
        process.stdout.write(` tokens=${result.totalTokens} (${result.promptTokens}+${result.completionTokens}), ${result.durationMs.toFixed(0)}ms\n`);
      } else {
        failures.push(i);
        process.stdout.write(` FAILED\n`);
      }

      // 礼貌延迟（避免 rate limit）
      if (i < N - 1) await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`  完成：${totalTokens.length}/${N} 成功，${failures.length} 失败`);

    if (totalTokens.length < 10) {
      console.log(`  ⚠️ 有效样本不足（${totalTokens.length} < 10），跳过统计`);
      continue;
    }

    // ---- Token 消耗标定 ----
    const tokMed = median(totalTokens);
    const tokMAD = mad(totalTokens, tokMed);
    const tokRobustSigma = tokMAD * 1.4826;
    const tokThreshold = shadowRatioThreshold(totalTokens);
    const tokCI = bootstrapCI(totalTokens, shadowRatioThreshold);
    const tokCV = crossValidate(totalTokens);

    // ---- 时长标定 ----
    const durMed = median(durations);
    const durMAD = mad(durations, durMed);
    const durThreshold = shadowRatioThreshold(durations);
    const durCI = bootstrapCI(durations, shadowRatioThreshold);

    // ---- prompt_tokens 标定（验证一致性） ----
    const ptMed = median(promptTokens);
    const ptMAD = mad(promptTokens, ptMed);

    results[cls] = {
      description: def.description,
      model: MODEL,
      nSuccess: totalTokens.length,
      nFail: failures.length,
      totalTokens: {
        raw: totalTokens,
        median: tokMed,
        MAD: tokMAD,
        robustSigma: tokRobustSigma,
        shadowRatioThreshold: tokThreshold,
        bootstrapCI_95: tokCI,
        cvExceedRate_mean: tokCV.reduce((s: number, c: any) => s + c.exceedRate, 0) / tokCV.length,
        min: Math.min(...totalTokens),
        max: Math.max(...totalTokens),
      },
      promptTokens: {
        median: ptMed,
        MAD: ptMAD,
        min: Math.min(...promptTokens),
        max: Math.max(...promptTokens),
        ratio_max_over_min: Math.max(...promptTokens) / Math.min(...promptTokens),
      },
      completionTokens: {
        median: median(completionTokens),
        min: Math.min(...completionTokens),
        max: Math.max(...completionTokens),
        ratio_max_over_min: Math.max(...completionTokens) / Math.min(...completionTokens),
      },
      duration: {
        raw: durations,
        median_ms: durMed,
        shadowRatioThreshold: durThreshold,
        bootstrapCI_95: durCI,
        min_ms: Math.min(...durations),
        max_ms: Math.max(...durations),
      },
    };

    console.log(`  总 Token 中位数=${tokMed}  MAD=${tokMAD.toFixed(1)}  σ_robust=${tokRobustSigma.toFixed(1)}`);
    console.log(`         影子比阈值=${tokThreshold.toFixed(4)}  (95% CI: ${tokCI.lo.toFixed(4)}–${tokCI.hi.toFixed(4)})`);
    console.log(`         范围：${Math.min(...totalTokens)}–${Math.max(...totalTokens)} tokens (max/min = ${(Math.max(...totalTokens) / Math.min(...totalTokens)).toFixed(2)}×)`);
    console.log(`         prompt_tokens 一致性：${Math.min(...promptTokens)}–${Math.max(...promptTokens)} (波动 ${(Math.max(...promptTokens) / Math.min(...promptTokens)).toFixed(4)}×)`);
    console.log(`         交叉验证平均异常率=${(results[cls].totalTokens.cvExceedRate_mean * 100).toFixed(1)}%`);
    console.log(`  时长  中位数=${durMed.toFixed(0)}ms  影子比阈值=${durThreshold.toFixed(4)}`);
  }

  // ---- 汇总 ----
  console.log('\n' + '='.repeat(70));
  console.log('汇总：Agent 任务级影子比阈值');
  console.log('='.repeat(70));
  console.log('等价类 | Token 阈值 | Token CI | 时长阈值 | 时长 CI');
  console.log('-'.repeat(70));
  for (const [cls, r] of Object.entries(results)) {
    if (!r.totalTokens) continue;
    console.log(
      `${cls.padEnd(12)} | ${r.totalTokens.shadowRatioThreshold.toFixed(4).padStart(8)} | ` +
      `${r.totalTokens.bootstrapCI_95.lo.toFixed(4)}–${r.totalTokens.bootstrapCI_95.hi.toFixed(4)} | ` +
      `${r.duration.shadowRatioThreshold.toFixed(4).padStart(8)} | ` +
      `${r.duration.bootstrapCI_95.lo.toFixed(4)}–${r.duration.bootstrapCI_95.hi.toFixed(4)}`,
    );
  }

  const allTokThresholds = Object.values(results).filter((r: any) => r.totalTokens).map((r: any) => r.totalTokens.shadowRatioThreshold);
  if (allTokThresholds.length > 0) {
    console.log('-'.repeat(70));
    console.log(`Agent 任务级影子比阈值（token 中位数）= ${median(allTokThresholds).toFixed(4)}`);
    console.log(`Agent 任务级影子比阈值（token 最保守）= ${Math.max(...allTokThresholds).toFixed(4)}`);
  }

  const output = { env, config: { N, K, BOOTSTRAP, FOLDS }, results };
  console.log('\n--- JSON_OUTPUT_START ---');
  console.log(JSON.stringify(output, null, 2));
  console.log('--- JSON_OUTPUT_END ---');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
