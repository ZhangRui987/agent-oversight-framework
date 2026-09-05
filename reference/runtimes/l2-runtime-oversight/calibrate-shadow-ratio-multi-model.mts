// ============================================================================
// calibrate-shadow-ratio-multi-model.mts
// 路径 B 扩展：多模型跨模型影子比阈值标定（v2.16.0）
//
// 目标：验证 AOE-CALIB-001 路径 B 仅用 GLM-4 标定的 1.36 影子比参考值
//       是否跨模型一致。分别对 DeepSeek / Kimi(Moonshot) / Qwen(千问)
//       三个模型用与原脚本完全同构的方法论各跑 N=50 次。
//
// 实验设计（与 calibrate-shadow-ratio-llm.mts 同构）：
//   - 2 个 prompt 等价类（短 / 长），各 N=50 次
//   - 影子比 = 每次总 token / 该等价类中位数
//   - 阈值 = 1 + 3 × MAD × 1.4826 / median
//   - bootstrap 95% CI + 5-fold CV
//
// 环境变量（运行时注入，不入库不存档）：
//   DEEPSEEK_API_KEY  DeepSeek API key
//   KIMI_API_KEY       Kimi (Moonshot) API key
//   QWEN_API_KEY       Qwen (DashScope) API key
//   MODELS             要跑的模型列表（逗号分隔，默认 all）
//
// 运行：
//   DEEPSEEK_API_KEY=xxx KIMI_API_KEY=xxx QWEN_API_KEY=xxx \
//     node --experimental-transform-types calibrate-shadow-ratio-multi-model.mts
//
// ⚠️ API 安全：所有 key 仅在运行时从环境变量读取，脚本内不做任何持久化。
//    产物只保留聚合统计量（中位数 / MAD / 阈值 / CI），不保留单次 raw tokens。
// ============================================================================

// ---------- Provider 配置 ----------
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek (deepseek-chat)',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    authScheme: 'bearer',
    overrides: { temperature: 0.7, delayMs: 600 },
  },
  kimi: {
    label: 'Kimi / Moonshot (kimi-k2.6)',
    apiKeyEnv: 'KIMI_API_KEY',
    apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-k2.6',
    authScheme: 'bearer',
    // Kimi k2.6 是推理模型：仅允许 temperature=1；max_tokens 需远高于 reasoning tokens 才能看到 completion 方差；
    // 免费层 RPM 很紧，需要更长延迟避免 429
    overrides: { temperature: 1.0, p1MaxTokens: 2000, p2MaxTokens: 4000, delayMs: 3500 },
  },
  qwen: {
    label: 'Qwen / DashScope (qwen-plus)',
    apiKeyEnv: 'QWEN_API_KEY',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
    authScheme: 'bearer',
    overrides: { temperature: 0.7, delayMs: 600 },
  },
};

type ProviderKey = keyof typeof PROVIDERS;

// ---------- 参数 ----------
const N = 50;
const K = 3;
const BOOTSTRAP = 2000;
const FOLDS = 5;
const TEMPERATURE = 0.7;
const POLITENESS_DELAY_MS = 600; // 跨 provider 礼貌延迟，稍高于原脚本 200ms

