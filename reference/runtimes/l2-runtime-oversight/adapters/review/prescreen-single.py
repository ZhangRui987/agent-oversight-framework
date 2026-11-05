#!/usr/bin/env python3
"""单侧预检：只用**一份**判类表 + 标记，算「标记 vs 语义」不一致率。

它回答的问题：**在已判的这一侧，格式标记与语义判类差了多少、差在哪个方向。**
它**不回答**的问题：两人一致性（Po）与 κ —— 那需要有第二个人。

输出 `out/单侧预检_<批次>.md`，页首带免责横幅。**不得作为 §6.2 证据入库**，
只用于：① 在第二人交回前判断量级是否已逼近 20% 触发线；② 留下可重算的中间记录。

用法：
    python prescreen-single.py                       # 扫 out/ 下全部 *_A.csv
    python prescreen-single.py --judge B             # 或 *_B.csv
    python prescreen-single.py --batch REVIEW-xxx
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import sys
from collections import Counter
from math import comb

HERE = os.path.dirname(os.path.abspath(__file__))
ASSIGN_TYPES = {"task_assign", "dispatch", "delegate", "subtask_assign"}
CLASSES = ("D", "H", "R", "C")


def cp_ci(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Clopper-Pearson 精确区间。用二项式和直接求解，避免不完全 Beta 的方向错。

    下界：满足 P(X ≥ k; p) = α/2 的 p（k=0 时取下界 0）；
    上界：满足 P(X ≤ k; p) = α/2 的 p（k=n 时取上界 1）。
    """

    def cdf(p: float, kk: int) -> float:
        return sum(comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(0, kk + 1))

    def solve_inc(f, target: float) -> float:
        lo, hi = 1e-12, 1 - 1e-12
        for _ in range(200):
            m = (lo + hi) / 2
            if f(m) < target:
                lo = m
            else:
                hi = m
        return (lo + hi) / 2

    lower = 0.0 if k == 0 else solve_inc(lambda p: 1 - cdf(p, k - 1), alpha / 2)
    upper = 1.0 if k == n else solve_inc(lambda p: 1 - cdf(p, k), 1 - alpha / 2)
    return lower, upper


