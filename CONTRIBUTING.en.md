# Contributing Guide

## Quick Start

1. Fork this repository;
2. Create a branch: `git checkout -b feat/your-change`;
3. Commit with `git commit -s` (Developer Certificate of Origin);
4. Open a PR (template in `.github/PULL_REQUEST_TEMPLATE.md`).

### Before committing: consistency verification (pre-commit)

This repository ships a release consistency check (`scripts/verify_consistency.py`, 33 items: table format / evidence-grade counts (five grades A–G, incl. G-class jurisdiction prefixes) / incident-number conventions / section references / terminology conventions / bidirectional citation closure / reference-key quality). Enable it (run once from the repository root):

```sh
git config core.hooksPath .githooks
```

Once enabled, every `git commit` runs it automatically, and a failing check blocks the commit. It can also be run manually:

```sh
python scripts/verify_consistency.py
```

### After committing: automatic annotated tag (post-commit, from v2.15.6)

The same `git config core.hooksPath .githooks` also enables a post-commit hook. It fires only when **all** of the following hold:

1. The current commit modified the `VERSION` file;
2. `VERSION` content matches `X.Y.Z` (semantic-version three-component);
3. No tag named `vX.Y.Z` exists yet.

Behavior: extracts the matching section from `CHANGELOG.md` as the tag message and creates an annotated tag anchored to the current commit. **Motivation**: eliminate "VERSION bumped but tag forgotten" drift — before v2.15.6 every tag had to be created manually, and tags were occasionally missed. Skip for debugging: `SKIP_AUTO_TAG=1 git commit ...`.

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

## Versioning Policy

Effective from v2.11.1, enforced by the maintainer at release time. This project follows semantic versioning (`major.minor.patch`):

- **minor (feature)**: adding or upgrading evidence entries, spec mechanism / section changes, gate-rule changes;
- **patch (correction & infrastructure)**: count corrections, date / typo fixes, bilingual synchronization, engineering infrastructure such as CI, text changes without mechanism semantics;
- Every release must synchronize `VERSION` / `CHANGELOG.md` / README version badges (both languages) / `CITATION.cff`, and **create an annotated git tag (`vX.Y.Z`)**;
- Before a release, all consistency checks (above) must pass and CI (`.github/workflows/ci.yml`) must be green.

Background lessons: v2.4.1 once appeared in the README although it never existed in repository history (a typo); early count corrections repeatedly consumed minor numbers, inflating the version line. This policy explicitly classifies "count corrections / text corrections" as patch and mandates a tag on every release, so that version numbers can never again float without an anchor to a commit.

## Style

See `STYLE.md` (terminology, numbering rules, writing conventions).
