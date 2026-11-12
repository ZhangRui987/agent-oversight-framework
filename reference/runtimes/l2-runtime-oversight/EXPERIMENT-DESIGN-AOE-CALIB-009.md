# EXPERIMENT-DESIGN · AOE-CALIB-009（预注册：仪器升级 / R3-甲）

> **状态：预注册定稿，先于任何采样入库（2026-11-12）。pilot 未开始。**
> 谱系：R3 判据草案（臂内标定程序）经 Phase 0 负结果（`results/PHASE0-R3-CANDIDATES-20261112.md`：封闭清单 7 候选 + 调度层/资源账本 2 项侦察，共 9 项统计量在 R2 攻击构造上无一恢复分离性）按预写翻车分支转入负结果存档；用户裁决下一步 = 甲（仪器升级）。影子比属 spec/10 资源账本线而非 CALIB-007 蜂群线，编号顺延为 **CALIB-009**（001 影子比标定 / 002 周期检测 / 003 合成标定 / 004–006 / 007 蜂群 / 008 运行时阈值分布之后）。用户三点裁决（2026-11-12）：M0-c 三框架全做、pilot 沿用 R2 三臂、M0 随时开工 pilot 待验收后点火。

## 〇、要回答的唯一问题

**spec/10 四信号的逐 agent 粒度计量，能否跨三框架（AutoGen / CrewAI / LangGraph）以统一 schema 落地，并产出第一份多 agent 场景的 per-agent 影子比分布（标定性登记）？**

只做仪器 + 分布登记。**不做、也不声称**任何检测效能——「影子比能检测异常」仍是开放问题（v2.16.0 已明文不支撑，本预注册不推翻也不强化它）。

## 一、现状侦察（Phase 0，2026-11-12，零 API；脚本 `adapters/phase0_r3_candidates.py`）

三家采集器（`adapters/*/collect.py`）都有 `tokens_by_side` 分侧记账，但粒度与口径各异：

| 框架 | 分侧方式 | usage 来源 | 逐 agent 粒度 |
|---|---|---|---|
| AutoGen | agent / selector 两 CountingClient（拦截 create / create_stream） | API 返回 usage | ✗（agent 侧聚合） |
| CrewAI | manager / workers | 事件流 `usage`（字段名 input/output_tokens 与另两家不同） | ✗ |
| LangGraph | 按作者分侧 | `usage_metadata` 逐条累加 | 部分（按作者但未对齐 schema） |

三家缺口一致：**账 = 侧，不是 agent**。spec/10 影子比语义（同任务消耗分布偏离基线）在多 agent 场景需要 per-agent 账目；R2 数据只有侧聚合，无法回算（这是必须新采的根本原因）。

同一侦察确认 R2 攻击构造的投影盲区（负结果机制根因，详见 `results/PHASE0-R3-CANDIDATES-20261112.md` §四）：标记内容形态同样模型相关（qwen 良性裸派发 100% 证伪「裸 = 纯指挥」）、攻击单轮 6 消息使接收/调度集中度全败于 1/k 台阶或方向反转。**甲路线因此换仪器层：从「消息投影」换到「资源账本」。**

## 二、冻结设计：M0 工程 + pilot + 分布登记

### 2.1 M0 工程（入库后、pilot 前；只做计量，不动判据不动场景）

- **M0-a AutoGen 逐 agent 计量**：`CountingClient` 的 label 从「侧」改为「agent 名」（每 agent 独立包装），selector 保持独立 label；**向后兼容不变量**：Σ(per-agent) + selector ≡ 旧 agent 侧聚合（差必须 = 0）。
- **M0-b 统一账本事件 schema**：三框架产出同构 `ledger-events.jsonl`（字段：framework / agent / scenario / task_id / repeat_idx / prompt / completion / calls / 采集时点），字段名对齐 spec/10 信号定义；三家 usage 字段差异在各自 adapter 内归一，不进公共层。
- **M0-c CrewAI / LangGraph 逐 agent 计量**：各自 usage 通道按 agent 归账（CrewAI 事件流按 agent 归属、LangGraph 按 `usage_metadata` 作者）。
- M0 验收（三框架各跑一次）：① Σ(per-agent) ≡ 旧侧聚合（硬不变量，差 = 0）；② schema 三家一致（字段集 diff = ∅）；③ 不传新参数时旧行为逐字节不变（默认值回归）。