// ---------- Prompt 等价类（与 calibrate-shadow-ratio-llm.mts 完全一致） ----------
const promptClasses = {
  P1_short: {
    description: '短 prompt：简单问答（低 token 消耗）',
    messages: [
      { role: 'user', content: '什么是递归？请用一句话解释。' },
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

// ---------- 统计工具（与路径 A/B 完全同构） ----------
function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function mad(arr: number[], med: number): number {
  return median(arr.map((x) => Math.abs(x - med)));
}

function bootstrapCI(data: number[], statFn: (d: number[]) => number, reps: number = BOOTSTRAP) {
  const stats: number[] = [];
  const n = data.length;
  for (let r = 0; r < reps; r++) {
    const sample: number[] = [];
    for (let i = 0; i < n; i++) sample.push(data[Math.floor(Math.random() * n)]);
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
  return 1 + K * (m * 1.4826 / med);
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
    results.push({ foldIdx: f, trainThreshold, exceedRate: exceedCount / test.length });
  }
  return results;
}

// ---------- 统一 OpenAI 兼容 API 调用 ----------
async function callOnce(
  provider: ProviderKey,
  messages: any[],
  maxTokens: number,
): Promise<{
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  durationMs: number;
  success: boolean;
  errorMsg?: string;
}> {
  const cfg = PROVIDERS[provider];
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    return {
      totalTokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, durationMs: 0,
      success: false, errorMsg: `${cfg.apiKeyEnv} not set`,
    };
  }
  const temp = cfg.overrides?.temperature ?? TEMPERATURE;
  const tStart = process.hrtime.bigint();
  try {
    const resp = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: maxTokens,
        temperature: temp,
      }),
    });
    const tEnd = process.hrtime.bigint();
    const durationMs = Number(tEnd - tStart) / 1e6;
    if (!resp.ok) {
      const text = await resp.text();
      return {
        totalTokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, durationMs,
        success: false, errorMsg: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
      };
    }
    const data: any = await resp.json();
    const usage = data.usage || {};
    const reasoning = usage.completion_tokens_details?.reasoning_tokens || 0;
    return {
      totalTokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      reasoningTokens: reasoning,
      durationMs,
      success: true,
    };
  } catch (err: any) {
    const tEnd = process.hrtime.bigint();
    return {
      totalTokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
      durationMs: Number(tEnd - tStart) / 1e6,
      success: false, errorMsg: err.message,
    };
  }
}

