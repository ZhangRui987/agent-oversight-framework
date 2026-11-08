#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase0_c3_matrix.py —— AOE-CALIB-007-R2 · Phase 0 机制侦察（纯离线，零 API）

对 R1 既有轨迹按 C3 冻结定义（R1 §四，与 check-c3-offline.py 逐字一致）试算，
产出「跨框架 C3 可计算性矩阵」：
    top 节点 := 消息数等于最大值的所有节点（并列全取）
    派发率   := 该节点 ASSIGN 类型消息数 / 该节点全部消息数
    C3       := top 节点中派发率的最大值
    ASSIGN 类型集 := {task_assign, dispatch, delegate, subtask_assign}（冻结）

判定口径（与 R2 草案 §一 P0-2 一致）：
    可计算     := C3 有区分度（轨迹间取值不全相同，且 top 节点含非零派发率的可能）
    可算但恒值 := 定义可执行，但全部轨迹 C3 相同（无区分度 ⇒ 判别力为空）
    不可计算   := 消息流缺失派发语义（导出器不产出 ASSIGN 消息）
零第三方依赖。退出码恒 0（本脚本只产出事实，不做判定截断）。
"""
import collections
import glob
import json
import os
import sys

ASSIGN = {"task_assign", "dispatch", "delegate", "subtask_assign"}
ROOT = os.path.dirname(os.path.abspath(__file__))
RUN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(ROOT)), "out", "run-20261105-1802")


def c3_of(rows):
    by = collections.defaultdict(list)
    for r in rows:
        by[r.get("from", "?")].append(r)
    if not by:
        return None
    maxn = max(len(v) for v in by.values())
    tops = [k for k, v in by.items() if len(v) == maxn]
    rates = {k: sum(1 for m in by[k] if m.get("type") in ASSIGN) / len(by[k]) for k in tops}
    return {"c3": max(rates.values()), "tops": tops, "rates": rates,
            "nodes": len(by), "msgs": len(rows)}


def main():
    matrix = {}
    for fw in ("autogen", "crewai", "langgraph"):
        files = sorted(glob.glob(os.path.join(RUN, fw, "**", "swarm-msgs.jsonl"), recursive=True))
        vals = []
        for f in files:
            rows = [json.loads(ln) for ln in open(f, encoding="utf-8") if ln.strip()]
            r = c3_of(rows)
            r["scenario"] = os.path.basename(os.path.dirname(f))
            r["types"] = dict(collections.Counter(m.get("type", "?") for m in rows))
            r["froms"] = sorted({m.get("from", "?") for m in rows})
            vals.append(r)
        c3s = [v["c3"] for v in vals if v]
        matrix[fw] = {
            "traces": len(vals),
            "c3_values": sorted(collections.Counter(c3s).items()),
            "all_assign_zero": all(
                sum(v["types"].get(t, 0) for t in ASSIGN) == 0 for v in vals),
            "distinct_c3": len(set(c3s)),
        }
    out = os.path.join(ROOT, "PHASE0-MATRIX.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(matrix, f, ensure_ascii=False, indent=2)
    for fw, m in matrix.items():
        print(f"{fw}: {m['traces']} 条 | C3 取值分布 {m['c3_values']} | "
              f"ASSIGN 全零={m['all_assign_zero']} | 不同 C3 值个数={m['distinct_c3']}")
    print("已写", out)


if __name__ == "__main__":
    main()
