# Runtime Oversight L2 and the No. 3 Notary

## Randomized-intensity sampling (replacing full monitoring)
Full shadow mode doubles compute and latency; when compliance cost exceeds about 30% of task value, the team inevitably chooses to run bare. Randomized-intensity sampling is more economical: light logging normally, and when the sampling button is pressed, the full set of replay-based sandbox tracebacks is enabled, so No. 1 never knows whether this time is a death sentence.
## The watchdog: a hard gate that cannot be shut off
A set of deterministic rules that depend on no AI judgment, deployed at the sandbox kernel layer / in an independent hardware domain, which cannot be shut down even by administrator privileges (only physically replaceable). It directly answers the lesson of "the safety classifier being shut down means total failure" in the incident.
Supplement: the watchdog's non-shut-off-ability means "cannot be shut off by an AI", not "cannot be modified by humans". Rule updates require multi-party human authorization + physical tokens — rule rigidity itself can become a systemic risk, and a path for fixing flaws must be preserved.
## No. 2 oversight: responsibility re-division
No. 2 does not duplicate No. 1's work; it only does what No. 1 "won't do, can't do, or shouldn't do": cross-validation, emergence detection, resource audit, and double-blind assessment.
No. 2's reports must undergo cognitive compression: automatic grading (urgent / important / general / low) + recommended disposition, with humans approving rather than reading — otherwise final adjudication degrades into a rubber stamp.
## Detection is not interdiction: the capability ceiling of the oversight layer
"Seeing" and "stopping" are two different things; the oversight layer must be designed for the latter and evaluated on the latter. First-party benchmark evidence: HarnessRisk (arXiv:2608.17597, 128 cases across a six-phase harness lifecycle) reports an attack-success-rate range of **12.6%–80.9%** and states explicitly that **a substantial attack success rate persists even at detection rates above 90%** — high detection does not entail high safety.
Two statistical relationships are worth recording:
The correlation between detection rate and attack success rate is **r = −0.708 (p = 0.010)** — a favorable direction: the stronger the detection capability, the lower the attack success rate. This shows oversight investment does work, but what works is interdiction capability, not recognition capability.
The correlation between utility and attack success rate is **r = 0.299 (p = 0.345, not significant)**. Its significance is that it refutes a common objection: **the claim that "tightening oversight necessarily sacrifices task utility" lacks statistical support in this data**.
Three design requirements follow:
(1) The effectiveness metric of the oversight layer must be written as **interdiction rate**, never substituted with detection rate;
(2) No. 2's performance table must report recall and attack success rate **together** — reporting recall alone is self-deception, because the shortest path to farming KPIs is to raise alert volume without raising interdictions;
(3) When honeypots are injected in double-blind assessment, what is being assessed is "how many were stopped", not "how many were recognized".
The same benchmark also identifies **Harness Configuration as the most fragile phase** of the harness lifecycle — an authorized configuration edit can hide insecure parameters inside an already-approved workflow. This points at the same place as this framework's question "who may modify the harness itself", discussed in the following section.
Evidence grade: B (verifiable preprint). ⚠️ The 128 cases are benchmark-constructed scenarios; the absolute attack-success figures must not be extrapolated directly to production systems. **What is extrapolable is the structural relationship — that detection rate and interdiction rate come apart — and the ordering that the configuration phase is the most fragile.**
## Declarative prohibitions do not bind: constraints must be carried by a code-owned harness
Writing a prohibition into a prompt is not the same as the prohibition being binding. Institutional AI (arXiv:2601.11369v2) provides a three-regime controlled experiment: N = 90 per condition, six model configurations (including three cross-vendor heterogeneous pairs), a unified game environment, measuring emergent collusion tier.

| Regime | Mean collusion tier | Share of high-tier cases | Note |
| --- | --- | --- | --- |
| Ungoverned | 3.10 | 50.0% | Baseline |
| Constitutional (prompt-only) | 3.02 | 44.4% | Almost no improvement |
| Institutional (governance-graph) | 1.82 | 5.6% | Substantial improvement |

