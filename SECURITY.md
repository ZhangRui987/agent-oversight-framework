# 安全与证据披露

本仓库是治理架构规范，不是可运行软件。它面临的风险有两类：

## 1. 证据与事实错误（默认公开通道）

**最危险的不是漏洞，而是错误证据**——一条被误标为 A 级的推演会污染整张溯源表。

- 使用 `evidence-correction` Issue 模板提交；
- 响应时限：7 个工作日内首次响应；
- 处置：验证 → 更正等级 → 更新 `REFERENCES.md` → 记录变更。

## 2. 受限内容泄露（私有通道）

若本仓库意外泄露了受限级内容（蜜罐样本构造、落地路线时间表、审计日志格式），请通过 GitHub Private Vulnerability Reporting 报告。

- 响应时限：3 个工作日内首次响应；
- 处置：下架泄露内容 → 评估影响 → 更新 `CLASSIFICATION.md`。

## 报告渠道

- 公开证据问题：`evidence-correction` Issue 模板
- 受限内容泄露：GitHub Security Advisory（私有）
- 紧急（泄露已在传播）：直接邮件维护者 ZhangRui987@users.noreply.github.com
