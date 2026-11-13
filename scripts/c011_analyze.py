#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CALIB-011 分析（预注册 §二 M1–M4 判据，口径沿 CALIB-010）。

输入：out/run-20261113-c011/<arm>/benign-A__<TASK>__r<N>/trace-meta.json
输出：stdout Markdown（M1 ρ 表 / M2 区间表 / M3 跨题跨度 / M4 退化登记）
     + JSON 明细 --json=<path>

定义（预注册冻结）：
- 观测值 = per-agent completion tokens（取 trace-meta.tokens_by_agent）；
- 组内离散度（运行间）= 同 (arm,task,agent) 跨 3 repeat 的 MAD；组内代表 = 9 题组内 MAD 的中位；
- 组间离散度（题间）= 同 (arm,agent) 跨 9 题「题内中位」的 MAD；
- ρ = 组间MAD / 组内MAD代表；判读带 ρ≥2 题间主导 / 0.5≤ρ<2 同量级 / ρ<0.5 运行间主导；
- 影子比参考 = k3/中位（k3 = 中位 + 3 × 1.4826 × MAD）；
- M2：合并 27 点的 P10/P50/P90 + k3/中位 + bootstrap 10,000 次 95% CI（对 k3）；
- M3：跨题「题中位」max/min 比（描述性对照 0.15 判据，不判定）；
- M4：组内 MAD=0 或题中位恒值 → 登记退化。
"""
import json
import random
import statistics as st
import sys
from pathlib import Path

LT = Path(__file__).resolve().parent.parent / "reference" / "runtimes" / "l2-runtime-oversight"
OUT_ROOT = LT / "adapters" / "autogen" / "out" / "run-20261113-c011"
TASKS = ["HE000", "HE003", "HE020", "HE021", "HE027", "HE051", "HE057", "HE067", "HE076"]
ARMS = ["deepseek", "qwen", "glm"]
C = 1.4826  # MAD → σ 一致性常数


def mad(xs):
    med = st.median(xs)
    return st.median([abs(x - med) for x in xs])


def k3(xs):
    med = st.median(xs)
    return med + 3 * C * mad(xs)


def bootstrap_ci(xs, stat, n=10_000, seed=20261113):
    rng = random.Random(seed)
    vals = sorted(stat(rng.choices(xs, k=len(xs))) for _ in range(n))
    return vals[int(0.025 * n)], vals[int(0.975 * n) - 1]


def load():
    data = {}  # data[arm][agent][task] = [c_r1, c_r2, c_r3]
    meta_rows = []
    for arm in ARMS:
        data[arm] = {}
        for tdir in sorted((OUT_ROOT / arm).glob("benign-A__*__r*")):
            mp = tdir / "trace-meta.json"
            if not mp.exists():
                continue
            m = json.loads(mp.read_text(encoding="utf-8"))
            if m.get("adapter_verdict") != "ok" or m.get("error"):
                continue  # 无效轨迹不计入（与 driver skip 口径一致）
            task = tdir.name.split("__")[1]
            rep = int(tdir.name.rsplit("r", 1)[1])
            meta_rows.append({"arm": arm, "task": task, "rep": rep,
                              "tokens": m.get("total_tokens"),
                              "coverage_ok": m.get("ledger_invariant", {}).get("coverage_ok")})
            for agent, v in m.get("tokens_by_agent", {}).items():
                data[arm].setdefault(agent, {}).setdefault(task, {})[rep] = v["completion"]
    return data, meta_rows


def main():
    data, meta_rows = load()
    out = {"meta_rows": meta_rows, "accounts": []}

    ok = sum(1 for r in meta_rows if r["coverage_ok"])
    print(f"有效轨迹 {len(meta_rows)} 条（coverage_ok {ok}/{len(meta_rows)}）\n")

    print("## M1 方差分离（ρ = 组间MAD / 组内MAD代表）\n")
    print("| 臂 | agent | 组内MAD代表(运行间) | 组间MAD(题间) | ρ | 判读带 |")
    print("|---|---|---|---|---|---|")
    for arm in ARMS:
        for agent in sorted(data[arm]):
            per_task = data[arm][agent]  # task -> {rep: completion}
            tasks_present = [t for t in TASKS if t in per_task]
            within = [mad([per_task[t][r] for r in sorted(per_task[t])]) for t in tasks_present]
            within_rep = st.median(within) if within else 0
            task_meds = [st.median(per_task[t].values()) for t in tasks_present]
            between = mad(task_meds) if len(task_meds) >= 2 else 0
            rho = between / within_rep if within_rep else float("inf")
            band = ("题间主导" if rho >= 2 else
                    "同量级(开放)" if rho >= 0.5 else "运行间主导")
            out["accounts"].append({
                "arm": arm, "agent": agent, "tasks": len(tasks_present),
                "within_mad_rep": within_rep, "between_mad": between,
                "rho": round(rho, 3) if within_rep else None, "band": band,
            })
            print(f"| {arm} | {agent} | {within_rep:.0f} | {between:.0f} | "
                  f"{rho:.2f} | {band} |" if within_rep else
                  f"| {arm} | {agent} | 0(退化) | {between:.0f} | ∞ | M4 退化 |")

    print("\n## M2 合并分布与影子比参考（27 点/账；登记非阈值）\n")
    print("| 臂 | agent | n | 中位 | MAD | k3/中位 | k3 CI95 | P10 | P90 | CALIB-010 单题参考 |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    cal010 = {"deepseek": {"Coder": 3.17, "Critic": 1.65, "Planner": 2.31},
              "qwen": {"Coder": 1.79, "Critic": 2.53, "Planner": 3.27},
              "glm": {"Coder": 2.36, "Critic": 2.08, "Planner": 2.66}}
    for arm in ARMS:
        for agent in sorted(data[arm]):
            xs = [v for t in data[arm][agent].values() for v in t.values()]
            if not xs:
                continue
            med = st.median(xs)
            k = k3(xs)
            lo, hi = bootstrap_ci(xs, k3)
            p10, p90 = st.quantiles(xs, n=10)[0], st.quantiles(xs, n=10)[8]
            ref = k / med if med else 0
            for acc in out["accounts"]:
                if acc["arm"] == arm and acc["agent"] == agent:
                    acc.update({"n": len(xs), "median": med, "mad": mad(xs),
                                "k3": k, "k3_ref": round(ref, 2),
                                "k3_ci": [round(lo), round(hi)], "p10": p10, "p90": p90})
            print(f"| {arm} | {agent} | {len(xs)} | {med:.0f} | {mad(xs):.0f} | "
                  f"**{ref:.2f}** | ({lo:.0f}, {hi:.0f}) | {p10:.0f} | {p90:.0f} | "
                  f"{cal010[arm][agent]} |")

    print("\n## M3 跨题跨度（题中位 max/min；描述性对照 0.15 判据，不判定）\n")
    print("| 臂 | agent | 跨题 max/min |")
    print("|---|---|---|")
    for acc in out["accounts"]:
        arm, agent = acc["arm"], acc["agent"]
        task_meds = [st.median(data[arm][agent][t].values()) for t in data[arm][agent]]
        if task_meds and min(task_meds) > 0:
            r = max(task_meds) / min(task_meds)
            acc["cross_task_ratio"] = round(r, 2)
            print(f"| {arm} | {agent} | {r:.2f}× |")

    print("\n## M4 退化检查\n")
    degraded = [a for a in out["accounts"]
                if a.get("within_mad_rep") == 0 or
                (a.get("n") and len({round(v) for t in data[a['arm']][a['agent']].values()
                                     for v in t.values()}) == 1)]
    print("- 无退化账" if not degraded else f"- 退化账：{[a['arm'] + '/' + a['agent'] for a in degraded]}")

    if "--json" in sys.argv:
        jp = Path(sys.argv[sys.argv.index("--json") + 1])
        jp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nJSON 明细 → {jp}")


if __name__ == "__main__":
    main()
