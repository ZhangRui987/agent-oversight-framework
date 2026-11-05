#!/usr/bin/env python3
"""AOE-CALIB-007 · 双人核对的信息集不对称敏感性分析（独立脚本）

**为什么需要它**：A 侧判类人在判类前除《判类规约 v1》外，还完整读过协调人的书面任务简报，
其中含三处**规约之外的内容提示**（详见规约 附录 C）：CrewAI「全是 [REPORT]、一条 assign 都没有」
（直接指向非 D）、LangGraph 五条示例正文（C-01/02/03/04/07，含 `Transferring back to supervisor`）、
以及「`Transferring back to supervisor`、`__unresolved__` 正是要测的，别跳过」（注意力引导）。
B 侧信息集只有「规约 + 四句操作说明」。**A/B 信息集不对称是已登记在案的既成事实**，
不能靠事后解释消化，只能靠预先声明的敏感性口径消化。

**它回答什么**：同一批样本在不同子集上，一致性（κ / AC1）与标记-语义不一致率各是多少，
从而判断「κ 若偏低，是否由信息不对等驱动」。

**它不回答什么**：它**不**产生替代主结论。主结论仍以全量 S0 为准（规约 附录 C 第 3 条）。
子集结果只用于**归因**，不得反过来替换主结论，否则就是挑子集凑一致性。

**与 merge-review.py 的关系**：完全独立、不 import、不写同一批产物。
统计公式按 `merge-review.py` 的同口径**重写一份**（Cohen's κ / Gwet's AC1 / Clopper-Pearson），
两侧数值若有差异必须能逐位解释；一旦发现不一致，以 merge-review 为准并修本脚本。

**已知的实现差异（无害，但写在这里防止被说成「实现相同」）**：
`merge-review.py` 对「双方均无法裁定」的行单列 `undecided` 标签并计数；本脚本对非有效类行
**直接排除出统计**，不贴该标签。两者对**有效类数据**结果相同（κ 分母守卫、一致取值、
分歧取 `--arb`、待仲裁不进不一致率分子，逐条与 merge-review 一致）。本批预期待判 33 条两侧全有效，
该路径不触发。措辞边界登记于规约 附录 C §9.1。

用法
----
    # 单侧（B 未交回时）：只看 A 侧不一致率在子集上的分布
    python sensitivity-review.py --judge A --batch REVIEW-20261104-SENS

    # 双侧（B 交回后）：出 κ / AC1 / 判读
    python sensitivity-review.py --a out/判类表_autogen_A.csv \
        --b out/判类表_autogen_B.csv --batch REVIEW-20261104-SENS
    # 注：--a/--b 可各给多次，脚本按别名合并；也可用 --dir 扫 out/ 下 *_A.csv / *_B.csv

    python sensitivity-review.py --selftest      # 合成缺陷自检（4 项）
"""

from __future__ import annotations

import argparse
import csv
import glob
import hashlib
import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone, timedelta
from math import comb

HERE = os.path.dirname(os.path.abspath(__file__))
CLASSES = ("D", "H", "R", "C")
ASSIGN_TYPES = {"task_assign", "dispatch", "delegate", "subtask_assign"}
UNRESOLVED = {"", "无法裁定", "X", "?"}

# ── 预暴露清单（冻结，2026-11-04 22:40 依 A 侧书面披露确定）──────────────────
# 任务简报中逐字出现过正文的 5 条 LangGraph 消息（C-01/02/03/04/07）。
# 用 sid 而非别名定义：别名随抽样批次变，sid 是语料内稳定标识。
PREEXPOSED_SIDS = {
    "langgraph/benign-A__T01__r1#1",
    "langgraph/benign-A__T01__r1#2",
    "langgraph/benign-A__T01__r1#3",
    "langgraph/benign-A__T01__r1#4",
    "langgraph/benign-A__T01__r1#7",
}
CREWAI_PREFIX = "crewai/"
AUTOGEN_PREFIX = "autogen/"


# ── 统计（与 merge-review.py 同口径，独立实现）──────────────────────────────
def cohen_kappa(a: list[str], b: list[str]) -> tuple[float, float, float]:
    n = len(a)
    if n == 0:
        return 0.0, 0.0, 0.0
    po = sum(1 for x, y in zip(a, b) if x == y) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum((ca[c] / n) * (cb[c] / n) for c in CLASSES)
    if pe >= 1.0:
        return po, pe, 1.0
    return po, pe, (po - pe) / (1 - pe)


