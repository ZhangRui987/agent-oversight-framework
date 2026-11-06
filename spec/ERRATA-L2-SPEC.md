# L2 规范层勘误（ERRATA-L2-SPEC）

**性质**：本文件登记**已发布的 spec 条款中**发现的缺陷与补正。与 `reference/runtimes/l2-runtime-oversight/ERRATA-AOE-CALIB-007.md` 分开维护——后者是实验预注册勘误（编号 `D-1`…`D-7`），本文件是规范层勘误（编号 `D-S1`…，`S` 表 spec）。

**纪律**：条款一经发布不复用编号、不删除原文。勘误以「原写法 → 现写法 + 影响 + 守护手段」的形式留痕；**不改任何判据与阈值**——需要改判据的处置必须走版本递增与新一轮预注册。

| 编号 | 条款 | 类别 | 一句话 |
|---|---|---|---|
| D-S1 | `spec/10` §10-D4 | 命名漂移 | 表格写了三个实现中**不存在**的信号类别名，与 `LedgerSignalKind` 对不上 |
| D-S2 | `tools/disposition/README.md` §7 | 规则不可执行 | 迁移键的第三元 `sha256(detail) 前 16 hex` 在台账 13 键里从未落盘，物理上无法取得 |

---

## D-S1 10-D4 的信号类别名与实现不一致（命名漂移）

**发现于**：v2.68.0 建 `tools/disposition/obligations.json`（义务注册表）时，逐一对照框架侧 `LedgerSignalKind`。

**原写法**（`spec/10` §10-D4，v2.67.0 起）：

| 级别 | 表格里写的类别 | 实现里的真实类别 |
|---|---|---|
| P0 | `memory-write-unauthorized` | `memory-write-audited` |
| P1 | `budget-exceeded` ✓、`shadow-ratio-deviation` | `budget-exceeded`、`shadow-deviation` |
| P2 | `periodic-touch-hit` | `periodic-egress` |

四个类别里**三个名字是错的**（`budget-exceeded` 恰好对上）。表格标注为「信号类别示例」，但示例用了不存在的名字，读者按条款实现会造出一张永不触发的义务表。

**影响**（不是措辞问题，是功能性缺陷）：

1. 按条款实现 fail-closed，会拦掉三类**真实**信号、放过三个**虚构**类别——条款与实现各自自洽、彼此不可用；
2. 10-D5 的 `undisposed_rate` / `overdue_rate` 若按错误类别聚合，分母恒为 0，二阶信号永远「完美」；
3. 第三方复现者无路径判断哪个名字对——条款是规范层，实现是参考实现，规范写错时参考实现反而「不合规」。

**为什么此前没被发现**：门禁第 48 项校验了 10-D1 的**字段键序**、10-D2 的**动作枚举**、10-D3 的**三态派生**，唯独没有校验 10-D4 的**类别枚举**——同一类漂移在动作上被挡住、在类别上漏了。条款里的类别名在 v2.68.0 之前**从未被任何机器读过**，只是给人看的文字。

**补正**（v2.68.0）：

1. `spec/10` §10-D4 表格改为四个真实类别，并加一句「类别名必须与实现一致，三处任一漂移即由门禁第 49 项拦截」；中英双语同步。
2. 新增 `tools/disposition/obligations.json`：类别集合即 `LedgerSignalKind` 四值，每类声明 `priority` / `sla_hours` / `owner_role` / 可逆性依据。
3. 新增门禁第 49 项（`tools/disposition/check-obligations.mts`）：注册表 ↔ `index.ts` ↔ 中英条款三方类别集合必须相等，逐级时限必须等于 `PRIORITY_SLA_HOURS`，10-D8 状态必须与实现相符；**8 项校验 + 8 条反向测试**（每条断言指定检查项命中，避免被别的检查顺带拦住而误判判别力）。

**定性**：属**规范可执行性**缺陷，不改变任何判定逻辑、阈值或样本口径。但它证明了一条更一般的问题——**条款里凡是枚举值，都必须与实现建立机器可验的对应关系**；只校验结构（字段、动作）不校验取值域（类别），漏的正是「名字」这一层。

**边界**：本勘误不主张 10-D4 的时限值（24h / 72h / 7d）已被标定——它们仍是工程占位，标定由 `spec/13` #33 承接。

---

## D-S2 迁移键三元组的第三元在台账中不存在（规则不可执行）

**发现于**：v2.69.0 实现集成层（阶段 2b-2）时，按 `tools/disposition/README.md` §7 写迁移器。

**原写法**（v2.62.0 起，`tools/disposition/README.md` §7）：

> 按 `(target_seq, signal_category, sha256(detail) 前 16 hex)` 三元组匹配阶段 1 的 target 与框架链事件。

**缺陷**：台账的 13 个冻结字段里**既没有 `detail`，也没有它的哈希**（字段为 `record_type` / `event_type` / `disp_seq` / `target_seq` / `target_chain_hash` / `signal_category` / `action` / `actor` / `rationale` / `reviewed_by` / `supersedes` / `plan` / `ts`）。第三元只能从**信号侧**的事件流里取，而信号侧不在台账里——规则把「待匹配对象的属性」当成了「匹配键的组成部分」，写法上成立、数据上无从取得。

**影响**：

1. 迁移器无法按文档实现，读者只能自行发明一套规则（第三方复现时必然分叉）；
2. `target_seq` 作为第一元同样不可跨链使用——两条链的 `seq` 空间独立，阶段 1 的 `seq=7` 与框架链的 `seq=7` 不是同一条信号。三元组里唯一跨链稳定的只有 `signal_category`。

**为什么此前没被发现**：§7 是一条**面向未来的备忘**而非可执行规格，写的时候没有对应实现，也就没有任何东西会因为它写错而失败。与 D-S1 同构：**没有机器读者的规则，等于没有被校验过的规则**。

**补正**（v2.69.0）：

1. 匹配规则改为**二元组 + 前缀证明**：候选 = 框架事件中 `type = ledger_signal` 且 `data.kind === signal_category` 者；匹配 = 该事件 `hash` 的前 16 位 `=== target_chain_hash`。`target_seq` 只作记录，不作依据。
2. 未匹配不丢弃，按四种原因分别标注：`hash_prefix_mismatch`（有同类信号但前缀对不上）/ `no_signal_of_category`（源中无该类别）/ `ambiguous`（两条候选共享 16 位前缀，不任选）/ 匹配成功记录框架 `{seq, hash}`。
3. 门禁第 50 项反向测试覆盖四类原因中的三类（`ambiguous` 由手工构造事件流触发——真实 64 位碰撞不可构造，故不假装「已实测碰撞」）。

**实测结论（v2.69.0，`check-bridge.mts --demo`）**：入库台账 `tools/disposition/data/disposition.jsonl` 3 行**全部 `unmapped`**（`hash_prefix_mismatch`，各 1 条候选）。原因是这三条演示记录引用的是另一条链的哈希——即 §7 预告的「进入框架链后 `target_chain_hash` 会失效」已经发生，而不是理论风险。三行原样保留，未丢弃、未改写。

**定性**：属**规范可执行性**缺陷，不改变任何判据或阈值。一般化教训：**规则里出现的每个键，必须先确认它在数据里存在**；「将来迁移时会用到」的字段，要么现在落盘，要么不写进规则。
