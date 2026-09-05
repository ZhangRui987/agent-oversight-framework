# 影子比阈值自复现标定实验报告

> **实验编号**：AOE-CALIB-001
>
> **执行日期**：2026-09-05
>
> **实验范式**：双层标定（路径 A 监察操作级 + 路径 B Agent 任务级）
>
> **证据等级**：A 级（一手 / 可核查 / 实证 / 可复现——脚本入库，任何人可重跑）
>
> **版本**：v2.14.0

---

## 1. 实验目的

标定 ResourceLedger 影子比阈值（`shadowRatioThreshold`），闭合 G5 剩余差距 (a) 基线标定中的影子比部分。

spec/10 原文：「影子比——同任务在不同模型 / 实例上的消耗分布，系统性偏离基线即异常（**阈值须标定后确定**）」。v2.13.0 的默认值 2.0 为占位常数，本实验用真实运行数据标定。

---

## 2. 实验环境

| 维度 | 路径 A（监察操作级） | 路径 B（Agent 任务级） |
|---|---|---|
| Node.js | v22.22.2 | v22.22.2 |
| 平台 | win32/x64 | win32/x64 |
| CPU 核数 | 16 | 16 |
| 运行时 flag | `--experimental-transform-types --expose-gc` | `--experimental-transform-types` |
| 执行时间 | 2026-09-05T06:30:36Z | 2026-09-05T06:34:24Z |
| API | 无（纯进程内测量） | 智谱 GLM-4（open.bigmodel.cn），temperature=0.7 |
| API key | 不适用 | 运行时注入环境变量，不入库不存档 |

---

## 3. 方法论

### 3.1 通用统计框架（两条路径同构）

1. **基线建立**：每等价类运行 N=50 次，取度量中位数作为基线（对齐 spec/10「同任务历史消耗中位数」定义）。
2. **异常检测阈值**：MAD（Median Absolute Deviation）+ 标准化系数 1.4826 + k=3 倍数。
   - 影子比阈值 = 1 + K × (MAD × 1.4826 / median)
   - 等价于 3σ 界限，但对重尾分布更稳健（比均值 ± σ 抗离群值）。
3. **不确定性量化**：bootstrap 95% 置信区间（重采样 2000 次），报告阈值的区间而非单点。
4. **交叉验证**：5-fold 交叉验证，每 fold 40 个样本训练标定、10 个样本验证异常率。

### 3.2 路径 A：监察操作级标定（下界）

| 设计维度 | 内容 |
|---|---|
| 测量对象 | ResourceLedger 四类操作在 Node.js 运行时上的执行开销 |
| 等价类 | C1=预算判定（record）/ C2=影子比判定 / C3=记忆写入审计（auditMemoryWrite）/ C4=周期型外联（record×8）/ C5=混合负载 |
| 主度量 | 执行时长（`process.hrtime.bigint()` → 纳秒 → 毫秒） |
| 辅助度量 | 堆内存增量（`process.memoryUsage().heapUsed`） |
| 热身协议 | 5 次空跑预热 JIT + 1 次 measureOnce 内部热身 + 每次 measureOnce 前 `global.gc()` |
| 标定目标 | 影子比阈值的**监察操作级下界**（进程开销方差 << LLM 消耗方差，故此值为保守下界） |

### 3.3 路径 B：Agent 任务级标定

| 设计维度 | 内容 |
|---|---|
| 测量对象 | 真实 LLM API 同一 prompt 重复调用的 token 消耗 |
| 等价类 | P1=短 prompt（「什么是递归？请用一句话解释」，max_tokens=100）/ P2=长 prompt（AI 治理方案分析，max_tokens=500） |
| 主度量 | 总 token 数（prompt_tokens + completion_tokens） |
| 辅助度量 | API 响应时长 |
| 礼貌延迟 | 每次调用间 200ms |
| 标定目标 | Agent 任务级影子比阈值的**参考值** |

---

## 4. 结果

### 4.1 路径 A：监察操作级

