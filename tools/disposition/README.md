# 处置台账（tools/disposition）

> **定位**：spec/13 **#44**（账本信号处置通道缺失）的**工具侧**最小补口——给「记了之后谁管」一个可核查的载体。
> **不构成 #44 闭合**：规范层由 `spec/10` §处置通道（10-D1–10-D10，v2.67.0）钉死，实现层 10-D1–10-D6 均已有机器实现（10-D4 义务注册表 / 10-D5 完整性聚合自 v2.68.0 起），集成层自 **v2.69.0** 起处置与所处置信号**同处一条 `AppendOnlyAuditLog`**（见 §9）——但 #44 仍定级「部分解」，理由已换成三条结构性边界：身份不验真、尾部截断须外锚、动作枚举只登记不处置。本 README 的 §3–§7 是 spec/10 条款的**实现对应物**；两者若不一致，由门禁第 48/49/50 项拦截。

---

## 1. 为什么单独一个模块，而不是放进审计面板

面板是**展示与重放**角色。把处置的**写入口**放进展示层，等于让监察者记录自己的处置，与 E 子系统职责分离相反。
因此本模块独立在仓库级 `tools/disposition/`，面板只**只读消费** `data/disposition.jsonl`，两者通过文件解耦。

| 阶段 | 载体 | 状态 |
|---|---|---|
| **阶段 1（本模块）** | 独立台账：append-only JSONL + sha256 链 | ✅ 已实现 |
| **阶段 2a（规范层）** | `spec/10` §处置通道 10-D1–10-D10：事件类型、四动作、三态、时限义务、二阶完整性信号 | ✅ **已落地**（v2.67.0） |
| **阶段 2b-1（实现层）** | 10-D4 义务注册表 + fail-closed；10-D5 `undisposed_rate` / `overdue_rate` 聚合；面板信号级视图 | ✅ **已落地**（v2.68.0） |
| **阶段 2b-2（集成层）** | `disposition` 成为框架第四种事件类型，进同一 `AppendOnlyAuditLog`（处置与被处置信号**同链**） | ✅ **已落地**（v2.69.0，见 §9；台账转为该链的投影视图） |

---

## 2. 快速使用

```bash
# 验证入库台账（Python 参照实现，纯标准库——第三方复算路径）
python tools/disposition/verify_chain.py

# 验证任意台账文件
node --experimental-transform-types tools/disposition/verify-chain.mts --file=<路径>
python tools/disposition/verify_chain.py <路径>

# 追加一条处置
node --experimental-transform-types tools/disposition/ledger.mts append \
  --target-seq=7 --target-chain-hash=9b91e16ac287dfcd \
  --signal-category=budget-exceeded --action=escalate \
  --actor=operator-alice --reviewed-by=operator-bob \
  --rationale="预算比 1.56 超出该任务标定区间，升级人工核查"

# 查看台账
node --experimental-transform-types tools/disposition/ledger.mts list

# 重放孤儿收敛演示（会重建 data/disposition.jsonl）
node --experimental-transform-types tools/disposition/demo-converge.mts --force

# 三方一致性校验（门禁第 49 项同款；--selftest 含 8 条反向测试）
node --experimental-transform-types tools/disposition/check-obligations.mts
node --experimental-transform-types tools/disposition/check-obligations.mts --selftest
```

面板侧：`node --experimental-transform-types tools/audit-panel/server/server.mts` → 「处置台账」标签页（含「处置完整性」二阶信号与「信号级处置状态」表）。
复现固定基准：`AOF_PANEL_NOW=1794000000000 node ... server.mts`——否则 `overdue` 数随访问时刻变化。

---

## 3. 链规格（冻结，跨语言可重算的唯一办法）

```
chain_hash = sha256( prev_hash + "|" + serialize(body) )
body       = 本行去掉 chain_hash / chain_prev 后的对象
prev_hash  = 上一行 chain_hash（首行为空串 ""）
```

### 3.1 键序（冻结，不得依赖运行时插入顺序）

