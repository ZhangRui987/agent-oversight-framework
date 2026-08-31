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

## Cross-validation is "mutual witnessing," not "mutual backup"

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
