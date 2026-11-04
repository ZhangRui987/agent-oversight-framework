#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_chain.py —— 处置台账独立验证器（Python 参照实现，纯标准库）

为什么必须有这一份：DoD 写的是「第三方可独立重算」。第三方大概率用 Python。
只提供 JS 验证器，等于只证明「同一实现能验自己」。

与 verify-chain.mts 的七类检查逐条对齐（两语言结果必须一致）：
  1. 键序冻结：== FIELD_ORDER + ["chain_hash", "chain_prev"]
  2. 链可重算：chain_hash == sha256(prev + "|" + serialize(body))
  3. 链连续：chain_prev == 上一行 chain_hash（首行为空串）
  4. 序号连续：disp_seq == 行号（从 1 起）
  5. 字段合法：动作枚举 / seq 正整数 / 16 hex 前缀 / 非空字段
  6. 复核规则：confirm_false_positive 与 escalate 的 reviewed_by 必填且 != actor
  7. 更正规则：supersedes 指向已存在、同 target_seq、未被二次更正的行

序列化规格（与 JS 端一致，缺一不可）：
    json.dumps(body, ensure_ascii=False, separators=(',', ':'))
  —— 默认的 (', ', ': ') 与 ensure_ascii=True 会产出不同字节，跨语言必然失败。

边界：只证明「台账文件未被事后改写」。处置者身份与处置时效不可验证（ts 为自报值）。

用法：
    python tools/disposition/verify_chain.py [台账文件]
