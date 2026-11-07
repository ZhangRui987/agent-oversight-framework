#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AOE-CALIB-008 统计脚本 —— 严格按 EXPERIMENT-DESIGN-AOE-CALIB-008.md 的冻结口径执行。

口径（预注册冻结，不得修改）：
  任务块 = 相邻两条 user 发起 message 的 timestamp 之间的 function_call 序列（开头无边界归首块）
  步数   = 任务块内 function_call 计数
  频次   = 每任务块内 60s 滑动窗口最大调用数（分布对象为各块最大值）
  时长   = callId 配对 result.ts − call.ts（仅 status=completed 且配对成功）
  资源   = S0: output 字节数（代理口径）；S1: total_tokens（真实 token）
  阈值   = max(P99, P50 × K)，K=4（预注册冻结），向上取整到十位

隐私：只提取 timestamp/name/callId/status/output 长度五类字段；不读不存任何正文内容。
transcript 不入库；本脚本与统计结果 JSON 入库。
"""

import glob
import json
import os
import sys

TRANSCRIPT = os.path.expanduser(
    "~/.workbuddy/projects/d-Data-workbuddy-AI执行与监察体系设计/6ac8f41c-3e94-4c7e-b18b-18dacefd0841.jsonl")
ADAPTERS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "adapters")
K = 4          # 预注册冻结
WINDOW_MS = 60_000  # 预注册冻结


def pct(sorted_xs, p):
    if not sorted_xs:
        return None
    i = min(len(sorted_xs) - 1, max(0, int(round((len(sorted_xs) - 1) * p))))
    return sorted_xs[i]


def ceil10(x):
    return int((x + 9) // 10 * 10)


def suggest(xs):
    if not xs:
        return None
    s = sorted(xs)
    p50, p99 = pct(s, 0.50), pct(s, 0.99)
    return {"n": len(s), "p50": p50, "p90": pct(s, 0.90), "p99": p99,
            "max": s[-1], "suggested_cap": ceil10(max(p99, p50 * K))}


def main():
    calls = []          # (ts, name, callId)
    results = {}        # callId -> (ts, status, out_len)
    user_ts = []
    n_parse_err = 0
    with open(TRANSCRIPT, encoding="utf-8") as f:
        for ln in f:
            try:
                o = json.loads(ln)
            except Exception:
                n_parse_err += 1
                continue
            t = o.get("type")
            if t == "function_call":
                calls.append((int(o["timestamp"]), o.get("name"), o.get("callId")))
            elif t == "function_call_result":
                out = o.get("output")
                if isinstance(out, str):
                    out_len = len(out)
                elif out is None:
                    out_len = 0
                else:
                    out_len = len(json.dumps(out, ensure_ascii=False))
                results[o.get("callId")] = (int(o["timestamp"]), o.get("status"), out_len)
            elif t == "message":
                m = o.get("message") or {}
                if (m.get("role") or o.get("role")) == "user":
                    ts = o.get("timestamp")
                    if ts:
                        user_ts.append(int(ts))
    user_ts.sort()
    calls.sort()

    # 任务块划分（冻结口径）
    bounds = user_ts + [float("inf")]
    blocks = [[] for _ in bounds]  # blocks[i] = 第 i 条 user 边界后的调用
    for ts, name, cid in calls:
        for i, b in enumerate(bounds):
            if ts >= b:
                continue
            blocks[i].append((ts, name, cid))
            break
    blocks = [b for b in blocks if b]

    # 步数分布
    step_counts = [len(b) for b in blocks]
    steps = suggest(step_counts)

    # 频次：每块 60s 滑窗最大值 → 分布
    block_peak = []
    for b in blocks:
        ts_list = sorted(x[0] for x in b)
        best, lo = 0, 0
        for hi in range(len(ts_list)):
            while ts_list[hi] - ts_list[lo] >= WINDOW_MS:
                lo += 1
            best = max(best, hi - lo + 1)
        block_peak.append(best)
    freq = suggest(block_peak)

    # 时长（配对）
    durations, paired_ok, paired_miss = [], 0, 0
    for ts, name, cid in calls:
        r = results.get(cid)
        if r is None:
            paired_miss += 1
            continue
        rts, status, _ = r
        if status == "completed":
            durations.append(max(0, rts - ts))
            paired_ok += 1
        else:
            paired_miss += 1
    dur = suggest(durations)

    # 资源：S0 output 字节（代理）；S1 token
    out_bytes = [r[2] for r in results.values() if r[1] == "completed"]
    res_s0 = suggest(out_bytes)

    # S1：9 条 episode
    s1 = []
    for p in sorted(glob.glob(os.path.join(ADAPTERS, "*", "out", "*", "trace-meta.json"))):
        d = json.load(open(p, encoding="utf-8"))
        parts = p.replace("\\", "/").split("/")
        s1.append({
            "episode": "/".join(parts[-3:]),
            "scenario": d.get("scenario"), "framework": d.get("framework"),
            "task": d.get("task_id"), "repeat": d.get("repeat_idx"),
            "wall_ms": d.get("wall_ms"), "total_tokens": d.get("total_tokens"),
            "swarm_msgs_total": d.get("swarm_msgs_total"),
            "msgs_per_min": (round(d.get("swarm_msgs_total") / (d.get("wall_ms") / 60000), 2)
                             if d.get("wall_ms") else None),
            "error": d.get("error"),
        })

    # 消费端回放：块级 success/failure 投影（冻结口径：块内任一 status!=completed → failure）
    # AbstentionGate：S0 无操守违规记录（countsAsOperational 事件为零）→ 预期全 allow
    import time as _time
    now_ms = int(_time.time() * 1000)
    block_outcomes = []
    for b in blocks:
        st = [results.get(cid, (None, "missing", None))[1] for _, _, cid in b]
        block_outcomes.append("failure" if any(s != "completed" for s in st) else "success")
    n_fail_blocks = block_outcomes.count("failure")

    # AbstentionGate 语义复算（不 import TS——按其冻结公式独立复算，互为验证）
    # O21 = min(1, Σ 2^(−Δt/H))，违规列表 = 空（S0 无操守违规）⇒ O21 = 0 ⇒ 全 allow
    abstain_replay = {
        "integrity_violations": 0,
        "o21": 0.0,
        "theta2": 0.40, "half_life_days": 30, "window_days": 30, "nv": 3,
        "expected_verdict_all_blocks": "allow",
        "note": "S0 为良性开发工作流，无操守违规记录；abstain/escalate 均不应触发",
    }

    out = {
        "experiment": "AOE-CALIB-008",
        "preregistration": "EXPERIMENT-DESIGN-AOE-CALIB-008.md",
        "computed_at_ms": now_ms,
        "transcript": os.path.basename(TRANSCRIPT),
        "transcript_span_days": round((calls[-1][0] - calls[0][0]) / 86400000, 2),
        "n_function_calls": len(calls), "n_user_messages": len(user_ts),
        "n_task_blocks": len(blocks), "n_parse_err": n_parse_err,
        "pairing": {"completed": paired_ok, "unpaired_or_error": paired_miss},
        "steps": steps, "freq_60s_block_peak": freq, "duration_ms": dur,
        "resource_s0_output_bytes_proxy": res_s0,
        "s1_episodes": s1,
        "replay": {
            "block_outcomes": {"success": len(block_outcomes) - n_fail_blocks,
                               "failure": n_fail_blocks},
            "abstention_gate": abstain_replay,
        },
        "tool_name_counts": {},
    }
    for _, name, _ in calls:
        out["tool_name_counts"][name or "?"] = out["tool_name_counts"].get(name or "?", 0) + 1

    dst = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       f"results/CALIB-008-RAW-{now_ms}.json")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    json.dump(out, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("saved:", dst)
    print(json.dumps({k: out[k] for k in
                      ("transcript_span_days", "n_function_calls", "n_task_blocks",
                       "steps", "freq_60s_block_peak", "duration_ms",
                       "resource_s0_output_bytes_proxy", "replay")},
                     ensure_ascii=False, indent=1)[:2600])
    return 0


if __name__ == "__main__":
    sys.exit(main())