def read_sheet(path: str) -> dict[str, str]:
    out = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            out[(r.get("别名") or "").strip()] = (r.get("判类(D/H/R/C)") or "").strip()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--judge", default="A")
    ap.add_argument("--frame", default=os.path.join(HERE, "out", "sample-frame.json"))
    ap.add_argument("--batch", default="REVIEW-UNNAMED-PRESCREEN")
    args = ap.parse_args()

    frame = json.load(open(args.frame, encoding="utf-8"))
    amap = frame["alias_map"]

    paths = sorted(glob.glob(os.path.join(args.out, f"判类表_*_{args.judge}.csv")))
    if not paths:
        print(f"未找到判类表_*_{args.judge}.csv", file=sys.stderr)
        return 2

    rows = []
    for p in paths:
        fw = os.path.basename(p).split("_")[1]
        for al, cls in read_sheet(p).items():
            if al not in amap:
                print(f"{p} 的别名 {al} 不在 sample-frame 中", file=sys.stderr)
                return 2
            rows.append(
                {
                    "fw": fw,
                    "alias": al,
                    "sid": amap[al]["sid"],
                    "marker": amap[al]["marker_raw"],
                    "cls": cls,
                }
            )

    unfilled = [r["alias"] for r in rows if not r["cls"]]
    if unfilled:
        print(f"⚠️ 仍有 {len(unfilled)} 条未填：{unfilled[:10]}", file=sys.stderr)
    judged = [r for r in rows if r["cls"] in CLASSES]
    if not judged:
        print("没有可用的判类", file=sys.stderr)
        return 2

    cross = Counter()
    for r in judged:
        mk = "assign" if r["marker"] in ASSIGN_TYPES else r["marker"]
        cross[(mk, r["cls"])] += 1
    n = len(judged)
    agree = sum(v for (mk, c), v in cross.items() if (mk == "assign") == (c == "D"))
    disagree = n - agree
    rate = disagree / n
    lo, hi = cp_ci(disagree, n)

    mism_rows = [r for r in judged if (r["marker"] in ASSIGN_TYPES) != (r["cls"] == "D")]
    false_assign = [r for r in mism_rows if r["marker"] in ASSIGN_TYPES]
    missed_assign = [r for r in mism_rows if r["marker"] not in ASSIGN_TYPES]

    benign = [r for r in judged if "/benign" in r["sid"]]
    attack = [r for r in judged if "/attack" in r["sid"]]

    p = os.path.join(args.out, f"单侧预检_{args.batch}.md")
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"# 单侧预检 · {args.batch}\n\n")
        f.write("> ⛔ **本文件不是双人核对结果。** 只有一侧判类，**没有** Po、**没有** κ，\n")
        f.write("> 不得作为 §6.2「标记-语义不一致率」的证据入库，不得写进预注册或论文。\n")
        f.write("> 用途仅限：在第二个判类人交回前，判断量级是否已逼近 20% 触发线。\n\n")
        f.write(f"- 判类侧：**{args.judge}**\n")
        f.write(f"- 已判条数：{n}（未填 {len(unfilled)}）\n")
        f.write(f"- 语料指纹：`{frame['corpus_sha256'][:16]}…`\n")
        f.write(f"- 抽样种子：`{frame['seed']}`\n\n")

        f.write("## 标记 × 语义 交叉表\n\n")
        f.write("| 标记 | D | H | R | C | 合计 |\n|---|---|---|---|---|---|\n")
        for mk in ("assign", "note", "chat", "report", "freeform", "other"):
            v = [cross.get((mk, c), 0) for c in CLASSES]
            if sum(v):
                f.write(f"| `{mk}` | " + " | ".join(str(x) for x in v) + f" | {sum(v)} |\n")
        f.write(f"| **合计** | " + " | ".join(str(sum(cross.get((m, c), 0) for m in ('assign', 'note', 'chat', 'report', 'freeform', 'other'))) for c in CLASSES) + f" | {n} |\n\n")

        f.write("## 不一致率（单侧）\n\n")
        f.write(f"- 一致 {agree} / 不一致 **{disagree}** ⇒ **{rate:.4f}**\n")
        f.write(f"- Clopper-Pearson 95% CI：**[{lo:.4f}, {hi:.4f}]**\n")
        f.write(f"- 20% 触发线是否被区间排除：**{'是' if hi < 0.20 else '否（区间上界仍高于 20%，不能断言未触发）'}**\n")
        if hi >= 0.20 and rate < 0.20:
            f.write("- ⚠️ 点估计低于 20% 但区间上界高于 20%：**样本量不足以支持「未触发」的结论**。\n")
            f.write("  这不算触发降级，但也**不许**写成「不一致率 9% < 20%，故类型维可靠」。\n")
        f.write("\n")
        f.write("| 方向 | 条数 | 对 S1 分子的影响 |\n|---|---|---|\n")
        f.write(f"| 假派发 `false_assign`（标记 assign、语义非 D） | {len(false_assign)} | 分子偏大 → H1 更难、H4 更易 |\n")
        f.write(f"| 漏派发 `missed_assign`（标记非 assign、语义 D） | {len(missed_assign)} | 分子偏小 → H1 更易、H4 更难 |\n\n")

        if mism_rows:
            f.write("## 不一致条目\n\n| 别名 | 框架 | sid | 标记 | 语义 | 方向 |\n|---|---|---|---|---|---|\n")
            for r in mism_rows:
                d = "false_assign" if r["marker"] in ASSIGN_TYPES else "missed_assign"
                f.write(f"| {r['alias']} | {r['fw']} | `{r['sid']}` | `{r['marker']}` | {r['cls']} | {d} |\n")
            f.write("\n")

        f.write("## 轨道侧分布（仅协调人可见）\n\n")
        f.write("| 轨道类型 | 条数 | 判 D | 标记 assign |\n|---|---|---|---|\n")
        for name, sub in (("良性", benign), ("攻击", attack)):
            f.write(f"| {name} | {len(sub)} | {sum(1 for r in sub if r['cls'] == 'D')} "
                    f"| {sum(1 for r in sub if r['marker'] in ASSIGN_TYPES)} |\n")
        f.write("\n")

    print(f"n={n} 一致={agree} 不一致={disagree} 单侧不一致率={rate:.4f} CI=[{lo:.4f},{hi:.4f}] "
          f"（false_assign {len(false_assign)} / missed_assign {len(missed_assign)}）")
    print(f"→ {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