退出码：0 通过 / 1 存在失败项。
"""

import hashlib
import json
import os
import re
import sys

FIELD_ORDER = [
    "record_type",
    "event_type",
    "disp_seq",
    "target_seq",
    "target_chain_hash",
    "signal_category",
    "action",
    "actor",
    "rationale",
    "reviewed_by",
    "supersedes",
    "plan",
    "ts",
]
EXPECTED_KEYS = FIELD_ORDER + ["chain_hash", "chain_prev"]
ACTIONS = (
    "confirm_false_positive",
    "escalate",
    "route_to_human",
    "park_for_observation",
)
REVIEW_REQUIRED = ("confirm_false_positive", "escalate")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "data", "disposition.jsonl")


def _is_positive_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _non_empty(v):
    return isinstance(v, str) and v.strip() != ""


def serialize(body):
    """冻结序列化——不得改用默认参数。"""
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def chain_hash(prev, body):
    return hashlib.sha256((prev + "|" + serialize(body)).encode("utf-8")).hexdigest()


def body_of(row):
    """按冻结键序重建 body；缺键即抛 KeyError（由调用方登记为失败项）。"""
    return {k: row[k] for k in FIELD_ORDER}


def verify_file(path):
    """返回 (ok, fails, rows, head)；fails 元素为 (disp_seq, reason)。"""
    if not os.path.exists(path):
        return False, [("-", "台账文件不存在")], 0, "", False

    fails = []
    with open(path, encoding="utf-8") as fh:
        lines = [ln for ln in fh.read().splitlines() if ln.strip() != ""]

    rows = []
    for i, ln in enumerate(lines):
        try:
            rows.append(json.loads(ln))
        except json.JSONDecodeError as exc:
            fails.append((i + 1, "第 %d 行不是合法 JSON：%s" % (i + 1, exc)))
            return False, fails, len(rows), "", True

    prev = ""
    seen = {}
    superseded = {}

    for i, row in enumerate(rows):
        seq = row.get("disp_seq", "?")
        before = len(fails)

        def push(reason):
            fails.append((seq, reason))

        # 1. 键序冻结
        keys = list(row.keys())
        if keys != EXPECTED_KEYS:
            push("键序不符冻结规格：实际 [%s]" % ",".join(keys))

        # 2-3. 链
        if row.get("chain_prev") != prev:
            push('chain_prev 应为 "%s"，实为 "%s"' % (prev, row.get("chain_prev")))
        try:
            recomputed = chain_hash(prev, body_of(row))
        except KeyError as exc:
            push("缺少冻结字段 %s" % exc)
            recomputed = None
        if recomputed is not None and row.get("chain_hash") != recomputed:
            push("chain_hash 重算不匹配（该行内容已被修改）")
        prev = row.get("chain_hash") if isinstance(row.get("chain_hash"), str) else prev

        # 4. 序号连续
        if seq != i + 1:
            push("disp_seq 应连续（期望 %d，实为 %s）" % (i + 1, seq))

        # 5. 字段合法
        if row.get("record_type") != "event" or row.get("event_type") != "disposition":
            push(
                "record_type/event_type 应为 event/disposition，实为 %s/%s"
                % (row.get("record_type"), row.get("event_type"))
            )
        if row.get("action") not in ACTIONS:
            push('action "%s" 不在冻结枚举内' % row.get("action"))
        if not _is_positive_int(row.get("target_seq")):
            push("target_seq 应为正整数")
        if not re.fullmatch(r"[0-9a-f]{16}", str(row.get("target_chain_hash"))):
            push("target_chain_hash 应为 16 位小写 hex")
        if not _non_empty(row.get("signal_category")):
            push("signal_category 为空")
        if not _non_empty(row.get("actor")):
            push("actor 为空")
        if not _non_empty(row.get("rationale")):
            push("rationale 为空")
        if not _is_positive_int(row.get("ts")):
            push("ts 应为正整数毫秒")

        # 6. 复核规则
        if row.get("action") in REVIEW_REQUIRED:
            if not _non_empty(row.get("reviewed_by")):
                push('action "%s" 缺 reviewed_by' % row.get("action"))
            elif row.get("reviewed_by") == row.get("actor"):
                push("reviewed_by 等于 actor（自审自批）")

        # 7. plan 使用范围
        if row.get("action") == "park_for_observation":
            if not _non_empty(row.get("plan")):
                push("park_for_observation 缺 plan")
        elif row.get("plan") is not None:
            push('plan 仅用于 park_for_observation，action "%s" 下应为 null' % row.get("action"))

        # 8. 更正引用
        sup = row.get("supersedes")
        if sup is not None:
            target = seen.get(sup) if isinstance(sup, int) else None
            if target is None:
                push("supersedes 指向不存在的 disp_seq=%s" % sup)
            else:
                if target.get("target_seq") != row.get("target_seq"):
                    push(
                        "supersedes=%s 的 target_seq=%s 与本次 %s 不一致"
                        % (sup, target.get("target_seq"), row.get("target_seq"))
                    )
                if sup in superseded:
                    push("disp_seq=%s 已被 %s 更正过（分叉更正）" % (sup, superseded[sup]))
                superseded[sup] = seq

        seen[seq] = row
        if len(fails) > before:
            continue

    head = rows[-1].get("chain_hash", "") if rows else ""
    return len(fails) == 0, fails, len(rows), head, True


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_FILE
    path = os.path.abspath(path)
    ok, fails, rows, _head, present = verify_file(path)

    out = [
        "",
        "处置台账 · 独立验证（Python 参照实现）",
        "-" * 58,
        "  文件          %s" % path,
        "  记录条数      %d" % rows,
        "  台账链        %s" % ("PASS" if ok else "FAIL"),
        "",
    ]
    if not ok:
        out.append("  失败项：")
        for seq, reason in fails:
            out.append("    [disp %s] %s" % (seq, reason))
        out.append("")
        sys.stdout.write("\n".join(out))
        return 1

    out.append("  全部通过：键序冻结 · 链可重算 · disp_seq 连续 · 复核与更正规则合法")
    out.append("  边界：只证明台账未被事后改写；处置者身份与处置时效不可验证（ts 为自报值）。")
    out.append("")
    sys.stdout.write("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
