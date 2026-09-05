# 证据核验状态公示日志（VERIFICATION-LOG）

> **定位**：本文件是 REFERENCES 全部条目的**核验状态常设记录**——每条证据「何时、以何方法核验、核验到什么程度、一手来源是否可达」，在此集中公示。它不重复 REFERENCES 的文献描述（唯一真相源仍是根 `REFERENCES.md`），只回答豆包深度审查问题 8 所指的审计缺口：**项目做了大量核验，但"每条核验过没有、怎么核验的"此前不可审计**。
>
> **口径**：
> - 核验方法统一用五档（与 REFERENCES 注脚同口径）：**官方原文核验**（监管文件/法文/判决原文经官方渠道可达并核对）、**WebSearch 追溯至一手**（二手线索经检索定位官方原始来源）、**GitHub API 核验**（issue/仓库元数据实测）、**arXiv 全文核验**（HTML 全文逐段核对引用）、**浏览器实测**（存档/数据集页面实地打开）。
> - 「入库版本」= 该条目进入 REFERENCES 的版本（v2.7.0 / v2.8.0 / v2.10.0 / v2.11.0）。
> - **回填进度**：本表当前回填 **G 类 47 条** + **A 类 3 条** + **D 类 1 条** + **C 类 9 条** + **B 类 15 条** = **75 条**；剩余 **B 类 43 条** 待回填（v2.15.2 本轮清零 A/D/C + B 类第 1 批）。
> - 回填日期口径：核验实际发生于入库版本日，**本次为补登记**——日期列填「2026-09-05（补登记）」，核验方式保留入库时实际采用的方法；段落级 ⚠️ 注记仍以 REFERENCES 为唯一真相源。
> - 任何条目核验状态变化（升级/降级/来源替换）须同步更新本表并写入 CHANGELOG——这是 evidence-correction 机制的落地配套。