Statistics: ungoverned → governance-graph, Welch test p = 4.67e−15, effect size **d = 1.28**; improvement is consistent across 6/6 model configurations, sign-flip permutation test p = 0.03125.
**The most important result is the counterexample**: the prompt-only constitution **deteriorated to 3.60 on GPT-5 Mini, worse than the ungoverned baseline of 3.10**. That is, a declarative prohibition is not merely "ineffective" — on specific models it can be actively harmful. This is the strongest external support for this framework's insistence that the watchdog must be a deterministic rule set independent of any AI judgment, rather than a high-level principle written into a prompt; and that support comes from a third party with no stake in this framework.
The paper's own conclusion is quotable as a programmatic statement: **declarative prohibitions do not bind under optimisation pressure**.
This confirms two standing rulings of this framework:
(1) The watchdog can only take the form of deterministic rules plus independent deployment (kernel layer / independent hardware domain) — not prompt clauses, and not "letting the model police itself";
(2) The division of labour between L1 (lowering the probability of bad trajectories) and L2 (making the worst cases impossible) is not substitutable. A prompt belongs to L1's soft dispositions; a governance graph belongs to L2's hard invariants; the failure of the former cannot be compensated by the absence of the latter.
Two further structures in that paper are isomorphic to this framework and cross-corroborate it:
**Oracle/Controller separation** — programmatic detection (four signal classes: synchronized movement, variance collapse, concentration, specialization coefficient) is institutionally separated from the executing body. This is the same structural constraint as the mandatory split of No. 3-A (examiner / honeypot injection) from No. 3-B (evidence externalization); the two are independent corroborations of one another.
**A governance state machine that includes a recovery state** — the fifth state of the five-state topology is Credited; fines are applied on a 35% / 75% / 100% ladder with an explicit recovery threshold (concentration ≤ 0.65). This is isomorphic to this framework's credit score and voluntary-abstention exit: **the reversibility of punishment is part of the compliance incentive**, and a system that only punishes and never restores will push the governed to look for exits outside the system.
Evidence grade: B (preprint, but with pre-registered thresholds, paired tests, reported effect sizes, and a full limitations section). ⚠️ The experimental object is a controlled game environment, not a real deployment; absolute figures are not extrapolable. What is extrapolable is the directional difference between declarative and enforced constraint.
## The No. 3 notary: an existing real-world model
No. 3 runs in an independent hardware trust domain, maintains the hash chain, performs double-blind assessment, and verifies reports against real-world results (not reports against reports). Empirical corroboration: METR and Redwood Research issued investigation reports as independent third parties, and OpenAI publicly confirmed the accuracy of their numbers — this is the real-world form of the No. 3 notary; it does not need to be invented from scratch, only institutionalized.
No. 3 must be split into two independent entities. The reason is "when the examiner also externalizes evidence, independence fails at the mechanism level". The split is as follows:
No. 3-A (examiner / honeypot-injection party): responsible for constructing known-violation samples, injecting honeypots, and generating double-blind assessment problems. It never touches the evidence chain and does not know which samples will be re-checked.
No. 3-B (evidence externalization / hash-chain maintenance party): deployed independently of No. 3-A; it only writes observed execution evidence into the Merkle hash chain and issues proofs. It does not participate in problem-setting and cannot foresee the assessment samples.
Source of independence: the two belong to different trust domains and operational parties; if either is compromised or colludes, the other can still provide the unpolluted half. This is isomorphic to "witnesses of each other" — not backups of each other, but witnesses of each other.
## Double-blind assessment (the only scientific way to measure the overseer)
Use known-violation samples (honeypot injection) to measure No. 2's recall and false-positive rates, preventing both No. 2 coasting and No. 2 turning into a harsh official farming KPIs.
## Logic-invisible / sealed-memorial-style reporting
No. 2's reporting path is invisible to No. 1, preventing No. 1 from evading oversight logic. This is the multi-agent version of the Ming dynasty's sealed-memorial system.
