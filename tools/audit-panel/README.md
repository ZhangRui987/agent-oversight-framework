# Agent 行为审计面板（audit-panel）

> 状态：**V1 + V2 real-agent + 处置台账（阶段 1）可用**（事件导出 / 独立链验证 / 重放校验 / Web 五视图 / CSV 全量导出 / LLM-in-the-loop / 启动时当场验证 / 审计报告）。
> 本目录是 [agent-oversight-framework](../../README.md) 的**参照实现附属工具**，不是独立项目。

---

## 一句话

不是给开发者调试的 trace 工具，是给**要交合规审计报告的人**用的证据工具：读取 Agent 运行时审计日志，按证据分级展示每条行为的规则依据，并映射到 TC260《人工智能安全治理框架 3.0》的具体条款。

第二条验证**文件没被改过**；第三条验证**日志说的是否为真**；第四条把前两步的成果变成可看、可导出的界面。四条命令均零安装、不联网。

## 按你的目的使用

| 你是谁 / 想做什么 | 用什么 | 需要 key | 需要网络 |
|---|---|---|---|
| **看效果**（clone 下来跑起来看看） | 命令 ① + ④，浏览器四个标签页 | 否 | 否 |
| **独立复核**（不信产物，自己验证——复现者 / 评审者） | 命令 ② + ③，外加重跑 ① 后 `md5sum` 与 git 内产物比对；有出入走主仓 `independent-replication` Issue 模板 | 否 | 否 |
| **出审计材料**（要交报告 / 进 Excel） | 命令 ④ 起服务 → 面板「导出 CSV」（V1+V2 全量 20 条）→ `/report` 页面 Ctrl+P 存 PDF | 否 | 否 |
| **登记处置 / 看孤儿是否收敛** | `tools/disposition/ledger.mts append` 追加处置 → 面板「处置台账」标签页 | 否 | 否 |
| **跑真实 LLM 会话**（看三件套拦真 Agent） | `realagent/runner.mts`（四场景）→ `verify-realagent.mts`（静态复核）→ 面板「real-agent 会话」标签 | **是** | 是 |
| **改代码后回归** | CLI 三件（①②③）+ 主仓 `python scripts/verify_consistency.py` | 否 | 否 |

## 命令总览

```bash
# 1) 导出审计事件（零依赖，无需 npm/pip install，不联网）
node --experimental-transform-types tools/audit-panel/scenario/export-events.mts

# 2) 独立验证事件文件（链重算 + 依据字段完整 + 篡改演示）
node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --tamper-demo

# 3) 重放校验（对每条拦截独立重执行规则，比对日志裁决——审计与看板的分界线）
node --experimental-transform-types tools/audit-panel/rules/replay.mts

# 4) 起面板（浏览器打开 http://127.0.0.1:7727；含 V1 / V2 / 处置台账三个数据视图）
node --experimental-transform-types tools/audit-panel/server/server.mts

# 5) 处置台账（阶段 1：工具侧补口。框架侧仍无处置通道，spec/13 #44 未解）
python tools/disposition/verify_chain.py                                         # 独立验链（Python 参照实现）
node --experimental-transform-types tools/disposition/demo-converge.mts --force   # 演示：V1 三条孤儿如何收敛
```

第二条验证**文件没被改过**；第三条验证**日志说的是否为真**；第四条把前两步的成果变成可看、可导出的界面；第五条给「记了之后谁管」一个可核查的载体。上述命令均零安装、不联网。

## V2 real-agent：接一个真实 LLM（可选，需 API key）

V1 的数据来自确定性场景；V2 让一个**真实 LLM Agent**（默认 DeepSeek，OpenAI 兼容）在同样的三件套包裹下执行任务——每次工具调用都走 EntryGuard → 执行 → ResourceLedger → ExitGuard，被拒的结果会回给 LLM，它被拒后的调整同样随链留痕。

```bash
# 前置：key 不入库。二选一：
#   a) 环境变量 OVERSIGHT_LLM_API_KEY=<key>
#   b) 在 tools/audit-panel/.env 写入一行 OVERSIGHT_LLM_API_KEY=<key>（.gitignore 已排除）
node --experimental-transform-types tools/audit-panel/realagent/runner.mts          # 四场景全跑
node --experimental-transform-types tools/audit-panel/realagent/runner.mts --only=N1 # 单场景
```

