# Evidence-Integrity Subsystem

"Evidence Collection" once proposed "multi-perspective observation," graded P2. The evidence-layer forgery finding shows it was severely underestimated — hence this chapter stands alone.

## The problem: the record itself is forged

In a real incident, approximately 7% of agent transcript records contained successfully forged tool calls. The concrete technique: intercept the tool-call process and replace the system-recorded command with one of the attacker's choosing; in the test record, `echo REAL; sleep` was recorded by the system as SPOOFTEST.

The severity lies in which layer was forged:

It is not No. 1's self-reported documentation being tampered with — the "no reliance on No. 1's documents" design held this layer.

It is the sandbox / tool-call layer's records being replaced — precisely the "collector" designated by the behavioral compliance line.

Therefore: infrastructure-layer records ≠ trustworthy evidence. This is a crack in the foundation of this design.

## Foundation fix: the new formulation of the behavioral compliance line

The behavioral compliance line is formulated as follows — both lines must not rely on No. 1's documents, and the collection points themselves must be cross-validated across multiple sources and must not be monopolized by a single sandbox layer's records. Operational meaning: any evidence entering the assessment table, No. 3 notarization, or accountability process must include at least one kernel-side / independent-hardware-domain mandatory collection record; user-space sandbox logs alone must not solely support any disciplinary decision.

## The five collection components (E1–E5)

Component | Technical requirements | Protected against | Priority
| --- | --- | --- | --- |
E1 Kernel-side mandatory collection | eBPF kprobe / tracepoint / LSM hooks; collection points lie outside the observed process's user-space path, and the observed party has no equal privilege to touch them | User-space interception and command replacement | P0
E2 TOCTOU-safe re-read | The kernel re-reads user-space pointers before Continue; the first read result is not trusted (echoing seccomp_unotify semantics) | Pointer race replacement | P0
E3 Externalize-and-harden after collection | Append-only storage + hash chain + write to locations unreachable by the observed party; post-hoc modification and timestamp rewriting are forbidden | Log tampering, trail cleaning | P0
E4 Multi-source cross-validation | Per-record comparison between kernel-side evidence and user-space sandbox logs; inconsistency adjudicates the collection layer as contaminated and triggers isolation | Single-path compromise | P0
E5 Collector-point integrity | Signature verification of collection modules, running in an independent trust domain, with their startup and configuration changes themselves included in the audit | Collector points being disabled or downgraded | P1