| 条目键 | 法域/类别 | 入库版本 | 核验日期 | 核验方式 | 一手来源（官方渠道） |
|---|---|---|---|---|---|
| cn-clear-2026 | CN 执法 | v2.7.0 | 2026-09-04 | 官方原文核验 | cac.gov.cn 清朗专项行动通知原文 |
| cn-label-2025 | CN 执法 | v2.7.0 | 2026-09-04 | 官方原文核验 | cac.gov.cn 查处通告原文 |
| cn-shanghai-2025 | CN 执法 | v2.7.0 | 2026-09-04 | 官方原文核验 | 上海市网信办官方通告 |
| cn-ac-criminal-2026 | CN 司法 | v2.7.0 | 2026-09-04 | 官方原文核验（法院公告；二审未宣判只引一审） | 涉案法院公告 |
| us-rite-aid-2024 | US 执法 | v2.7.0 | 2026-09-04 | 官方原文核验 | FTC 和解令（ftc.gov 案件页 2223017） |
| us-fda-cgmp-2026 | US 监管 | v2.7.0 | 2026-09-04 | 官方原文核验 | FDA Warning Letter（fda.gov） |
| us-eeoc-itutor-2023 | US 执法 | v2.7.0 | 2026-09-04 | 官方原文核验 | EEOC v. iTutorGroup 和解（eeoc.gov） |
| us-waymo-bus-2025 | US 监管 | v2.7.0 | 2026-09-04 | 官方原文核验 | NHTSA 召回报告 25E084 |
| us-ai-comply-2024 | US 执法 | v2.7.0 | 2026-09-04 | 官方原文核验 | FTC「Operation AI Comply」新闻稿 |
| eu-garante-openai-2024 | EU 执法 | v2.7.0 | 2026-09-04 | 官方原文核验 | 意大利 Garante 处罚决定 |
| eu-ai-act-2026 | EU 立法 | v2.7.0 | 2026-09-04 | 官方原文核验 | EUR-Lex Regulation (EU) 2024/1689 |
| sg-mgf-aa-2026 | SG 政策 | v2.7.0 | 2026-09-04 | 官方原文核验 | 新加坡 IMDA Model AI Governance Framework |
| kr-ai-act-2026 | KR 立法 | v2.7.0 入库 / v2.11.0 来源升级 | 2026-09-04 | 官方原文核验 + 来源升级（二手商业翻译 → law.go.kr 官方法文 + CSET 官方授权英译） | law.go.kr Act No. 20676 + CSET Georgetown 英译 PDF |
| kr-dmpa-2025 | KR 立法 | v2.11.0 | 2026-09-04 | 官方原文核验 | law.go.kr 官方法文 + MFDS IMDRF 监管更新 PDF |
| iso-42001-2023 | 国际标准 | v2.7.0 | 2026-09-04 | 官方原文核验 | ISO/IEC 42001:2023 标准文本 |
| owasp-six-nation-2026 | 国际指南 | v2.7.0 | 2026-09-04 | 官方原文核验 | OWASP Agentic Security Top 10 + 六国联合指南 |
| cn-wuhan-ai-news-2025 | CN 执法 | v2.8.0 | 2026-09-04 | 官方原文核验 | 武汉市公安局官方通告 |
| cn-chongqing-2024 | CN 执法 | v2.8.0 | 2026-09-04 | 官方原文核验 | 重庆市网信办官方通告 |
| cn-qingyun-80w | CN 司法 | v2.8.0 | 2026-09-04 | 官方原文核验（判决） | 庆余年案法院判决 |
| cn-export-2025 | CN 政策 | v2.8.0 | 2026-09-04 | 官方原文核验 | 商务部出口管制清单公告 |
| us-workado-2025 | US 执法 | v2.8.0 | 2026-09-04 | 官方原文核验 | FTC v. Workado（ftc.gov 法律库） |
| us-ngl-2024 | US 执法 | v2.8.0 | 2026-09-04 | 官方原文核验 | FTC v. NGL Labs 和解（ftc.gov） |
| us-eeoc-workday-2024 | US 执法 | v2.8.0 | 2026-09-04 | 官方原文核验 | EEOC v. Workday 法庭之友意见书 |
| us-colorado-2024 | US 州立法 | v2.8.0 | 2026-09-04 | 官方原文核验 | Colorado SB 24-205（leg.colorado.gov） |
| us-illinois-2026 | US 州立法 | v2.8.0 | 2026-09-04 | 官方原文核验 + v2.10.1 来源升级 | ilga.gov Public Act 103-0804 |
| us-illinois-frontier-2026 | US 州立法 | v2.8.0 | 2026-09-04 | 官方原文核验 | Illinois 前沿 AI 治理法案 |
| eu-rome-annul-2026 | EU 司法 | v2.8.0 | 2026-09-04 | 官方原文核验 | 罗马法院撤销判决 |
| eu-replika-2025 | EU 执法 | v2.8.0 | 2026-09-04 | 官方原文核验 | 意大利 Garante v. Replika 罚款决定 |
| uk-clearview-2025 | UK 执法 | v2.8.0 | 2026-09-04 | 官方原文核验 | 英国 ICO v. Clearview 罚款 |
| uk-blueprint-2025 | UK 政策 | v2.8.0 | 2026-09-04 | 官方原文核验 | GOV.UK AI 监管蓝图公告 |
| ca-thaler-dabus-2025 | CA 司法 | v2.8.0 | 2026-09-04 | 官方原文核验 | 加拿大专利上诉委员会裁决 |
| int-oecd-unesco | 国际组织 | v2.8.0 | 2026-09-04 | 官方原文核验 | OECD AI Principles（2019/2024）+ UNESCO 文件 |
| int-gpai-2020 | 国际组织 | v2.8.0 | 2026-09-04 | 官方原文核验 | GPAI 官方文件 |
| jp-ai-promotion-2025 | JP 立法 | v2.8.0 | 2026-09-04 | 官方原文核验 | 日本官报法文 |
| au-robodebt-2023 | AU 调查 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | robodebt.royalcommission.gov.au 最终报告 |
| int-g7-hiroshima-2023 | 国际组织 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | G7 领导人声明 + soumu.go.jp 官方 PDF |
| int-imdrf-n67-n88 | 国际标准 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | imdrf.org N67（2022）/ N88（2025） |
| uk-ai-playbook-2025 | UK 政策 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | gov.uk AI Playbook（DSIT） |
| us-aclu-hirevue-2025 | US 投诉 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | aclu.org 官方新闻稿 + FTC 投诉 |
| us-ca-sb942-2024 | US 州立法 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | leginfo.legislature.ca.gov SB 942 |
| us-fda-pccp-2024 | US 监管 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | fda.gov PCCP 指南（2024-08/12） |
| us-kadrey-v-meta-2023 | US 诉讼 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | N.D. Cal. 3:23-cv-03417 |
| us-nhtsa-waymo-2024 | US 监管 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | nhtsa.gov 召回 24E-049 / 25E-034 |
| us-nyc-ll144-2021 | US 市立法 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | legistar.council.nyc.gov Local Law 144 |
| us-nyt-v-openai-2023 | US 诉讼 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | SDNY 1:23-cv-11195 |
| us-sec-ai-washing-2024 | US 执法 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | sec.gov 执法公告 + 和解令 |
| us-tx-traiga-2025 | US 州立法 | v2.10.0 | 2026-09-04 | WebSearch 追溯至一手 | Texas Legislature Online HB 149 |

