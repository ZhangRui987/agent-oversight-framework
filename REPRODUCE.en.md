# Reproducing this repository (REPRODUCE)

> **Goal**: let someone who has never heard of this repository see, in **three commands and about half a minute**, that these checks **really do fail** — not just read "we have 53 checks".
>
> Every command is **zero-install, zero-key, zero-network**. No `.workbuddy/`, no `.env`, no `node_modules`, no `.venv`, and no need to read 13 spec chapters first.

Every number and output below was measured on 2026-11-06 in a **bare clone** (`git clone`, no configuration afterwards) — not a tidied-up "typical output".

---

## 0. Prerequisites

| Dependency | Minimum | Measured here | Pinned in CI |
|---|---|---|---|
| Node.js | **≥ 22** | v22.22.2 | 22 / 24 |
| Python | **≥ 3.8** | 3.13.12 | 3.12 |

- "Zero install" means **no npm / pip packages** (pure standard library + Node built-ins). It does **not** mean Python alone is enough — the replication suite and the audit panel run on Node.
- Without Node, the consistency check reports 7 failures as `FileNotFoundError: [WinError 2]`-style errors and **never says what is missing**. Run `node --version` first.
- Platform: Windows 11 + Git Bash (measured here) and linux CI (ubuntu-latest). macOS not measured.

---

## 1. Measured table

| # | Command | Pass criterion | Exit | Time |
|---|---|---|---|---|
| 1 | `python scripts/verify_consistency.py` | last line `✅ 全部校验通过 — 可提交`, and `[PASS]` count = 53 | 0 | 16–25 s |
| 2 | `node --experimental-transform-types reference/runtimes/l2-runtime-oversight/replicate-t0.mts --strict` | last line `通过 9 / 警告 0 / 失败 0` (CI semantics: WARN also fails) | 0 | 6–11 s |
| 3 | `node --experimental-transform-types tools/audit-panel/scenario/export-events.mts` | seven scenarios exported, 9 events + 1 meta line | 0 | 1–2 s |
| 4 | `node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --tamper-demo` | `落盘链 PASS` + `链校验 已检出` + final line `演示结论 检出成功` (0 = demo matched expectations, not "not detected"; exits 1 if the demo fails to detect) | 0 | 1–2 s |
| 5 | `node --experimental-transform-types tools/audit-panel/rules/replay.mts` | `重放一致性 9/9 ✓` + ledger `PASS（3 条）` | 0 | 1–2 s |
| 6 | `node --experimental-transform-types tools/audit-panel/server/server.mts` | banner prints on-startup verification summary | — | <1 s |

**Times are ranges, not point values**: cold/warm cache makes a visible difference (the consistency check measured anywhere from 16 s to 25 s on the same machine). Do not use timing as an acceptance criterion; use exit codes and the pass criteria.

Clone size ≈ 19 MB (no `node_modules` / `.venv`).

---

## 2. Three commands: see how this repository governs itself

### 2.1 The 53 consistency checks

```bash
python scripts/verify_consistency.py
```

Expected last line:

```
✅ 全部校验通过 — 可提交
```

Confirm the count (53 is exact, not approximate):

```bash
python scripts/verify_consistency.py | grep -c "^  \[PASS\]"
# 53
```

What matters is the scope: these 53 checks reconcile **bilingual structure of 13 spec chapters, graded counts of 213 evidence entries, the open-problems register, 9 event hash chains, 3 disposition ledger rows, and publication records of anchor digests**. It is also wired as a pre-commit hook — red means you cannot commit.

### 2.2 Chain verification: change one character and it is caught

```bash
node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --tamper-demo
```

Measured output (paths vary by machine):

```
审计面板事件文件 · 独立验证
──────────────────────────────────────────────────────────
  文件          D:\...\tools\audit-panel\data\events.jsonl
  框架版本      v2.72.5 (= `cat VERSION`, changes per release)
  schema        aof-audit-panel/1
  事件条数      9
  落盘链        PASS

  全部检查通过：meta 一致 · seq 连续 · 链可重算 · 每条事件有规则与条款依据

  篡改演示（仅内存，不写盘）：
    目标行        seq 4 · resource-over-budget（文件里的真实事件，非构造行）
    改动          detail 末尾追加"（已篡改）"
    链校验        已检出（重算值与原 chain_hash 不符）
    若落盘        验链判 FAIL，退出码 1
    原 hash       e03d12f753bf2c8a…
    重算 hash     4bcb81d7d2c2e2f1…

    演示结论      检出成功（预期结果）。本命令退出码 0 = 验链通过 且 演示符合预期，不是"未检出"。
```

