# PHASE0 RESULTS —— R2 跨框架 C3 可计算性矩阵（2026-11-08，纯离线，零 API）

> 执行物：`adapters/phase0_c3_matrix.py`（C3 冻结定义与 check-c3-offline.py 逐字一致；默认数据路径相对仓库解析，仓库内直跑可复现）。
> 数据：R1 既有轨迹 `reference/runtimes/l2-runtime-oversight/out/run-20261105-1802/`（AutoGen 245 / CrewAI 24 / LangGraph 24），未采任何新轨迹、未调任何 API。
> 机器可读结果：`results/PHASE0-MATRIX-20261108.json`。

## 一、矩阵

| 框架 | 轨迹数 | C3 取值分布 | 不同 C3 值 | ASSIGN 消息 | 判定 |
|---|---|---|---|---|---|
| AutoGen 0.7.5 | 245 | 0.0×104, 0.2×4, 0.25×77, 0.33×4, 0.4, 0.5×6, 0.67, 0.71, 0.75×3, 0.857, **1.0×43** | **11** | 有 | **可计算**（对照组，判别力正常） |
| CrewAI | 24 | **0.0×24** | 1 | **全零**（type 仅 report） | **当前导出器口径下无判别力** |
| LangGraph | 24 | **0.0×24** | 1 | **全零**（type 为 report+chat） | **当前导出器口径下无判别力** |

## 二、机制解释（与 R1 已登记的调度可见性差异吻合）

- **CrewAI**：派发走 `tool_args`，不进消息流。`Crew Manager` 节点在消息流中仅 4 条（疑似最终产出），其派发行为在 swarm-msgs.jsonl 中不可见 ⇒ C3 分子恒 0。
- **LangGraph**：`supervisor` **确实双写进了消息流**（25 条 `from=supervisor`），但被标为 `chat` 而非 ASSIGN 类型 ⇒ 冻结定义下分子恒 0。
- **AutoGen**：调度不进流，但 Agent 间 task_assign 进流 ⇒ C3 有 11 个取值、含 1.0×43（攻击侧构造恒 1.0）与良性侧 0–0.75，判别力与 R1 一致。

## 三、判定与对 R2 的影响

1. **R2-c（跨框架）在本预注册内被否决**——不是「C3 理论上不适用」，而是**当前测量仪器（swarm-msgs 导出器）在 CrewAI/LangGraph 上不产出派发语义**。仪器口径属测量定义，改它 = 换仪器，须独立预注册（`-R2-c` 前置工程：CrewAI 从 tool_args 提取派发、LangGraph 对 supervisor 双写显式标 type），不得在 R2 执行中顺手改。
2. **R2 范围落定为：AutoGen 单框架 × 跨模型（deepseek 对照 + qwen + glm）× 跨任务池（HumanEval 子集）**——Phase 0 的唯一作用就是把这个范围钉死，避免 11M token 烧在仪器不支持的框架上。
3. LangGraph 的 supervisor 双写是**可救的**：数据在流里、只是 type 标错。这使 `-R2-c` 的前置工程量可控（改导出器标注 + 重放），但按纪律必须走新预注册。
4. AutoGen 对照组的 C3 分布（11 个取值、1.0×43 全为攻击侧）与 R1 报告一致——本脚本与冻结定义的实现正确性互证。

## 四、遗留（进 R2 预注册正文）

- HumanEval 池的「派发」语义与 task-pool-v1 的差异（reviewer 修改指令算不算 ASSIGN）仍需 pilot 实测良性 k 分布（§决策记录见 R2 草案 §七）。
- 本结果文件与脚本已随 R2 预注册同批入库（本文件 + `adapters/phase0_c3_matrix.py` + `results/PHASE0-MATRIX-20261108.json`）。