| 等价类 | 时长中位数 (ms) | MAD (ms) | 影子比阈值 | 95% CI | 交叉验证异常率 |
|---|---|---|---|---|---|
| C1 预算判定 | 0.0444 | 0.0103 | **2.04** | 1.55–2.27 | 4.0% |
| C2 影子比判定 | 0.0542 | 0.0079 | **1.65** | 1.39–2.04 | 10.0% |
| C3 记忆写入审计 | 0.1079 | 0.0195 | **1.80** | 1.57–2.11 | 8.0% |
| C4 周期型外联 | 0.0584 | 0.0136 | **2.03** | 1.48–2.27 | 6.0% |
| C5 混合负载 | 0.1115 | 0.0182 | **1.72** | 1.53–1.92 | 4.0% |
| **综合** | | | **1.80**（中位数） | | **6.4%**（平均） |
| **最保守** | | | **2.04** | | |

**堆内存标定**：所有等价类 MAD=0（50 次测量的堆内存增量高度一致），影子比阈值退化为 1.0。这验证了「操作计数/确定性度量不适合做异常检测」的方法论判断——当度量缺乏方差时，MAD=0 导致阈值无意义。

### 4.2 路径 B：Agent 任务级

| 等价类 | Token 中位数 | Token MAD | Token 影子比阈值 | 95% CI | 时长影子比阈值 |
|---|---|---|---|---|---|
| P1 短 prompt | 37 | 3.0 | **1.36** | 1.18–1.64 | 1.86 |
| P2 长 prompt | 670 | **0** | **1.00** ⚠️ | 1.00–1.00 | 1.46 |

**关键发现：P2 token 方差为零**

P2 的 50 次调用全部返回 670 tokens（170 prompt + 500 completion），MAD=0，影子比阈值退化为 1.0。根因：`max_tokens=500` 硬限制导致 completion tokens 每次恰好截断在 500——这不是模型的自然方差为零，而是**分布被配置截断**。

这是一个对 spec/10 有直接含义的发现：**当 `max_tokens` 成为限制因素时，影子比信号失效**（方差为零 → 阈值退化为 1.0 → 任何偏差都触发，或什么都不触发，取决于实现）。生产部署时，影子比检测必须考虑是否在 `max_tokens` 限制之上——若 completion 经常触及限制，需要切换到 prompt_tokens 做影子比（prompt 编码是确定性的），或改用时長/内存维度。

P1（无截断的自然短回复）是唯一有效的 token 方差来源：completion_tokens 范围 14–47（2.4× 波动），总 token 影子比阈值 **1.36**（95% CI 1.18–1.64）。

### 4.3 双层对比

| 维度 | 路径 A（监察操作级） | 路径 B（Agent 任务级，有效部分） |
|---|---|---|
| 标定对象 | 进程开销 | LLM token 消耗 |
| 时长影子比阈值 | 1.65–2.04 | 1.46–1.86 |
| Token 影子比阈值 | 不适用 | 1.36（P1 有效） |
| 方差来源 | Node.js 事件循环、GC、JIT | LLM 采样的固有随机性 |
| 与 arXiv:2604.22750 的关系 | 该论文测的是 agentic coding 任务的 30× 波动——本实验的方差远小于此 | GLM-4 简单问答 2.0× 波动，差异来自任务复杂度与是否使用 max_tokens 限制 |

---

## 5. 标定结论

### 5.1 推荐阈值

| 用途 | 推荐值 | 来源 | 理由 |
|---|---|---|---|
| 监察操作级下界（时长） | **1.80**（保守取 2.04） | 路径 A 时长 | 进程开销波动的 3σ 界限 |
| Agent 任务级参考值（token） | **1.36** | 路径 B P1 有效数据 | GLM-4 简单问答 token 消耗的 3σ 界限 |
| 生产默认值（保留） | **2.0** | v2.13.0 原值 | 生产系统面对的任务多样性远超实验——arXiv:2604.22750 实测 30× 波动提示阈值不可低于 2.0 |

### 5.2 为什么不改默认值

1. **实验覆盖面有限**：仅 GLM-4 一个模型、两个 prompt 模式、50 次采样——生产系统面对的是多模型、多任务、长尾分布。
2. **arXiv:2604.22750 的参照**：同任务 30× 波动意味着任何固定阈值都只是工程近似，2.0 作为默认值在「误报率可控」与「异常检测灵敏」之间取了合理折中。
3. **一致性**：改紧默认值可能导致 demo [20] 组在 CI 环境上因噪声触发误报。

**采纳豆包建议的「双阈值设计」**：默认值 2.0 不变，新增标定值作为注释/参考字段。

---

## 6. 诚实边界

### 6.1 本实验支撑的

