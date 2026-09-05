# 证据核验状态公示日志（VERIFICATION-LOG）

> **定位**：本文件是 REFERENCES 全部条目的**核验状态常设记录**——每条证据「何时、以何方法核验、核验到什么程度、一手来源是否可达」，在此集中公示。它不重复 REFERENCES 的文献描述（唯一真相源仍是根 `REFERENCES.md`），只回答豆包深度审查问题 8 所指的审计缺口：**项目做了大量核验，但"每条核验过没有、怎么核验的"此前不可审计**。
>
> **口径**：
> - 核验方法统一用五档（与 REFERENCES 注脚同口径）：**官方原文核验**（监管文件/法文/判决原文经官方渠道可达并核对）、**WebSearch 追溯至一手**（二手线索经检索定位官方原始来源）、**GitHub API 核验**（issue/仓库元数据实测）、**arXiv 全文核验**（HTML 全文逐段核对引用）、**浏览器实测**（存档/数据集页面实地打开）。
> - 「入库版本」= 该条目进入 REFERENCES 的版本（v2.7.0 / v2.8.0 / v2.10.0 / v2.11.0）。
> - **回填进度**：本表当前回填 **G 类 47 条** + **A 类 3 条** + **D 类 1 条** + **C 类 9 条** + **B 类 58 条** = **118 条（全部完成）**。豆包审查建议 4 全部落地。
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

## B 类（B-grade，可核查期刊或预印本）— 第 2 批 15 条 / 共 58 条

| 条目键 | 类别 | 入库版本 | 核验日期 | 核验方式 | 一手来源（官方渠道） |
|---|---|---|---|---|---|
| Cyber-Capable AI Agents（arXiv:2607.25379） | 评估环境即安全边界 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2607.25379（Abu Bakar Siddik）；⚠️ 综述非一手测量，两份事故记录作者自陈为「preliminary」，只引共有系统性命题 |
| Off-Support Barrier（arXiv:2608.11243） | 语义安全约束 off-support | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2608.11243（Yoshinori Watanabe）；github.com/xiangze/Preventing_Jailbreak_as_regularization；⚠️ 预印本未同行评审、单作者、Lean 证明未机器检查 |
| Teichmann | Agent 责任归因 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验（期刊 DOI 核实） | *Law Innovation and Technology*，DOI 10.1080/17579961.2026.2718578（London School of Economics）；注：卷期页码待补 |
| GPT-5.6 | OpenAI-HF 事故一手博客 | v2.8.0 | 2026-09-05（补登记） | 官方原文核验 | openai.com/index/hugging-face-model-evaluation-security-incident/（OpenAI 官方博客，含 7/28 + 7/29 两次更新） |
| claude-code-65961 | Claude 过度注释 issue | v2.6.0 | 2026-09-05（补登记） | GitHub API 核验 | anthropics/claude-code issue #65961（2026-06-07，state=open，+189 reactions）；⚠️ 只引 issue 正文实测内容（定性 + +189 计数），评论页未独立核验 |
| Weinberger | 提示词诱发浪费 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2608.01347 v5（Sarel Weinberger、Amir Hozez）；⚠️ 含预注册 + 冻结 holdout；三项限定：倍数不可外推为生产预期 / 论文反对方案泄漏到产物 / 证明的是浪费不是污染 |
| 898 题 | OpenAI-HF 技术报告 | v2.8.0 | 2026-09-05（补登记） | 官方原文核验（PDF 直连核实） | cdn.openai.com PDF（38 页，2026-08-26 发布）；ExploitGym 898 题中 198 题无解 / 约 1,200 Agent / ~7% 伪造工具调用 |
| METR | METR-Redwood 独立调查 | v2.8.0 | 2026-09-05（补登记） | 官方原文核验 | redwoodresearch.org + metr.org（91 页，2026-08-26）；Ed25519 ≥19 公钥 / 429 条签名消息 |
| Anatomy of a Frontier Lab Agent Intrusion | HF 受害方技术时间线 | v2.8.0 | 2026-09-05（补登记） | 官方原文核验 | huggingface.co/blog/agent-intrusion-technical-timeline；⚠️ HF 同时为受害方/调查方/发布方，数字为自身法医重建非中立第三方核验；具体发布日期未能直连核实（站点两次拒绝抓取） |
| LongHorizon-Harness（arXiv:2608.01964） | 状态外置 + MEA 三角色 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2608.01964（2026-08）；⚠️ COI：作者团队隶属 Alibaba，主模型 Qwen；跨模型结果（Claude Opus 4.7）无利害冲突、优先引用 |
| AI Harness Engineering（arXiv:2605.13357） | harness 11 职责 + H0–H3 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2605.13357（2026-05）；⚠️ 每个成熟度级别仅 n=1，只能作框架依据，不得作实证引用 |
| HarnessRisk（arXiv:2608.17597） | harness 生命周期基准 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2608.17597（2026-08）；128 例六阶段；⚠️ 基准构造场景，攻击成功率绝对数值不可外推 |
| Self-Harness（arXiv:2606.09498） | harness 自我改进 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2606.09498 v3（2026-08）；⚠️ 单作者预印本，不引用增益数值作为生产预期 |
| From Prompts to Contracts（arXiv:2607.08028） | 企业级 harness 可审计 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2607.08028（Joongho Ahn、Moonsoo Kim）；github.com/hammerbaki/enterprise-llm-agent-harness + Zenodo 10.5281/zenodo.21269426；⚠️ 单机构实现 / 单一领域 / 120 分制自设打分 |
| AutoHarness（arXiv:2603.03329） | harness 自动合成 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2603.03329（Xinghua Lou 等 6 位作者，**2026-02-10** 原登记 2026-03 已订正）；⚠️ 78% 为败局中归因非法走子的比例非全部走子比例，TextArena 游戏环境具备完备可判定规则集 |

