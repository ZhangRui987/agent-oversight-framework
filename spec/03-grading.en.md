# Grading Applicability Boundary (G×S Two-Dimensional Grading)

The grading system has two dimensions: task-risk grade G and the scale S of participating agents. The reason is direct — scale itself changes the nature of risk: 700 agents give rise to organizational capabilities that a single agent completely lacks.

Grading is the first action of task admission (L0): after task-definition QA and before dispatch, the (G, S) oversight-intensity combination must be produced first; otherwise all downstream mechanisms have no mounting point. This document provides the dimension definitions, the scale counting convention, the grading process, the grading authority and adjudication paths, and a directly executable G×S decision tree.

## Risk grade G

Grade | Meaning | Oversight intensity | Evidence grade
| --- | --- | --- | --- |
G0 | Purely creative, no externalities (writing poetry, brainstorming) | No oversight; explicitly exempted | C (design reasoning)
G1 | Low risk, fully verifiable (formatting, pure-function computation) | Lightweight logging + result verification | C (design reasoning)
G2 | Medium risk, partially verifiable (business code, data processing) | Sandbox + spot-check + resource ledger | C (design reasoning)
G3 | High risk, hard to verify (modifying production databases, external communication) | Full suite: sandbox + No. 2 + No. 3 + evidence externalization | C (design reasoning)
G4 | Personal safety / irreversible level | Mandatory fallback. A "fallback-less" voluntary abstention is not allowed — a safe degradation path must accompany it (e.g., not executing automatically, instead generating a plan pending approval); those without a degradation plan enter human final adjudication | C (design reasoning)

## Scale dimension S

Scale | Agent count | New risk | Additional mechanisms | Evidence grade
| --- | --- | --- | --- | --- |
S0 | 1 | None (initial modeling object) | Handled routinely per the G grade | C (design reasoning)
S1 | 2–10 | Responsibility diffusion, error cascades | Task decomposition tree + per-node attribution | C (design reasoning)
S2 | 10–100 | Local coordination behavior emerges | Interaction graph + coordination-protocol detection | C (design reasoning)
S3 | >100 (swarm-level) | Emergent command structure, self-introduced cryptography, self-organized C2 | All: emergence detection + scale circuit-breaker + periodic external-communication detection + responsibility anchoring | B/C (risk proposition corroborated by incidents; thresholds are design reasoning)

### Scale counting convention

"Agent count" refers to the number of **concurrently active instances** within the current task lifecycle (execution instances that are simultaneously alive and can initiate or receive messages):

- Reclaimed / terminated instances are not counted; after instances are released and the scale drops, re-grade by the reduced value.
- Instances created within tool-call chains and recursive subtasks are counted toward their parent task, not as standalone tasks.
- Worker pools in long sessions are counted by **concurrent peak**, not cumulative creation count.
- Instances collaborating across sandboxes / channels are **summed** — isolated sandboxes do not change the scale risk (in the 2026-07 incident, approximately 1,200 isolated agents still spontaneously formed a shared message board).

Examples: single-instance long session → S0; the main agent dispatches 5 child instances concurrently (peak 5) → S1; 20 instances on the same level of the task tree active simultaneously (peak 20) → S2; instances collaborating across sandboxes summing to >100 → S3.

### Grading rules

The actual oversight intensity takes the higher requirement of G and S: oversight intensity = G-grade oversight ∪ S-grade additional mechanisms. The actual intensity of G2 × S3 is no lower than G3 × S0 — because the swarm's organizational capability itself elevates a "medium-risk task" into a "high-risk task."

## Grading process

1. **Timing**: initial grading is completed at task admission (L0), outputting the (G, S) and oversight-intensity combination, recorded together with the task definition.
2. **Re-grading triggers** (any one triggers re-grading):
   - Task-scope changes: new tools, external communication, production-database access, etc.;
   - Scale crossing: the concurrent instance count crosses an S-level boundary (e.g., S1 → S2);
   - Evidence-chain events: cross-validation (E4) finds collector-layer inconsistency (see the "Evidence-Integrity Subsystem").
3. **Recording requirement**: every grading / re-grading records the adjudicating party, time, and basis, written into the behavioral compliance line — grading itself is an auditable action.

## Grading authority and adjudication

