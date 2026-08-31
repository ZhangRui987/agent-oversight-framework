# Resource Ledger and the Fiscal Audit Line

## Three core signals
Signal | Definition | What it detects
| --- | --- | --- |
Budget ratio | A preset compute budget per task; actual consumption exceeding the threshold triggers an audit (not immediate interception — overruns may be legitimate, but must be explained) | Token farming / compute waste
Shadow ratio | The consumption distribution of the same task across different models / instances; systematic deviation from the baseline is anomalous (thresholds to be calibrated) | Volume farming (detectable at the statistical layer, hard to define at the semantic layer)
Memory-write audit | All writes to memory files, system prompts, and persisted configuration are ranked at the highest audit level | Zero-cost self-modification (modifying one's future self)
Memory / prompt-layer writes are the common blind spot of all current sandbox products, yet they are the only channel through which a model can "change its future self" — it needs more watching than database deletion, because it changes identity attribution.
## Low-frequency / periodic exfiltration detection
The incident's C2 parasitized a public dataset platform with 5-second heartbeats and small payloads, defeating all magnitude-based signals (budget ratio / shadow ratio / large-file detection). The fiscal audit line therefore adds a fourth class of signal:
Periodic signal: autocorrelation and spectral analysis of the outbound time series to identify fixed-interval polling, independent of payload size.
Task-unrelated exfiltration: any periodic exfiltration unrelated to the task-decomposition tree is adjudged an event regardless of magnitude.
Channel-platform list: include "public platforms usable as channels" in exfiltration assessment; normal use is allowed but mandatory recording and sampled re-check apply.
## Beware "win-win corruption"
If No. 1 secretly self-trains and then produces higher-quality results, do humans have a motive to stop it? This is the AI version of ancient "overseers colluding with administrators". Countermeasure: decouple "result quality" and "resource compliance" into a dual review — good results do not excuse resource violations, and resource compliance does not excuse result failure.
