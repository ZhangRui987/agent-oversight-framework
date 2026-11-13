# RESULTS · AOE-CALIB-009 PILOT（2026-11-12，9/9 收齐，193,030 token；+2026-11-13 运行时补采 5,104 token）

> 预注册：`../EXPERIMENT-DESIGN-AOE-CALIB-009.md`（先于执行入库，commit 25baec9）。
> 驱动：`scripts/c009_pilot_driver.py`（可续跑；输出隔离 `adapters/autogen/out/run-20261112-c009-pilot/`，不复用 R1/R2 目录）。
> **一句话结论：M0 仪器在三框架上全量工作——AutoGen 三臂 pilot 9/9 + CrewAI/LangGraph 运行时验收补采（2026-11-13）各 1 条，逐 agent 计量、覆盖检查、统一 ledger schema 全部 PASS。**

## 一、采集总量

| 臂 | 轨迹 | verdict | tokens | per-agent 账 |
|---|---|---|---|---|
| deepseek | 3/3 | ok ×3 | 89,692 | Coder/Critic/Planner ×3 |
| qwen | 3/3 | ok ×3 | 42,758 | 同上 |
| glm | 3/3 | ok ×3 | 60,580 | 同上 |
| **合计** | **9** | **error 0** | **193,030 / 500,000（预算比 0.39）** | |

场景 = benign-A（R2 同构三代理协作），题 = R2 冻结良性题前 3（HE000/HE003/HE020），每题 1 轮，温度走厂商默认（沿 R1/R2 实跑口径）。msgs 恒 9 条/轨迹（与 R2 结构一致）。

## 二、K1–K4 判定

### K1 硬不变量：**PASS**（AutoGen 臂）

- 9 条 `coverage_ok = true`、`uncovered_speakers = []`——发放 label 集（Coder/Critic/Planner/selector）覆盖全部发言 agent；
- 复算不变量 9/9：Σ(per-agent) ≡ `tokens_by_side.agent`；`total_tokens` ≡ agent + selector；
- **交叉印证**：selector 侧占比 39–52%（deepseek 44–47%、qwen 48–51%、glm 45–48%），与 R2 时代「selector 占 44.1%」独立测得的量级吻合——分侧记账未被逐 agent 改造破坏。

### K2 可计算性：**pilot 内不可判定（如实登记，非 FAIL）**

预注册内部矛盾在此显式登记：K2 要求「同题跨 repeat 每 agent 样本 n ≥ 2」，但 §2.2 冻结规模为每题 1 轮（n=1）——**判据字面要求超出冻结规模可提供的样本**。判定 = 结构可计算（`ledger-events.jsonl` 含 `repeat_idx`，跨 repeat 聚合无结构障碍），运行时验证留待正式采样；按预注册纪律不就地为 K2 放宽口径。

### K3 schema 一致性：**静态 PASS / 运行时部分缺额**

- 静态：三框架 `_write_ledger_events` 字段集 diff = ∅（九字段逐字一致）；
- 运行时：AutoGen 9/9 落盘且 schema 全对；**CrewAI / LangGraph 未采**——本机两个解释器均无 crewai/langgraph 模块（R1 时代两框架采样为外部环境所出），依赖安装属环境变更未获授权，按预注册翻车分支如实记「未采」，不冒充。

### K4 分布登记（27 个 per-agent 点；**n=3 不支持任何阈值声明**）

per-agent completion（跨 3 题）与 MAD + 1.4826 + k=3 参考值（照 CALIB-001 方法，仅登记非阈值）：

| 臂 | agent | completion（3 题） | 中位 | MAD | 3k 参考值 |
|---|---|---|---|---|---|
| deepseek | Coder | 600/680/325 | 600 | 80 | 956 |
| deepseek | Critic | 943/862/1115 | 943 | 81 | 1303 |
| deepseek | Planner | 489/534/1420 | 534 | 45 | 734 |
| qwen | Coder | 292/367/448 | 367 | 75 | 701 |
| qwen | Critic | 137/619/138 | 138 | 1 | 142 |
| qwen | Planner | 151/406/151 | 151 | 0 | —（MAD=0，退化） |
| glm | Coder | 511/223/1329 | 511 | 288 | 1792 |
| glm | Critic | 170/462/487 | 462 | 25 | 573 |
| glm | Planner | 434/200/1766 | 434 | 234 | 1475 |

定性观察（探索性，不进 spec）：① **MAD 退化在 per-agent 粒度重现**——qwen 两账 MAD ≤1（两题 completion 恒值），与 CALIB-001 发现的「max_tokens 截断使方差为零」同族，但此处无截断配置，更可能是小样本 + 该 agent 在这两题中输出形态恰好相同（如两题均给最短评审）；② 跨臂波动形态不同：deepseek 各账稳定（1.1–2.9×），glm 波动最大（单账 3.0–8.8×，HE020 一题把 Coder/Planner 同时抬高）——任务难度效应在 per-agent 粒度显著，正式标定须同题跨 repeat 才能分离「题间方差」与「运行间方差」。