| # | 字段 | 类型 | 规则 |
|---|---|---|---|
| 1 | `record_type` | string | 固定 `"event"` |
| 2 | `event_type` | string | 固定 `"disposition"` |
| 3 | `disp_seq` | int | 台账内从 1 单调递增，不重用；**证明写入顺序，不证明时间** |
| 4 | `target_seq` | int | 被处置信号的 `seq`（强引用） |
| 5 | `target_chain_hash` | string | 信号 `chain_hash` 的**前 16 位小写 hex**（防错位引用） |
| 6 | `signal_category` | string | 信号类别（如 `budget-exceeded`） |
| 7 | `action` | string | 四选一，见 §4 |
| 8 | `actor` | string | 处置者标识（阶段 1 自报，**不验真**） |
| 9 | `rationale` | string | 处置依据，非空 |
| 10 | `reviewed_by` | string \| null | `confirm_false_positive` / `escalate` **必填且 ≠ actor**；其余可 null |
| 11 | `supersedes` | int \| null | 指向被更正的 `disp_seq`；被更正行保留但不计当前状态 |
| 12 | `plan` | string \| null | **仅** `park_for_observation` 使用（#15 预案占位），其余必须为 null |
| 13 | `ts` | int | wall-clock 毫秒，**自报值** |

落盘行键序 = 上表 13 个字段 + `chain_hash` + `chain_prev`（共 15 键，顺序即上表顺序）。
**键序被重排即视为改写**——两端验证器都会 FAIL。

### 3.2 序列化参数（缺一不可）

| 语言 | 调用 | 禁止 |
|---|---|---|
| JS | `JSON.stringify(body)`（无空格，非 ASCII 原样 UTF-8） | 加 `null, 2` 之类缩进 |
| Python | `json.dumps(body, ensure_ascii=False, separators=(',', ':'))` | 默认 `(', ', ': ')` 与默认 `ensure_ascii=True` |

数值与空值：整数不带小数点（`1` 不写成 `1.0`）；`null` 序列化为 `null`（不是空串）；字符串内 U+2028/U+2029 不转义。
**为什么必须写死**：Python 默认参数会输出 `", "` 与 `\uXXXX`，与 JS 输出字节不同 → 第三方按文档复算必然失败，而 DoD 正是「第三方可独立重算」。

### 3.3 门禁守护（第 47 / 48 / 49 项）

`scripts/verify_consistency.py` 第 47 项每次提交执行四件事，任一失败即拦截：

1. Node 生成 20 行样本 → **Python** 验链 PASS（序列化规格漂移即失败）；
2. 改任意一行内容 → Python 与 Node **必须 FAIL**；
3. 打乱一行键序 → 两端**必须 FAIL**；
4. 入库台账 `data/disposition.jsonl` → Python 验链 PASS。

第 48 项校验条款 ↔ 实现的结构面（13 字段键序 / 四动作 / 三态 / 中英时限），第 49 项校验取值域面（类别集合 / 逐级时限 / 10-D8 状态 / 10-D5 聚合行为）。两项互补：**只校验结构不校验取值域，漏的正是「名字」这一层**（v2.67.0 的 10-D4 曾写错三个类别名，见 `spec/ERRATA-L2-SPEC.md` D-S1）。

---

## 4. 动作枚举（冻结四项）

| 动作 | 含义 | `reviewed_by` | 是否闭合 |
|---|---|---|---|
| `confirm_false_positive` | 判为误报，关闭信号 | **必填**，且 ≠ actor | ✅ 已闭合 |
| `escalate` | 升级处置等级（交更高权限） | **必填**，且 ≠ actor | ✅ 已闭合 |
| `route_to_human` | 转交人工 | 可 null | ❌ **未闭合**（转交 ≠ 处置完成） |
| `park_for_observation` | 挂起观察 | 可 null | ⏸ 观察中（`plan` 必填） |

**刻意不含** `auto_block` / `auto_deduct` / 任何阻断与扣分动作（治理红线：真实业务标定完成前 S3 不得硬熔断；信用处分须人工复核独立取证）。
升级为阻断的动作属 #15 选型与 #3 标定后的演化，以「新增枚举 + 新前置条件校验」进入，**不静默扩展**。

## 5. 三态语义（面板与 replay 共用同一派生）

