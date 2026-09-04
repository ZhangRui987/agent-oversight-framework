# 证据核验状态公示日志（VERIFICATION-LOG）

> **定位**：本文件是 REFERENCES 全部条目的**核验状态常设记录**——每条证据「何时、以何方法核验、核验到什么程度、一手来源是否可达」，在此集中公示。它不重复 REFERENCES 的文献描述（唯一真相源仍是根 `REFERENCES.md`），只回答豆包深度审查问题 8 所指的审计缺口：**项目做了大量核验，但"每条核验过没有、怎么核验的"此前不可审计**。
>
> **口径**：
> - 核验方法统一用五档（与 REFERENCES 注脚同口径）：**官方原文核验**（监管文件/法文/判决原文经官方渠道可达并核对）、**WebSearch 追溯至一手**（二手线索经检索定位官方原始来源）、**GitHub API 核验**（issue/仓库元数据实测）、**arXiv 全文核验**（HTML 全文逐段核对引用）、**浏览器实测**（存档/数据集页面实地打开）。
> - 「入库版本」= 该条目进入 REFERENCES 的版本（v2.7.0 / v2.8.0 / v2.10.0 / v2.11.0）。
> - 本表当前回填 **G 类 47 条**（治理/政策/执法一手实证，核验路径最完整可查）；B/C/D/A 类 69 条标「待逐条回填」，其段落级 ⚠️ 注记仍以 REFERENCES 为准。
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
