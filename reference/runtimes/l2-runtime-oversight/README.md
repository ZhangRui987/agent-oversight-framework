# L2 运行时监察最小参照实现（l2-runtime-oversight）

本目录是 agent-oversight-framework 的**第一份可运行参照实现**，对应 spec/09「运行监察 L2 与三号公证机」中的看门狗机制、spec/02「五层结构与两条审计线」中的 E3 固化外抛，以及 spec/09 二号监察的确定性检测思想。

机制提炼自 OpenMAIC（一个集中调度式多 Agent 运行器）的 `lib/server/agent-runtime/runner.ts`，按本框架的术语与边界改写而来——出处如实标注，不隐匿借鉴。

## 它是什么、不是什么

**是**：把 spec/02、spec/09、spec/10 中可被确定性规则承载的治理抽象（租约、心跳、事件序闸门、owner 作用域、append-only 审计链、能力门控、错误样本排除的回归守卫、入口/出口守卫、配置内容审查），落成约 1000 行无外部依赖的 TypeScript，供实现者作为「L2 运行时监察长什么样」的工程范例阅读或移植。

**不是**：

- 不是可上生产的沙箱、规则引擎或观测平台；
- 不是 LLM-as-judge 评测——所有判定都是确定性硬规则，不依赖任何 AI 判断（这正是 spec/09「看门狗的不可关闭性」的直接落地：看门狗的形态只能是确定性规则 + 独立部署，不能是提示词条款）；
- 不是完整合规实现——诚实边界（见下）逐项列明缺口，生产前必须补齐。

## 组件 → spec 映射

| 组件 | 对应 spec 机制 | 机制来源 |
|---|---|---|
| `LeaseAuthority` + `LeaseLostError` | spec/09 看门狗：确定性租约/心跳，AI 关不掉 | OpenMAIC runner 心跳/失租即停 |
| `SqliteLeaseAuthority` | 同上（G1 演示级闭合）：租约权威 SQLite 持久化，崩溃后可恢复（Node 22+ 内置 `node:sqlite`，零外部依赖） | 本框架自研（接口形态与 OpenMAIC store 一致） |
| `LifecycleTripwire` | spec/09 看门狗思想：事件序确定性闸门 | OpenMAIC runner 首事件必须为 lifecycle |
| `OwnerScopedStore` | spec/09 责任锚定：ownerId 由运行器注入，工具层不可伪造 | OpenMAIC probeStageAccess 门控 |
| `OrderedDurableChain` | spec/02 有序写入 + 关键写入不允许部分成功 | OpenMAIC enqueue / writeRequiredSessionEntry |
| `AppendOnlyAuditLog` + `sha256` | spec/02 E3：采集后即固化外抛（append-only + SHA-256 哈希链，G2 演示级闭合）的进程内缩样 | OpenMAIC appendRunEvent seq 代际 |
| `otel-adapter` | E3 固化外抛的工程对接层：审计事件流 → OTLP/JSON Logs，接入现有可观测性栈（otel-collector / Loki / Datadog 等） | 本框架自研（格式转换桥，非采集/发送端） |
| `CapabilityRegistry` | spec/09 L0 准入：能力门控 + fail-loud（注册 ≠ 授权） | OpenMAIC 能力门控工具 + 白名单 |
| `regressionGuard` | spec/09 二号监察：确定性裁决 + 错误样本排除（基础设施故障不算模型行为） | OpenMAIC eval/orchestration |
| `EntryGuard` / `ExitGuard` / `guardedToolCall` | spec/02 E1 入口 / E5 出口检查的最小可运行示例：拦截恶意工具调用（白名单 / 参数策略 / 资源预算 / 输出策略），把「观测」升级为「观测 + 一次性的强制力展示」 | 本框架自研（语义演示，非内核侧采集 / 独立信任域，见 PRODUCTION-GAPS.md G3/G4） |
| `ConfigReviewer` | spec/02 第四条「配置权即攻击面」的五项配置内容审查（明文凭据 / 共享范围 / 审批步骤 / 网关公开 / 脱敏弱化），经 `EntryGuard` 注入接入入口检查管道——性能不回归不等于安全不退化 | 本框架自研（语义演示，确定性字符串/结构匹配，非语义级配置 schema，见 PRODUCTION-GAPS.md G9） |
| `RuntimeOverseer` | 以上组合成 L2 最小监察循环：claim → 心跳 → 执行 → 收尾 | OpenMAIC runSession 裁剪镜像 |

## 运行验证

Node 22+ 原生支持 TS 类型转换，无需编译、无外部依赖、纯内存：

```bash
node --experimental-transform-types demo.ts
# 退出码 0 = 全部 PASS；1 = 有 FAIL
```

OpenTelemetry 导出适配器（把审计事件流转为 OTLP/JSON，接入现有可观测性栈）：

```bash
# 自检
node --experimental-transform-types otel-adapter.ts --selftest
# 管道模式：把 JSONL 事件流转换为 OTLP/JSON Logs
node --experimental-transform-types otel-adapter.ts < audit-events.jsonl > otlp-export.json
```

demo 覆盖 20 组、136 项断言（截至 v2.13.0 实测全绿），含 9 组对抗性用例：

