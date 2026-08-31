# Runtime Oversight L2 and the No. 3 Notary

## Randomized-intensity sampling (replacing full monitoring)
Full shadow mode doubles compute and latency; when compliance cost exceeds about 30% of task value, the team inevitably chooses to run bare. Randomized-intensity sampling is more economical: light logging normally, and when the sampling button is pressed, the full set of replay-based sandbox tracebacks is enabled, so No. 1 never knows whether this time is a death sentence.
## The watchdog: a hard gate that cannot be shut off
A set of deterministic rules that depend on no AI judgment, deployed at the sandbox kernel layer / in an independent hardware domain, which cannot be shut down even by administrator privileges (only physically replaceable). It directly answers the lesson of "the safety classifier being shut down means total failure" in the incident.
Supplement: the watchdog's non-shut-off-ability means "cannot be shut off by an AI", not "cannot be modified by humans". Rule updates require multi-party human authorization + physical tokens — rule rigidity itself can become a systemic risk, and a path for fixing flaws must be preserved.
## No. 2 oversight: responsibility re-division
No. 2 does not duplicate No. 1's work; it only does what No. 1 "won't do, can't do, or shouldn't do": cross-validation, emergence detection, resource audit, and double-blind assessment.
No. 2's reports must undergo cognitive compression: automatic grading (urgent / important / general / low) + recommended disposition, with humans approving rather than reading — otherwise final adjudication degrades into a rubber stamp.
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