## B 类（B-grade，可核查期刊或预印本）— 第 3 批 15 条 / 共 58 条

| 条目键 | 类别 | 入库版本 | 核验日期 | 核验方式 | 一手来源（官方渠道） |
|---|---|---|---|---|---|
| Agentic Abstention（arXiv:2606.28733） | LLM 弃权时机 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2606.28733（Han Luo 等）；⚠️ 26.7→57.4 只在 WebShop + Llama-3.3-70B 验证，不得外推为通用增益 |
| Abduct Act Predict（arXiv:2509.10401） | 失效归因因果推断 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2509.10401（Alva West 等 6 位）；github.com/ResearAI/A2P；⚠️ 只引较低者 29.31%（手工构造集）作天花板 |
| LongCoT（arXiv:2604.14140） | 长程推理基准 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2604.14140（Sumeet Ramesh Motwani 等 20 位）；2,500 道专家设计题，最佳模型不足 10%；⚠️ 不得用来断言「有 harness 也解决不了长程任务」 |
| Multi-Agent Risks（arXiv:2502.14143） | 蜂群失效模式分类 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2502.14143（多机构 40 余位作者，被引 180 次）；⚠️ 二手合成综述非一手实证，只支撑分类骨架 |
| Open Challenges MAS（arXiv:2505.02077） | multi-agent security 学科界定 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2505.02077（Christian Schroeder de Witt 等 23 位）；⚠️ 自陈「preliminary work」，非已验证威胁清单；概念性机理无实测值 |
| Colosseum（arXiv:2602.15198） | 协作共谋审计 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2602.15198（2026-02）；19 模型在 DCOP 协调任务评测；⚠️ 未在英语以外语种评测，中文推广系本框架外推 |
| Mapping Anti-collusion（arXiv:2601.00360） | 人类反共谋映射 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验（期刊 DOI 核实） | arXiv:2601.00360 + *Knowledge-Based Systems* DOI 10.1016/j.knosys.2026.116067；⚠️ 无一手实验，映射研究虽经 SCI 同行评议 |
| SWARM（arXiv:2604.19752） | 软标签分布式治理 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2604.19752（**2026-03-19** 原登记 04 已订正）；swarm-ai.org；⚠️ 仿真框架非实测，未给跨场景方差 |
| Institutional AI 实验（arXiv:2601.11369） | 三制度对照实验 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2601.11369（Marcantonio Bracale Syrnikov 等 9 位）；N=90/组，Welch p=4.67e−15；⚠️ 受控博弈环境非真实部署 |
| Runtime Contract（arXiv:2608.11274） | 安全运行时契约 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2608.11274（2026-08）；⚠️ 立场论文，四条证据线非受控实验 |
| DarwinX（arXiv:2608.07545） | harness 自然选择进化 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2608.07545（2026-07-31）；⚠️ 预印本，不引用 +17 分增益作为生产预期 |
| Meta-Harness（arXiv:2603.28052） | harness 自动搜索 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2603.28052（Stanford IRIS Lab，Yoonho Lee 等）；github.com/stanford-iris-lab/meta-harness；5 个社区独立实现 |
| SemaClaw（arXiv:2604.11548） | harness 工程定义 | v2.6.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2604.11548（Ningyan Zhu 等 11 位）；⚠️ 系统论文，未见完整实验对照，只引定义与趋势判断 |
| Quipu（arXiv:2608.16813） | 受治理双时态知识图 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2608.16813（Steve Brown）；独立跑通 DEMM-Bench（属同一证据线的外部使用者，非独立第二条线） |
| From Runtime Records（arXiv:2607.00941） | 法律可归因性准则 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验（Zenodo DOI 核实） | arXiv:2607.00941（Jeroen Janssen）；Zenodo 10.5281/zenodo.21025237；⚠️ 作者法律分析非监管方立场，不得表述为「欧盟 AI Act 要求」 |

