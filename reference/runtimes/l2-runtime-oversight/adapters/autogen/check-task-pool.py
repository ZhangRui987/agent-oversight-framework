# -*- coding: utf-8 -*-
"""任务池结构校验（AOE-CALIB-007）。

纯标准库，退出码 0/1，可直接挂门禁。校验的是**结构自洽**，不校验任务文本质量。

用法：python check-task-pool.py [--file <路径>]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

# __file__ = <repo>/reference/runtimes/l2-runtime-oversight/adapters/autogen/check-task-pool.py
# parents: [0]=autogen [1]=adapters [2]=l2-runtime-oversight ← 任务池同级
DEFAULT = Path(__file__).resolve().parents[2] / "task-pool-v1.json"

REQUIRED = {
    "task_id",
    "difficulty",
    "category",
    "prompt_template",
    "success_criteria",
    "expected_tool_calls",
    "max_turns",
    "expected_message_band",
    "rationale",
}

# 难度 → (类别, max_turns, 消息带)，三者在池内必须一一对应
D_RULE = {
    "simple": ("single_query", 6, "3-5"),
    "medium": ("multi_step", 10, "5-9"),
    "complex": ("collaborative", 14, "8-14"),
}
EXPECTED_COUNT = {"simple": 8, "medium": 9, "complex": 8}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(DEFAULT))
    args = ap.parse_args()

    p = Path(args.file)
    if not p.exists():
        print(f"[FAIL] 文件不存在：{p}")
        return 1
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"[FAIL] JSON 解析失败：{exc}")
        return 1

    fails: list[str] = []
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        print("[FAIL] 缺少 tasks 数组")
        return 1

    # 1. 数量
    if len(tasks) != 25:
        fails.append(f"任务数 {len(tasks)}（要求 25）")

    # 2. 字段齐全
    for t in tasks:
        miss = REQUIRED - set(t)
        if miss:
            fails.append(f"{t.get('task_id', '?')} 缺字段 {sorted(miss)}")

    # 3. ID 唯一且连续
    ids = [t.get("task_id") for t in tasks]
    if len(set(ids)) != len(ids):
        dup = [k for k, v in Counter(ids).items() if v > 1]
        fails.append(f"task_id 重复：{dup}")
    expect_ids = [f"T{i:02d}" for i in range(1, len(tasks) + 1)]
    if sorted(ids) != expect_ids:
        fails.append("task_id 不是 T01..T25 连续编号")

    # 4. 难度分布
    dist = Counter(t.get("difficulty") for t in tasks)
    for d, n in EXPECTED_COUNT.items():
        if dist.get(d, 0) != n:
            fails.append(f"难度 {d} 数量 {dist.get(d, 0)}（要求 {n}）")
    extra = set(dist) - set(EXPECTED_COUNT)
    if extra:
        fails.append(f"出现未知难度值：{sorted(extra)}")

    # 5. 难度 → 类别 / max_turns / 消息带 三元一致
    for t in tasks:
        d = t.get("difficulty")
        if d not in D_RULE:
            continue
        cat, turns, band = D_RULE[d]
        if t.get("category") != cat:
            fails.append(f"{t['task_id']} 类别 {t.get('category')} 与难度 {d} 不匹配（应为 {cat}）")
        if t.get("max_turns") != turns:
            fails.append(f"{t['task_id']} max_turns {t.get('max_turns')}（{d} 应为 {turns}）")
        if t.get("expected_message_band") != band:
            fails.append(f"{t['task_id']} 消息带 {t.get('expected_message_band')}（{d} 应为 {band}）")

    # 6. 无工具声明须自洽
    for t in tasks:
        if t.get("expected_tool_calls") != []:
            fails.append(f"{t['task_id']} expected_tool_calls 非空（本池声明为纯文本任务）")

    # 7. 关键文本字段非空
    for t in tasks:
        for k in ("prompt_template", "success_criteria", "rationale"):
            if not str(t.get(k, "")).strip():
                fails.append(f"{t['task_id']} 字段 {k} 为空")

    # 8. 元信息
    notes = data.get("notes", {})
    if "no_tools" not in notes:
        fails.append("notes 缺少 no_tools 声明（易被误读为「有工具但未用」）")
    if "control_subset" not in notes:
        fails.append("notes 缺少 control_subset（对照框架取前 6 个任务）")

    if fails:
        print(f"[FAIL] 任务池校验 {len(fails)} 项不通过：")
        for f in fails:
            print(f"  - {f}")
        return 1

    print(f"[PASS] 任务池校验通过：{len(tasks)} 条（simple {dist['simple']} / medium {dist['medium']} / complex {dist['complex']}）")
    print(f"       文件 {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
