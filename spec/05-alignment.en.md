# Intrinsic Alignment Layer L1

Intrinsic alignment is the center of governance, taking about 60% of the budget. Five mechanisms:
Mechanism | Content | Responsible party
| --- | --- | --- |
M1 Task-definition quality control | Before a task is dispatched, translate the vague wish into atomic, verifiable steps; mandate a Definition of Done | L1-deployer
M2 Model-selection evaluation | Admission evaluation by task type; models that fail are not admitted to the dispatch pool | L1-deployer
M3 Prompt-layer design | System-prompt engineering, capability-boundary statements, tool whitelist and least privilege | L1-deployer
M4 Training alignment | RLHF / Constitutional AI, reward design, anti-reward-hacking training | L1-vendor
M5 Procurement-clause pushback | Use procurement and contract clauses to require vendors to provide capability boundaries, evaluation data, incident disclosures, and model-version-level recall commitments | L1-deployer → vendor
M5 is the real lever available after the deployer cannot touch the training layer: it cannot change the model, but it can decide whose model to buy, and on what terms.