---

## A 类（A-grade，一手 / 可核查实证）— 3 条

| 条目键 | 类别 | 入库版本 | 核验日期 | 核验方式 | 一手来源（官方渠道） |
|---|---|---|---|---|---|
| Sandlock | 容器隔离 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2605.26298（Cong Wang, Yusheng Zheng）；github.com/multikernel/sandlock（Apache-2.0） |
| AOE-CALIB-002 | 阈值标定（自复现） | v2.15.0 | 2026-09-05（补登记） | 浏览器实测（脚本复现） | 本仓库 `reference/runtimes/l2-runtime-oversight/calibrate-periodic-threshold.mts` + `calibrate-periodic-sensitivity.mts` + `CALIBRATION-REPORT-PERIODIC.md`；数据集与方法论同产（张金瑞，单作者） |
| AOE-CALIB-001 | 阈值标定（自复现） | v2.14.0 | 2026-09-05（补登记） | 浏览器实测（脚本复现） | 本仓库 `reference/runtimes/l2-runtime-oversight/calibrate-shadow-ratio.mts` + `calibrate-shadow-ratio-llm.mts` + `CALIBRATION-REPORT.md`；路径 B 智谱 GLM-4 API（c7a72b70… key 已轮换，见 ⚠️ 注记） |

⚠️ **AOE-CALIB-001/002 共同限定**：两条均为本仓库自产 A 级证据，严格支撑范围已在 REFERENCES.md 逐条声明——AOE-CALIB-001 仅支撑影子比标定方法 + 两个标定值（监察操作级 1.80 / Agent 任务级 1.36），AOE-CALIB-002 仅支撑间隔方差阈值标定方法 + 推荐值 10000ms²；二者**均不支撑**「该阈值适用于所有 Agent 任务」。核验方式说明：「浏览器实测」指脚本在本机 Node.js 22 运行并复核结果，而非第三方独立复现——诚实边界已在 spec/10 实证段登记。

## D 类（D-grade，待核实 / 利益关联）— 1 条

| 条目键 | 类别 | 入库版本 | 核验日期 | 核验方式 | 一手来源（官方渠道） |
|---|---|---|---|---|---|
| Mitchell-2026-04 | Agent 逃逸（降级） | v2.6.0 入库 / v2.10.0 降级 | 2026-09-05（补登记） | arXiv 全文核验（含降级审查） | arXiv:2604.23425（R. J. Mitchell，AuraSpark Technologies LLC） |

⚠️ **降级理由（已在 REFERENCES.md 段落级注记）**：① 作者机构为小型商业公司（AuraSpark Technologies LLC），非学术机构；② 论文自述其已公开专利组合覆盖所提要求，结论与作者专利存在利益关联；③「698 起 scheming 事件」引自 CLTR 二手统计而非论文自身实证。威胁模型一章已改用 Anthropic 官方红队博客（【键: Glasswing】）等可核查来源。该条目在以 A/B 级材料交叉印证前，**不支撑任何机制与 P0 硬约束**。

## C 类（C-grade，可信但存在域迁移缺口 / 二手转述）— 9 条