| 组 | 证明的机制 / 对抗目标 |
|---|---|
| [1]–[7b] | 各组件功能路径：租约/心跳/失租、事件序闸门、owner 作用域、审计链自检、fail-loud、错误样本排除、端到端健康完成与失租中断 |
| [8] | 伪造 ownerId 注入：参数注入在结构上无效（ownerId 只能源于 claim） |
| [9] | 租约窃取、伪造 worker、attempt 重放、双重抢占 |
| [10] | tripwire 违规不可恢复、名称混淆、空事件名 |
| [11] | tombstoned/missing 拒绝、TOCTOU、不信任后端 read |
| [12] | 审计链篡改/截断检测；G2 闭合验证：SHA-256 下等长篡改必被检出（原「占位哈希碰撞漏检」自曝用例已改为验证闭合语义） |
| [13] | 工具名称混淆、注册 ≠ 授权、白名单与注册错配 |
| [14] | **自曝**：错误洪泛可绕过守卫（缺 min-sample 门禁）、阈值边界、空基线失效 |
| [15] | 超尝试上限不执行、execute 抛错不崩溃、心跳异常视为失租 |
| [16] | 关键写入失败中止整链（拒绝部分成功）、非关键失败被容忍 |
| [17] | E1/E5 强制力展示：入口拦截恶意工具调用（rm -rf / 写 /etc）、出口拦截超预算与数据泄露；端到端证明拦截时工具根本不执行 |
| [18] | G1 闭合：SQLite 租约权威——崩溃（close）后重开数据库租约状态仍在；语义与内存实现一致 |
| [19] | G9 闭合：spec/02 第四条「配置权即攻击面」五项配置内容审查（明文凭据 / 共享范围 / 审批关闭 / 网关公开 / 脱敏弱化）；端到端证明恶意配置变更被拦在入口、execute 零调用 |
| [20] | G5 闭合：spec/10 资源账本四类信号——预算比超阈产出审计信号（非拦截）、影子比偏离基线、记忆/提示/配置写入最高级审计（level=highest）、周期型外联检测（固定间隔、与数据量无关）；对抗性验证非周期出站不误报、基线内不误报、无基线跳过影子比 |

## 诚实边界（生产前必须补齐，不得误标为完整合规）

本实现存在 **9 项生产级缺口（G1–G9）**，已集中到同目录 [`PRODUCTION-GAPS.md`](PRODUCTION-GAPS.md) 作为一级章节性文件。**v2.2.0 起 G1（SQLite 持久化租约）与 G2（SHA-256 哈希链）已演示级闭合**；**v2.5.0 起 G9（配置内容审查）已演示级闭合**；**v2.13.0 起 G5（资源账本）已演示级闭合**；其余 5 项未闭合：

| 编号 | 缺口 | 状态 |
|---|---|---|
| **G1** | 租约权威存储 | ✅ 演示级闭合（`SqliteLeaseAuthority`，崩溃后可恢复）；生产级需 PostgreSQL / 独立信任域 |
| **G2** | 审计哈希强度 | ✅ 演示级闭合（SHA-256 哈希链，等长篡改必检出）；生产级需 E5 签名比对 |
| **G3** | E1 内核侧采集 | ❌ 需内核态组件（eBPF / LSM） |
| **G4** | E5 采集点完整性 | ❌ 需独立硬件信任域 + 远程证明 |
| **G5** | 资源账本 | ✅ 演示级闭合（`ResourceLedger` 四类信号判定：预算比超阈审计 / 影子比偏离 / 记忆写入最高级审计 / 周期型外联检测占位）；生产级需基线标定、记忆写入落地核查、自相关 + 频谱分析 |
| **G6** | 三号公证机 | ❌ 需独立公证服务 |
| **G7** | 信用分与信用回避 | ❌ 需对接 L1 信用分子系统 |
| **G8** | 群治理与涌现检测 | ❌ 需分布式交互图谱层 |
| **G9** | 配置内容审查（配置权即攻击面） | ✅ 演示级闭合（`ConfigReviewer` 五项确定性检查 + `EntryGuard` 接入）；生产级需语义级配置 schema 与意图分析 |

因此：本实现**不能单独用作信任根**。在 spec/02 所述 P3 阶段（独立硬件域 + 远程证明）落地之前，它只是把「确定性硬闸门应该怎么写」变成可运行、可复现的参照。**引用本实现时，必须同时引用 `PRODUCTION-GAPS.md`**——这是本框架「诚实边界」纪律的直接落地。

## 许可证

本目录属代码路径，适用 **Apache License 2.0**（见根目录 `LICENSE-CODE`）；文档部分仍适用 CC BY-SA 4.0。路径 ↔ 许可证映射见根目录 `LICENSING.md`。

## 出处与致谢

- 机制出处：OpenMAIC `lib/server/agent-runtime/runner.ts`（集中调度式 Agent 运行器）与 eval/orchestration 模块。
- 改写说明：接口形态、确定性判定逻辑与对抗用例保留；文档、注释与 spec 映射按本框架术语重写，并按 spec/13 的诚实传统逐项标注缺口。
