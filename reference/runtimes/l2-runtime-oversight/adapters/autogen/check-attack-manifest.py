#!/usr/bin/env python3
"""攻击 manifest 结构校验（AOE-CALIB-007）。

校验对象：reference/runtimes/l2-runtime-oversight/attack-manifest.json

为什么要单独校验：设计稿 §5.3 只冻结了「每型 15 条」，没有冻结「哪几个任务、重复几次」。
而任务决定 `msgs.length` 分布、`msgs.length` 是 `S1_raw` 的分母，进而直接决定 H4 的 P5。
这块若不在开跑前冻死，执行中换任务就等于换判据。本脚本把三件事钉住：

① 45 条三元组（场景 × 任务 × 重复）必须与 types 声明逐条展开一致，不允许「声明 15 条、实际 45 条里有别的」；
② 任务必须真实存在于冻结任务池，且每型至少 3 个不同任务（cluster bootstrap 需要 ≥3 簇，否则 CI 退化）；
③ 强度自检规则必须在册——构造未达强度的轨迹不得计入 H4，规则不写就无从判定。

用法：
    python check-attack-manifest.py                  # 校验
    python check-attack-manifest.py --selftest       # 反向测试：逐条注入缺陷，必须 FAIL

退出码：0 全 PASS；1 有 FAIL；2 参数错误。
零第三方依赖。
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MANIFEST = ROOT / "attack-manifest.json"
TASK_POOL = ROOT / "task-pool-v1.json"

REQUIRED_TOP = ("schema", "manifest_id", "frozen_at", "purpose", "frozen_rules", "types", "entries")
REQUIRED_RULES = (
    "total",
    "per_type",
    "repeats_per_task",
    "tasks_per_type",
    "cluster_unit",
    "why_three_tasks_per_type",
    "no_substitution",
    "strength_check",
)
REQUIRED_TYPES = ("attack-concentrate", "attack-scale", "attack-cross")
REQUIRED_TYPE_FIELDS = ("label", "spec_ref", "expected_s1_raw", "strength_rule", "tasks", "repeats", "count")
MIN_TASKS_PER_TYPE = 3  # cluster bootstrap 按任务聚类，<3 簇时该层重抽退化为原样本


def load_task_ids(pool_path: Path | None = None) -> set[str]:
    data = json.loads((pool_path or TASK_POOL).read_text(encoding="utf-8"))
    tasks = data["tasks"] if isinstance(data, dict) and "tasks" in data else data
    return {t["task_id"] for t in tasks}


def check(doc: dict, task_ids: set[str]) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    def add(cid: str, ok: bool, msg: str) -> None:
        out.append((cid, ok, msg))

    missing = [k for k in REQUIRED_TOP if k not in doc]
    add("A1 顶层字段齐全", not missing, "缺 " + ", ".join(missing) if missing else f"{len(REQUIRED_TOP)} 项齐备")
    add(
        "A1b schema 版本标记",
        str(doc.get("schema", "")).endswith("@1"),
        f"schema={doc.get('schema')!r}",
    )

    rules = doc.get("frozen_rules") or {}
    miss_rules = [k for k in REQUIRED_RULES if k not in rules]
    add(
        "A2 冻结规则齐全",
        not miss_rules,
        "缺 " + ", ".join(miss_rules) if miss_rules else "总数 / 每型 / 重复 / 聚类单位 / 不补数 / 强度自检 均在册",
    )

    types = doc.get("types") or {}
    miss_types = [t for t in REQUIRED_TYPES if t not in types]
    add("A3 三型齐全", not miss_types, "缺 " + ", ".join(miss_types) if miss_types else "三型均在册")

    entries = doc.get("entries") or []
    per_type = rules.get("per_type")
    repeats_rule = rules.get("repeats_per_task")
    tasks_rule = rules.get("tasks_per_type")

    expected: set[tuple[str, str, int]] = set()
    expand_ok = True
    cluster_ok = True
    strength_ok = True

    for tname in REQUIRED_TYPES:
        t = types.get(tname)
        if not isinstance(t, dict):
            continue
        miss = [k for k in REQUIRED_TYPE_FIELDS if k not in t]
        if miss:
            add(f"A4 {tname} 字段齐全", False, "缺 " + ", ".join(miss))
            expand_ok = False
            continue

        tasks = [str(x) for x in (t.get("tasks") or [])]
        reps = int(t.get("repeats") or 0)
        c = int(t.get("count") or 0)

        uniq = sorted(set(tasks))
        add(
            f"A5 {tname} 任务数 ≥ {MIN_TASKS_PER_TYPE} 且不重复",
            len(uniq) >= MIN_TASKS_PER_TYPE and len(uniq) == len(tasks),
            f"tasks={tasks}（去重 {len(uniq)} 个，声明 {len(tasks)} 个）",
        )
        unknown = [x for x in tasks if x not in task_ids]
        add(f"A5b {tname} 任务须在冻结池内", not unknown, "池外任务 " + ", ".join(unknown) if unknown else f"{len(tasks)} 个任务全在 task-pool-v1.json")
        add(
            f"A6 {tname} count = 任务数 × 重复",
            c == len(tasks) * reps and c == per_type,
            f"count={c}，tasks×repeats={len(tasks) * reps}，per_type={per_type}",
        )
        add(
            f"A7 {tname} 重复次数与冻结规则一致",
            reps == repeats_rule and len(uniq) == tasks_rule,
            f"repeats={reps}（规则 {repeats_rule}），tasks/type={len(uniq)}（规则 {tasks_rule}）",
        )

        rule = t.get("strength_rule") or {}
        need = {"attack-concentrate": ("assign_min", "assign_share_min"),
                "attack-scale": ("window_segments_min", "growth_min", "delta_min"),
                "attack-cross": ("cross_sandbox_msgs_min",)}[tname]
        lacking = [k for k in need if k not in rule]
        if lacking:
            strength_ok = False
        add(f"A8 {tname} 强度自检规则完整", not lacking, "缺 " + ", ".join(lacking) if lacking else f"含 {list(need)}")

        exp = t.get("expected_s1_raw")
        add(
            f"A9 {tname} expected_s1_raw ∈ (0,1]",
            isinstance(exp, (int, float)) and 0 < float(exp) <= 1,
            f"expected_s1_raw={exp!r}",
        )

        for tk in tasks:
            for r in range(1, reps + 1):
                expected.add((tname, tk, r))

    # A10 展开一致性：声明集合与 entries 集合必须完全相同
    got = [(str(e.get("scenario")), str(e.get("task_id")), int(e.get("repeat") or 0)) for e in entries]
    got_set = set(got)
    add(
        "A10 entries 与 types 展开一致",
        expand_ok and len(got) == len(got_set) and got_set == expected,
        f"entries={len(got)} 行、去重 {len(got_set)}；声明展开 {len(expected)} 条；"
        f"缺 {len(expected - got_set)} / 多 {len(got_set - expected)} / 重复 {len(got) - len(got_set)}",
    )

    # A11 总数
    total = rules.get("total")
    add("A11 总数与冻结规则一致", len(entries) == total, f"entries={len(entries)}，total={total}")

    # A12 每型条数（防「用其它型补数」）
    cnt = Counter(s for s, _, _ in got)
    bad = {t: cnt.get(t, 0) for t in REQUIRED_TYPES if cnt.get(t, 0) != per_type}
    add("A12 每型条数一律等于 per_type", not bad, "偏离 " + json.dumps(bad, ensure_ascii=False) if bad else f"三型各 {per_type} 条")

    # A13 cluster 键自洽 + 簇数
    for e in entries:
        want = f"{e.get('scenario')}/{e.get('task_id')}"
        if e.get("cluster") != want:
            cluster_ok = False
            break
    n_clusters = len({(e.get("scenario"), e.get("task_id")) for e in entries})
    expect_clusters = len(REQUIRED_TYPES) * int(tasks_rule or 0)
    add(
        "A13 cluster 键自洽且簇数达标",
        cluster_ok and n_clusters == expect_clusters and n_clusters >= len(REQUIRED_TYPES) * MIN_TASKS_PER_TYPE,
        f"簇数={n_clusters}（期望 {expect_clusters}），键格式={ 'scenario/task_id' if cluster_ok else '有不符' }",
    )

    return out


def selftest(doc: dict, task_ids: set[str]) -> int:
    cases: list[tuple[str, str, callable]] = [
        ("A1 顶层字段齐全", "删 frozen_rules", lambda d: d.pop("frozen_rules")),
        ("A2 冻结规则齐全", "删 cluster_unit", lambda d: d["frozen_rules"].pop("cluster_unit")),
        ("A3 三型齐全", "删一型", lambda d: d["types"].pop("attack-cross")),
        (
            "A5 attack-concentrate 任务数 ≥ 3 且不重复",
            "同型任务收敛到 2 个（cluster 退化）",
            lambda d: d["types"]["attack-concentrate"].update(tasks=["T18", "T19"]),
        ),
        (
            "A5b attack-scale 任务须在冻结池内",
            "塞入池外任务",
            lambda d: d["types"]["attack-scale"].update(tasks=["T09", "T10", "T99"]),
        ),
        (
            "A6 attack-cross count = 任务数 × 重复",
            "虚报 count",
            lambda d: d["types"]["attack-cross"].update(count=14),
        ),
        (
            "A8 attack-concentrate 强度自检规则完整",
            "删 assign_min",
            lambda d: d["types"]["attack-concentrate"]["strength_rule"].pop("assign_min"),
        ),
        (
            "A10 entries 与 types 展开一致",
            "多插一条同型异任务",
            lambda d: d["entries"].append({"scenario": "attack-concentrate", "task_id": "T21", "repeat": 1, "cluster": "attack-concentrate/T21"}),
        ),
        (
            "A10 entries 与 types 展开一致",
            "复制一行（重复三元组）",
            lambda d: d["entries"].append(copy.deepcopy(d["entries"][0])),
        ),
        (
            "A11 总数与冻结规则一致",
            "改冻结总数为 30",
            lambda d: d["frozen_rules"].update(total=30),
        ),
        (
            "A12 每型条数一律等于 per_type",
            "抽掉 cross 一条（用别型补数的等价形态）",
            lambda d: d["entries"].remove({"scenario": "attack-cross", "task_id": "T23", "repeat": 5, "cluster": "attack-cross/T23"}),
        ),
        (
            "A13 cluster 键自洽且簇数达标",
            "篡改 cluster 键",
            lambda d: d["entries"][0].update(cluster="attack-concentrate/T99"),
        ),
    ]

    failures = 0
    for expect_id, desc, mutate in cases:
        probe = copy.deepcopy(doc)
        mutate(probe)
        results = check(probe, task_ids)
        hit = [ok for cid, ok, _ in results if cid == expect_id]
        if not hit:
            print(f"[FAIL] 反向测试 {desc}：结果里没有 {expect_id} 这一项")
            failures += 1
            continue
        if any(hit):
            print(f"[FAIL] 反向测试 {desc}：{expect_id} 未按预期 FAIL")
            failures += 1
        else:
            print(f"[PASS] 反向测试 {desc} → {expect_id} 正确 FAIL")

    print()
    if failures:
        print(f"反向测试 {failures} 项未达预期")
        return 1
    print(f"反向测试 {len(cases)} 项全部符合预期")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="校验攻击 manifest 结构")
    ap.add_argument("--manifest", default=str(MANIFEST))
    ap.add_argument("--task-pool", default=str(TASK_POOL))
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    path = Path(args.manifest)
    if not path.exists():
        print(f"[FAIL] manifest 不存在：{path}")
        return 2
    pool = Path(args.task_pool)
    if not pool.exists():
        print(f"[FAIL] 任务池不存在：{pool}")
        return 2

    doc = json.loads(path.read_text(encoding="utf-8"))
    task_ids = load_task_ids(pool)

    if args.selftest:
        return selftest(doc, task_ids)

    results = check(doc, task_ids)
    bad = 0
    for cid, ok, msg in results:
        if not ok:
            bad += 1
        if not args.quiet or not ok:
            print(f"[{'PASS' if ok else 'FAIL'}] {cid} — {msg}")
    print()
    print(f"共 {len(results)} 项，FAIL {bad} 项")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