- ResourceLedger 监察操作级影子比阈值的下界标定方法（路径 A）——**完全支撑**
- GLM-4 在简单问答场景下的 token 消耗方差特性（路径 B P1）——**在该模型该任务上完全支撑**
- `max_tokens` 限制对 token 方差的截断效应（路径 B P2）——**定性支撑，定量需更多模型验证**

### 6.2 本实验不支撑的

- **不支撑**「影子比阈值 X.X 适用于所有 Agent 任务」——实验只覆盖了 GLM-4 + 两类 prompt。
- **不支撑**「影子比能有效检测 Agent 异常」——实验只标定了阈值，未验证阈值在真实异常场景下的检出率与误报率。
- **不支撑**「周期型外联检测阈值」——本实验只标定影子比，周期检测方差阈值（默认 1ms²）未涉及（另议）。
- **不支撑**路径 A 的阈值直接用于 Agent 任务——进程开销方差 << LLM token 方差，两者方差结构不同。

### 6.3 泛化性限制

- 单运行时环境（Node.js 22）、单机器（win32/x64, 16 核）、单次执行。
- GLM-4 单模型——不同供应商的模型 token 方差特性可能显著不同。
- 50 次采样提供了 bootstrap CI，但不足以捕获长尾异常。
- `temperature=0.7` 是一个常见的生产配置，但不同 temperature 下方差结构可能不同。

---

## 7. 复现指南

### 7.1 路径 A

```bash
cd reference/runtimes/l2-runtime-oversight
node --experimental-transform-types --expose-gc calibrate-shadow-ratio.mts
```

零外部依赖、零 API key——任何人 clone 仓库即可重跑。运行时间约 3 秒。

### 7.2 路径 B

```bash
cd reference/runtimes/l2-runtime-oversight
ZHIPU_API_KEY=<your-key> ZHIPU_MODEL=glm-4 \
  node --experimental-transform-types calibrate-shadow-ratio-llm.mts
```

需要智谱 API key。运行时间约 8–10 分钟（100 次 API 调用 + 200ms 礼貌延迟）。

---

## 8. 对 spec/10 与 PRODUCTION-GAPS 的影响

### 8.1 spec/10 更新

spec/10 影子比章节增加实证段：

> **影子比阈值标定（v2.14.0 自复现实验，A 级）**：本体系用自身的 ResourceLedger 操作开销（路径 A）与真实 LLM API 调用（路径 B，GLM-4）做了首次影子比阈值标定实验。监察操作级下界（时长维度）为 1.80（5 类中位数，保守取 2.04），Agent 任务级参考值（GLM-4 简单问答 token 维度）为 1.36。实验发现 `max_tokens` 硬限制会使 completion token 方差为零、影子比失效——生产部署须确保影子比检测不被配置截断架空。默认阈值 2.0 保留不变，标定值作为参考注释。完整原始数据与复现脚本见 `calibrate-shadow-ratio.mts` / `calibrate-shadow-ratio-llm.mts` / `CALIBRATION-REPORT.md`。

### 8.2 PRODUCTION-GAPS G5(a) 更新

从「基线标定——未闭合」更新为「**影子比阈值已标定（监察操作级下界 1.80 / Agent 任务级参考值 1.36，v2.14.0），周期检测方差阈值待标定**」。

### 8.3 index.ts 更新

`shadowRatioThreshold` 默认值 2.0 不变，注释更新为：

> 默认 2.0（v2.14.0 自复现实验标定：监察操作级下界 1.80，Agent 任务级参考值 1.36；生产默认值保留 2.0 因 arXiv:2604.22750 实测同任务 30× 波动提示阈值不可低于此值）。

---

## 附录 A：原始数据存放

- 路径 A JSON 输出：本文 §4.1 表格 + `calibrate-shadow-ratio.mts` 运行时 stdout
- 路径 B JSON 输出：本文 §4.2 表格 + `calibrate-shadow-ratio-llm.mts` 运行时 stdout
- 完整 50 次原始度量值：嵌入脚本的 JSON_OUTPUT 段，任何人可重跑获取

## 附录 B：方法论参考文献

- MAD 异常检测：Leys et al. (2013). *Detecting outliers: Do not use standard deviation around the mean, use absolute deviation around the median.* J Exp Soc Psychol 49(4):764–766.
- bootstrap 置信区间：Efron & Tibshirani (1993). *An Introduction to the Bootstrap.* Chapman & Hall.
- arXiv:2604.22750（同任务 30× 波动）：Bai et al. (2026). Token consumption study on SWE-bench Verified.