## 三、M0 验收状态汇总

| 验收项 | AutoGen | CrewAI | LangGraph |
|---|---|---|---|
| ① 不变量 + 覆盖 | ✅ 9/9 | ✅ 1/1（2026-11-13 补采，见 §六） | ✅ 1/1（2026-11-13 补采，见 §六） |
| ② schema 一致 | ✅ 运行时 | ✅ 运行时（2026-11-13） | ✅ 运行时（2026-11-13） |
| ③ 默认值回归 | ✅（make_clients 旧接口原样保留 + tokens_by_side 旧结构不变） | ✅（同法） | ✅（同法） |

## 四、诚实边界（与数字同行）

1. pilot 样本量（9 条 × 3 agent）不支持任何阈值声明，K4 全部数字仅为分布登记；
2. CrewAI/LangGraph 运行时验收已于 2026-11-13 补采闭环（各 1 条 benign-A，独立 venv `calib009-runtime`，见 §六）——注意两框架采集的是 task-pool-v1（T01），与 AutoGen 臂的 HE 题不同源，分布不可横比；
3. 「影子比可检测多 agent 异常」仍无任何新证据——本 pilot 只证明仪器可核算；
4. 采样中数字不进发布素材。

## 五、下一步（按预注册产物清单）

正式的 per-agent 影子比标定（N≥50 级、含同题跨 repeat）**不在本预注册内**，须另立预注册；CrewAI/LangGraph 验收条已于 2026-11-13 补齐（实耗 5,104 token，远低于登记的 ≈30K/臂预估）。

## 六、CrewAI / LangGraph 运行时验收补采（2026-11-13）

**环境**：独立 venv `calib009-runtime/.venv`（工作区 `AI执行与监察体系设计/` 下，Python 3.13.14），pin 与 CALIB-007 完全一致：`crewai==1.15.35 / langgraph==1.2.19 / langgraph-supervisor==0.0.31 / langchain-core==1.7.4 / langchain-openai==1.7.3`。**R2 解释器未动**：安装前后 `pip freeze` 快照 diff = ∅（155 包）。输出隔离 `adapters/{crewai,langgraph}/out/run-20261113-c009-runtime/`。

**采集**：各 1 条 `benign-A × T01 × r1`（deepseek-chat，温度 0.0 沿 CrewAI 采集器既有口径）。CrewAI 3,587 token（2 消息 1 委派，manager 直发 report）；LangGraph 1,517 token（4 消息 1 transfer，WriterB 未发言）。**合计 5,104 token，pilot 预算 193,030 + 5,104 = 198,134 / 500,000（预算比 0.40）。**

**K1（硬不变量）两框架 PASS**：

| 框架 | Σ(per-agent) ≡ side 聚合 | coverage | 发言集 vs 账本 |
|---|---|---|---|
| CrewAI | (3166, 421, 4 calls) ≡ manager+workers，差 = 0 | `coverage_ok=true`、`uncovered=[]` | {Crew Manager, WriterB} = 账本键，发言集独立复核一致 |
| LangGraph | (1274, 243, 3 calls) ≡ supervisor+workers，差 = 0 | `coverage_ok=true`、`uncovered=[]` | {supervisor, AnalystA} = 账本键，发言集独立复核一致（WriterB 本轮无发言，非漏账） |

**K3（schema 一致性）运行时闭环**：三框架 11 份 `ledger-events.jsonl`（AutoGen 9 + CrewAI 1 + LangGraph 1）字段集 = 九字段基准（agent / calls / collected_at_ms / completion / framework / prompt / repeat_idx / scenario / task_id），diff = ∅。核查脚本 `calib009-runtime/verify_k3_runtime.py`（工作区，不入仓），11/11 PASS。

**③ 默认值回归**：两框架 `tokens_by_side` 旧结构原样保留（CrewAI manager/workers、LangGraph supervisor/workers），由逐 agent 账聚合生成，`total_tokens` = 两侧之和逐位吻合。

**usage 语义查证（虚惊登记）**：运行时出现 crewai 警告「Using an approximate input token count…」——静态追查（crewai 1.15.35 源码）：该近似计数（1 token ≈ 4 字符）只用于 `get_input_tokens_count` 的**上下文管理启发式**（工具结果超阈检查 / 摘要 prompt，`base_llm.py:497`、`context_window.py:429`），不进 `LLMCallCompletedEvent.usage`；deepseek 走 chat-completions 路径，事件 usage 取 `response.usage`（`providers/openai/completion.py:3059-3062`）= **API 原生返回**。账本语义无须降级。
