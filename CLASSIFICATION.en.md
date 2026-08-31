# Confidentiality Classification

This framework's content is managed at the following three levels. **This public repository contains only "public"-level content.**

| Level | Content | Handling |
|---|---|---|
| **Public** | Architecture principles, mechanism design, public incident lessons, evidence grading, references | This repository (GitHub) |
| **Restricted** | Construction methods and injection methods of honeypot samples, rollout-roadmap timelines (deliverables / cycles / priorities / acceptance criteria), change-review and adjudication records, credit-score decay parameters and shadow-ratio calibration values (once calibrated) | Distributed only with deployment packages; the `restricted/` directory in this repository contains only the inventory and how to request access |
| **Confidential** | An organization's internal red-team attack chains, exploit details, audit-log formats | Organizational internal control, under NDA |

## Distinguishing the Three Confidentiality Natures

| Type | Reason for secrecy | When it can be declassified |
|---|---|---|
| **Epistemic** | Measurement validity requires ignorance (honeypot samples — knowing the exam questions enables cheating) | **Never declassifiable** — declassification = mechanism failure |
| **Preventive** | Preserving future limitation options (credit-score decay parameters) | Can be evaluated once the system matures and is Goodhart-proof |
| **Operational** | Preventing threshold riding (shadow-ratio calibration values) | Can be evaluated once the methodology is sufficiently robust |

## Decision Criterion

> Would making this content public give an attacker an evasion capability "not findable through previously public channels"?

If the answer is no — the content is public technology, placeholder values, or already-published literature — it should be made public. Security through obscurity contradicts this framework's general principle that "trust comes from institutions, not capabilities".

## Technical-Detail Notes for the Public Version in This Repository

The E1–E5 technical choices in `spec/08-evidence-integrity.md` (eBPF/kprobe/tracepoint/LSM hooks, TOCTOU re-read, Merkle hash chain, cross-validation) are all combinations of public Linux kernel mechanisms and standard audit practices — **the innovation is in the architectural combination, not in any single technique**. The emergence-detection-signal concepts in `spec/07-swarm-governance.md` are consistent with public literature such as MultiAgent4Collusion (arXiv:2507.14660).
