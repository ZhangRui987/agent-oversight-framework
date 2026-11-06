# 处置台账（tools/disposition）

> **定位**：spec/13 **#44**（账本信号处置通道缺失）的**工具侧**最小补口——给「记了之后谁管」一个可核查的载体。
> **不构成 #44 闭合**：规范层由 `spec/10` §处置通道（10-D1–10-D11，v2.67.0 起、10-D11 于 v2.70.0 增补）钉死，实现层 10-D1–10-D6 均已有机器实现（10-D4 义务注册表 / 10-D5 完整性聚合自 v2.68.0 起），集成层自 **v2.69.0** 起处置与所处置信号**同处一条 `AppendOnlyAuditLog`**（见 §9），见证层自 **v2.70.0** 起有外锚（见 §10）——但 #44 仍定级「部分解」，理由已换成三条结构性边界：身份不验真、尾部截断的锚与链同域时不构成防篡改且锚尾须域外发布、动作枚举只登记不处置。本 README 的 §3–§7 是 spec/10 条款的**实现对应物**；两者若不一致，由门禁第 48/49/50/51/52 项拦截。

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
| **阶段 3（见证层）** | 外锚 `{chain_id, count, last_hash}` 逐次锚定 → 尾部截断与「同条数换史」可检出 | ✅ **已落地**（v2.70.0，见 §10） |
| **阶段 3.1（发布校验）** | 摘要串「是否真的发布了」：发布记录 + CHANGELOG 声明 + Release 正文对照（P1–P5） | ✅ **已落地**（v2.71.0，见 §10.6；域外发布这一步本身仍是运维动作） |

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

# 外锚：核验仓库实锚 / 重新锚定 / 自检与反测（门禁第 51 项）
node --experimental-transform-types tools/disposition/check-anchor.mts --verify-repo
node --experimental-transform-types tools/disposition/check-anchor.mts --reanchor
node --experimental-transform-types tools/disposition/check-anchor.mts --selftest
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
7. **尾部截断须外锚方能检出**（v2.69.0 确认结构事实，v2.70.0 补手段）：删掉链尾若干条后，剩余部分依然自洽——`verifyChain()` 与 `verify_chain.py` 都会 PASS。**实测过的边界**：连 `meta.event_count` 一起改，面板验链器会报「全部检查通过」，只有外锚报 `truncated`。检出手段是 `data/anchor.jsonl` 里的 `{count, last_hash}` 与链比对（`anchor.mts`）。**但边界随之收窄而非消失**：① 锚与链同处一个可写域时只提供「可检出」而非「不可篡改」——能改链者通常也能改锚；② **锚尾删除**在锚日志内部看不出来，只有域外摘要串（`aof-anchor/v1:…`）能检出，该步是运维动作、代码无法自证；③ 锚只回答「链当时长这样」，不回答「谁写的」。
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
| `anchor.mts` | **外锚（见证层）**：只对 `{count, last_hash}` 做比较，**不重实现任何链**；五种判定（`match` / `grew` / `truncated` / `forked` / `undecidable`）；锚日志自身成链 + 同链 `count` 单调不减；`externalDigest()` 生成可外发摘要串 |
| `check-anchor.mts` | **外锚自检**（门禁第 51 项）：14 项校验 + 6 条反向测试；`--verify-repo` 核验仓库实锚（先由产物各自的验证器验链，再比锚）；`--reanchor` 追加新锚；`--emit-digests` 输出机器可读的锚与摘要串（供发布校验消费，锚格式只此一份实现）；`--publish-lines` 吐出待追加的发布记录行 |
| `data/anchor.jsonl` | **锚日志**（append-only，2 条起）：对面板 V1 事件流与处置台账逐次锚定；历史锚永不删除/改写 |
| `data/published-anchors.jsonl` | **发布记录**（append-only）：一行 = 「某版本发布了某链某锚的串」；键序冻结；非防篡改对象，真伪由 Release 正文对照 |
| `scripts/check_anchor_publish.py` | **发布校验**（门禁第 52 项跑其 `--selftest`）：P1 覆盖 / P2 可溯 / P3 仓内声明（离线）+ P4 域外 / P5 双向闭包（`--release`）；7 条反向测试 |

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
2. **尾部截断不可自证**：见 §6 第 7 条。v2.70.0 起由 **§10 外锚**承接检出（`data/anchor.jsonl`），但锚与链同域时不构成防篡改，锚尾须靠域外摘要串。
3. **仍然只登记不处置**：动作枚举不含 `auto_block` / `auto_deduct`，被观测行为不因处置记录改变。

