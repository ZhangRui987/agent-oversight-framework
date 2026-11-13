#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AOE-CALIB-012 统计脚本 —— 严格按 EXPERIMENT-DESIGN-AOE-CALIB-012.md 冻结口径执行。

沿 CALIB-008 的 calibrate-runtime-params.py 提取核心（schema 已验证），扩展为多项目任务族：
  族映射   = 目录名关键词（冻结 §2.1）：AI执行与监察体系设计→F1 / 秋招→F2 /
             专业方向探索助手→F3 / 学年论文|论文→F4 / 其余→F0；*开源执行层* 排除
  入选线   = 目录任务块数 ≥ 10（冻结 §2.2）；族入选线 = 族任务块 n ≥ 30 才出上限
  口径     = 沿 CALIB-008 §三逐字冻结（块/步数/60s 滑窗/callId 配对/字节代理）
  K=4      = max(P99, P50×4) 向上取整到十位（继承，不重调）
  H1″      = 至少一类指标族间 P99 比值（max/min，仅计有上限族）≥ 2

隐私：只提取 timestamp/name/callId/status/output 长度五类字段 + 目录名；
transcript 不入库；产出 = 会话清单（纯元数据）+ 聚合统计 JSON。
用法：
  python calibrate-runtime-params-families.py inventory [--out=<json>]   # 阶段1：清点
  python calibrate-runtime-params-families.py stats     [--out=<json>]   # 阶段2：统计