### 2.2 pilot（唯一调参窗口）

- 规模：3 臂（deepseek / qwen / glm，沿用 R2 臂）× 3 题（R2 良性题前 3）× benign-A × 1 轮 = 9 条，**≤ 500K token**（R2 pilot 实耗 185,105）。
- 唯一目的：① 验证 M0 三项验收；② 采集 per-agent 消耗的初步分布。
- pilot 结束即冻结；正式采样中任何参数改动 = 作废重跑。
- 温度口径沿用 R1/R2 实跑口径（不设 temperature，走厂商默认），保证对照可比。

### 2.3 冻结判据

- **K1（硬不变量）**：三框架各验 Σ(per-agent) + selector/manager ≡ 旧侧聚合，差 = 0；任何一臂差 > 0 ⇒ 仪器缺陷，ERRATA 后重采，不得就地修补。
- **K2（可计算性）**：同题跨 repeat 的 per-agent 消耗分布可计算（每 agent 样本 n ≥ 2）；任一框架不可计算 ⇒ 记「该框架计量不可用」，不冒充。
- **K3（schema 一致性）**：三框架 `ledger-events.jsonl` 字段集 diff = ∅。
- **K4（分布登记，非阈值）**：per-agent 影子比初步分布按 CALIB-001 方法（MAD + 1.4826 标准化 + k=3）登记；登记值**只作分布参考，不作检测阈值**（CALIB-001 严格支撑范围条款照搬：不支撑单值通用性、不支撑异常检出）。
- 判据入库后不得修改；不适用 ⇒ 报负结果。

## 三、翻车分支（全部为合法判定）

| 情形 | 判定 | 动作 |
|---|---|---|
| K1 不变量差 > 0 | 仪器缺陷 | ERRATA 重采，不得就地修补 |
| 某框架 usage 不可逐 agent 归属 | 「该框架计量不可用」 | 如实登记，不补第二家冒充 |
| per-agent 分布方差为零（max_tokens 截断类） | 「信号被配置架空」 | 按 CALIB-001 先例登记，换维度兜底另行预注册 |
| pilot 超预算 | 该部分记「未采完」 | 不挪用他人结论补叙事 |

## 四、预算（冻结）

- pilot ≤ **500K token**；M0 工程零 LLM 消耗（stub 冒烟除外，≤10K）。
- 超限即停；正式的 per-agent 影子比标定（N≥50 级采样）**不在本预注册内**——K4 只登记 pilot 分布，样本量不足的标定声明是本项目明令禁止的行为。

## 五、诚实边界（随结果同行，不得拆开引用）

1. 本预注册产出的是**仪器与分布数据**，不是检测器；「影子比可检测多 agent 异常」不在本预注册的回答范围；
2. per-agent 影子比分布基于 3 臂 × 9 条 pilot，样本量不支持任何阈值声明；
3. R3 Phase 0 负结果不变：消息层投影统计量在该攻击构造上无判别力（`results/PHASE0-R3-CANDIDATES-20261112.md`）；本仪器不承诺检测能力，只承诺**让 spec/10 四信号在多 agent 场景变得可核算**；
4. 与 spec/13 #33 / #44 的关系：本仪器产出标定数据源（#33 的「真实 trace 分布」采集面）与处置通道的输入面，但不推进阈值标定本身。

## 六、产物清单（收尾时一次性入库）

`results/RESULTS-AOE-CALIB-009-PILOT-<日期>.md`（含 K1–K4 判定 + per-agent 分布）、三框架 `collect.py` 改造（含不变量自检）、ERRATA（如有）、CHANGELOG 条目（重述当前锚摘要串）。采样中间数字不得进任何发布素材。
