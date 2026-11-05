#!/usr/bin/env python3
"""AOE-CALIB-007 · 标记/语义双人核对 —— 合并两份判类表并算统计

输入：判类表_<fw>_A.csv、判类表_<fw>_B.csv（由 make-review-sample.py 生成，两人各自填写）、
      sample-frame.json（抽样凭据，回填标记用）。
输出：核对记录_<批次>.md（按《核对记录模板 v1》的字段自动填充）+ summary JSON。

设计取舍
--------
- **不一致不猜**：两人判类不同且未提供仲裁表时，该条记「待仲裁」，不计入终判统计，
  但仍然计入 κ 的分母（κ 是评分者间一致性，与终判无关）。
- **标记是后回填的**：判类阶段两份表里没有标记列，这里从 alias_map 取，
  所以「判类人在填表时不可能看到标记」这件事由数据流保证，而不是靠口头约定。
- **结构性空层照实报**：某框架 assign 层可用量为 0 时，报「结构性空层」而不是「样本不足」。

用法
----
    python merge-review.py --a out/判类表_autogen_A.csv --b out/判类表_autogen_B.csv \
        --frame out/sample-frame.json --batch REVIEW-20261104-01
    # 可选：--arb 仲裁表.csv（列：别名,终判,依据）
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
CLASSES = ("D", "H", "R", "C")
ASSIGN_TYPES = {"task_assign", "dispatch", "delegate", "subtask_assign"}
UNRESOLVED = {"", "无法裁定", "X", "?"}


def read_sheet(path: str) -> dict[str, dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    out: dict[str, dict] = {}
    for r in rows:
        alias = (r.get("别名") or "").strip()
        if not alias:
            continue
        out[alias] = {
            "cls": (r.get("判类(D/H/R/C)") or "").strip().upper(),
            "hard": (r.get("疑难(Y/N)") or "").strip().upper(),
            "note": (r.get("备注") or "").strip(),
        }
    return out


def read_arb(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        return {(r.get("别名") or "").strip(): (r.get("终判") or "").strip().upper()
                for r in csv.DictReader(f) if (r.get("别名") or "").strip()}


def cohen_kappa(a: list[str], b: list[str]) -> tuple[float, float, float]:
    n = len(a)
    if n == 0:
        return 0.0, 0.0, 0.0
    po = sum(1 for x, y in zip(a, b) if x == y) / n
    pa = Counter(a)
    pb = Counter(b)
    pe = sum((pa[c] / n) * (pb[c] / n) for c in CLASSES)
    if pe >= 1.0:
        return po, pe, 1.0
    return po, pe, (po - pe) / (1 - pe)


def gwet_ac1(a: list[str], b: list[str]) -> tuple[float, float, float]:
    """Gwet's AC1：小样本 + 边际偏斜时替代 κ 的一致性系数。

    Pe_gwet = Σ π_c (1-π_c) / (q-1)，π_c = (n_A(c) + n_B(c)) / (2n)，q = 类别数。
    预注册于 2026-11-04（规约 附录 B），用于判别「κ 低」是判类不可信，还是边际偏斜所致。
    """
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


def selftest(frame_path: str) -> int:
    """合成两份「判类表」注入已知缺陷，确认统计路径能检出。

    注意：这**不是**判类，只是脚本自检——用标记本身当答案再注入 3 个已知缺陷，
    检查 false_assign / 待仲裁 / κ 三处是否按预期变化。真实判类必须由人做。
    """
    import tempfile

    frame = json.load(open(frame_path, encoding="utf-8"))
    amap = frame["alias_map"]
    marker_to_cls = {"assign": "D", "report": "R", "freeform": "C", "other": "C"}

    base = {al: marker_to_cls.get(m["stratum"], "C") for al, m in amap.items()}
    A = dict(base)
    B = dict(base)
    # 缺陷 1：一条 assign 被两人都判成 C → false_assign
    fa = next(al for al, m in amap.items() if m["marker_raw"] in ASSIGN_TYPES)
    A[fa] = B[fa] = "C"
    # 缺陷 2：一条 report 两人判类不同 → 待仲裁
    dis = next(al for al, m in amap.items() if m["stratum"] == "report" and al != fa)
    A[dis], B[dis] = "C", "R"
    # 缺陷 3：一条 freeform 两人都判 D → missed_assign
    mi = next(al for al, m in amap.items() if m["stratum"] == "freeform" and al not in (fa, dis))
    A[mi] = B[mi] = "D"

    with tempfile.TemporaryDirectory() as td:
        def dump(path: str, data: dict) -> None:
            with open(path, "w", encoding="utf-8-sig", newline="") as f:
                w = csv.writer(f)
                w.writerow(["序号", "别名", "位置", "发送者", "接收者", "上一条发送者",
                            "上一条摘要", "本条正文", "判类(D/H/R/C)", "疑难(Y/N)", "备注"])
                for i, al in enumerate(sorted(data, key=lambda x: int(x.split("-")[1])), 1):
                    w.writerow([i, al, "#1", "x", "y", "", "", "", data[al], "", ""])
        pa, pb = os.path.join(td, "A.csv"), os.path.join(td, "B.csv")
        dump(pa, A)
        dump(pb, B)
        out = os.path.join(td, "rec.md")
        argv = sys.argv
        sys.argv = ["merge-review.py", "--a", pa, "--b", pb, "--frame", frame_path,
                    "--batch", "SELFTEST", "--out", out]
        try:
            rc = main()
        finally:
            sys.argv = argv
        if rc != 0:
            print("SELFTEST FAIL: main() 返回非 0")
            return 1
        s = json.load(open(os.path.splitext(out)[0] + ".summary.json", encoding="utf-8"))
        checks = [
            ("false_assign == 1", s["false_assign"] == 1, s["false_assign"]),
            ("missed_assign == 1", s["missed_assign"] == 1, s["missed_assign"]),
            ("待仲裁 == 1", s["pending_arbitration"] == 1, s["pending_arbitration"]),
            ("两人分歧 == 1", s["disagree"] == 1, s["disagree"]),
            ("κ < 1（存在分歧）", s["kappa"] < 1.0, s["kappa"]),
            ("可裁定 == n-1", s["judged"] == s["n"] - 1, f"{s['judged']}/{s['n']}"),
            ("记录文件已生成", os.path.isfile(out), out),
        ]
        ok = True
        for name, passed, val in checks:
            print(f"  [{'PASS' if passed else 'FAIL'}] {name}（实测 {val}）")
            ok = ok and passed
        print("SELFTEST", "PASS" if ok else "FAIL")
        return 0 if ok else 1


def track_of(sid: str) -> str:
    """从 sid（`框架/轨道#序号`）取轨道名；取不到返回空串。"""
    try:
        return sid.split("/", 1)[1].split("#", 1)[0]
    except IndexError:
        return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a")
    ap.add_argument("--b")
    ap.add_argument("--frame", default=os.path.join(HERE, "out", "sample-frame.json"))
    ap.add_argument("--batch", default="REVIEW-UNNAMED")
    ap.add_argument("--arb")
    ap.add_argument("--arbiter", default="未指定",
                    help="仲裁人代号（签署表用）。用了 --arb 就必须填，否则记录里只有占位符")
    ap.add_argument("--arbiter-blind", choices=["yes", "no", "na"], default=None,
                    help="仲裁人是否满足盲审条件（没看过 marker 列与双方判类）：yes/no；无分歧时 na")
    ap.add_argument("--out", default=None)
    ap.add_argument("--selftest", action="store_true", help="合成缺陷自检，不做真实判类")
    args = ap.parse_args()

    if args.selftest:
        return selftest(args.frame)
    if not (args.a and args.b):
        ap.error("需要 --a 与 --b（或 --selftest）")

    frame = json.load(open(args.frame, encoding="utf-8"))
    amap = frame["alias_map"]
    A = read_sheet(args.a)
    B = read_sheet(args.b)
    arb = read_arb(args.arb)
    if arb and args.arbiter == "未指定":
        print("⚠️ 用了 --arb 但没给 --arbiter：签署表将写「未指定」，须补填后才可归档", file=sys.stderr)
    if arb and args.arbiter_blind is None:
        print("⚠️ 用了 --arb 但没给 --arbiter-blind（yes/no）：仲裁盲性未声明", file=sys.stderr)

    if set(A) != set(B):
        only_a, only_b = set(A) - set(B), set(B) - set(A)
        print(f"两份表的别名集合不一致：仅 A {sorted(only_a)}，仅 B {sorted(only_b)}", file=sys.stderr)
        return 2
    bad = [k for k, v in list(A.items()) + list(B.items())
           if v["cls"] not in CLASSES and v["cls"] not in UNRESOLVED]
    if bad:
        print(f"判类取值非法（只允许 D/H/R/C 或留空）：{sorted(set(bad))[:10]}", file=sys.stderr)
        return 2

    aliases = sorted(A, key=lambda x: int(x.split("-")[1]))
    rated_a, rated_b = [], []
    rows = []
    for al in aliases:
        a, b = A[al], B[al]
        mark = amap.get(al, {})
        marked_assign = mark.get("marker_raw") in ASSIGN_TYPES
        if a["cls"] in CLASSES and b["cls"] in CLASSES:
            rated_a.append(a["cls"])
            rated_b.append(b["cls"])
        if a["cls"] in UNRESOLVED and b["cls"] in UNRESOLVED:
            final, how = "", "双方均无法裁定"
        elif a["cls"] == b["cls"]:
            final, how = a["cls"], "一致"
        else:
            final, how = arb.get(al, ""), ("仲裁" if arb.get(al) else "待仲裁")
        if final in CLASSES:
            consistent = (marked_assign == (final == "D"))
            # legit 由轨道前缀机械派生，不看备注：
            # 判类人对轨道名是遮蔽的（规约 §四），让他们标 legit 等于要求他们猜场景，
            # 所以 v1 的「备注含 legit」写法永远取不到值，改为合并侧回补。
            is_benign = track_of(mark.get("sid", "")).startswith("benign")
            tag = "legit" if (final == "D" and marked_assign and is_benign) else ""
            if consistent:
                sub = tag
            else:
                sub = "false_assign" if marked_assign else "missed_assign"
        else:
            consistent, sub = None, ""
        rows.append({
            "alias": al, "sid": mark.get("sid", ""), "from": mark.get("from", ""),
            "to": mark.get("to", ""), "marker": mark.get("marker_raw", ""),
            "A": a["cls"], "B": b["cls"], "agree": a["cls"] == b["cls"] and a["cls"] in CLASSES,
            "hard": "Y" if "Y" in (a["hard"], b["hard"]) else "",
            "how": how, "final": final, "sub": sub, "note": a["note"] or b["note"],
        })

    po, pe, kappa = cohen_kappa(rated_a, rated_b)
    _, pe_ac1, ac1 = gwet_ac1(rated_a, rated_b)
    n = len(rows)
    judged = [r for r in rows if r["final"] in CLASSES]
    mism = [r for r in judged if r["sub"] in ("false_assign", "missed_assign")]
    legit = [r for r in judged if r["sub"] == "legit"]
    pending = [r for r in rows if r["how"] == "待仲裁"]
    undecided = [r for r in rows if r["how"] == "双方均无法裁定"]
    disagree = [r for r in rows if not r["agree"] and r["A"] in CLASSES and r["B"] in CLASSES]

    print(f"n={n}  可裁定={len(judged)}  κ={kappa:.3f}  Po={po:.3f}  AC1={ac1:.3f}")
    print(f"不一致={len(mism)}（false_assign {sum(1 for r in mism if r['sub']=='false_assign')}"
          f" / missed_assign {sum(1 for r in mism if r['sub']=='missed_assign')}）"
          f"  legit={len(legit)}  待仲裁={len(pending)}  无法裁定={len(undecided)}")
    # 判读按规约 附录 B 的预注册规则，不看单一系数
    if po >= 0.90 and kappa >= 0.60:
        verdict = "正常：可入库"
    elif po >= 0.90 and kappa < 0.60 and ac1 >= 0.80:
        verdict = "κ 悖论（边际偏斜压低 κ）：以 AC1 为准，结论可入库并注明"
    elif po < 0.90:
        verdict = "规约未定标：本批次只作内部预检，须回改规约后重抽"
    else:
        verdict = "存疑：Po 或 AC1 均不达标，须人工复核"
    print(f"判读（附录 B 预注册）：{verdict}")
    if kappa < 0.6 and not (po >= 0.90 and ac1 >= 0.80):
        print("⚠️ κ < 0.6 且 AC1 未达 0.80：规约未定标，本批次只能作内部预检（规约 §六）")
    if pending:
        print(f"⚠️ 有 {len(pending)} 条待仲裁，终判统计不完整；补 --arb 后重跑")

    out_path = args.out or os.path.join(os.path.dirname(args.a) or ".",
                                        f"核对记录_{args.batch}.md")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"# 标记/语义双人核对记录 · {args.batch}\n\n")
        f.write("> 由 `merge-review.py` 自动生成。判类人只填过 `判类/疑难/备注` 三列，"
                "`标记` 列在此处才回填——遮蔽由数据流保证，不靠口头约定。\n\n")
        f.write("## 一、批次与抽样凭据\n\n| 字段 | 值 |\n|---|---|\n")
        f.write(f"| 批次号 | `{args.batch}` |\n")
        f.write(f"| 判类规约 | v1 |\n")
        f.write(f"| 抽样种子 | `{frame['seed']}` |\n")
        f.write(f"| 语料指纹 | `{frame['corpus_sha256'][:16]}…`（共 {frame['corpus_size']} 条） |\n")
        f.write(f"| 配额/框架 | {frame['quota_per_framework']} = {frame['target_per_framework']} |\n")
        f.write(f"| 本批样本 | {n} 条 |\n\n")
        f.write("## 二、统计\n\n| 指标 | 值 | 判读 |\n|---|---|---|\n")
        f.write(f"| 样本 n | {n} | |\n")
        f.write(f"| 可裁定 | {len(judged)} | |\n")
        f.write(f"| 一致条数 | {sum(1 for r in judged if r['agree'])} | |\n")
        f.write(f"| 一致率 `Po` | {po:.3f} | |\n")
        f.write(f"| 期望一致率 `Pe` | {pe:.3f} | |\n")
        f.write(f"| **Cohen's κ** | **{kappa:.3f}** | "
                + ("**< 0.6 ⇒ 规约未定标，仅作内部预检**" if kappa < 0.6 else "≥ 0.6，可用于正式记录") + " |\n")
        f.write(f"| Gwet's AC1 | {ac1:.3f} | 边际偏斜时的替代系数（规约 附录 B） |\n")
        f.write(f"| **判读（附录 B 预注册）** | — | **{verdict}** |\n")
        f.write(f"| 不一致条数 | {len(mism)} | 率 = {len(mism)/len(judged):.3f} |\n" if judged else "| 不一致条数 | 0 | |\n")
        if judged:
            f.write(f"| ├ 假派发 `false_assign` | {sum(1 for r in mism if r['sub']=='false_assign')} | 标记 assign、判类非 D |\n")
            f.write(f"| ├ 漏派发 `missed_assign` | {sum(1 for r in mism if r['sub']=='missed_assign')} | 标记非 assign、判类 D |\n")
        f.write(f"| **一致但机制敏感 `legit`** | {len(legit)} | 计入一致率，单列作为 H1 误报素材 |\n")
        f.write(f"| 待仲裁 | {len(pending)} | 补 `--arb` 后重跑 |\n")
        f.write(f"| 双方均无法裁定 | {len(undecided)} | 不计入分子分母 |\n")
        f.write(f"| 两人分歧（需仲裁） | {len(disagree)} | |\n\n")

        f.write("## 三、分歧与不一致明细\n\n")
        f.write("| 别名 | sid | 发送者→接收者 | 标记 | A | B | 终判 | 子类 | 备注 |\n|---|---|---|---|---|---|---|---|---|\n")
        for r in disagree + [r for r in rows if r["sub"] in ("false_assign", "missed_assign", "legit")]:
            f.write(f"| {r['alias']} | `{r['sid']}` | {r['from']}→{r['to']} | {r['marker']} "
                    f"| {r['A']} | {r['B']} | {r['how']}·{r['final'] or '—'} | {r['sub'] or '—'} | {r['note']} |\n")
        if not (disagree or mism or legit):
            f.write("| — | | | | | | | | 无 |\n")
        f.write("\n## 四、逐条表（全量）\n\n")
        f.write("| # | 别名 | sid | 标记 | A | B | 一致 | 疑难 | 终判 | 子类 |\n|---|---|---|---|---|---|---|---|---|---|\n")
        for i, r in enumerate(rows, 1):
            f.write(f"| {i} | {r['alias']} | `{r['sid']}` | {r['marker']} | {r['A'] or '—'} | {r['B'] or '—'} "
                    f"| {'✓' if r['agree'] else '✗'} | {r['hard'] or ''} | {r['final'] or '—'} | {r['sub'] or ''} |\n")
        f.write("\n## 五、结论（须人工填写）\n\n")
        f.write("1. **映射表是否可用**：☐ 可用 ☐ 有条件可用 ☐ 须修订后重核\n")
        f.write("2. **是否越过 20% 降级线**：☐ 否 ☐ 是（阈值为候选值，n=1 未标定）\n")
        f.write("3. **结构性空层的解释**：\n")
        f.write("4. **`legit` 对 H1 的意义**：\n")
        f.write("5. **未决事项**：\n")
        f.write("\n## 六、签署\n\n| 角色 | 代号 | 日期 | 确认内容 |\n|---|---|---|---|\n")
        f.write("| 判类人 A | `J-A` | | 判类独立完成，未接触对方结果 |\n")
        f.write("| 判类人 B | `J-B` | | 同上 |\n")
        # 仲裁人行必须写实际代号与盲性：脚本原先硬编码 `J-C` + 「符合规约」，
        # 会让「协调人自己预判」被读成「有独立第三方仲裁」，属记录失真。
        if arb:
            blind = {
                "yes": "分歧裁定符合规约；仲裁人未接触 marker 列与双方判类（盲审）",
                "no": "**不满足盲审**：仲裁人已接触 marker 列或双方判类；裁定按规约条文逐条对应，属**非独立仲裁**",
                "na": "给了 --arb 但本批无分歧，仲裁未实际启用",
            }.get(args.arbiter_blind, "**未声明盲性（须补填）**")
            f.write(f"| 仲裁人 | `{args.arbiter}` | | {blind} |\n")
        else:
            f.write("| 仲裁人 | — | | 本批未启用仲裁 |\n")
        f.write("| 协调人 | | | 抽样可复现、遮蔽符合规约 §四 |\n")
    print(f"→ {out_path}")

    summary = {
        "batch": args.batch, "n": n, "judged": len(judged), "po": round(po, 4),
        "pe": round(pe, 4), "kappa": round(kappa, 4),
        "ac1": round(ac1, 4), "verdict": verdict,
        "mismatch": len(mism), "false_assign": sum(1 for r in mism if r["sub"] == "false_assign"),
        "missed_assign": sum(1 for r in mism if r["sub"] == "missed_assign"),
        "legit": len(legit), "pending_arbitration": len(pending),
        "undecided": len(undecided), "disagree": len(disagree),
        "arbiter": args.arbiter if arb else None,
        "arbiter_blind": args.arbiter_blind if arb else None,
    }
    with open(os.path.splitext(out_path)[0] + ".summary.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