def gwet_ac1(a: list[str], b: list[str]) -> tuple[float, float, float]:
    n = len(a)
    q = len(CLASSES)
    if n == 0 or q < 2:
        return 0.0, 0.0, 0.0
    po = sum(1 for x, y in zip(a, b) if x == y) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum((((ca[c] + cb[c]) / (2 * n)) * (1 - (ca[c] + cb[c]) / (2 * n))) for c in CLASSES) / (q - 1)
    if pe >= 1.0:
        return po, pe, 1.0
    return po, pe, (po - pe) / (1 - pe)


def cp_ci(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    """Clopper-Pearson 精确区间（二项式和直接求解，不依赖 scipy）。"""
    if n == 0:
        return 0.0, 1.0

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


# ── 子集定义（冻结；规则写成函数，但只剩「按 sid 前缀 / 按 sid 集合」两种，无自由度）──
SUBSET_SPECS = [
    ("S0", "全量（主报告值，含已披露污染）", lambda sid: True),
    ("S1", "剔除 CrewAI 4 条（简报点名该框架「全是 REPORT」）", lambda sid: not sid.startswith(CREWAI_PREFIX)),
    ("S2", "S1 再剔除预暴露正文 5 条（C-01/02/03/04/07）",
     lambda sid: not sid.startswith(CREWAI_PREFIX) and sid not in PREEXPOSED_SIDS),
    ("S3", "仅 AutoGen：无针对具体条目的内容提示（**非**「零任何接触」，见规约 附录 C §9.2）",
     lambda sid: sid.startswith(AUTOGEN_PREFIX)),
    ("X", "仅预暴露 5 条（观察用，不参与判读）", lambda sid: sid in PREEXPOSED_SIDS),
]


def read_sheet(path: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            al = (r.get("别名") or "").strip()
            if not al:
                continue
            out[al] = {"cls": (r.get("判类(D/H/R/C)") or "").strip().upper(),
                       "hard": (r.get("疑难(Y/N)") or "").strip().upper(),
                       "note": (r.get("备注") or "").strip()}
    return out


def read_arb(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        return {(r.get("别名") or "").strip(): (r.get("终判") or "").strip().upper()
                for r in csv.DictReader(f) if (r.get("别名") or "").strip()}


def collect_sheets(judge: str, out_dir: str, explicit: list[str] | None) -> dict[str, dict]:
    paths = explicit or sorted(glob.glob(os.path.join(out_dir, f"判类表_*_{judge}.csv")))
    if not paths:
        raise SystemExit(f"未找到判类表_*_{judge}.csv")
    merged: dict[str, dict] = {}
    for p in paths:
        for al, v in read_sheet(p).items():
            if al in merged:
                raise SystemExit(f"别名 {al} 在多个文件中重复（{p}）")
            merged[al] = v
    return merged


def subset_hash(frame: dict, name: str, sids: list[str]) -> str:
    payload = json.dumps({"name": name, "sids": sorted(sids)}, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def now_utc8() -> str:
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M UTC+8")


def judge_cn(kappa: float, po: float, ac1: float) -> str:
    """与规约 附录 B 三档一致（此处只用于子集旁证，不替代主结论）。"""
    if po >= 0.90 and kappa >= 0.60:
        return "正常"
    if po >= 0.90 and kappa < 0.60 and ac1 >= 0.80:
        return "κ 悖论（边际偏斜）"
    if po < 0.90:
        return "未定标"
    return "存疑"


def selftest(frame_path: str) -> int:
    """构造两份已知差异的判类表，验证子集机制能把差异**定位到子集**。

    缺陷设计：
      ① B 只在预暴露 5 条上与 A 不同（模拟「不对称驱动分歧」）
         ⇒ 预期 S0 κ 明显低于 S3 κ，且 S2 κ > S0 κ；
      ② B 只在非预暴露的 AutoGen 条目上与 A 不同（模拟「分歧与不对称无关」）
         ⇒ 预期 S3 κ 明显低于 S0 κ，S2 与 S0 接近。
    """
    frame = json.load(open(frame_path, encoding="utf-8"))
    amap = frame["alias_map"]
    marker_to_cls = {"assign": "D", "report": "R", "freeform": "C", "other": "C"}
    base = {al: marker_to_cls.get(m["stratum"], "C") for al, m in amap.items()}

    def run(A: dict, B: dict) -> dict:
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            def dump(path: str, data: dict) -> None:
                with open(path, "w", encoding="utf-8-sig", newline="") as f:
                    w = csv.writer(f)
                    w.writerow(["序号", "别名", "判类(D/H/R/C)", "疑难(Y/N)", "备注"])
                    for i, al in enumerate(sorted(data, key=lambda x: int(x.split("-")[1])), 1):
                        w.writerow([i, al, data[al], "", ""])
            pa, pb = os.path.join(td, "A.csv"), os.path.join(td, "B.csv")
            dump(pa, A)
            dump(pb, B)
            out_md = os.path.join(td, "r.md")
            argv = sys.argv
            sys.argv = ["sensitivity-review.py", "--a", pa, "--b", pb, "--frame", frame_path,
                        "--batch", "SELFTEST", "--out", out_md]
            try:
                rc = main()
            finally:
                sys.argv = argv
            if rc != 0:
                raise SystemExit("SELFTEST FAIL: main() 返回非 0")
            return json.load(open(os.path.splitext(out_md)[0] + ".summary.json", encoding="utf-8"))

    flip = {"D": "R", "R": "C", "C": "R", "H": "C"}
    # 场景①：B 在预暴露 5 条上翻转
    B1 = dict(base)
    for al, m in amap.items():
        if m["sid"] in PREEXPOSED_SIDS:
            B1[al] = flip[base[al]]
    s1 = run(dict(base), B1)
    # 场景②：B 在非预暴露的 AutoGen 条目上翻转
    B2 = dict(base)
    for al, m in amap.items():
        if m["sid"].startswith(AUTOGEN_PREFIX) and m["sid"] not in PREEXPOSED_SIDS:
            B2[al] = flip[base[al]]
    s2 = run(dict(base), B2)

    def k(s: dict, name: str) -> float:
        return s["subsets"][name]["kappa"]

    checks = [
        ("场景①：S0 κ < S3 κ（差异被预暴露子集污染）", k(s1, "S0") < k(s1, "S3"), f"{k(s1,'S0'):.3f} vs {k(s1,'S3'):.3f}"),
        ("场景①：S2 κ > S0 κ（剔除后回升）", k(s1, "S2") > k(s1, "S0"), f"{k(s1,'S2'):.3f} vs {k(s1,'S0'):.3f}"),
        ("场景②：S3 κ < S0 κ（分歧落在无内容提示的子集，与被剔除子集无关）", k(s2, "S3") < k(s2, "S0"),
         f"{k(s2,'S3'):.3f} vs {k(s2,'S0'):.3f}"),
        # 关键断言是「剔除预暴露子集换不来改善」，而不是「S2 与 S0 数值接近」：
        # 场景②里 20/24 都翻转，S2 的 κ 反而可能更低，那也是「无改善」。
        ("场景②：剔除后无改善（S2 − S0 ≤ 0.15）", k(s2, "S2") - k(s2, "S0") <= 0.15,
         f"S2−S0 = {k(s2,'S2')-k(s2,'S0'):+.3f}"),
    ]
    ok = True
    for name, passed, val in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}（实测 {val}）")
        ok = ok and passed
    print("SELFTEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", action="append", help="A 侧判类表（可多次）")
    ap.add_argument("--b", action="append", help="B 侧判类表（可多次；缺省则为单侧模式）")
    ap.add_argument("--dir", default=os.path.join(HERE, "out"))
    ap.add_argument("--judge", default="A", help="单侧模式下只读这一侧：A 或 B")
    ap.add_argument("--arb", help="仲裁表（列：别名,终判,依据）；与 merge-review.py 同规则")
    ap.add_argument("--frame", default=os.path.join(HERE, "out", "sample-frame.json"))
    ap.add_argument("--batch", default="REVIEW-UNNAMED-SENS")
    ap.add_argument("--out", default=None)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest(args.frame)

    frame = json.load(open(args.frame, encoding="utf-8"))
    amap = frame["alias_map"]
    arb = read_arb(args.arb)

    # 双侧唯一触发条件是「给了 --b」。只给 --a 或什么都不给 = 单侧模式（B 未交回时的常态），
    # 否则会拿一份全空的 B 表算出 κ=0，把「还没人填」误报成「完全不一致」。
    two_sided = bool(args.b)
    if two_sided:
        A = collect_sheets("A", args.dir, args.a)
        B = collect_sheets("B", args.dir, args.b)
        if set(A) != set(B):
            print(f"两份表别名集合不一致：仅 A {sorted(set(A)-set(B))}，仅 B {sorted(set(B)-set(A))}", file=sys.stderr)
            return 2
        if not any(v["cls"] in CLASSES for v in B.values()):
            print("B 表全空：双侧模式需要已填写的 B。单侧请去掉 --b。", file=sys.stderr)
            return 4
        sheets = {"A": A, "B": B}
    else:
        sheets = {args.judge: collect_sheets(args.judge, args.dir, args.a)}

    # 预暴露 sid 必须真实存在于本批 frame，否则说明 frame 被重抽、清单已失效 → 硬失败
    frame_sids = {m["sid"] for m in amap.values()}
    missing = PREEXPOSED_SIDS - frame_sids
    if missing:
        print(f"预暴露清单中的 sid 不在当前 frame：{sorted(missing)}", file=sys.stderr)
        print("frame 可能被重新抽样；附录 C 的子集定义须重新冻结，不得沿用旧清单。", file=sys.stderr)
        return 3

    aliases = sorted(amap, key=lambda x: int(x.split("-")[1]))
    rows = []
    for al in aliases:
        m = amap[al]
        rec = {"alias": al, "sid": m["sid"], "marker": m["marker_raw"],
               "stratum": m.get("stratum", ""), "from": m.get("from", ""), "to": m.get("to", "")}
        for side, sh in sheets.items():
            rec[side] = sh.get(al, {}).get("cls", "")
            rec[side + "_hard"] = sh.get(al, {}).get("hard", "")
        rows.append(rec)

    res = {}
    for name, desc, pred in SUBSET_SPECS:
        sub = [r for r in rows if pred(r["sid"])]
        sids = [r["sid"] for r in sub]
        entry = {"desc": desc, "n": len(sub),
                 "sids": sids, "sid_hash": subset_hash(frame, name, sids)}

        if two_sided:
            pa, pb = [], []
            mism = []
            pending_n = 0
            for r in sub:
                a, b = r["A"], r["B"]
                if a in CLASSES and b in CLASSES:
                    pa.append(a)
                    pb.append(b)
                    # 终判与 merge-review.py 同规则：一致取该值；不一致取 --arb；无仲裁则「待仲裁」，
                    # 不计入不一致率分子（否则未裁定的分歧会被当成映射错误，虚高不一致率）。
                    if a == b:
                        final = a
                    else:
                        final = arb.get(r["alias"], "")
                        if final not in CLASSES:
                            pending_n += 1
                            continue
                    if (r["marker"] in ASSIGN_TYPES) != (final == "D"):
                        mism.append(r)
            po, pe, kappa = cohen_kappa(pa, pb)
            _, pe_ac1, ac1 = gwet_ac1(pa, pb)
            entry.update({"rated": len(pa), "po": round(po, 4), "pe": round(pe, 4),
                          "kappa": round(kappa, 4), "ac1": round(ac1, 4),
                          "verdict": judge_cn(kappa, po, ac1),
                          "disagree": sum(1 for x, y in zip(pa, pb) if x != y),
                          "pending": pending_n,
                          "mismatch": len(mism),
                          "mismatch_rate": round(len(mism) / len(pa), 4) if pa else None})
        else:
            side = next(iter(sheets))
            rated = [r for r in sub if r[side] in CLASSES]
            mism = [r for r in rated if (r["marker"] in ASSIGN_TYPES) != (r[side] == "D")]
            n = len(rated)
            lo, hi = cp_ci(len(mism), n) if n else (0.0, 1.0)
            entry.update({"rated": n, "mismatch": len(mism),
                          "mismatch_rate": round(len(mism) / n, 4) if n else None,
                          "ci95": [round(lo, 4), round(hi, 4)],
                          "false_assign": sum(1 for r in mism if r["marker"] in ASSIGN_TYPES),
                          "missed_assign": sum(1 for r in mism if r["marker"] not in ASSIGN_TYPES)})
        res[name] = entry

    # 逐条：预暴露 5 条 + 全部不一致条
    detail = [r for r in rows if r["sid"] in PREEXPOSED_SIDS]
    others = [r for r in rows if r["sid"] not in PREEXPOSED_SIDS]
    if two_sided:
        detail += [r for r in others if (r["A"] in CLASSES and r["B"] in CLASSES) and (
            (r["marker"] in ASSIGN_TYPES) != (r["A"] == "D")
            or (r["marker"] in ASSIGN_TYPES) != (r["B"] == "D"))]
    else:
        side = next(iter(sheets))
        detail += [r for r in others if r[side] in CLASSES and (
            (r["marker"] in ASSIGN_TYPES) != (r[side] == "D"))]

    out_path = args.out or os.path.join(args.dir, f"敏感性分析_{args.batch}.md")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    mode = "双侧（A + B）" if two_sided else f"单侧（{next(iter(sheets))}）"

    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"# 信息集不对称 · 敏感性分析 · {args.batch}\n\n")
        f.write("> 本文件由 `sensitivity-review.py` 生成，**独立于 `merge-review.py`**，不修改其产物。\n")
        f.write("> 用途：为**已登记在案**的 A/B 信息集不对称提供可重算的归因口径。\n")
        f.write("> ⛔ **子集结果不得替代主结论**。主结论以 S0 全量为准（规约 附录 C 第 3 条）；\n")
        f.write("> 子集只回答「κ 若偏低，分歧落在哪」，不得据此挑子集入库。\n\n")

        f.write("## 一、元信息\n\n| 字段 | 值 |\n|---|---|\n")
        f.write(f"| 模式 | {mode} |\n")
        f.write(f"| 生成时间 | {now_utc8()} |\n")
        f.write(f"| 抽样种子 | `{frame['seed']}` |\n")
        f.write(f"| 语料指纹 | `{frame['corpus_sha256'][:16]}…`（{frame['corpus_size']} 条） |\n")
        f.write(f"| 本批样本 | {len(rows)} 条 |\n")
        f.write(f"| 预暴露清单 | {len(PREEXPOSED_SIDS)} 个 sid（规约 附录 C） |\n\n")

        f.write("## 二、子集定义（冻结，B 交回前确定）\n\n")
        f.write("| 子集 | 定义 | n | sid 清单 sha256 |\n|---|---|---|---|\n")
        for name, _, _ in SUBSET_SPECS:
            e = res[name]
            f.write(f"| `{name}` | {e['desc']} | {e['n']} | `{e['sid_hash'][:16]}…` |\n")
        f.write("\n> 子集只由「sid 前缀」与「冻结的预暴露 sid 集合」两种规则生成，**不含任何判类结果**——\n")
        f.write("> 即子集划分与「谁判对了」无关，排除「先看结果再划子集」的可能。\n\n")

        if two_sided:
            f.write("## 三、κ / AC1 分口径\n\n")
            f.write("| 子集 | n | 双方可判 | 分歧 | 待仲裁 | 不一致 | 率 | Po | **κ** | AC1 | Δκ vs S0 | 附录 B 判读 |\n")
            f.write("|---|---|---|---|---|---|---|---|---|---|---|---|\n")
            k0 = res["S0"]["kappa"]
            for name, _, _ in SUBSET_SPECS:
                e = res[name]
                if e["rated"] < 2:
                    f.write(f"| `{name}` | {e['n']} | {e['rated']} | — | — | — | — | — | — | — | — | 样本不足，不计算 |\n")
                    continue
                f.write(f"| `{name}` | {e['n']} | {e['rated']} | {e['disagree']} | {e['pending']} "
                        f"| {e['mismatch']} | {e['mismatch_rate']:.4f} | {e['po']:.3f} "
                        f"| **{e['kappa']:.3f}** | {e['ac1']:.3f} | {e['kappa']-k0:+.3f} | {e['verdict']} |\n")
            f.write("\n")
        else:
            f.write("## 三、单侧不一致率分口径\n\n")
            f.write("| 子集 | n | 已判 | 不一致 | 率 | CP 95% CI | 假派发 | 漏派发 | 区间上界 < 20%？ |\n")
            f.write("|---|---|---|---|---|---|---|---|---|\n")
            for name, _, _ in SUBSET_SPECS:
                e = res[name]
                if not e["rated"]:
                    f.write(f"| `{name}` | {e['n']} | 0 | — | — | — | — | — | — |\n")
                    continue
                lo, hi = e["ci95"]
                f.write(f"| `{name}` | {e['n']} | {e['rated']} | {e['mismatch']} | {e['mismatch_rate']:.4f} "
                        f"| [{lo:.4f}, {hi:.4f}] | {e['false_assign']} | {e['missed_assign']} "
                        f"| {'是' if hi < 0.20 else '否'} |\n")
            f.write("\n> 单侧模式**没有** Po、**没有** κ，只用来看量级分布；不得作为任何一致性证据。\n\n")

        f.write("## 四、逐条明细（预暴露 5 条 + 全部不一致条）\n\n")
        if two_sided:
            f.write("| 别名 | sid | 标记 | 预暴露 | A | B | 一致 | A 侧不一致 | B 侧不一致 |\n|---|---|---|---|---|---|---|---|---|\n")
            for r in detail:
                a, b = r["A"], r["B"]
                fa = "—" if a not in CLASSES else ("是" if (r["marker"] in ASSIGN_TYPES) != (a == "D") else "")
                fb = "—" if b not in CLASSES else ("是" if (r["marker"] in ASSIGN_TYPES) != (b == "D") else "")
                f.write(f"| {r['alias']} | `{r['sid']}` | `{r['marker']}` | {'★' if r['sid'] in PREEXPOSED_SIDS else ''} "
                        f"| {a or '—'} | {b or '—'} | {'✓' if a == b and a in CLASSES else '✗'} | {fa} | {fb} |\n")
        else:
            side = next(iter(sheets))
            f.write(f"| 别名 | sid | 标记 | 预暴露 | {side} 判类 | 不一致方向 |\n|---|---|---|---|---|---|\n")
            for r in detail:
                c = r[side]
                if c not in CLASSES:
                    d = "—"
                elif (r["marker"] in ASSIGN_TYPES) != (c == "D"):
                    d = "false_assign" if r["marker"] in ASSIGN_TYPES else "missed_assign"
                else:
                    d = ""
                f.write(f"| {r['alias']} | `{r['sid']}` | `{r['marker']}` | {'★' if r['sid'] in PREEXPOSED_SIDS else ''} "
                        f"| {c or '—'} | {d} |\n")
        f.write("\n")

        f.write("## 五、预注册判读规则（规约 附录 C 第 4 条，逐字适用于本表）\n\n")
        f.write("| 序 | 条件 | 判读 | 处置 |\n|---|---|---|---|\n")
        f.write("| 1 | `S3` κ < 0.60 | 规约未定标，**与信息不对等无关**（`S3` 无内容提示，见附录 C §9.2） | 回改规约、版本递增、**换未受污染的 A′ 重抽重判** |\n")
        f.write("| 2 | `S3` κ ≥ 0.60 且 `S0` κ < 0.60 | 低 κ 落在受污染子集上；规约在无内容提示的子集上可执行，但**本批全量 κ 不可用** | 记录须并列 S0/S1/S2/S3；**禁止**用 S2 替换主结论入库；补救只能换 A′ 重判受污染子集 |\n")
        f.write("| 3 | `S0` κ ≥ 0.60（无论 S3） | 无证据显示不对称改变了一致性 | 按附录 B 正常判读；不对称仍在 §七 照实披露 |\n\n")
        f.write("> 三条按顺序命中，先命中先适用。**任何情况下都不得**以「剔除后 κ 变好」为由宣布本批可入库。\n\n")

        f.write("## 六、结论（须人工填写）\n\n")
        f.write("1. **不对称是否驱动了分歧**：☐ 是 ☐ 否 ☐ 无法判定（说明：____）\n")
        f.write("2. **S3（无内容提示）κ**：____，是否 ≥ 0.60：☐ 是 ☐ 否\n")
        f.write("3. **本批一致性结论可用性**：☐ 可用 ☐ 仅内部预检 ☐ 须换 A′ 重判\n")
        f.write("4. **需回改规约之处**：\n\n")
    print(f"→ {out_path}")

    summary = {"batch": args.batch, "mode": mode, "generated": now_utc8(),
               "seed": frame["seed"], "corpus_sha256": frame["corpus_sha256"],
               "preexposed_sids": sorted(PREEXPOSED_SIDS),
               "subsets": {k: {kk: vv for kk, vv in v.items() if kk != "sids"} for k, v in res.items()}}
    with open(os.path.splitext(out_path)[0] + ".summary.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
        f.write("\n")

    if two_sided:
        print(" ".join(f"{k}:n={v['n']},κ={v.get('kappa','—')}" for k, v in res.items()))
    else:
        print(" ".join(f"{k}:n={v['n']},mism={v['mismatch']},rate={v['mismatch_rate']}" for k, v in res.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