"""

import glob
import json
import os
import re
import sys

PROJECTS = os.path.expanduser("~/.workbuddy/projects")
K = 4
WINDOW_MS = 60_000
DIR_MIN_BLOCKS = 10      # 用户裁决 ②：目录入选线
FAMILY_MIN_BLOCKS = 30   # 用户裁决 ③：族小样本线
H1_RATIO = 2.0           # 用户裁决 ⑥：分化阈值

FAMILY_RULES = [
    ("F1-framework", "AI执行与监察体系设计"),
    ("F2-jobhunt", "秋招"),
    ("F3-appdev", "专业方向探索助手"),
    ("F4-paper", "论文"),
]
EXCLUDE_PAT = re.compile(r"开源执行层")


def family_of(dirname: str) -> str:
    if EXCLUDE_PAT.search(dirname):
        return "EXCLUDED"
    for fam, kw in FAMILY_RULES:
        if kw in dirname:
            return fam
    return "F0-other"


def pct(sorted_xs, p):
    if not sorted_xs:
        return None
    i = min(len(sorted_xs) - 1, max(0, int(round((len(sorted_xs) - 1) * p))))
    return sorted_xs[i]


def ceil10(x):
    return int((x + 9) // 10 * 10)


def parse_session(path):
    """提取五字段 + 计数（不读不存任何正文）。返回 None = 文件不可读。"""
    calls, results, user_ts, n_err = [], {}, [], 0
    try:
        with open(path, encoding="utf-8") as f:
            for ln in f:
                try:
                    o = json.loads(ln)
                except Exception:
                    n_err += 1
                    continue
                t = o.get("type")
                if t == "function_call":
                    calls.append((int(o["timestamp"]), o.get("callId")))
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
                    if (m.get("role") or o.get("role")) == "user" and o.get("timestamp"):
                        user_ts.append(int(o["timestamp"]))
    except (OSError, UnicodeDecodeError) as e:
        return {"unreadable": str(e)[:120]}
    user_ts.sort()
    # 任务块（沿 CALIB-008 口径）：相邻 user 消息之间的调用序列，开头无边界归首块
    blocks = []
    if calls:
        cuts = sorted({sum(1 for c in calls if c[0] < ts) for ts in user_ts})
        prev = 0
        for cut in cuts + [len(calls)]:
            if cut > prev:
                blocks.append(calls[prev:cut])
            prev = cut
    # callId 配对：字典映射（重复 callId 取首次出现的 call 时间戳）
    call_ts = {}
    for ts, cid in calls:
        call_ts.setdefault(cid, ts)
    durations, out_lens = [], []
    for cid, (rts, status, ol) in results.items():
        ct = call_ts.get(cid)
        if ct is not None and status == "completed":
            durations.append(rts - ct)
            out_lens.append(ol)
    return {"n_calls": len(calls), "blocks": blocks,
            "durations": durations, "out_lens": out_lens, "n_parse_err": n_err}


def block_stats(blocks):
    steps = [len(b) for b in blocks]
    freqs = []
    for b in blocks:
        ts = sorted(t for t, _ in b)
        best, j = 0, 0
        for i in range(len(ts)):
            while ts[i] - ts[j] > WINDOW_MS:
                j += 1
            best = max(best, i - j + 1)
        freqs.append(best)
    return steps, freqs


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "inventory"
    out_path = None
    for a in sys.argv[2:]:
        if a.startswith("--out="):
            out_path = a[6:]

    sessions = []  # (fam, dir, sessionId, path)
    for d in sorted(os.listdir(PROJECTS)):
        full = os.path.join(PROJECTS, d)
        if not os.path.isdir(full):
            continue
        fam = family_of(d)
        if fam == "EXCLUDED":
            continue
        for p in glob.glob(os.path.join(full, "*.jsonl")):
            if p.endswith(".file-rollback.ndjson"):
                continue
            sessions.append((fam, d, os.path.basename(p)[:-6], p))

    parsed, unreadable = [], []
    for fam, d, sid, path in sessions:
        r = parse_session(path)
        if r is None or "unreadable" in r:
            unreadable.append({"family": fam, "dir": d, "session": sid,
                               "error": (r or {}).get("unreadable", "open failed")})
            continue
        parsed.append((fam, d, sid, r))

    # ── 目录级清点 ──
    dir_blocks = {}
    for fam, d, sid, r in parsed:
        dir_blocks[(fam, d)] = dir_blocks.get((fam, d), 0) + len(r["blocks"])
    inventory = {
        "n_project_dirs": len({d for _, d, _, _ in parsed}) + len({u["dir"] for u in unreadable}),
        "n_sessions": len(parsed),
        "n_unreadable": len(unreadable),
        "unreadable": unreadable,
        "dirs": [{"family": f, "dir": d, "blocks": dir_blocks[(f, d)],
                  "selected": dir_blocks[(f, d)] >= DIR_MIN_BLOCKS}
                 for (f, d) in sorted(dir_blocks)],
    }

    if mode == "inventory":
        print(json.dumps(inventory, ensure_ascii=False, indent=1))
        if out_path:
            json.dump(inventory, open(out_path, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
        return

    # ── 统计阶段：入选目录的块按族聚合 ──
    fam_data = {}  # fam -> {"steps": [], "freqs": [], "dur": [], "out": [], "sessions": set, "dirs": set}
    for fam, d, sid, r in parsed:
        sel = dir_blocks.get((fam, d), 0) >= DIR_MIN_BLOCKS
        if not sel or fam == "F0-other":
            continue
        g = fam_data.setdefault(fam, {"steps": [], "freqs": [], "dur": [], "out": [],
                                      "sessions": set(), "dirs": set()})
        st, fr = block_stats(r["blocks"])
        g["steps"] += st
        g["freqs"] += fr
        g["dur"] += r["durations"]
        g["out"] += r["out_lens"]
        g["sessions"].add(sid)
        g["dirs"].add(d)

    def summarize(xs, family_n):
        s = sorted(xs)
        p50, p90, p99 = pct(s, .5), pct(s, .9), pct(s, .99)
        row = {"n": len(s), "p50": p50, "p90": p90, "p99": p99, "max": s[-1] if s else 0}
        if family_n >= FAMILY_MIN_BLOCKS:
            row["suggested_cap"] = ceil10(max(p99, p50 * K))
        return row

    report = {"families": {}, "calib008_note":
              "F1 包含 CALIB-008 S0 会话（6ac8f41c…，89 块）作为子集——来源双登记，非独立重采"}
    for fam, g in sorted(fam_data.items()):
        n_blocks = len(g["steps"])
        report["families"][fam] = {
            "n_blocks": n_blocks, "n_sessions": len(g["sessions"]),
            "n_dirs": len(g["dirs"]),
            "steps": summarize(g["steps"], n_blocks),
            "freq": summarize(g["freqs"], n_blocks),
            "dur_ms": summarize(g["dur"], n_blocks),
            "out_bytes": summarize(g["out"], n_blocks),
        }

    # H1″：族间 P99 比值（仅计有上限的族）
    h1 = {}
    for metric in ("steps", "freq", "dur_ms", "out_bytes"):
        p99s = {f: rep[metric]["p99"] for f, rep in report["families"].items()
                if rep[metric].get("suggested_cap") and rep[metric]["p99"]}
        if len(p99s) >= 2:
            mx, mn = max(p99s.values()), min(p99s.values())
            h1[metric] = {"p99_by_family": p99s, "ratio": round(mx / mn, 2) if mn else None,
                          "differentiated": bool(mn and mx / mn >= H1_RATIO)}
    report["H1_family_differentiation"] = h1
    report["H1_conclusion"] = (
        "分化成立" if any(v["differentiated"] for v in h1.values()) else "全部同分布")

    print(json.dumps(report, ensure_ascii=False, indent=1))
    if out_path:
        json.dump(report, open(out_path, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