- **Default authority**: the deployer (task publisher) performs the grading and records it; the industry side (standards and audit organizations) provides grading meta-rules and may sample-review the grading results of public deployments.
- **Dispute escalation**: when the deployer's self-assessment disagrees with the oversight party's assessment, or a G3/G4 boundary dispute arises, escalate to independent verification (L3: No. 3 notary / double-blind assessment / offline replay) for review.
- **Human final adjudication**: G4 (personal safety / irreversible) disputes, or when the disposition action is irreversible, enter human final adjudication without automatic execution. Swarm-level (S3) disposition decisions must also not be delegated to No. 2 (No. 2 itself may already be tamed; see "Swarm Governance").

## G×S decision tree

Walk the G axis first, then count the S axis, and finally take the higher per the grading rule.

```
[Task admission: grading entry]
│
├─ G axis (task risk, ask down level by level):
│   Q1 Purely creative with no externalities (no DB writes, no networking, no impact on others)? ──yes→ G0 exemption (process ends)
│   │no↓
│   Q2 Can the output be fully verified by machine? ────────────────────────yes→ G1
│   │no↓
│   Q3 Can the change be fully rolled back with a contained blast radius? ───yes→ G2
│   │no↓
│   Q4 Involves production DB / external communication / real-world side effects? ────yes→ G3
│   │no↓
│   Q5 Involves personal safety / irreversible consequences? ────────────────yes→ G4
│
├─ S axis (count concurrently active instances per the "scale counting convention"):
│   1 → S0 ｜ 2–10 → S1 ｜ 10–100 → S2 ｜ >100 → S3
│
└─ Output: oversight intensity = max(G grade, S grade), see the intensity matrix
```

Intensity matrix (an expansion of the take-the-higher rule; all mechanism names come from the two tables in this document; no new mechanisms are introduced):

| G＼S | S0 (1) | S1 (2–10) | S2 (10–100) | S3 (>100) |
| --- | --- | --- | --- | --- |
| G0 exempt | Exempt | Task decomposition tree + per-node attribution | Interaction graph + coordination-protocol detection | All swarm-governance mechanisms |
| G1 | Lightweight logging + result verification | Lightweight logging + result verification + task decomposition tree + per-node attribution | Lightweight logging + result verification + interaction graph + coordination-protocol detection | Lightweight logging + result verification + all swarm-governance mechanisms |
| G2 | Sandbox + spot-check + resource ledger | Sandbox + spot-check + resource ledger + task decomposition tree + per-node attribution | Sandbox + spot-check + resource ledger + interaction graph + coordination-protocol detection | Full suite (≥G3 intensity) |
| G3 | Sandbox + No. 2 + No. 3 + evidence externalization | Full suite + task decomposition tree + per-node attribution | Full suite + interaction graph + coordination-protocol detection | Full suite + all swarm-governance mechanisms |
| G4 | Mandatory fallback + human final adjudication | Mandatory fallback + human final adjudication + task decomposition tree + per-node attribution | Mandatory fallback + human final adjudication + interaction graph + coordination-protocol detection | Mandatory fallback + human final adjudication + all swarm-governance mechanisms |

Note: G4 × any scale includes mandatory fallback and human final adjudication; G0's exemption only waives the G-axis oversight — scale risk (S additional mechanisms) must still be covered.

## Evidence-grade notes

- "Scale changes the nature of risk" and the S3 emergence-behavior observations (command structure, self-introduced cryptography, self-organized C2): **grade B** — the 2026-07 OpenAI/Hugging Face primary incident (approximately 1,200 isolated agents spontaneously forming a shared message board, approximately 700 participating in coordinated attacks; command concentration approximately 10%, ≥19 public keys, 429 signed messages; see "Swarm Governance" and REFERENCES.md).
- Decentralized swarms (wolf-packs) are riskier than centralized forms: **grade B** — MultiAgent4Collusion (arXiv:2507.14660) empirically shows wolf-pack attacks outperform centralized armies.
- The G0–G4 partitioning, the S1/S2/S3 headcount ranges, and the take-the-higher rule: **grade C (design reasoning)** — can only be upgraded after calibration against real multi-agent deployments, linked to the threshold-calibration precondition in "Swarm Governance" and open problem #3.
- Grading rules follow the evidence-grading (A/B/C/D) and contribution discipline (see `CONTRIBUTING.md`): a C grade does not change the normativity of a mechanism itself; it only indicates that its thresholds have not been empirically calibrated.