| 条目键 | 类别 | 入库版本 | 核验日期 | 核验方式 | 一手来源（官方渠道） |
|---|---|---|---|---|---|
| AIprint（arXiv:2607.14434） | 沙箱环境可探测性 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2607.14434（Zhiyong Sui 等 7 位作者）；⚠️ 域迁移：评估对象为恶意软件分析沙箱（ANY.RUN / CAPEv2 / Cuckoo），**非 AI Agent 执行栈**，论证方向相反 |
| SABSA（IEEE IoT Journal） | 安全架构流水线 | v2.10.0 入库 / v2.11.0 据 B→C 降级 | 2026-09-05（补登记） | 官方原文核验（IEEE Xplore 页面核实） | IEEE IoT Journal DOI 10.1109/JIOT.2026.3717946；⚠️ Early Access、DistilGPT-2 微型模型 + 模拟对抗向量 + 仅直接注入三重限定；数值不引用 |
| Institutional AI（arXiv:2601.10599） | 蜂群对齐漂移 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2601.10599（Federico Pierucci 等 9 位作者）；⚠️ 立场论文（无一手实验），与 arXiv:2601.11369 实验论文区分 |
| HarnessCard（Preprints.org） | Harness 披露卡 | v2.10.0 | 2026-09-05（补登记） | 官方原文核验（Preprints.org DOI 核实） | DOI 10.20944/preprints202603.1756.v1；11 字段已逐字核对该文附录 Table A5；⚠️ 作者自陈无受控消融，C 级仅作披露要求，不设合格线 |
| DEMM-Bench（arXiv:2606.20634） | 证据充分性基准 | v2.10.0 | 2026-09-05（补登记） | arXiv 全文核验 + 浏览器实测（Zenodo + HuggingFace 数据集页） | arXiv:2606.20634；Zenodo `10.5281/zenodo.20426092`（v0.1.1，2026-09-02 实测可下载）；HuggingFace `dev404ai/DEMM-Bench`（2026-09-02 实测 64 行 × 8 regime）；⚠️ 75% / 50% / 56.25% 三个数字为「按构造为真」，不得作真实系统实测频率引用 |
| DES（arXiv:2604.09296） | 决策事件 schema | v2.10.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2604.09296（Oleg Solozobov）；github.com/governance-evidence/decision-event-schema；⚠️ 5 个示例全部为事后手写，与 DEMM-Bench 同一作者，不得加总 |
| AIREP（arXiv:2608.21363） | 决策证据协议 | v2.10.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2608.21363；⚠️ COI：署名 Phionyx Research / founder@phionyx.ai，唯一 producer 为作者自有系统；只采纳 scope.does_not_cover 字段设计 |
| SDB-Runtime（arXiv:2605.20173） | 运行时架构模式 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2605.20173；⚠️ replay divergence 从未被测量（只命名 + 诊断步骤），可靠性分解 y(t)=μt+σξ(t) 作者自陈为「隐喻而非推导模型」 |
| GAIE（arXiv:2606.22484） | 分级人工监督 | v2.8.0 入库 / v2.11.0 引用红线收紧 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2606.22484；⚠️ 引用红线：声称的编码速度保留率为 18 个自设参数算出的解析估计（论文自陈 analytical approximations, not empirical measurements），**该数字不得以任何形式引用** |

⚠️ **C 类共同限定**：9 条均存在不同程度的域迁移缺口或概念采纳限定（详见 REFERENCES.md 段落级 ⚠️ 注记），**均不单独支撑 P0 硬约束**，须配 A/B 级材料方可引用。

## B 类（B-grade，可核查期刊或预印本）— 第 1 批 15 条 / 共 58 条

