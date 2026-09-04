# 贡献指南

## 快速开始

1. Fork 本仓库；
2. 创建分支：`git checkout -b feat/your-change`；
3. 提交时使用 `git commit -s`（Developer Certificate of Origin）；
4. 提交 PR（模板见 `.github/PULL_REQUEST_TEMPLATE.md`）。

### 提交前必跑：一致性校验（pre-commit）

本仓库自带发布一致性校验（`scripts/verify_consistency.py`，34 项：表格格式 / 证据分级数量（A–G 五级，含 G 类管辖前缀）/ 事故数字口径 / 章节号 / 术语口径 / 双向引用检查 / 引用键质量 / 核验日志键集同步）。启用方式（仓库根目录执行一次）：

```sh
git config core.hooksPath .githooks
```

启用后每次 `git commit` 自动执行，校验失败即拦截提交。也可手动运行：

```sh
python scripts/verify_consistency.py
```

## 硬性要求

### 1. 证据分级（每条机制必须）

新增或修改任何机制，必须声明证据等级：

- **A**：真实环境复现、可复验；
- **B**：可核查期刊/预印本/一手公开事件（附 arXiv/DOI/URL）；
- **C**：域迁移缺口或二手转述（须配 A/B 升级）；
- **D**：推演——**不得单独支撑 P0 机制**。

来源必须写入 `REFERENCES.md`。

### 2. 引用利益关联披露

新增文献时须同时声明：
- 作者机构性质（学术 / 商业）；
- 是否存在专利或商业利益关联；
- 关键数据是一手实证还是二手统计。

可检索到 ≠ 可作为独立证据。

### 3. 回灌检查（PR 必勾）

- ① 相邻段落同步（原则段 ↔ 执行段）；
- ② 相关表格同步；
- ③ 进度表与成熟度同步；
- ④ 变更日志与未解清单同步。

### 4. 保密分级确认

- 不引入受限级内容（蜜罐样本构造、落地路线时间表、审计日志格式）；
- 不确定时先读 `CLASSIFICATION.md`。

## 版本管理政策（Versioning Policy）

自 v2.11.1 起生效，由维护者在发布时执行。本项目遵循语义化版本（`major.minor.patch`）：

- **minor（特性）**：新增或升级证据条目、spec 机制 / 章节变更、门禁规则变更；
- **patch（订正与基建）**：计数修正、日期 / 笔误订正、双语同步、CI 等工程基建、无机制语义的文本改动；
- 每次发布必须同步 `VERSION` / `CHANGELOG.md` / README 双语版本徽章 / `CITATION.cff`，并**打 annotated git tag（`vX.Y.Z`）**；
- 发布前必须通过全部一致性校验（见上文），并确保 CI（`.github/workflows/ci.yml`）全绿。

背景教训：v2.4.1 曾在 README 出现而仓库历史从未存在（笔误）；早期计数修正多次占用 minor 号导致版本膨胀。本政策把「计数修正 / 文本订正」显式归入 patch，并强制每次发布打 tag，杜绝「版本号与 commit 无锚点」再次发生。

## 风格

见 `STYLE.md`（术语表、编号规则、写作规范）。