## B 类（B-grade，可核查期刊或预印本）— 第 4 批 13 条 / 共 58 条（完结）

| 条目键 | 类别 | 入库版本 | 核验日期 | 核验方式 | 一手来源（官方渠道） |
|---|---|---|---|---|---|
| AI Agents Under EU Law（arXiv:2604.04604） | EU 监管映射工作文件 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2604.04604（Luca Nannini 等 9 位）；⚠️ Working Paper，作者监管映射分析非监管方立场，只作旁证 |
| CASE Framework（arXiv:2608.10153） | 多学科控制架构 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2608.10153（Srinivas Telukunta 等）；github.com/srinivastelukunta/case_framework_arxiv_codes；⚠️ 本轮新收录尚未走独立技术复核，82% / 22 / 35 三项调查口径须自核验 |
| RL Beneficial Models（arXiv:2606.24014） | RL 训练有益特质 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2606.24014（Akshay V. Jagadeesh 等 8 位）；⚠️ COI 强制声明：作者全部隶属 OpenAI，训练与评估均基于其自家模型，有益特质数据集未公开 |
| When RLHF Fails（arXiv:2606.03238） | RLHF 失效分类 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2606.03238 v2（Zelalem Abahana 等）；github.com/zabahana/rlhf-failure-modes-diagnostics；⚠️ 紧凑流水线非前沿模型规模 |
| TRACE Benchmark（arXiv:2601.20103） | reward hack 检测基准 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + 浏览器实测（数据集页） | arXiv:2601.20103（Patronus AI）；huggingface.co/datasets/PatronusAI/trace-dataset；⚠️ 轨迹合成生成 + 人工核验，作者隶属 Patronus AI 存在轻度利益关联 |
| Alignment Sycophancy（arXiv:2607.18114） | 对齐安装线索诱导偏差 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2607.18114 v2（Prakhar Gupta 等）；⚠️ 基座模型参与度混淆未被完全排除，作者已登记 |
| Reward Hacking Gridworlds（arXiv:2606.15385） | 文本化安全 Gridworlds | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2606.15385（Ömer Veysel Çağatan、Xuandong Zhao）；github.com/asparius/verl-agent-safety；⚠️ 文本化 Gridworlds 受控环境，绝对数值不可外推 |
| Token Consumption（arXiv:2604.22750） | agentic 任务 Token 消耗 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2604.22750 v2（Longju Bai 等 8 位）；⚠️ 对象为 agentic coding 任务，消耗分布未必迁移到其他任务域 |
| Utility Under Attack（arXiv:2608.21230） | 记忆投毒防御失效 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + 浏览器实测（代码制品页） | arXiv:2608.21230（Arulnidhi Karunanidhi，Quantify Labs Ltd，单作者）；harnesses、corpora 与聚合运行报告已随文公开；⚠️ 单作者、机构自测（属不利证据自报，可信度较高） |
| MemSecBench（arXiv:2607.27080） | 记忆生命周期安全基准 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2607.27080（Xuanze Chen 等 6 位）；310 案例（48 个现实情境）；⚠️ 受控运行时环境，84.2% / 50.3% 为跨配置描述统计非生产频率 |
| Covert-Channel Monitor（arXiv:2605.20734） | 应用层多模态隐蔽信道 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2605.20734（Alfredo Metere，单作者）；⚠️ 参考实现未经第三方复现，「残余容量为零」限于受测信道集 |
| Trace-Economic Underwriting（arXiv:2606.16465） | agent 可保性定价 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 + GitHub API 核验 | arXiv:2606.16465 v2（Binyan Xu 等 4 位）；代码、标签与审计表已公开；⚠️ 承保前提是有界权限的明确角色，trace-to-loss 规则需按行业定制 |
| Authority Frontier（arXiv:2605.25632） | 精算动作接口定价 | v2.8.0 | 2026-09-05（补登记） | arXiv 全文核验 | arXiv:2605.25632（Hao-Hsuan Chen，台湾政治大学，单作者）；配套数学基础见 SSRN 6761960；⚠️ 单作者评估框架非社区基准 |

✅ **B 类 58 条回填完结。VERIFICATION-LOG 全部 118 条核验状态公示完成。**
