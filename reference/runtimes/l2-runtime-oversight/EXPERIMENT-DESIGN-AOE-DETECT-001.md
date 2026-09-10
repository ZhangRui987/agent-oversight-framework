> **入库说明**：本文档为 AOE-DETECT-001 的预注册设计文档，2026-09-10 落档于维护者工作区（`G9实验设计_v1.md`），先于实验执行冻结。实验执行后按预注册纪律**原样入库**（未修改任何预注册内容）；执行偏差的如实登记见 `CALIBRATION-REPORT-CONFIG-REVIEWER.md` §6。

# G9 配置内容审查检出率实验设计（预注册 v1）

> 制定日期：2026-09-10
> 实验编号（预分配）：**AOE-DETECT-001**
> 被测对象：`reference/runtimes/l2-runtime-oversight/index.ts` 的 `ConfigReviewer`（DEFAULT_CHECKS 五项，L719–L768）
> 动机：豆包审查建议 8（核心机制 A 级复现，最高优先级）+ 建议 11（打破连续 14 版无代码回归）；推进规划 §七 MRV 验证线首个落地实验
> **预注册纪律**：本文档落档后，假设、样本构造规则、判定标准不再修改；执行中如发现设计缺陷，在实验报告「偏差记录」一节如实登记，不回改本文档。

---

## 一、研究问题

RQ1：`ConfigReviewer` 五项确定性检查对其**设计目标形态**的恶意配置（直检正例）检出率（TPR_direct）是多少？

RQ2：对**已声明的生产级差距类变体**（键名变体 / 值形态变体 / 编码与结构变体）的检出率（TPR_variant）是多少？——把 PRODUCTION-GAPS.md G9「生产级仍需语义级配置 schema 与意图分析」的定性差距**量化为数字**。

RQ3：良性配置对照集（含 tricky 子集）的误报率（FPR）是多少？

## 二、被测对象事实底座（2026-09-10 逐行核验 index.ts）

| 检查项 | 规则实现（L719–L767 已核验） | 结构性覆盖边界（从规则静态可推） |
|---|---|---|
| ① inline-credential | 对整个 config（string 或 JSON.stringify 结果）做正则：`["']?(?:password\|passwd\|api[_-]?key\|secret\|token\|private[_-]?key)["']?\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{8,}`（i） | 全文扫描→对嵌套免疫；键名子串敏感（client_secret 命中 secret）；值字符类不含 `$`/空格 |
| ② share-scope-widened | 顶层 `visibility ?? share ?? shareWith ?? accessLevel` ∈ {public, *, all, org-wide, everyone} 严格全等 | 仅顶层固定键名 + 精确小写值 |
| ③ approval-disabled | 顶层 `requireApproval ?? approvalRequired ?? reviewRequired ?? requireReview` ∈ {false, 0, 'false', 'no', 'off'} | 同上；注意 'disabled' 不在 ③ 的值集合 |
| ④ gateway-publicized | 顶层 `gateway ?? endpoint ?? host`；命中 `0.0.0.0` / `*` / `^https?:\/\/(?!127.\|localhost\|10.\|192.168.\|172.(1[6-9]\|2\d\|3[01]).)[a-z0-9.-]+\.[a-z]{2,}` | IP 字面量（数字 TLD）不匹配；无 scheme 主机名不匹配；.local/.internal 内网域名会被误判为公网 |
| ⑤ redaction-weakened | 顶层 `redact ?? redaction ?? pii ?? mask` ∈ {false, 0, 'off', 'none', 'disabled'} | 同 ②③ |

`review()` 语义（L694–L708）：命中任意一项即 fail；检查规则自身抛错视为未命中（fail-open，已在代码注释声明，生产应 fail-closed）。

## 三、样本集构造规则（预注册，共 130 例）

构造原则：V 类（变体）样本**全部对应** PRODUCTION-GAPS.md G9 已声明的生产级差距（命名混淆 / 编码混淆 / 间接引用 / 语义级理解缺失），不构造 G9 未声明范围内的攻击形态——本实验测的是「已声明规则集的覆盖边界」，不是对实现的不公平攻击。

| 类别 | 定义 | ① | ② | ③ | ④ | ⑤ | 小计 |
|---|---|---|---|---|---|---|---|
| D 直检正例 | 设计目标形态（demo [19] 同型），预期 block | 10 | 10 | 10 | 10 | 10 | 50 |
| V1 键名变体 | 同语义不同键名（pwd/passphrase/credentials；access/autoApprove/masking；公网 IP 字面量目标等） | 8 | 6 | 6 | 6 | 6 | 32 |
| V2 值形态变体 | 键名正确、值形态在集合外（'Public' 大写 / 'disabled' 给③ / 带空格 / `${ENV}` 间接 / IP 字面量 / 无 scheme 域名） | 6 | 5 | 5 | 5 | 5 | 26 |
| V3 编码/结构变体 | base64/hex 整体 blob、unicode 转义键、值内拼接；②③⑤ 嵌套一层；④ IPv6 字面量 | 8 | 4 | 4 | 2 | 4 | 22 |
| B 良性对照 | 常规运维配置 20 + tricky 10（文档含示例密码、token_budget 长数字、.local 网关带 scheme、redact:'partial'、mask:'on'、visibility:'team'、requireApproval:'yes'、内网 10.x、password_requirements 文档字段、corp 域名） | — | — | — | — | — | 30 |