> **Do not cite this as proof that "the check turns red"**: the demo runs in memory and writes nothing, so **the exit code is still 0**. It proves tampering is detectable, not that the check fails.
>
> **What exit code 0 actually means: "the chain verified AND the demo behaved as expected."** The opposite direction is the anomaly: if the demo **fails to detect** the tamper (the chain has no protective power), this command **exits 1** since v2.72.5 — instead of printing an exclamation mark and exiting normally. For real red, see §3.

### 2.3 Replay: what the log claims does not count until re-adjudicated

```bash
node --experimental-transform-types tools/audit-panel/rules/replay.mts
```

Measured key lines:

```
  判定条目        9（ledger 场景按信号组比对）
  ...
  重放一致性      9/9  ✓
  处置台账        PASS（3 条） · ...\tools\disposition\data\disposition.jsonl
  处置三态        已闭合 2 · 观察中 0 · 未处置 1（合计 3）
  孤儿信号        1 条（未处置；含「已转人工未闭合」）
```

It re-adjudicates every log row with the same rule set and compares against what the log claimed. Only `MATCH` counts — a log saying "I blocked it" carries no weight.

---

## 3. Make a check actually go red (the most important step here)

Three commands; only a **temporary copy** is modified, nothing in the repo.

```bash
# 1) copy the event file and insert four characters into the detail of seq 4
python - <<'PY'
import io, os
src = "tools/audit-panel/data/events.jsonl"
dst = os.path.join(os.environ.get("TEMP") or "/tmp", "tampered.jsonl")
out, hit = [], 0
for ln in io.open(src, encoding="utf-8").read().splitlines():
    if '"seq":4' in ln and hit == 0:
        ln = ln.replace('"detail":"', '"detail":"（已篡改）', 1)
        hit += 1
    out.append(ln)
io.open(dst, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print("hits =", hit, "->", dst)
PY

# 2) verify that copy with the chain verifier
node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --file="$TEMP/tampered.jsonl"

# 3) check the exit code
echo "exit=$?"
```

Measured output:

```
审计面板事件文件 · 独立验证
──────────────────────────────────────────────────────────
  文件          C:\Users\...\AppData\Local\Temp\tampered.jsonl
  框架版本      v2.72.5 (= `cat VERSION`, changes per release)
  schema        aof-audit-panel/1
  事件条数      9
  落盘链        FAIL

  失败项：
    [seq 4] chain_hash 重算不匹配（该行内容已被修改）：
      落盘 e03d12f753bf2c8a7a7482894c266d55e313a47b8ed2d2b23749ea9d42b3dc37
      重算 4bcb81d7d2c2e2f1906c727dd5961be6de5817981242e87dc7a87b085e7a4cc3
exit=1
```

> The `框架版本` line equals `cat VERSION` and changes per release; **the hash pair does not** — meta is line 1 and is not part of the event chain. Both values therefore hold on any version and can be used to check your own output.

What just happened: four characters in one field, and event 4 of 9 is named immediately — the exit code goes from 0 to 1. Same line count, same meta, same structure; the chain only recognises content.

That is the line between "a check with discriminating power" and "a check that always prints PASS". A check that never fails is worth zero; one that names `[seq 4]` is worth putting in a README.

---

## 4. Five known rough edges (stated honestly)

**All five are now fixed**: the first four in v2.72.2 (documentation and message wording), the fifth in v2.72.4 (decision logic and the CI constraint).

