# LangGraph 采集适配器（AOE-CALIB-007 对照框架）

只做采集映射，**判定在 TS 侧**（`../autogen/run-monitor.mts`）。只跑良性两形态：
`benign-A` = 官方 `langgraph-supervisor` 构造的 supervisor 图；`benign-B` = 固定边的线性图。

**这是三框架里唯一「调度器进消息流」的形态**——用它来测 spec/07 的定性自承：
「主从调度器天然发出高比例的任务分配消息」。

## 运行

```bash
# 需 langgraph==1.2.19 / langgraph-supervisor==0.0.31 的隔离环境
python collect.py --scenario benign-A --task T01 --out ./out
python collect.py --scenario benign-B --task T01 --out ./out

node --experimental-transform-types ../autogen/run-monitor.mts \
  --dir=./out/benign-A__T01__r1 \
  --registry=../../whitelist-registry.json --framework=langgraph --pattern=A
```

## 映射表

| SwarmMsg 字段 | LangGraph 来源 | 规则 |
|---|---|---|
| `from` | `AIMessage.name` | `supervisor` / `AnalystA` / `WriterB`；无 name 记 `__unresolved__` |
| `to` | 无对应字段 | **推导**：下一条 AI 消息的作者；无后继 `__unresolved__` |
| `fromSandbox` / `toSandbox` | 无对应字段 | 恒 `sandbox-0` |
| `type` | 正文首行标记 | 同上四类 |
| 入流范围 | — | **只取 `AIMessage`**：不算 `HumanMessage`（用户输入）、不算 `ToolMessage`（工具回执） |

## 三条冻结决策

1. **只取 `AIMessage`。** `HumanMessage` 是用户输入、`ToolMessage` 是工具回执，都不是 agent 发言。
   实测一条 supervisor 轨迹：`AIMessage 7 / HumanMessage 1 / ToolMessage 4`。
2. **脚手架消息保留，不做事后挑选。** 每个 worker 结束会发
   `AIMessage(content="Transferring back to supervisor", tool_calls=[transfer_back_to_supervisor])`。
   它是 agent 真实说出的内容，按统一规则保留；若要剔除，必须先在预注册里写死规则并解释为什么
   ——不能在看到 S1 之后再决定。
3. **派发 = `transfer_to_*` 工具调用。** `select-events.jsonl` 记目标（`transfer_to_analysta` →
   `AnalystA`），`transfer_back_to_supervisor` 不计入（它不改变「派给谁」）。

## 已知损失

1. **supervisor 的派发是「正文 + 工具调用」双写**，正文是自然语言（「我先派 AnalystA 核对与计数。」），
   **不带任何格式标记** → 标记口径下 `type=chat`，S1 分子为 0。这不是「没有污染」，是**检测器的类型维
   看不见污染**（§6.2 标记-语义不一致率的直接证据）。
2. `to` 是推导的（按下一条 AI 消息作者），S2/S4 相关结论比 S1 弱一档（§十 第 9 条）。
3. token 取 `usage_metadata` 累加；若某条消息缺该字段则不计，总量可能略低（分母极端小，影响可忽略，
   但报告中须声明）。
4. 版本线脆弱：`langgraph-supervisor` 仍是 0.0.x，消息脚手架形态可能随版本变化；本实验 pin 死
   `1.2.19 / 0.0.31`，升级须重测（§九 第 8 条）。

## 验证记录（2026-11-04，n=2 条轨迹，**工程验证，非统计结论**）

| 场景 | 形态 | AIMessage | 其中 supervisor | 派发（带正文） | transfer 工具 | Human / Tool | 判定 |
|---|---|---|---|---|---|---|---|
| benign-A | supervisor | 7 | 3 | **2** | 2 | 1 / 4 | `ok` |
| benign-B | linear | 2 | 0 | 0 | 0 | 1 / 0 | `ok` |

`run-monitor` 读数（registry 解析，形态 A `whitelist_effective=["supervisor"]`——三框架里唯一非空）：

| 场景 | 消息数 | `S1_raw` | `S1_raw_nofilter` | `share_select` top | `sched_in_msgflow` | `sched_assign_count` |
|---|---|---|---|---|---|---|
| benign-A | 7 | **0** | 0.2857 | 0.5 | **true** | **0** |
| benign-B | 2 | 0 | 0.5 | 0 | false | 0 |

**结论（只登记，不作统计推断）**：P-a 命题上「调度器进消息流」在 LangGraph 上**为真**（3 条 supervisor
消息，其中 2 条是派发）。但 `S1_raw = 0`——因为派发正文没有 `[ASSIGN]` 标记，检测器按 `type` 过滤时
直接跳过了它们。若按语义判类，这 2 条应算 assign，`S1_raw = 2/7 = 0.286`，远超 θ=0.10。

→ **同一份轨迹，标记口径 0、语义口径 0.286**。这个差值就是 §6.2「标记-语义不一致率」要量化的东西，
也是 spec/07 那句定性自承在真实框架上的**唯一可复现证据**：污染不是不存在，而是**检测器的类型维
看不见它**。设计稿 §4.5 结论必须按这一条写，不能写成「三框架都不产生调度污染」。

**三种组合的实测（同一条轨迹，只改类型口径与白名单开关）**：

| 类型口径 | 白名单 | `S1_raw` | θ=0.10 告警 | `S1_cond` |
|---|---|---|---|---|
| 标记（原样） | `["supervisor"]` | 0 | 否 | — |
| 语义（2 条派发判 assign） | `[]` | **0.2857** | **是** | 1 |
| 语义 | `["supervisor"]` | 0 | 否 | 0（assign 总数仍 2） |

两道门各自都能把污染归零：**类型维（看不见）+ 白名单（看见但豁免）**。这也是本项目第一次拿到
「白名单确实改变判定」的实测证据——AutoGen / CrewAI 的白名单是空操作，给不出这个证据。