| 状态 | 判定 | 面板文案 |
|---|---|---|
| `unhandled` | 无生效处置，或最新为 `route_to_human`，或复核人缺失 | 未处置 / 已转人工 · 未闭合 |
| `observing` | 最新为 `park_for_observation` | 观察中 |
| `closed` | 最新为 `confirm_false_positive` / `escalate` 且 `reviewed_by` 非空 | 已闭合 |

**孤儿 = `unhandled`**。`route_to_human` 归入未处置是刻意的：否则「已转人工」会被读成「已闭合」。

### 5.1 义务与时限（10-D4，v2.68.0）

`obligations.json` 是义务注册表：每个 `signal_category` 必须登记 `priority` / `sla_hours` / `owner_role` / 可逆性依据。**未登记的类别拒写**（`assertDeclared` 在 `validateInput` 里 fail-closed）——「没有处置通道的信号只是噪声」这条原则，只能靠写入口强制。

| 级别 | 类别 | 时限 | 责任角色 | 可逆性依据 |
|---|---|---|---|---|
| P0 | `memory-write-audited` | 24h | `safety-reviewer` | 记忆/系统提示可污染后续全部会话，事后难辨投毒与维护 |
| P1 | `budget-exceeded` | 72h | `cost-owner` | 已发生成本，可归因可追偿，不损坏后续行为 |
| P1 | `shadow-deviation` | 72h | `cost-owner` | 消耗结构变化，可能滥用也可能任务迁移，需人工判读 |
| P2 | `periodic-egress` | 168h | `ops-owner` | 多为心跳/健康检查，信息性为主 |

⚠️ **四个时限都是工程占位，未标定**（由 `spec/13` #33 承接）。标定完成前，任何时效统计只能报分布，不得写「达标」。

**级别与时限的对应写死在代码里**（`PRIORITY_SLA_HOURS`）：手改 JSON 把 P0 写成 168h 会直接抛错，而不是悄悄放宽最高级别的时限。

### 5.2 完整性信号（10-D5，v2.68.0）

| 量 | 定义 | 分母 |
|---|---|---|
| `undisposed_rate` | 生效状态为 `unhandled` 的信号数 ÷ 信号总数 | **必须显式传入信号全集** |
| `overdue_rate` | 超过 10-D4 时限仍为 `unhandled` 的信号数 ÷ 信号总数 | 同上 |

三条实现纪律，都是为了防止造出「看起来对」的假指标：

1. **`now` 必传、不取 `Date.now()` 默认值**——否则同一份数据在不同时刻算出不同 `overdue` 数，输出不可复现。面板用环境变量 `AOF_PANEL_NOW` 固定基准即可复算。
2. **信号全集必传，台账不得自任分母**——台账只含「被处置过的」`seq`，拿它当分母会把两个 rate 结构性压向 0（甚至算出 >100%）。面板的分母来自事件流的 `ledger_signal`。
3. **空集返回 `null`，不返回 0**——`0/0` 报 0 会制造「零未处置」的假象。

未登记类别的信号**不被丢弃**：SLA 记 `null`、单列、`provisional=true`——提醒读者比例未覆盖全部信号。时钟倒挂（`signal_ts` 在基准之后）不计入 `overdue`，但单列 `clock_skew` 计数。

**四段时效只可分离一段**：台账只有「信号 ts」与「处置 ts」两个时间点，因此只能算「信号 → 首条生效处置」；MTTD / 确认 → 动作 / 动作 → 关闭三段不可分离。代码里该函数名是 `measureSignalToDisposition` 而非 `mttr`——命名就是为了防止混报（10-D5 限制 2 明禁合成单一平均值）。

---

## 6. 边界（不得省略的八条）