四个诱导场景（任务正常、规则收紧，拦截的是 LLM 的自然决策）：**N1** 窄白名单（试列目录被拒）· **N2** 低预算（累积消耗一路超阈，逐轮双信号）· **N3** 记忆写入（最高审计级别）· **N4** 输出泄密（凭据字段原样搬运被出口门拦下）。

**V2 的诚实边界**（页面同样内置）：

- `ts_mode = wall-clock`（真实时钟）、每条事件可复现性 = **不可确认**——LLM 输入不可重放，两次运行产物必然不同，这是设计而非缺陷；
- 本数据是**自测性质的行为记录**，只支撑"三件套在真实 LLM 行为流上正常运行并留痕"，**不支撑任何效能断言**（不得写"证明 LLM 会违规""检出率 X%"）；
- key 只从环境变量 / `.env` 读取，绝不入库、不入日志、不入错误信息；沙箱工作区（`realagent/workspace/`）运行产物不入 git。
- **运行历史归档与增量落盘**：每次运行开始时上一份产物自动归档至 `data/history/realagent-run{N}-{stamp}.jsonl`（gitignore，本地研究素材）——多次运行的行为差异可回溯对比，`--only` 单场景运行也不再可能覆盖历史（v2.60.1 事故结构性排除）；事件按场景粒度增量落盘，中途失败不丢已完成场景，残留由下次运行归档为 incomplete run。

## 数据从哪来（诚实声明）

`data/events.jsonl` 的每一条事件，都由 `scenario/export-events.mts` **真实调用**框架 L2 参照实现的
`EntryGuard` / `ExitGuard` / `ResourceLedger` 产生——不是手写日志、不是抄实验报告、不是 LLM 生成。

- 执行路径：`index.ts`（框架原码）→ 注入 `RecordingAuditLog`（实现 `{ append }` 鸭子接口）→ 投影为 JSONL
- 框架改动：**零**。`index.ts` 与 `demo.ts` 均未修改（`demo.ts` 是 24 组 153 断言的 CI 基线）
- 数据可复现：同一框架版本的两次运行产出**逐字节相同**的文件（实测 md5 一致）

重跑验证可复现性：

```bash
md5sum tools/audit-panel/data/events.jsonl
node --experimental-transform-types tools/audit-panel/scenario/export-events.mts --quiet
md5sum tools/audit-panel/data/events.jsonl   # 应与上一次相同
```

## 覆盖了什么、没覆盖什么

导出器按代码实读得出覆盖率，**不按类型定义推断**。未覆盖项在面板上必须原样展示。

| 规则 | 已产出 | 未覆盖 / 缺口 |
|---|---|---|
| R1 准入门 | `tool-not-allowed`、`arg-policy-violation`、`config-review-fail` | `rate-limit`、`budget-exhausted` **仅在类型定义中声明，`EntryGuard.check` 无任何分支产生**（`index.ts:704-705`）——属"已声明未实现" |
| R2 出口门 | `output-policy-violation`、`resource-over-budget`、`integrity-check-failed` | `integrity-check-failed` 由显式注入 `integrityCheck=()=>false` 触发，属"分支可达性演示"，**不代表真实完整性校验能力**（PRODUCTION-GAPS G4 未闭合） |
| R3 资源账本 | `budget-exceeded`、`shadow-deviation`、`memory-write-audited` | `periodic-egress` **未覆盖**：该信号依赖 8 次出站调用的真实时间间隔方差；紧循环触发会造出 0ms 间隔的假阳性。宁可不覆盖，也不拿构造数据冒充检测能力 |
| R5 审计链 | `verifyChain` 运行期校验 + 落盘链 | 链在**被观测进程内**计算，进程被攻陷时可整链重算（G4/E5 未闭合）。**不得表述为"防篡改"** |

## 边界声明（面板必须展示，不可省略）

1. **审计链：链已实现，但无密钥与外部锚定。** SHA-256 链可检出等长篡改（G2，演示级闭合）；未闭合的是整链可重算（G4）。
   注意区分：`ExitGuard.integrityCheck` 的"占位钩子、默认恒真"属于**工具结果完整性（E5）**，与审计链是两件事。
2. **审计链只记录拒绝，放行不留痕。** 只在 deny/reject 分支 `append`；allow/accept 不写事件。
   因此本文件不是完整会话，而是"全部被拦下的行为"——"为什么放过了某次调用"当前不可审计。
