# Contributing Guide

## Quick Start

1. Fork this repository;
2. Create a branch: `git checkout -b feat/your-change`;
3. Commit with `git commit -s` (Developer Certificate of Origin);
4. Open a PR (template in `.github/PULL_REQUEST_TEMPLATE.md`).

### Before committing: consistency verification (pre-commit)

This repository ships a release consistency check (`scripts/verify_consistency.py`, 18 items: table format / evidence-grade counts / incident-number conventions / section references / terminology conventions). Enable it (run once from the repository root):

```sh
git config core.hooksPath .githooks
```

Once enabled, every `git commit` runs it automatically, and a failing check blocks the commit. It can also be run manually:

```sh
python scripts/verify_consistency.py
```

## Hard Requirements

### 1. Evidence grading (mandatory for every mechanism)

Any mechanism added or modified must declare an evidence grade:

- **A**: reproduced in a real environment, re-verifiable;
- **B**: verifiable journal / preprint / first-hand public event (with arXiv / DOI / URL);
- **C**: domain-transfer gap or second-hand account (must pair with an A/B upgrade);
- **D**: deduction — **must not alone support a P0 mechanism**.

Sources must be recorded in `REFERENCES.md`.

### 2. Citation conflict-of-interest disclosure

When adding a reference, also declare:
- the nature of the author's institution (academic / commercial);
- whether any patent or commercial conflict of interest exists;
- whether key data is first-hand empirical or second-hand statistics.

Retrievability ≠ admissibility as independent evidence.

### 3. Back-propagation check (mandatory on every PR)

- ① Adjacent-paragraph synchronization (principle paragraph ↔ execution paragraph);
- ② Related-table synchronization;
- ③ Schedule-and-maturity synchronization;
- ④ Changelog-and-open-problem synchronization.

### 4. Confidentiality-classification confirmation

- Do not introduce restricted-level content (honeypot-sample construction, rollout-roadmap timelines, audit-log formats);
- When in doubt, read `CLASSIFICATION.md` first.

## Style

See `STYLE.md` (terminology, numbering rules, writing conventions).