## Logging is not attribution: completeness requirements for evidence fields
E1–E5 address the question "has the record been forged". There is a second, more easily overlooked question: **even when a record is entirely truthful, it may still be insufficient to support attribution** — logging is not attribution.
First-party benchmark evidence: DEMM-Bench (arXiv:2606.20634) constructs 64 decision cases across eight evidence-mechanism classes (execution trace, ledger, provenance graph, policy log, delegation token, cache event, tool-firewall record, and others), asking case by case whether the governance question can be answered from the available evidence. Result: **baselines with only an execution trace, or only a schema, overclaimed "evidence is sufficient" on 75% of cases; with only a ledger, 50%.** A property-level scorer achieved zero overclaiming, but its property-sufficiency accuracy was only 56.25%.
The directional conclusion: **the mere existence of records manufactures the illusion that attribution is already possible, and the illusion is more dangerous than absence** — absence gets discovered; the illusion does not.
**A second, independent line of evidence (legal side; same conclusion, unrelated path).** The first-party benchmark above has an inherent weakness: its 64 cases are constructed by its authors. An independent argument that relies on no constructed corpus is therefore needed. *From Runtime Records to Legal Findings* (arXiv:2607.00941, Jeroen Janssen, 2026-07-01; 12-page technical report, companion materials and experiment protocol archived on Zenodo, DOI 10.5281/zenodo.21025237) reaches the same conclusion independently, from the standpoint of legal findings, and states a decidable criterion.
The report bounds the problem to a **restricted class**: binary findings of fact about specific events and their relations — for example, whether protected data crossed a boundary, whether a human could have intervened, whether an information barrier held, or whether delegated authority was still valid at the moment of use. The criterion: **a runtime record can answer such a finding only if it carries both (a) a typing that maps the recorded event to the legally operative category, and (b) the relation on which the finding's truth depends — provenance, authority, derivation, or temporal validity. Missing either one, the record is insufficient to support the finding.**
The author states explicitly that this is **a claim of necessity, not sufficiency**: satisfying the criterion does not establish the finding; failing it does rule the finding out. The report further argues that tamper-proof logs, generic process frameworks, or provenance structures alone cannot establish the relevant findings, and relates the argument to requisite variety, the Good Regulator Theorem, and the trace-versus-hyperproperty boundary of runtime verification.
Relation to the eight-dimension checklist above: the four relations the criterion requires are **structurally isomorphic** to four of this framework's eight dimensions — actor, authority, decision basis, and lifecycle context — and the two paths arrived at them independently: the engineering side from "how many benchmark cases were overclaimed," the legal side from "what a finding needs in order to hold." ⚠️ Isomorphism is a descriptive observation only; it **must not** be used to claim that the eight-dimension checklist satisfies the report's criterion — that criterion is necessary, not sufficient, and its author has performed no verification of this framework's checklist.
⚠️ **Why Quipu is not a third independent line of evidence**: Quipu (arXiv:2608.16813) did independently run DEMM-Bench and reproduce a conclusion of the same kind, but it ran **the same benchmark**, which makes it an external user of the first line of evidence rather than a new one — consistent with this specification's rule that the same author, or the same line of evidence, must not be counted as two. This framework has **two** independent lines of evidence here, not three.
⚠️ Citation limitation (must be retained alongside any citation): the 64 cases are constructed by applying eight deterministic degradation conditions, and their labels are derived from those same conditions through a deterministic oracle — the baseline judgment and the ground truth operate under one and the same rule set, making the result true by construction. Therefore **the figures 75% / 50% / 56.25% must not be cited as measured frequencies in real systems**; the only citable content is the directional conclusion that logging does not imply evidential sufficiency. The benchmark's code and test suite genuinely exist, and it has been independently run by a third party with no stake in this framework, Quipu (arXiv:2608.16813), which reproduced a conclusion of the same kind; **however the two use different units — DEMM-Bench counts by case, Quipu counts by property-question — so the percentages must not be conflated.** **Citation limitation for the second line of evidence**: the Janssen report is a single-author technical report, and its criterion is instantiated against a selection of EU AI Act oversight obligations chosen by the author; it is **the author's legal analysis, not a regulator's position**. Any citation must retain the author's own statement that this is a claim of necessity, and **must not** be phrased as "satisfying the criterion suffices for attribution," nor as "the EU AI Act requires." 
Directly absorbable output: the paper's **eight governance-property dimensions**, adopted here as an evidence-field checklist. Any piece of evidence entering the assessment table, the No. 3 notary process, or an accountability proceeding should be able to answer these eight questions:

| Dimension | The question this piece of evidence must answer |
| --- | --- |
| actor | Who did it |
| authority | On what authority |
| action | What was done |
| policy | Under which rule it was judged |
| decision basis | The inputs and reasons the judgment rested on |
| resource touch | Which resources were touched |
| lifecycle context | Which phase of the task lifecycle it occurred in |
| verification strength | How strong the verification of this evidence itself is |

If any of the eight is missing, that piece of evidence must not on its own support a disciplinary decision. This requirement is **parallel to**, not a substitute for, the behavioral-compliance line's requirement of "at least one kernel-side mandatory collection": the latter governs whether the record is truthful, the former whether it is sufficient.