3. **资源账本信号默认是孤儿；工具侧台账可登记处置，但不构成闭合。** 框架不提供任何处置通道（不拦截、不阻断），spec/10 的设计取向正是"审计而非拦截"，
   这也意味着每条信号都"记了但没人处置"。**处置通道缺口已登记为 [spec/13 #44](../../spec/13-boundaries.md) 未解问题**（处置 API / 处置台账 / 处置时限义务的最小形态）。
   阶段 1 在 [`tools/disposition/`](../disposition/README.md) 提供**独立**台账（不放进面板，避免监察者记录自己的处置）：append-only + sha256 链，
   动作枚举仅 `confirm_false_positive` / `escalate` / `route_to_human` / `park_for_observation`——**不含任何阻断或扣分动作**。
   三条边界不得省略：① **处置记录存在 ≠ 处置有效**（`confirm_false_positive` 可以一键关掉任何信号，孤儿归零不等于缺口已解）；
   ② 处置时延 `ts` 为**自报值**，不可验证；③ **框架侧仍无处置事件类型，#44 未闭合**，本台账只是工具侧补口。
4. **时间戳是合成值。** 落盘 `ts = BASE_TS + seq*1000`，用于保证逐字节可复现；不能据此推断真实发生时刻或间隔。
5. **契约字段有一半是导出器补写的。** 框架 `AuditEvent` 只有 `{ type, data, ts }`；
   `session_id` / `rule_id` / `spec_ref` / `tc260_*` 均为按映射表补写的元数据。
6. **配置审查依赖固定字段名。** `share-scope-widened` 只认 `visibility` / `share` / `shareWith` / `accessLevel`；
   语义等价的 `shareScope` 不触发。S3 场景刻意保留了这一漏检样本（报 2 项而非 3 项）——
   与 AOE-DETECT-001「混淆类变体 77/77 未检出」同源。**"未报错"不等于"配置安全"。**

## 两套链，不可混用

| | 运行期框架链 | 落盘链 |
|---|---|---|
| 算法 | 框架 `AppendOnlyAuditLog` 原生（含真实 `Date.now()`） | `sha256(prev + "\|" + JSON.stringify(本行去两个链字段))` |
| 有效范围 | 仅本次运行内 | 跨运行、跨机器 |
| 能证明什么 | 本次运行期间链未被破坏 | 文件未被事后篡改 |
| 不能证明什么 | 跨运行一致性（每次哈希不同） | 框架原逻辑正确、事件真实发生过 |

`meta.chain.recompute_recipe` 给出了第三方独立重算的完整步骤，`verify-chain.mts` 是它的可执行实现。

## 事件契约要点

一行一事件，首行为 `meta`（记录 schema 版本、框架版本、覆盖矩阵、边界声明、链校验结果）。

三种 `event_type`（框架真实取值，无第四种）：

| event_type | category 来源 | 附带的实测字段 |
|---|---|---|
| `entry_deny` | `data.category` | 无（只有 `tool` / `callerId` / `reason`，`config-review-fail` 另带 `findings`） |
| `exit_reject` | `data.category` | 超预算分支为 `metric` / `actual` / `budget`，投影时归一化为 `measured` / `threshold` |
| `ledger_signal` | `data.kind` | 原生 `measured` / `threshold` |

> 注意：`entry_deny` 没有实测值。统一给它挂 `measured`/`threshold` 等于造假字段，故这两种事件填 `null`。

**证据分级是三层，不是一层**（详见《审计面板_方案_v4.0》§9）：

- **事件级**：该事件的可复现性（`可重跑` / `仅留档` / `不可确认`）
- **规则级**：该规则**技术效能主张**的等级（A 自复现 / B 文献 / C 域迁移缺口 / D 未核实 / G 治理一手）
- **条款级**：映射到的标准条款（G 级，只支撑义务、不支撑效能）

> 常见错误：把"条款是 G 级"当成"机制有效"。G 类支撑**义务**（"应当做 X"），不支撑**效能**（"X 有效"）。

## 重放校验：日志说的不是"是否为真"的终点

`rules/replay.mts` 对每条拦截/信号做**独立重执行**，比对三方一致性：

```
日志记录的 category == 事件 replay.expect == 重放器重新执行得到的 category
```

- 判定输入（白名单、策略声明、预算、结果）由导出器写入每条事件的 `replay` 字段并**随链落盘**——重放不靠"猜当时的配置"，篡改重放输入同样会被链校验检出。
- 策略谓词不可序列化，契约里是声明式描述（`forbidden-substring` 等），重放器按声明重建。
- 反向测试：把 seq 1 的 category 篡改为 `config-review-fail`，重放立即 MISMATCH（日志 vs 重执行）并 exit 1。
- 已知边界：S6 的 `integrityCheck` 是注入钩子（框架默认恒真，G4 未闭合），重放仅验证分支可达性；`ledger_signal` 按信号序比对。
  孤儿判定自阶段 1 起改为 **target 引用匹配**（`target_seq` + `target_chain_hash` 前 16 位），并派生三态（未处置 / 观察中 / 已闭合）；
  台账不存在或链校验失败时**全部按未处置报告**（宁可多报孤儿，不用不可信记录掩盖缺口）。

## 目录

```
tools/audit-panel/
├── scenario/
│   ├── export-events.mts   ✅ V1：事件导出（七场景，零依赖，确定性，含重放规格落盘）
│   └── verify-chain.mts    ✅ 独立链验证（可检出篡改）
├── rules/
│   ├── replay.mts          ✅ 重放校验（独立重执行 + 孤儿信号清单）
│   └── rule-map.mts        ✅ category→规则映射表（V1/V2 共用的单一真相源，v2.56.0 从导出器抽出）
├── realagent/
│   ├── runner.mts          ✅ V2：真实 LLM Agent 主循环（三件套全程包裹，被拒行为留痕）
│   ├── llm.mts             ✅ OpenAI 兼容客户端（内置 fetch 零依赖；key 只读 env/.env，不入库）
│   ├── tools.mts           ✅ 本地确定性工具集（真实读写沙箱；全工具声明、白名单在门上收紧）
│   ├── scenarios.mts       ✅ 四个诱导场景（N1 越权 / N2 预算挤压 / N3 记忆 / N4 泄密）
│   └── workspace/          （运行沙箱，产物不入 git）
├── server/
│   └── server.mts          ✅ node:http 单文件（6 只读端点：timeline / realagent / disposition / evidence / boundaries / export）
├── web/
│   ├── index.html          ✅ 五视图单页（时间线 / real-agent 会话 / 处置台账 / 证据卡 / 诚实边界）
│   └── app.js              ✅ loadXxx / renderXxx 配对模式，零框架
├── data/
│   ├── events.jsonl        ✅ V1 产物（9 事件，确定性，入库作 golden）
│   └── realagent-events.jsonl ✅ V2 产物（LLM-in-the-loop，wall-clock，不可复现，meta 声明数据类别）
├── mapping/                ⬜ 条款映射已抽至 rules/rule-map.mts（mapping/ 目录预留，暂无独立文件）
└── README.md
```

处置台账**不在面板目录内**（职责分离：面板是展示与重放，台账是写入口），位于仓库级 `tools/disposition/`：

```
tools/disposition/
├── ledger.mts              ✅ 台账核心（键序冻结 / disp_seq 分配 / supersedes 更正 / 字段校验 / 三态派生）
├── verify-chain.mts        ✅ Node 验链（键序 · 链重算 · 序号连续 · 复核与更正规则）
├── verify_chain.py         ✅ Python 参照实现（纯标准库；第三方可独立复算）
├── gen-sample.mts          ✅ 20 行固定样本（门禁第 47 项的双语言夹具）
├── demo-converge.mts       ✅ 端到端演示（V1 三条孤儿 → 2 闭合 + 1 未闭合）
├── data/disposition.jsonl  ✅ 演示台账（actor 以 demo- 标注，非真实运维处置）
└── README.md               ✅ 链序列化规格 + 动作语义 + 边界
```

## 未实现（不要在别处声称已实现）

- 条款映射已外置为 [`mapping/tc260-3.0.json`](mapping/tc260-3.0.json)（含 `_meta.verification` 核验字段；条款号已逐条对照原文 p.38–45 核对）
- PDF 直出（当前路线：`/report` 打印友好 HTML + 浏览器 Ctrl+P；服务端 PDF 库不引入——破坏零依赖）
- V2 的**行为重放**（V2 事件不可复现，重放语义不成立；替代方案 = `verify-realagent.mts` 静态复核：拦截声明 vs 场景白名单常量 / 预算数值 / 产物终态）
- 面板页面的验证条为**服务启动时快照**，不实时刷新——数据是快照不是流

## 与框架的关系

本目录是「规范 + 参照实现 + 审计面板」三位一体的第三件，不是独立仓库。
改动 `index.ts` 的公共形状会破坏本目录（依赖点清单见 `export-events.mts` 文件头）。

> 本子目录 README 为中文单语，不纳入 `spec/` 的双语门禁范围。