### 9.4 可复现性前提（v2.69.0 的框架侧改动）

框架 `AppendOnlyAuditLog.append` 原以隐式 `Date.now()` 取 `ts`，而哈希覆盖 `ts`，因此同一事件序列两次运行**必然**得到不同链哈希。v2.69.0 给 `append` 增加**可选** `ts` 参数（缺省仍是 `Date.now()`，既有调用行为不变），由 `appendDispositionToChain` 传入处置自报时间。

- 效果：同输入序列 → 同哈希（门禁 B17 断言「注入可复现、不注入不可复现」，两面都测）；
- 代价：链时间的可信度**没有**提高，只是从「不可复现」变成「可复现但时间同样不可信」；
- 生产建议：由可信时钟服务签名，而非沿用自报值。

---

## 10. 见证层：外锚（v2.70.0）

### 10.1 它补的是哪一条

§9.3 第 2 条——**尾部截断**。哈希链能检出「中间被改」（哈希断）与「中间被删」（跳号），但删掉链尾若干条后，剩余部分逐条自洽，`verifyChain()` 与 `verify_chain.py` 都会 PASS。这不是缺陷，是链结构的固有边界。

**已实测过的那一步**（比任何论证都直接）：删掉 `events.jsonl` 末条事件、**并把 `meta.event_count` 一并改成 8**，面板验链器输出「全部检查通过」；同一时刻外锚报 `truncated · 链只有 8 条，锚记的是 9 条`。没改 meta 时验链器会失败——但那是因为 meta 对不上，不是链有防护力。

### 10.2 五判定，不是二分

| 判定 | 含义 | 为什么必须单列 |
|---|---|---|
| `match` | 条数与末哈希都等于锚 | 唯一可写进「链完整」结论的状态 |
| `grew` | 条数更多，且锚位置哈希未变 | **正常增长**。把它报成篡改会产生大量误报，误报会让人关掉告警——比没有告警更差 |
| `truncated` | 条数更少 | 本模块存在的理由 |
| `forked` | 条数相同但末哈希不同；或条数更多但锚位置哈希已变 | 含「截断后补等量伪造事件」：条数看起来正常，只有锚能检出 |
| `undecidable` | 拿不到前缀证据且条数增长 | **如实说不知道**，不猜 |

### 10.3 锚日志与递归边界

锚日志 `data/anchor.jsonl` 自身也是一条链（`prev_anchor_hash` 逐条链接），且同一 `chain_id` 的 `count` 必须**单调不减**——否则「先截断链、再补一条更小的锚」就能自圆其说。

但递归到末端仍在：**删掉最新那条锚，日志内部看不出来**。切断它只能靠域外发布：

```
aof-anchor/v1:audit-panel/events-v1:1:9:27c2fe8f…:7d8a896bed4ce976
```

把这一串写进 Release 说明 / 交给第三方，日后任何持串者都能核验「链是否被截到这一条之前」。**这一步本身是运维动作，代码无法自证其「已发生」**——所以 `--reanchor` 每次都会把这句警告打出来。v2.71.0 起可以机器校验「发布声明是否与锚一致、是否真的出现在 Release 正文里」，见 §10.6；但校验的也只是「GitHub 上那份正文里有这串」，不是「这串没被有权限的人改过」。

### 10.4 用法

```bash
# 自检（fixture）/ 反向测试 / 仓库实锚核验 / 重新锚定
node --experimental-transform-types tools/disposition/check-anchor.mts
node --experimental-transform-types tools/disposition/check-anchor.mts --selftest
node --experimental-transform-types tools/disposition/check-anchor.mts --verify-repo
node --experimental-transform-types tools/disposition/check-anchor.mts --reanchor

# 判五种形态长什么样（人类可读）
node --experimental-transform-types tools/disposition/check-anchor.mts --demo
```

