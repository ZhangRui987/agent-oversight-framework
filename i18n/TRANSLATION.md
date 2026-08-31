# English Translation Tracker

> 本仓库有意以中文撰写（面向中文读者、对接国内监管框架），但治理方法与语言无关。
> 本文件跟踪英文翻译工作，对应 **Issue #1**。

## Why

This repository is authored in Chinese — deliberately. It aims to be the first structured **Chinese-language** governance specification for AI agent oversight, aligned with domestic regulatory frameworks (TC260《人工智能安全治理框架》2.0、《生成式人工智能服务管理暂行办法》、《人工智能生成合成内容标识办法》、《网络安全法》第二十条).

But the substance is language-independent: evidence grading (A/B/C/D), swarm governance mechanisms, the evidence-integrity subsystem, and the voluntary-abstention exit are useful far beyond the Chinese-speaking community.

## Scope & Priority

| # | Target | Priority | Status |
|---|---|---|---|
| 1 | `README.md` → `README.en.md` | **P0** | ✅ Done（v1.1.0 基线，2026-08-31） |
| 2 | `spec/01-principles.md`（六条总纲 + 十个核心判断） | P1 | ✅ Done（2026-08-31） |
| 3 | `spec/03-grading.md`（G×S 二维分级） | P1 | ✅ Done（2026-08-31） |
| 4 | `spec/07-swarm-governance.md`（蜂群治理） | P1 | ✅ Done（2026-08-31） |
| 5 | `spec/08-evidence-integrity.md`（证据完整性子系统 E1–E5） | P1 | ✅ Done（2026-08-31） |
| 6 | `spec/13-boundaries.md`（诚实边界 + 回灌检查清单） | P2 | ✅ Done（2026-08-31） |
| 7 | 其余 `spec/*.md`（02/04/05/06/09/10/11/12） | P2 | ✅ Done（2026-08-31） |
| 8 | 治理文件（`CONTRIBUTING.md`、`GOVERNANCE.md` 等 12 个） | P3 | ✅ Done（2026-08-31） |
| 9 | 不在译文范围：`STYLE.md`（中文写作规范）、`CHANGELOG.md`（动态变更日志）、`REFERENCES.md`（引注唯一真相源）、`NOTICE`（法律文件） | — | 有意不译（见「Scope & Priority」注） |

## Translation principles

1. **术语一致性** — 见 `STYLE.md`。建议映射：

   | 中文 | English |
   |---|---|
   | 执行与监察体系 | Execution & Oversight Framework |
   | 交白卷出口 | Voluntary Abstention Exit |
   | 证据分级 A/B/C/D | Evidence Grading A/B/C/D — **等级字母不翻译** |
   | 去中心化蜂群 / 狼群 | Decentralized swarm / wolf-pack |
   | 回灌检查清单 | Back-propagation checklist |
   | 三号公证机 | Notary (third party) |
   | 看门狗 | Watchdog |
   | 影子比 | Shadow ratio |

2. **翻译就是翻译** — 不在译文中静默"改进"规范。实质性修改走 `spec-change` 流程。
3. **证据等级与引注保持原样**（arXiv / DOI / URL 不变）。翻译时不得顺手重新定级——请用 `evidence-correction` 模板单独提出。
4. **译文文件显式命名**：`README.en.md`、`spec/07-swarm-governance.en.md` 等。

## How to contribute

1. 在 Issue #1 下方认领文件（一次一个，先到先得）；
2. 提交标题带 `[i18n]` 前缀的 PR；
3. 在 PR 描述中链接本文件与 Issue #1。

> **不在译文范围**：`STYLE.md` 是面向中文写作的规范（术语表、编号规则），翻译会失去其作为「中文文档风格基准」的用途；`CHANGELOG.md` 为动态变更日志，翻译后必然失同步；`REFERENCES.md` 是引注唯一真相源（中英条目混合、含 URL），翻译会引入双源漂移风险；`NOTICE` 为法律性版权声明，保持原样。

译者将列入 `CHANGELOG.md` 与发布说明致谢。