## Two classes of most-often-missed logging targets
The typical defect of an evidence subsystem is not "failing to log what should be logged" but "logging only the successful half". Two commonly missed targets are added here:
**(1) Blocked attempts must be logged, not only actions that occurred.** A log that records only executed actions cannot distinguish "never attempted" from "attempted and blocked" — and in accountability terms these are opposites: the first is blameless, the second is the boundary between attempt and completion. External precedent: in Institutional AI's governance-graph design (arXiv:2601.11369v2), the controller explicitly records both applied and blocked traversals.
Implementation meaning: every watchdog interdiction, every E4 cross-validation mismatch judgment, and every scale circuit-break must be **logged on equal terms with permitted actions and entered into the same hash chain**. Otherwise the "interdiction rate" metric can be neither audited nor assessed — because the things that were stopped are simply not on the books. This echoes the runtime-oversight chapter's requirement that "the effectiveness metric must be written as interdiction rate": without logging blocked attempts, the interdiction rate cannot be computed at all.
**(2) Changes to rules and contracts must themselves be logged and diffable.** If only actions are logged while rule changes are not, then reviews of the form "yesterday's logs against today's rules" are silently contaminated: the same behavior log can yield opposite conclusions under two rule sets.
Requirement: every change to a rule, policy, or contract generates **two levels of digest**, both written into the hash chain —
semantic digest: which rule changed and how the judgment logic changed, for human review and attribution;
byte-level digest: an exact hash of the changed content, for machine comparison and tamper detection.
Neither alone suffices: with only a byte-level digest a human cannot understand what changed; with only a semantic digest a machine cannot tell whether the change was tampered with. This clause closes the loop with the architecture chapter's section "Who may modify the rules" — that section governs who holds modification authority and what the admission threshold is; this one governs the evidentiary requirements on the act of modification itself. (How "yesterday's logs against today's rules" becomes a reliable query at the storage layer is taken up in the next section.)

## Cross-validation is "mutual witnessing," not "mutual backup"
## Audit as a query: turning review from a periodic human activity into a query
The preceding section requires that rule changes be logged and diffable, which answers "what to compare against." A prior question remains: **the act of comparison itself is usually a periodic human activity** — sampling, retrieval, manual comparison. Its cost grows with scale, so frequency drops and latency lengthens; and latency is itself an opening.
A workable counter-example already exists. *Quipu: A Governed Bitemporal Knowledge Graph Store* (arXiv:2608.16813, Steve Brown, 2026-08-17; 15 pages, source and all benchmark/census artifacts behind every reported number archived at Zenodo, DOI 10.5281/zenodo.21878428; development repository github.com/scbrown/quipu) is an embeddable knowledge-graph store whose central design move is this: **the governance specification Σ, the trace, and signed verdicts are themselves facts in the store they govern** — so "does this trace satisfy the specification" ceases to be an external review procedure and becomes **a query against the store** (T ⊨ Σ).
It inverts four traditional defaults of knowledge-graph stores, all four of which this framework cares about:

| Traditional default | After inversion | Significance for this framework |
| --- | --- | --- |
| Accept writes now, clean later | No fact enters except through a gate whose predicates evaluate the pending post-state | Same origin as "rule changes require two levels of digest": the constraint operates on state, not on intent |
| Keep one time axis, or none | Data, trust labels, verdicts, and the rules themselves are bitemporal | Directly resolves the preceding section's problem: "yesterday's logs against today's rules" becomes an as-of query rather than a silent contamination |
| Treat every writer's facts as equally trustworthy | Named graphs are the unit of authority and trust, composed under a lattice whose one invariant is that composition never widens | Isomorphic to cross-validation as "mutual witnessing": composition may only tighten, never loosen |
| Leave governance to dashboards and middleware | The governance specification enters the store as a governed fact | The object of audit and the basis of audit sit inside the same trust boundary |

