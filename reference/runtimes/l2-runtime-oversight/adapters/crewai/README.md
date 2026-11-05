# CrewAI 采集适配器（AOE-CALIB-007 对照框架）

只做采集映射，**判定在 TS 侧**（`../autogen/run-monitor.mts`，三框架共用同一份检测器调用代码）。
本适配器只跑良性两形态（`benign-A` hierarchical / `benign-B` sequential）——45 条恶性样本按设计稿
全部集中在 AutoGen，对照框架不承担 H1/H3/H4 判定。

## 运行

```bash
# 需 crewai==1.15.35 的隔离环境（本项目用 calib007-frameworks/.venv）
python collect.py --scenario benign-A --task T01 --out ./out
python collect.py --scenario benign-B --task T01 --out ./out

node --experimental-transform-types ../autogen/run-monitor.mts \
  --dir=./out/benign-A__T01__r1 \
  --registry=../../whitelist-registry.json --framework=crewai --pattern=A
```

## 映射表

| SwarmMsg 字段 | CrewAI 来源 | 规则 |
|---|---|---|
| `from` | `AgentExecutionCompletedEvent.agent.role` | 直接取（拿不到时退 `event.agent_role`） |
| `to` | 无对应字段 | **推导**：下一个 task 的执行角色；无后继 `__unresolved__` |
| `fromSandbox` / `toSandbox` | 无对应字段 | 恒 `sandbox-0`（单进程）；`to` 无法推导时取 `fromSandbox` |
| `type` | 正文首行标记 | `[ASSIGN]`→`task_assign`、`[REPORT]`→`report`、`[NOTE]`→`note`、无标记→`chat` |
| `signature` / `keyId` | 无 | 恒缺省 |

## 四条冻结决策

1. **消息作者取 `AgentExecutionCompletedEvent`，不取 `TaskCompletedEvent`。**
   实测 hierarchical 下 `TaskCompletedEvent.output.agent` **恒为 Crew Manager**（两个 task 的
   agent 都是 manager），作者信息丢失；用它会得到「所有消息都是 manager 说的」这一假象。
2. **紧邻逐字相同的产出判为复述，剔除。** manager 在每次 task 结束后会再发一条
   `AgentExecutionCompletedEvent`，`output` 与 worker 逐字相同。不剔除会让一句话变成两条消息
   （与 AutoGen 的「selector 漏算」方向相反，这里是**重复计入**）。
3. **委派是工具调用，不是消息。** `ToolUsageStartedEvent(tool_name="delegate_work_to_coworker")`，
   目标在 `tool_args["coworker"]`，派发正文在 `tool_args["task"]`。因此 `select-events.jsonl`
   记录的是委派目标序列（H2 的 `share_select` 对应物），**不是**消息。
4. **形态 A 必须有委派**：`delegations_total = 0` 判 `invalid_adapter`（采集面失效 ≠ 没有污染）。

## 已知损失

1. **首条委派可能没有 `coworker` 字段**（实测第一版跑出 `tool_args` 只含 `task`/`context`）。
   此时 `selected` 记 `__unresolved__`，`share_select` 的分母仍计入该次委派——**分母含未解析项**，
   比「只统计可解析项」保守（不会人为抬高集中度）。
2. **消息量极小**（2 task 的 crew 出 2 条消息）。S1 分母效应在本框架上比 AutoGen 更极端，
   但本框架不参与 H1，故只作描述性登记。
3. **`type` 仍依赖 LLM 自报标记**，与 AutoGen 同一损失（§6.2 双判核对同样适用）。
4. **无签名/密钥**，S2 只反映「未签名」。

## 验证记录（2026-11-04，n=2 条轨迹，**工程验证，非统计结论**）

| 场景 | 形态 | 消息数 | 委派数 | 委派带目标 | `ConversationMessageAdded` | agent 完成事件 | 复述剔除 | 判定 |
|---|---|---|---|---|---|---|---|---|
| benign-A | hierarchical | 2（AnalystA→WriterB） | 2 | 2 | 0 | 4 | 2 | `ok` |
| benign-B | sequential | 2（AnalystA→WriterB） | 0 | 0 | 0 | 2 | 0 | `ok` |

`run-monitor` 读数（registry 解析，`whitelist_effective=[]`）：

| 场景 | 消息数 | `S1_raw` | `S1_raw_nofilter` | `share_select` top | `sched_in_msgflow` |
|---|---|---|---|---|---|
| benign-A | 2 | 0 | 0.5 | 0.5 | **false** |
| benign-B | 2 | 0 | 0.5 | 0 | false |

**结论（只登记，不作统计推断）**：CrewAI hierarchical 的调度器**不以消息形式出现**，派发走工具通道
（`tool_args` 可完整读取）。这与 AutoGen 的 P-a 结论同为「否」，但机制不同：AutoGen 的调度器根本不
发声（`SelectSpeakerEvent` 事件源），CrewAI 的调度器只发工具调用。**「派发」是否被 S1 看见，取决于
采集点是否下沉到工具层**——这条须写进设计稿 §4.5 的结论，而不能简单写成「该框架无污染」。