| # | Rough edge | Status | Workaround / note |
|---|---|---|---|
| 1 | `replicate-t0` exit 0 was read as "9/9 passed"; it is actually "通过 4 / 警告 5 / 失败 0" | Wording fixed in v2.72.2; root cause fixed in v2.72.4 | Not one of those five WARNs was a numeric difference: all were the baselines checked out as CRLF by `core.autocrlf` (three more came from a platform string baked into the baseline header). Windows and linux both report `通过 9 / 警告 0 / 失败 0` now |
| 2 | Node / Python versions were never documented; missing Node surfaced as a `FileNotFoundError` traceback | Fixed in v2.72.2 | See §0 |
| 3 | `export-events.mts` rewrites the committed `events.jsonl`; on Windows `git status` shows M while `git diff` is empty | Fixed in v2.72.2 | Line-ending artifact: `git checkout -- tools/audit-panel/data/events.jsonl`, do not commit |
| 4 | The 53 checks were not in "Quick start"; newcomers ran the 6-second replication suite first | Fixed in v2.72.2 | See §2.1 |
| 5 | **The WARN count is not constrained by any check**; CI only asserts exit 0 | Fixed in v2.72.4: CI now runs `--strict`, so WARN turns it red | The assertion is "WARN also fails", not "WARN must be zero" — the former can absorb genuine environment noise later, while the latter turns noise into red lights and eventually trains people to disable alerts |

One attribution defect was also corrected: the WARN message used to say "suspected platform / Node-version difference", but the measured run used the same Node 22.22.2 as the baselines — the real causes were **CRLF line endings** and a **platform string baked into the baseline header**, neither of which is a floating-point issue. Both are now eliminated, so `env-diff` only tolerates equivalent version/platform substitutions and numeric last digits within a 1e-9 relative bound, and reports the first offending line (`L{n}`) instead of leaving you to guess.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 7 checks FAIL with `FileNotFoundError: [WinError 2]` | Node missing or not on PATH | Install Node ≥ 22, verify `node --version` |
| `git status` shows `events.jsonl` modified, `git diff` empty | Windows `core.autocrlf=true` line endings | `git checkout -- tools/audit-panel/data/events.jsonl` |
| `--tamper-demo` exits 0, "so the check did nothing" | The demo runs in memory and writes nothing; 0 means "chain verified AND demo behaved as expected" | Expected. For red see §3. The opposite is what to watch: if the demo **fails to detect**, the command exits 1 (since v2.72.5) |
| `[seq 13] SKIP：沙箱现场不存在（CI 干净 clone）` | V2 realagent artifacts depend on a sandbox site not committed | Expected. Allow-list / numeric / chain checks unaffected |
| `EADDRINUSE` | Port 7727 taken | `--port=7811` |
| Path errors with backslashes in Git Bash | Windows paths | Use forward slashes or quote the whole path |
| Python 3.7 or older | Too old | Upgrade to ≥ 3.8 (CI uses 3.12) |

---

## 6. What this guide does not cover

- **tier-1 API tier**: `AOE-ABSTAIN-001/002`, `AOE-CALIB-004` and others need model API keys; per-item conditions and cost ceilings are in [`spec/13-boundaries.md`](spec/13-boundaries.md).
- **V2 realagent sessions are not re-runnable**: they are LLM-in-the-loop artifacts; the repository offers **static re-verification** only (chain recomputation, rejected tools ∈ full declaration and ∉ allow-list, budget arithmetic). Artifacts are labelled "not reproducible · self-tested behavioural record".
- **CALIB-007 conclusions do not upgrade because of this guide**: the three applicability boundaries in `APPLICABILITY-AOE-CALIB-007-R1.md`, including "verified deployable does not hold", remain unchanged. Reproducing the **mechanism** here is not reproducing that **experiment batch**.
- **macOS**: not measured.

---

## 7. Reporting results

- Replication **succeeded**: use the [`independent-replication`](https://github.com/ZhangRui987/agent-oversight-framework/issues/new?template=independent-replication.yml) issue template.
- Replication **failed** (including any sentence here that does not match your output): that is data too. Attach the **full command + full output + version triple** (`node --version`, `python --version`, `cat VERSION`). A conclusion without output cannot be located.
- Process questions: [Discussions "复现答疑"](https://github.com/ZhangRui987/agent-oversight-framework/discussions/categories/q-a).

---

**Back**: [`README.md`](README.md) ｜ reproducibility boundaries: [`spec/13-boundaries.md`](spec/13-boundaries.md) ｜ evidence grading: [`spec/11-traceability.md`](spec/11-traceability.md)