// ---------- 单 provider × 全 prompt 类 的完整流程 ----------
async function runProvider(provider: ProviderKey) {
  const cfg = PROVIDERS[provider];
  const apiKey = process.env[cfg.apiKeyEnv];
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Provider: ${cfg.label}`);
  console.log(`API key 来源: ${apiKey ? '✓ 已设置 (' + cfg.apiKeyEnv + ')' : '✗ 未设置，跳过'}`);
  if (!apiKey) return null;
  console.log(`${'='.repeat(70)}`);

  const providerResults: any = {};

  for (const [cls, def] of Object.entries(promptClasses)) {
    // 推理模型（overrides.delayMs >= 3000）只跑 P1_short：P2 会让 reasoning tokens 极大，
    // 耗时极长且触发限流；P2 方差主要受 max_tokens 截断，推理模型更甚，数据意义低。
    const isReasoningModel = (cfg.overrides?.delayMs ?? 0) >= 3000;
    if (isReasoningModel && cls !== 'P1_short') {
      console.log(`\n[${provider}/${cls}] 跳过（推理模型只跑 P1_short）`);
      providerResults[cls] = { skipped: true, reason: 'reasoning_model_skipped_P2' };
      continue;
    }
    console.log(`\n[${provider}/${cls}] ${def.description}`);
    // 推理模型（如 kimi-k2.6）需要在 overrides 中放大 max_tokens，避免 reasoning_tokens 占满预算
    const overrideKey = cls === 'P1_short' ? 'p1MaxTokens' : 'p2MaxTokens';
    const effectiveMaxTokens = cfg.overrides?.[overrideKey] ?? def.maxTokens;
    const effectiveTemp = cfg.overrides?.temperature ?? TEMPERATURE;
    console.log(`  参数：max_tokens=${effectiveMaxTokens}, temperature=${effectiveTemp}, model=${cfg.model}, N=${N}`);

    console.log(`  开始调用 ${cfg.model} × ${N} 次...`);

    const totalTokens: number[] = [];
    const promptTokens: number[] = [];
    const completionTokens: number[] = [];
    const reasoningTokens: number[] = [];
    const durations: number[] = [];
    let failures = 0;

    for (let i = 0; i < N; i++) {
      process.stdout.write(`  ${i + 1}/${N}...`);
      const result = await callOnce(provider, def.messages, effectiveMaxTokens);
      if (result.success) {
        totalTokens.push(result.totalTokens);
        promptTokens.push(result.promptTokens);
        completionTokens.push(result.completionTokens);
        reasoningTokens.push(result.reasoningTokens);
        durations.push(result.durationMs);
        process.stdout.write(
          ` tokens=${result.totalTokens} (p=${result.promptTokens},c=${result.completionTokens},r=${result.reasoningTokens}), ${result.durationMs.toFixed(0)}ms\n`,
        );
      } else {
        failures++;
        process.stdout.write(` FAILED: ${result.errorMsg?.slice(0, 100)}\n`);
        // 连续失败阈值按 provider 自适应：推理模型免费层限流紧，放宽阈值
        const failLimit = cfg.overrides?.delayMs && cfg.overrides.delayMs >= 3000 ? 40 : 10;
        if (failures >= failLimit) {
          console.log(`  ⚠️ 累计失败 ≥${failLimit} 次，中止 ${cls}`);
          break;
        }
      }
      if (i < N - 1) {
        // 失败时（尤其 429）延长下次延迟到 base×3
        const baseDelay = cfg.overrides?.delayMs ?? POLITENESS_DELAY_MS;
        const delay = (!result.success && result.errorMsg?.includes('429')) ? baseDelay * 4 : baseDelay;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (totalTokens.length < 10) {
      console.log(`  ⚠️ 有效样本不足（${totalTokens.length} < 10），跳过统计`);
      providerResults[cls] = { nSuccess: totalTokens.length, skipped: true };
      continue;
    }

    const tokMed = median(totalTokens);
    const tokMAD = mad(totalTokens, tokMed);
    const tokThreshold = shadowRatioThreshold(totalTokens);
    const tokCI = bootstrapCI(totalTokens, shadowRatioThreshold);
    const tokCV = crossValidate(totalTokens);
    const ptMed = median(promptTokens);
    const ptMAD = mad(promptTokens, ptMed);
    const durMed = median(durations);
    const durThreshold = shadowRatioThreshold(durations);
    const durCI = bootstrapCI(durations, shadowRatioThreshold);

    providerResults[cls] = {
      model: cfg.model,
      nSuccess: totalTokens.length,
      nFail: failures,
      effectiveMaxTokens,
      effectiveTemperature: effectiveTemp,
      totalTokens: {
        median: tokMed,
        MAD: tokMAD,
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
        range: Math.max(...completionTokens) - Math.min(...completionTokens),
      },
      reasoningTokens: {
        median: median(reasoningTokens),
        min: Math.min(...reasoningTokens),
        max: Math.max(...reasoningTokens),
        medianShareOfCompletion: median(reasoningTokens) / (median(completionTokens) || 1),
      },
      duration: {
        median_ms: durMed,
        shadowRatioThreshold: durThreshold,
        bootstrapCI_95: durCI,
        min_ms: Math.min(...durations),
        max_ms: Math.max(...durations),
      },
    };

    console.log(`  完成：${totalTokens.length}/${N} 成功，${failures} 失败`);
    console.log(`  Token 中位数=${tokMed}  MAD=${tokMAD.toFixed(1)}  影子比阈值=${tokThreshold.toFixed(4)}  (95% CI ${tokCI.lo.toFixed(4)}–${tokCI.hi.toFixed(4)})`);
    console.log(`         completion_tokens 范围：${Math.min(...completionTokens)}–${Math.max(...completionTokens)} (${(Math.max(...completionTokens) - Math.min(...completionTokens))} 绝对波动)`);
    if (median(reasoningTokens) > 0) {
      console.log(`         reasoning_tokens 中位数=${median(reasoningTokens)} (占 completion 的 ${(median(reasoningTokens) / (median(completionTokens) || 1) * 100).toFixed(1)}%)`);
    }
    console.log(`         prompt_tokens 一致性：${Math.min(...promptTokens)}–${Math.max(...promptTokens)} (${(Math.max(...promptTokens) / Math.min(...promptTokens)).toFixed(4)}×)`);
    console.log(`  时长  中位数=${durMed.toFixed(0)}ms  影子比阈值=${durThreshold.toFixed(4)}`);
  }
  return providerResults;
}

// ---------- 主流程 ----------
async function main() {
  const os = await import('node:os');
  const env = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    date: new Date().toISOString(),
    cpuCount: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    temperature: TEMPERATURE,
    politenessDelayMs: POLITENESS_DELAY_MS,
  };
  const argModels = (process.env.MODELS || 'all').toLowerCase().split(',').map((s) => s.trim());
  const targets = argModels.includes('all')
    ? Object.keys(PROVIDERS) as ProviderKey[]
    : argModels.filter((m) => m in PROVIDERS) as ProviderKey[];

  console.log('='.repeat(70));
  console.log('影子比阈值标定 —— 路径 B 扩展：多模型跨模型标定');
  console.log('='.repeat(70));
  console.log(JSON.stringify(env, null, 2));
  console.log(`参数：N=${N}/类, K=${K}, bootstrap=${BOOTSTRAP}, folds=${FOLDS}, delay=${POLITENESS_DELAY_MS}ms`);
  console.log(`目标模型：${targets.map((t) => PROVIDERS[t].label).join(' / ')}`);
  console.log('-'.repeat(70));

  const allResults: any = {};
  for (const provider of targets) {
    const result = await runProvider(provider);
    if (result) allResults[provider] = result;
  }

  // ---- 跨模型汇总 ----
  console.log('\n' + '='.repeat(70));
  console.log('跨模型影子比汇总（token 维度）');
  console.log('='.repeat(70));
  console.log('Provider     | 等价类   | Token 中位数 | Token 阈值 | 95% CI           | CV 异常率');
  console.log('-'.repeat(70));
  for (const [prov, cls_data] of Object.entries(allResults)) {
    for (const [cls, r] of Object.entries(cls_data as any)) {
      const rr = r as any;
      if (rr.skipped || !rr.totalTokens) continue;
      console.log(
        `${prov.padEnd(12)} | ${cls.padEnd(8)} | ${String(rr.totalTokens.median).padStart(12)} | ${rr.totalTokens.shadowRatioThreshold.toFixed(4).padStart(10)} | ${rr.totalTokens.bootstrapCI_95.lo.toFixed(4)}–${rr.totalTokens.bootstrapCI_95.hi.toFixed(4)} | ${(rr.totalTokens.cvExceedRate_mean * 100).toFixed(1)}%`,
      );
    }
  }

  // ---- 只取 P1_short（无 max_tokens 截断的有效比较点）做跨模型一致性判断 ----
  const p1Thresholds: Array<{ provider: string; threshold: number; ci: [number, number] }> = [];
  for (const [prov, cls_data] of Object.entries(allResults)) {
    const p1 = (cls_data as any).P1_short;
    if (p1 && !p1.skipped && p1.totalTokens) {
      p1Thresholds.push({
        provider: prov,
        threshold: p1.totalTokens.shadowRatioThreshold,
        ci: [p1.totalTokens.bootstrapCI_95.lo, p1.totalTokens.bootstrapCI_95.hi],
      });
    }
  }
  if (p1Thresholds.length > 0) {
    console.log('-'.repeat(70));
    console.log('P1 短 prompt 跨模型一致性（无 max_tokens 截断）：');
    for (const p of p1Thresholds) {
      console.log(`  ${p.provider.padEnd(12)}  阈值=${p.threshold.toFixed(4)}  CI ${p.ci[0].toFixed(4)}–${p.ci[1].toFixed(4)}`);
    }
    const values = p1Thresholds.map((p) => p.threshold);
    const max = Math.max(...values);
    const min = Math.min(...values);
    console.log(`  跨模型范围：${min.toFixed(4)}–${max.toFixed(4)}（跨度 ${(max - min).toFixed(4)}）`);
    // 原 GLM-4 标定值 1.36 作为参照线
    console.log(`  参照（GLM-4 原标定值）：1.36`);
    console.log(`  是否一致（最大偏离 ≤0.15）？${max - min <= 0.15 ? '是 ✓' : '否 ✗'}`);
  }

  const output = {
    env,
    config: { N, K, BOOTSTRAP, FOLDS, TEMPERATURE, POLITENESS_DELAY_MS },
    referenceGLM4: { P1_short: { shadowRatioThreshold: 1.36, ci: [1.18, 1.64] } },
    providers: PROVIDERS,
    results: allResults,
    crossModelP1: p1Thresholds,
  };
  console.log('\n--- JSON_OUTPUT_START ---');
  console.log(JSON.stringify(output, null, 2));
  console.log('--- JSON_OUTPUT_END ---');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