**何时需要 `--reanchor`**：链内容真的变了（重生成事件流、真实新增处置）。版本号 / 门禁计数变化只改 `events.jsonl` 的 meta 行，事件行哈希不变，锚保持不变——这条设计让发版不必每次重锚。

`--verify-repo` 的核验顺序固定：**先让产物自己的验证器验链，再比锚**。锚只说条数与末哈希，链内自洽不由锚回答——锚越权背书会让「链断了但条数对」这种形态被误判为通过。

### 10.5 边界（三条，与 `spec/10` 10-D11 一致）

1. **同域不防篡改**：能改链者通常也能改锚。外锚提供「不一致可检出」与「回滚可检出」，不是「不可篡改」；
2. **锚尾不可自证**：见 §10.3，只能靠域外摘要串；
3. **不证明作者**：锚只回答「链当时长这样」，身份验真（E1/E5）不在主张范围。

### 10.6 发布的机器校验（v2.71.0）

§10.3 那句「运维动作、代码无法自证」在 v2.70.0 是终点，现在是**起点**：漏贴、贴旧串、重锚后忘记重新发布，这三种情况在仓库内部都看不出来（锚日志是对的、链也是对的），但它们都可以被机器发现——只要「发布了什么」有落点。

- **发布记录** `data/published-anchors.jsonl`：一行 = 「某版本发布了某链某锚的摘要串」，键序冻结（`published_version` / `chain_id` / `anchor_seq` / `digest`）。它**不是**防篡改对象（与链同域）；它的作用是让「声称发布了什么」可被逐字比对。
- **校验** `scripts/check_anchor_publish.py`（门禁第 52 项跑其 `--selftest`）：

| 项 | 断言 | 抓的是什么 |
|---|---|---|
| P1 覆盖 | 每条链的**当前**锚必须有记录，且串与派生值逐字相等；同一锚被多次登记时各条不得矛盾 | 重锚后忘了登记 / 登记了但抄错 / 其中一条被改坏 |
| P2 可溯 | 每条记录必须指回真实锚行（`chain_id` + `anchor_seq`）且串相符 | 先写一条「已发布」记录，再声称已发布 |
| P3 仓内声明 | `CHANGELOG` 当前版本小节逐字含当前串，且**不得残留旧串** | 发版说明从 CHANGELOG 抄，抄到旧串即错 |
| P4 域外 | 该记录所在版本的 Release 正文必须含该串 | 记录了但从没发出去 |
| P5 双向闭包 | Release 正文里的合法串都必须有记录 | 删掉记录即可绕过 P4 |

- P1–P3 离线、进门禁；P4/P5 联网，挂在 `release-guard` 每日定时（push 上查会因网络抖动变红，而红灯被忽略比没有红灯更差）。
- **不重实现锚格式**：脚本不读 `anchor.jsonl`，只消费 `check-anchor.mts --emit-digests` 的 JSON。
- **一个实测到的误报陷阱**：Release 正文里有格式模板 `aof-anchor/v1:<chain_id>:…`，naive grep 会把它算成「未登记的串」而让 P5 永远 FAIL。故只认严格匹配（64 位 hex + 16 位前缀 + 尾边界断言），实测 68 个 Release 正文零误报。

```bash
# 生成待追加的发布记录行（版本取自 VERSION）→ 粘进 published-anchors.jsonl
node --experimental-transform-types tools/disposition/check-anchor.mts --publish-lines

# 离线校验（P1–P3）/ 发版前用本地说明文件预检 / 联网校验（P4–P5）
python scripts/check_anchor_publish.py
python scripts/check_anchor_publish.py --release-body=<发版说明.md> --version=2.71.0
python scripts/check_anchor_publish.py --release
```

**发版 checklist 的实际顺序**（重锚时）：`--reanchor` → `--publish-lines` 追加记录 → CHANGELOG 小节写入同样的串 → 写 Release 说明（含同样的串）→ `--release-body=` 预检 → 建 Release → `--release` 复核。