1. **只登记不阻断**：本模块不提供任何阻断 / 扣分 / 拦截能力，框架侧也仍无处置通道。
2. **处置 ≠ 有效**：`confirm_false_positive` 可以一键关掉任意信号；孤儿归零不等于缺口已解。
3. **时序不可信**：`ts` 为自报 wall-clock，`disp_seq` 只证明写入顺序；任何时延统计须标注「自报值，不可验证」，且 MTTD / 人工确认 / 处置动作 / MTTR 四段分开报告，不得混报单一平均值。
4. **身份不验真**：`actor` / `reviewed_by` 自报可伪造；本模块只能证明「文件未事后被改」，不能证明「处置者是谁」（E1/E5 级完整性不在主张范围）。
5. **信任域有限**：链在被观测进程内计算，进程被攻陷时整链可重算（G4 边界原样复现）；不得表述为「防篡改」。
6. **演示数据 ≠ 真实处置**：`data/disposition.jsonl` 中 actor 以 `demo-` 开头、rationale 以「演示数据」开头的记录，仅用于演示孤儿清单如何收敛。
7. **尾部截断不可自证**（v2.69.0 实测确认）：删掉链尾若干条后，剩余部分依然自洽——`verifyChain()` 与 `verify_chain.py` 都会 PASS。这不是缺陷，是哈希链的结构边界。检出只能靠**外锚** `{count, lastHash}`（`chainDigest()`）与链外记录比对，而外锚尚未实现。因此任何「链完整」的结论都只在「未被截断」的假设下成立，报告必须连带这句。
8. **两个时间戳不可混用**（v2.69.0 起）：框架事件外层 `ts` 是链上时间（由调用方传入以保证可复现），处置载荷 `data.ts` 是处置自报时间。报表一律用 `data.ts` 且标「自报值，不可验证」；排序用 `seq`，不用任何 `ts`。

---

## 7. 迁移到阶段 2（`target_chain_hash` 会失效）

进入框架链后，链哈希覆盖的键序与内容都不同，阶段 1 的 `target_chain_hash` 不再可比。**原规则（v2.62.0 写的三元组）不可执行**，已由 `spec/ERRATA-L2-SPEC.md` **D-S2** 登记并修正：

| 项 | 原写法 | 现写法（`migrateLedger`） |
|---|---|---|
| 匹配键 | `(target_seq, signal_category, sha256(detail) 前 16 hex)` | `(signal_category, hash 前 16 位)` |
| 为什么改 | 第三元 `sha256(detail)` 在台账 13 键里**从未落盘**，物理上取不到；第一元 `target_seq` 跨链不同空间，不可作依据 | 只剩两个元在两链间都稳定 |

未匹配**不丢弃**，按四种原因分别标注：

| 原因 | 含义 | 处置 |
|---|---|---|
| `hash_prefix_match` | 命中且唯一 | 记录框架 `{seq, hash}`，写 `migration-map.json` |
| `hash_prefix_mismatch` | 有同类信号，但前 16 位对不上 | 保留原引用，人工回查（多为引用了另一条链） |
| `no_signal_of_category` | 框架链里没有该类别信号 | 保留原引用；说明信号源不在本链 |
| `ambiguous` | 两条候选共享 16 位前缀 | 不任选，保留原引用（64 位碰撞不可构造，此分支靠手工事件流测试） |

**实测（v2.69.0，`check-bridge.mts --demo`）**：入库台账 3 行全部 `hash_prefix_mismatch`（各 1 条候选）——它们引用的是另一条链的哈希。这正是「进入框架链后 `target_chain_hash` 会失效」的实证，不是理论风险。三行原样保留。

> 迁移后仍需重算整链并产出迁移前后 `chain_hash` 对照表（配置项，非默认产物）；投影重跑须逐字节一致，这一条由门禁第 50 项的 B5 断言守护。

---

## 8. 文件清单