每个样本登记：`id / target rule / category / config / expected(block|pass)`。预期判定在脚本中与样本同源公开（预注册的样本级预期），运行结果与预期逐条比对。

## 四、指标定义

- **TPR_direct**（每检查项 + 汇总）：D 类样本中被 `review()` 判 fail 的比例
- **TPR_variant**（按 V1/V2/V3 分层 + 每检查项 + 汇总）：V 类样本中被判 fail 的比例；**逐样本记录实际命中的规则名**（允许被其它规则命中——如嵌套 ③ 样本可能被 ① 的全文扫描误命中，须如实记录）
- **FPR**（汇总 + tricky 子集单独报告）：B 类样本中被判 fail 的比例，并记录命中规则

- 全部为**确定性精确计数**（规则无随机性）——本实验是覆盖率枚举范式，与 AOE-CALIB-001/002 的统计标定范式不同，不涉及置信区间

## 五、预注册假设与判定标准

| # | 假设 | 判定标准 |
|---|---|---|
| H1 | 五项直检 TPR 均为 100% | 50/50 全命中（确定性规则对其设计形态；若 <100% 即发现实现缺陷，如实报告） |
| H2 | 变体检出率显著低于直检，覆盖边界与规则结构一致 | 预注册预期：②③⑤ 对 V1/V2/V3 检出率 ≈ 0%（固定键名+严格全等+顶层限定）；① 对 V2/V3 ≈ 0%（`${ENV}`/编码/空格均在字符类外）、对 V1 部分检出（子串敏感性：credentials 不命中、client_secret 型命中）；④ 对 V2（IP 字面量/无 scheme）= 0% |
| H3 | FPR ≤ 10% 且误报集中可解释 | 30 例良性总误报 ≤ 3；tricky 子集预注册预期：.local 带 scheme 网关（④ 正则无内网域名排除）与文档含示例密码（① 全文扫描）**可能**误报——命中即如实报告为规则设计取舍，不判为缺陷 |
| A 级资格 | 产出可登记为 A 级证据（建议定级，最终由维护者核） | 四要素：预注册先行（本文档）+ 脚本零依赖入库可重跑 + 逐样本原始结果公开 + 限定语如实（见 §六） |

## 六、诚实边界（预注册）

1. 样本为**构造合成集**：检出率仅在本异常集分布内有效，**不可外推**为「对任意真实攻击的检出率」。
2. 本实验测的是**已声明的确定性规则集的覆盖边界**，不是「配置内容审查的理论上限」——ConfigReviewer 自我声明为语义演示。
3. 变体低检出率**不是新发现的缺陷**：对应差距已登记于 PRODUCTION-GAPS.md G9（生产级需语义级配置 schema 与意图分析）；本实验把该定性差距**量化**。
4. 实验零 AI 参与、零外部依赖（Node 内置 + index.ts），可在任何 Node ≥22 环境重跑。
5. fail-open 语义（规则抛错视为未命中）在样本集内不触发（全部样本为合法 JSON 结构），不构成本实验变量。

## 七、复现方式

```bash
cd reference/runtimes/l2-runtime-oversight
node --experimental-transform-types calibrate-config-reviewer-detection.mts
```

输出：逐样本判定明细（id / category / target / expected / actual / findings）+ 分层汇总表。脚本内嵌全部 130 样本与样本级预期（预注册同源）。

## 八、结果反哺计划

1. `CALIBRATION-REPORT-CONFIG-REVIEWER.md`（实验编号 AOE-DETECT-001，格式对齐 001/002）
2. `REFERENCES.md` +1 条 A 级（【键： AOE-DETECT-001】，带限定语）
3. `spec/11-traceability.md` +1 行 CAE（「确定性规则对声明变体类的覆盖边界可实测」）
4. `spec/02-architecture.md` 配置权即攻击面节补检出率实证锚点
5. `PRODUCTION-GAPS.md` G9 更新：演示级闭合声明附检出率数字，生产级差距从定性变定量
6. README 双语证据计数 165→166（A:3→4）；verify_consistency.py 计数同步；VERSION/CHANGELOG/CITATION → v2.32.0