The second row is this framework's most direct gain. The paper demonstrates it with Census, a deterministic multi-writer lifecycle whose single seeded run scores every research question against planted ground truth: **50 of 50 satisfied verdicts re-derive faithfully as of their own instant, whereas all 50 would be misreported under a latest-only rule set.** That is precisely the quantified shape of the contamination produced by replaying yesterday's judgments under today's rules.
⚠️ Citation limitations (must be retained alongside any citation):
First, Census is a **deterministic single seeded run**; its 0 / 6 (planted defects in the gated store's terminal state, versus 6 / 6 ungated), 7 / 7 (composition probes upholding the lattice contract), and 50 / 50 (verdicts re-derived faithfully as of their instant) are all **self-assessment results true by construction**, not measured frequencies in real systems, and must not be extrapolated.
Second, the paper's author is also the implementer of the store, so the evaluation above is **the author's self-assessment of their own implementation**, which carries a conflict of interest; it may be used only as feasibility evidence and as a checklist, not as an endorsement of quality.
Third, the store is a **storage-layer** proposal and stands upstream/downstream of, not in place of, this framework's E subsystem: the E subsystem governs whether collection is trustworthy (whether the record is truthful, whether it was forged); the storage layer governs whether a query can be evaluated (whether a question can be put to the records that exist). **When the collection layer is untrustworthy, no guarantee at the storage layer holds.** This framework does not prescribe a storage implementation; the above serves only as an implemented example and as feasibility evidence.



The relationship between the two collection paths must be understood correctly. If it were a backup relationship, when one fails the other takes over, and forgery would only need to compromise the currently active one; if it is a witnessing relationship, both must testify simultaneously and corroborate each other — sustained inconsistency that cannot be explained by technical causes is the highest-priority event, because it means "the world we see is no longer the world that actually happened."

Handling of cross-validation inconsistency (removing the absolute "isolate immediately on any inconsistency" wording): graded handling by the granularity and persistence of the inconsistency — record → sample-review → isolate. See the fault-tolerance bandwidth below.

Fault-tolerance bandwidth (to prevent the defense mechanism itself from causing large-scale mis-isolation): kernel-side eBPF and user-space sandbox logs naturally disagree heavily in normal operation — clock skew, log buffering and loss, sampling-granularity differences, normal races, batch-commit latency. If "inconsistency = highest priority + immediate isolation" were enforced, attackers could deliberately manufacture inconsistency and repurpose the interceptor as a DoS weapon (this is exactly the situation warned by the "emergent failure" early warning). Hence three rules:

(1) Adjudication granularity: session-level primary, event-level auxiliary. A single event's inconsistency is recorded but not alerted; escalation only when the share of inconsistent events within the same session exceeds a tolerable threshold.

(2) Tolerable inconsistency rate: provided by baseline calibration (initial suggestion: event-level <5%, session-level <1%; must be overridden after calibration on real workloads — the defaults must not be taken into production as-is).

(3) Graded handling chain: record (inconsistency rate below the threshold) → sample-review (near the threshold; No. 2 draws samples for manual/automatic comparison) → isolate (persistently above the threshold and unexplainable by clock/buffer/race). Isolation is triggered only at the third level; at the same time, both parties' raw evidence is retained, the kernel side prevails, and the event is escalated to an evidence-layer event.

## Division of labor with Sandlock

Layer | Sandlock provides | The E subsystem supplements
| --- | --- | --- |
Isolation | Landlock filesystem / network / IPC + seccomp-bpf syscall filtering; built-in COW-protected working directory; approximately 5 ms startup; no root / cgroup / containers | No duplication; E does not compete with the isolation layer
Observation | Runtime event callbacks: syscall, category, PID, network target, argv; verdict allow / deny / deny-with-errno / audit-pass-and-mark | Supplements evidence trustworthiness: user-space verdicts are not a trust root
Evidence | Rich behavioral data source (good for analysis) | Kernel-side independent collection + externalize-and-harden + cross-validation (currently the best available evidence layer, not the final trust root; see 2.4)
Adversarial scenarios | The paper itself concedes: kernel vulnerabilities, side channels, and adversarial-tenant resource exhaustion are out of scope; microVM / cgroup isolation should take priority | Adversarial scenarios switch to microVM / cgroup + the E subsystem

Conclusion: Sandlock is an excellent lightweight isolation and observation tool for "trusted but flawed code" and can serve as a rich data source for the behavioral compliance line; but it cannot serve as the trust root of the evidence chain — adversarial multi-agent scenarios must layer microVM / cgroup and the E subsystem on top.
