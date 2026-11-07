# EXPERIMENT-DESIGN-AOE-CALIB-008：真实 agent 工作流的运行时参数分布与四类阈值保守区间

**预注册状态：已冻结，先于任何统计执行入库（git 提交时间戳即冻结凭证）。**
**承接**：spec/13 #33（四类运行时阈值未标定）——小米教训【键: xiaomi-mimo-mopd-2026】要求「收紧阈值前先查阈值下行为分布」，本实验提供该分布的第一份真实测量。**本实验不改 CALIB-007 的任何判定**；研究对象是运行时参数分布，不是检测阈值，不属「-R2 不得并入」范围（新预注册、新编号）。
**打包关系**：与 spec/13 #9 的「消费端首次真实数据运行」共用同一次采集（清单第 3 步打包）——见 §消费端回放。

## 一、研究问题

| # | 问题 | 对应 spec/09 四类 |
|---|---|---|
| Q1 | 真实 agent 工作流中，单个任务的执行步数分布是什么？ | 执行步数上限 |
| Q2 | 单位时间工具调用频次分布是什么？ | 单位时间调用频次上限 |
| Q3 | 单次工具调用的真实时长分布是什么？ | 单任务执行时长上限（单次调用口径） |
| Q4 | 资源消耗分布是什么？ | 资源消耗上限 |

## 二、数据源

### S0（主源）：真实个人 agent 开发工作流的会话记录

- WorkBuddy 会话 transcript：`~/.workbuddy/projects/d-Data-workbuddy-AI执行与监察体系设计/6ac8f41c-3e94-4c7e-b18b-18dacefd0841.jsonl`
- 性质：**真实运行的一手记录**——同一 agent（WorkBuddy 内置编码助手）在同一 sessionId 下跨约两个月的连续开发工作（agent-oversight-framework 的全部维护工作即在此会话中完成）。预注册时点已知：`function_call` 约 3,470 条、`function_call_result` 约 3,469 条、user 发起 message 125 条（任务块边界）。**分布数值预注册时点未知**（只探明过 schema 与个别样本行的字段名，未统计）。
- **隐私纪律**：transcript 含会话正文（可能涉用户其他项目内容），**transcript 本身不入仓库**；统计脚本只提取 `timestamp / name / callId / status / output 长度` 五个字段，不读不存任何正文内容；入库的是脚本 + 聚合统计结果。

### S1（对照源）：CALIB-007 已入库轨迹的 episode 口径

- 本仓库 `reference/runtimes/l2-runtime-oversight/adapters/*/out/*/trace-meta.json`，共 **9 条**（autogen 5 / crewai 2 / langgraph 2；良性 6 / 攻击 3；真实框架 autogen 0.7.5 / crewai 1.15.35 / langgraph 1.2.19 + 真实模型 deepseek-chat）。
- 提供**真实 token 计量**（`total_tokens`）与 episode 级墙钟（`wall_ms`）、消息数（`swarm_msgs_total`）——S0 缺 token 计量，由 S1 补资源口径的真实锚点。

## 三、统计口径（冻结）

| 指标 | S0 口径 | S1 口径 |
|---|---|---|
| 任务块 | 相邻两条 user 发起 message 的 timestamp 之间的 `function_call` 序列；开头无 user 边界的调用归首块 | 每个 trace 目录 = 一个 episode |
| 执行步数 | 任务块内 `function_call` 计数 | episode 的 `swarm_msgs_total`（消息口径，与工具调用**不同口径**，只作对照不作合并） |
| 调用频次 | 全序列上 **60 秒滑动窗口**内的最大 `function_call` 数（窗口长度预注册固定，不得事后改） | `swarm_msgs_total / (wall_ms/60000)`（每分钟消息数） |
| 单次时长 | `callId` 配对：result.timestamp − call.timestamp（毫秒）；只取 status=completed 且配对成功的 | episode 级 `wall_ms` |
| 资源 | `output` 字节数（**代理口径**，非 token——S0 无 token 计量） | `total_tokens`（真实 token） |

配对失败（call 无 result 或反之）如实计数报告，不计入时长样本。

## 四、预注册假设与阈值构造规则（先冻结，后计算）

- **H1′**：S0 良性任务块的步数分布右偏；建议上界 = max(P99, 中位数 × 4) 向上取整到十位。
- **H2′**：S0 的 60s 窗口频次分布集中（P99 与中位数之比 < 10）；建议上界同规则。
- **H3′**：S0 单次调用时长 P99 量级在分钟级以内（< 600,000 ms）；建议上界同规则。
- **H4′**：S1 良性 episode 的 `total_tokens` 可给出量级区间；**仅 6 条，只报数值区间，不作分布推断**。
- **阈值构造规则 K=4 预注册固定**：在看到任何分布数值之前冻结，杜绝「先看分布再挑系数」。
- 判读纪律：以上全部是**良性侧保守区间**——它们回答「正常任务用到多少」，不回答「攻击者会不会藏在这个区间下」（该问题属检出力，由 S1 攻击 episode 作**方向性观察**：3 条，不推断）。

## 五、消费端回放（#9 打包部分）

用 S0 的真实事件做**回放**（不是在线拦截）：

- 会话事件投影：每个任务块按其内 function_call 的成败投影为 `success / failure`（status != completed 计 failure；预注册时点未统计失败数）——喂 `CreditEventStream`，产出第一份真实数据上的行为摘要；
- `AbstentionGate` 全量回放（θ2=0.40 / H=30 / 窗口 30 天 / n_v=3，参数照工程占位显式传入）：S0 是良性开发工作流，**预期全部 allow**——若出现 abstain/escalate 则必须逐条归因（预期之外即报告异常段）；
- 语义限定：这是消费端的**首次真实数据运行**（回放），**不是生产启用**——生产启用 = 在线接入真实工作流持续消费裁决，仍缺。

## 六、边界（预注册即写明，报告不得收回）

1. S0 是**单 agent、单 harness（WorkBuddy）、任务族单一**（文档与代码维护）——本实验产出的是「第一份真实分布」，不是「任务族全谱」；长期运行登记继续累积，不因本版而闭合。
2. S1 良性仅 6 条 episode——一切 S1 数值只报区间。
3. 资源口径 S0 为输出字节代理——与 token 不可互换，报告必须双口径分行。
4. **本实验不标定 spec/10 10-D4 的处置时限**（P0 24h / P1 72h / P2 7d）——那是处置时延分布，需真实处置样本（台账仍 3 条演示数据），#33 的这一半维持占位。
5. 产出物：统计脚本（入库）+ 报告 `results/RESULTS-AOE-CALIB-008-<date>.md`（入库）+ spec/09 状态表阈值列更新 + spec/13 #33 / #9 状态更新。#33 是否闭合由报告按「口径覆盖面」判定——预注册的预期是**不闭合**（步数/频次/单次时长有初步区间，任务级累计口径与多任务族仍缺）。
