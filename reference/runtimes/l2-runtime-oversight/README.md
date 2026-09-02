# L2 运行时监察最小参照实现（l2-runtime-oversight）

本目录是 agent-oversight-framework 的**第一份可运行参照实现**，对应 spec/09「运行监察 L2 与三号公证机」中的看门狗机制、spec/02「五层结构与两条审计线」中的 E3 固化外抛，以及 spec/09 二号监察的确定性检测思想。

机制提炼自 OpenMAIC（一个集中调度式多 Agent 运行器）的 `lib/server/agent-runtime/runner.ts`，按本框架的术语与边界改写而来——出处如实标注，不隐匿借鉴。

## 它是什么、不是什么

**是**：把 spec/02、spec/09、spec/10 中可被确定性规则承载的治理抽象（租约、心跳、事件序闸门、owner 作用域、append-only 审计链、能力门控、错误样本排除的回归守卫），落成约 700 行无外部依赖的 TypeScript，供实现者作为「L2 运行时监察长什么样」的工程范例阅读或移植。

**不是**：

- 不是可上生产的沙箱、规则引擎或观测平台；
- 不是 LLM-as-judge 评测——所有判定都是确定性硬规则，不依赖任何 AI 判断（这正是 spec/09「看门狗的不可关闭性」的直接落地：看门狗的形态只能是确定性规则 + 独立部署，不能是提示词条款）；
- 不是完整合规实现——诚实边界（见下）逐项列明缺口，生产前必须补齐。

## 组件 → spec 映射

| 组件 | 对应 spec 机制 | 机制来源 |
|---|---|---|
| `LeaseAuthority` + `LeaseLostError` | spec/09 看门狗：确定性租约/心跳，AI 关不掉 | OpenMAIC runner 心跳/失租即停 |
| `LifecycleTripwire` | spec/09 看门狗思想：事件序确定性闸门 | OpenMAIC runner 首事件必须为 lifecycle |
| `OwnerScopedStore` | spec/09 责任锚定：ownerId 由运行器注入，工具层不可伪造 | OpenMAIC probeStageAccess 门控 |
| `OrderedDurableChain` | spec/02 有序写入 + 关键写入不允许部分成功 | OpenMAIC enqueue / writeRequiredSessionEntry |
| `AppendOnlyAuditLog` | spec/02 E3：采集后即固化外抛（append-only + 哈希链）的进程内缩样 | OpenMAIC appendRunEvent seq 代际 |
| `CapabilityRegistry` | spec/09 L0 准入：能力门控 + fail-loud（注册 ≠ 授权） | OpenMAIC 能力门控工具 + 白名单 |
| `regressionGuard` | spec/09 二号监察：确定性裁决 + 错误样本排除（基础设施故障不算模型行为） | OpenMAIC eval/orchestration |
| `RuntimeOverseer` | 以上组合成 L2 最小监察循环：claim → 心跳 → 执行 → 收尾 | OpenMAIC runSession 裁剪镜像 |

## 运行验证

Node 22+ 原生支持 TS 类型转换，无需编译、无外部依赖、纯内存：

```bash
node --experimental-transform-types demo.ts
# 退出码 0 = 全部 PASS；1 = 有 FAIL
```

demo 覆盖 16 组、72 项断言（截至 v2.1.0 实测全绿），含 9 组对抗性用例：

| 组 | 证明的机制 / 对抗目标 |
|---|---|
| [1]–[7b] | 各组件功能路径：租约/心跳/失租、事件序闸门、owner 作用域、审计链自检、fail-loud、错误样本排除、端到端健康完成与失租中断 |
| [8] | 伪造 ownerId 注入：参数注入在结构上无效（ownerId 只能源于 claim） |
| [9] | 租约窃取、伪造 worker、attempt 重放、双重抢占 |
| [10] | tripwire 违规不可恢复、名称混淆、空事件名 |
| [11] | tombstoned/missing 拒绝、TOCTOU、不信任后端 read |
| [12] | 审计链篡改/截断检测；**自曝**：占位哈希等长碰撞可漏检 |
| [13] | 工具名称混淆、注册 ≠ 授权、白名单与注册错配 |
| [14] | **自曝**：错误洪泛可绕过守卫（缺 min-sample 门禁）、阈值边界、空基线失效 |
| [15] | 超尝试上限不执行、execute 抛错不崩溃、心跳异常视为失租 |
| [16] | 关键写入失败中止整链（拒绝部分成功）、非关键失败被容忍 |

## 诚实边界（生产前必须补齐，不得误标为完整合规）

| 缺口 | 本实现现状 | spec 要求 |
|---|---|---|
| 租约权威存储 | 内存 `InMemoryLeaseAuthority` 占位 | PostgreSQL 或独立信任域 |
| 审计哈希 | 占位哈希（仅链长 + 前缀），等长篡改可漏检（demo [12d] 自曝） | SHA-256 及以上 |
| E1 内核侧采集 | 无（事件产生于被观测进程内部） | spec/02：eBPF/LSM 等内核侧采集，不经用户态路径 |
| E5 采集点自身完整性 | 无 | spec/02：独立信任域、采集模块签名 |
| 资源账本 | 无（仅 attempt/lease 预算） | spec/10：预算比、影子比、记忆写入审计 |
| 三号公证机 | 无 | spec/09：独立硬件信任域、三号甲/乙拆分、Merkle 双盲 |
| 信用分与信用回避 | 无 | spec/04 |
| 群治理与涌现检测 | 无（集中调度模型） | spec/07 |

因此：本实现**不能单独用作信任根**。在 spec/02 所述 P3 阶段（独立硬件域 + 远程证明）落地之前，它只是把「确定性硬闸门应该怎么写」变成可运行、可复现的参照。

## 许可证

本目录属代码路径，适用 **Apache License 2.0**（见根目录 `LICENSE-CODE`）；文档部分仍适用 CC BY-SA 4.0。路径 ↔ 许可证映射见根目录 `LICENSING.md`。

## 出处与致谢

- 机制出处：OpenMAIC `lib/server/agent-runtime/runner.ts`（集中调度式 Agent 运行器）与 eval/orchestration 模块。
- 改写说明：接口形态、确定性判定逻辑与对抗用例保留；文档、注释与 spec 映射按本框架术语重写，并按 spec/13 的诚实传统逐项标注缺口。
