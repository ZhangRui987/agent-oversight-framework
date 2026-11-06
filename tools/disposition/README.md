# 处置台账（tools/disposition）

> **定位**：spec/13 **#44**（账本信号处置通道缺失）的**工具侧**最小补口——给「记了之后谁管」一个可核查的载体。
> **不构成 #44 闭合**：规范层已由 `spec/10` §处置通道（10-D1–10-D10，v2.67.0）钉死，但本模块仍是独立台账、未进框架同一审计链，且 10-D4 时限判定 / 10-D5 完整性聚合尚未自动化——#44 定级「部分解」。本 README 的 §3–§6 是 spec/10 条款的**实现对应物**；两者若不一致，由门禁第 48 项拦截。

---

## 1. 为什么单独一个模块，而不是放进审计面板

面板是**展示与重放**角色。把处置的**写入口**放进展示层，等于让监察者记录自己的处置，与 E 子系统职责分离相反。
因此本模块独立在仓库级 `tools/disposition/`，面板只**只读消费** `data/disposition.jsonl`，两者通过文件解耦。

| 阶段 | 载体 | 状态 |
|---|---|---|
| **阶段 1（本模块）** | 独立台账：append-only JSONL + sha256 链 | ✅ 已实现 |
| **阶段 2a（规范层）** | `spec/10` §处置通道 10-D1–10-D10：事件类型、四动作、三态、时限义务、二阶完整性信号 | ✅ **已落地**（v2.67.0） |
| **阶段 2b（实现层）** | `disposition` 成为框架第四种事件类型，进同一 `AppendOnlyAuditLog`（处置与被处置信号**同链**） | ⬜ 另轮（索引扩展 + 迁移执行 + 10-D4/D5 自动化） |

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
```

面板侧：`node --experimental-transform-types tools/audit-panel/server/server.mts` → 「处置台账」标签页。

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

### 3.3 门禁守护（第 47 项）

`scripts/verify_consistency.py` 第 47 项每次提交执行四件事，任一失败即拦截：

1. Node 生成 20 行样本 → **Python** 验链 PASS（序列化规格漂移即失败）；
2. 改任意一行内容 → Python 与 Node **必须 FAIL**；
3. 打乱一行键序 → 两端**必须 FAIL**；
4. 入库台账 `data/disposition.jsonl` → Python 验链 PASS。

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

---

## 6. 边界（不得省略的六条）

1. **只登记不阻断**：本模块不提供任何阻断 / 扣分 / 拦截能力，框架侧也仍无处置通道。
2. **处置 ≠ 有效**：`confirm_false_positive` 可以一键关掉任意信号；孤儿归零不等于缺口已解。
3. **时序不可信**：`ts` 为自报 wall-clock，`disp_seq` 只证明写入顺序；任何时延统计须标注「自报值，不可验证」，且 MTTD / 人工确认 / 处置动作 / MTTR 四段分开报告，不得混报单一平均值。
4. **身份不验真**：`actor` / `reviewed_by` 自报可伪造；本模块只能证明「文件未事后被改」，不能证明「处置者是谁」（E1/E5 级完整性不在主张范围）。
5. **信任域有限**：链在被观测进程内计算，进程被攻陷时整链可重算（G4 边界原样复现）；不得表述为「防篡改」。
6. **演示数据 ≠ 真实处置**：`data/disposition.jsonl` 中 actor 以 `demo-` 开头、rationale 以「演示数据」开头的记录，仅用于演示孤儿清单如何收敛。

---

## 7. 迁移到阶段 2（`target_chain_hash` 会失效）

进入框架链后，链哈希覆盖的键序与内容不同，阶段 1 的 `target_chain_hash` 不再可比。迁移规则：

1. 按 `(target_seq, signal_category, sha256(detail) 前 16 hex)` 三元组匹配阶段 1 的 target 与框架链事件；
2. 生成 `migration-map.json`（`disp_seq → new_target_seq`），每条重映射登记；
3. 匹配失败的行**不丢弃**，标 `unmapped: true` 并在面板「迁移异常」列展示；
4. 迁移后重算整链，产出迁移前后 `chain_hash` 对照表，供第三方核验。

---

## 8. 文件清单

| 文件 | 作用 |
|---|---|
| `ledger.mts` | 核心：键序冻结 / `disp_seq` 分配 / `supersedes` / 字段校验 / 三态派生 / CLI（`append` · `list`） |
| `verify-chain.mts` | Node 验链（八类检查，与 Python 逐条对齐） |
| `verify_chain.py` | Python 参照实现（纯标准库）——第三方复算路径 |
| `gen-sample.mts` | 20 行固定样本（覆盖四动作 / 中文 / 复核人为空与非空 / plan / 更正链） |
| `demo-converge.mts` | 端到端演示：V1 三条孤儿 → 2 已闭合 + 1 未闭合（**刻意不三条全闭合**） |
| `data/disposition.jsonl` | 演示台账（3 条，链可验证，**非真实运维处置**） |