| 条目键 | 类别 | 入库版本 | 核验日期 | 核验方式 | 一手来源（官方渠道） |
|---|---|---|---|---|---|
| Glasswing | Anthropic 2026-04 事故 | v2.6.0 | 2026-09-05（补登记） | 官方原文核验 + WebSearch 追溯至一手 | red.anthropic.com/2026/mythos-preview/（官方红队博客）+ Project Glasswing 发布公告（2026-04-07）+ 科技日报 / 中国科技网 / 澎湃新闻 交叉印证 |
| AI Sandboxes（arXiv:2606.18532） | 沙箱威胁模型 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2606.18532（Inderjeet Singh 等 3 位作者）；⚠️ 保证导向框架性论述，六维未给出经实证标定的阈值 |
| AI Sandbox Tech Report（arXiv:2608.02679） | 多租户沙箱架构 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2608.02679（Muhammad Waseem 等 11 位作者）；⚠️ 技术报告，无对照实验、无第三方评估，属架构可行性证据而非有效性证据 |
| Zhiyuan Wan | 容器沙箱规则挖掘 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验（期刊 DOI 核实） | *Empirical Software Engineering* 24(6):4034–4070，DOI 10.1007/s10664-019-09737-2；⚠️ 引用红线：系统调用覆盖率 96.4%–99.8% 为估计值且附两项不成立假设，**不得引作采集覆盖率预期** |
| Dzhaliuk | 提示注入检测比较 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验（期刊 DOI 核实） | *International Journal of Information Security* 25(4):109，DOI 10.1007/s10207-026-01264-8（CC BY 4.0）；⚠️ 三项限定：摘要无具体检测率数值 / 均衡基准不可外推 / 提示文本分类非工具调用序列 |
| Kusne | 多 Agent 材料实验室 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验（期刊 DOI 核实） | *Communications Materials* 7:173，DOI 10.1038/s43246-026-01219-5（CC BY 4.0）；⚠️ Perspective 无实测数据，附 NIST 免责声明 |
| GEN-RWD | 医疗分布式分析公证 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验（期刊 DOI 核实） | *BMC Medical Informatics and Decision Making* 24(1):170，DOI 10.1186/s12911-024-02549-5（CC BY 4.0）；⚠️ 沙箱对数据与任务不可知，不由平台自动处理偏倚 |
| Gipiškis（arXiv:2410.23472） | GPAI 风险源目录 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2410.23472（Gipiškis 等）；自陈 descriptive, self-contained and neutral，本体系据此避免分层设计阶段引入特定法域路径依赖 |
| Mahmutovic | EU AI Act 监管沙盒 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验（期刊 DOI 核实） | *International Journal of Law and Information Technology* Vol 33, 2025, eaaf028，DOI 10.1093/ijlit/eaaf028（Al Yamamah University 法学院） |
| AI Code Sandboxes（arXiv:2606.08433） | AI 沙箱引擎级比较 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2606.08433（George Andronchik、Pavel Lokhmakov）；github.com/orbitalab/RnD-ai-sandboxes-sec-study-part-1（Apache-2.0）；⚠️ 三项限定：不提出总排名 / Part 1 只覆盖引擎级 / 0 CVE 代表测量缺失 |
| Gonzalez Torres | 公共部门 AI 沙盒 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验（期刊 DOI 核实） | *The Review of Socionetwork Strategies* 17(2):297–318，DOI 10.1007/s12626-023-00146-y；⚠️ 作者自陈框架尚未经验证，只引问题域不引成效主张 |
| Buscemi | AI 监管沙盒操作化 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2509.25256 v4（A. Buscemi 等 6 位作者）；⚠️ 勘误：v1 旧标题「Sandbox Configurator」已按 v4 实际标题更正 |
| AgentAbstain（arXiv:2607.10059） | LLM 弃权能力 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2607.10059（伊利诺伊大学厄巴纳-香槟分校）；263 组配对任务 / 42 个沙箱 / 8 类弃权场景 |
| When Autonomy Goes Rogue（arXiv:2507.14660） | 多 Agent 共谋仿真 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2507.14660（上海交通大学 + 上海人工智能实验室，Qibing Ren 等）；github.com/renqibing/MultiAgent4Collusion（Apache-2.0） |
| Zaidi | OpenAI-HF 事故案例研究 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验（SSRN DOI 核实） | DOI 10.2139/ssrn.7181179（SSRN Electronic Journal）；⚠️ 三项限定：事实基础与本体系同一批来源不得作独立佐证 / 9 页工作论文未经同行评审 / 监管框架判断为作者个人分析 |