| 文件 | 作用 |
|---|---|
| `ledger.mts` | 核心：键序冻结 / `disp_seq` 分配 / `supersedes` / 字段校验（含 10-D4 fail-closed 调用）/ 三态派生 / CLI（`append` · `list`） |
| `obligations.json` | **义务注册表**（10-D4）：四类别 × 级别 / 时限 / 责任角色 / 可逆性依据；时限为工程占位、未标定 |
| `obligations.mts` | **义务加载与 SLA 判定**（10-D4/D5）：无 wall-clock 依赖的纯函数——`annotateSla` / `computeCompleteness` / `measureSignalToDisposition`；`now` 与信号全集必传 |
| `check-obligations.mts` | **三方一致性校验**（门禁第 49 项）：注册表 ↔ `LedgerSignalKind` ↔ 中英条款；8 项校验 + 8 条反向测试 |
| `verify-chain.mts` | Node 验链（八类检查，与 Python 逐条对齐） |
| `verify_chain.py` | Python 参照实现（纯标准库）——第三方复算路径 |
| `gen-sample.mts` | 20 行固定样本（覆盖四动作 / 中文 / 复核人为空与非空 / plan / 更正链） |
| `demo-converge.mts` | 端到端演示：V1 三条孤儿 → 2 已闭合 + 1 未闭合（**刻意不三条全闭合**） |
| `data/disposition.jsonl` | 演示台账（3 条，链可验证，**非真实运维处置**）——v2.69.0 起它是**链的投影视图**示例 |
| `framework-bridge.mts` | **集成层（2b-2）**：把处置写进框架同一 `AppendOnlyAuditLog`（`appendDispositionToChain`）；从链投影出台账（`projectLedger`）；独立复算链（`verifyEventChain`）；链摘外锚（`chainDigest`）；历史台账迁移（`migrateLedger`） |
| `check-bridge.mts` | **集成层自检**（门禁第 50 项）：19 项校验 + 6 条反向测试；`--demo` 打印链上内容、投影结果与真实台账迁移结论；`--emit-ledger=` 供 Python 参照实现复核 |

---

## 9. 集成层：为什么「同链」不等于「闭合」

### 9.1 一条链，两种视图

```
框架 AppendOnlyAuditLog（唯一真相源）
  seq 1 ledger_signal   信号①
  seq 2 ledger_signal   信号②
  seq 3 ledger_signal   信号③
  seq 4 disposition     ← 处置（target_seq=1）
  seq 5 disposition     ← 处置（target_seq=2）
        │
        ├─ verifyEventChain(events)   ← JS 侧独立复算（落盘数据即可验）
        └─ projectLedger(events) ─────→ 台账 JSONL（台账链规约重算哈希）
                                          └─ verify_chain.py  ← Python 参照实现复核
```

**单一真相源 + 投影**，不是双写。双写必然漂移：一次 append 成功、一次文件写失败，此后两份数据永久不一致，而「哪个是真的」没有答案。投影则可以随时重算——门禁 B5 断言两次投影逐字节相同。

### 9.2 同链买到了什么

| 能力 | 阶段 1（独立台账） | 阶段 2b-2（同链） |
|---|---|---|
| 删改一条处置 | 台账链断，信号链不受影响 | **整链断**，断点定位到该条 |
| 删掉中间一条信号 | 无感 | 跳号 + 哈希断，处置一并受牵连 |
| 处置与信号的引用关系 | 跨链弱引用（前缀 16 hex） | 同链 `target_seq` 强引用 |
| 第三方复核路径 | 只有台账一条 | 链路或投影皆可，两者互为交叉验证 |

### 9.3 同链没买到什么（三条，必须同行展示）

1. **身份仍不验真**：`actor` / `reviewed_by` 自报可伪造。链证明「文件未事后被改」，不证明「谁处置的」。
2. **尾部截断仍不可自证**：见 §6 第 7 条。`chainDigest()` 提供了外锚的**形状**，但外锚本身未落地。
3. **仍然只登记不处置**：动作枚举不含 `auto_block` / `auto_deduct`，被观测行为不因处置记录改变。

### 9.4 可复现性前提（v2.69.0 的框架侧改动）

框架 `AppendOnlyAuditLog.append` 原以隐式 `Date.now()` 取 `ts`，而哈希覆盖 `ts`，因此同一事件序列两次运行**必然**得到不同链哈希。v2.69.0 给 `append` 增加**可选** `ts` 参数（缺省仍是 `Date.now()`，既有调用行为不变），由 `appendDispositionToChain` 传入处置自报时间。

- 效果：同输入序列 → 同哈希（门禁 B17 断言「注入可复现、不注入不可复现」，两面都测）；
- 代价：链时间的可信度**没有**提高，只是从「不可复现」变成「可复现但时间同样不可信」；
- 生产建议：由可信时钟服务签名，而非沿用自报值。
