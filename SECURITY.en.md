# Security and Evidence Disclosure

This repository is a governance-architecture specification, not runnable software. It faces two classes of risk:

## 1. Evidence and factual errors (default public channel)

**The most dangerous thing is not a vulnerability but wrong evidence** — a deduction mislabeled as A-grade pollutes the entire traceability table.

- Submit via the `evidence-correction` Issue template;
- Response target: first response within 7 working days;
- Handling: verify → correct the grade → update `REFERENCES.md` → record the change.

## 2. Restricted-content leakage (private channel)

If this repository accidentally leaks restricted-level content (honeypot-sample construction, rollout-roadmap timelines, audit-log formats), report it via GitHub Private Vulnerability Reporting.

- Response target: first response within 3 working days;
- Handling: take down the leaked content → assess the impact → update `CLASSIFICATION.md`.

## Reporting Channels

- Public evidence issues: `evidence-correction` Issue template
- Restricted-content leakage: GitHub Security Advisory (private)
- Emergency (leakage already spreading): email the maintainer directly at ZhangRui987@users.noreply.github.com
