#!/usr/bin/env python3
"""白名单登记表结构校验（AOE-CALIB-007）。

校验对象：reference/runtimes/l2-runtime-oversight/whitelist-registry.json

为什么要单独校验：白名单是整份实验最容易被写成「声明」而不是「事实」的一环。
登记表一旦允许「把不进消息流的实体塞进 effective」或「pending 条目混进判定」，
后续所有 S1 读数都会建立在一句无法核验的话上。这里的检查全部围绕这两点。

用法：
    python check-whitelist-registry.py                 # 校验
    python check-whitelist-registry.py --selftest       # 反向测试：逐条注入缺陷，必须 FAIL

退出码：0 全 PASS；1 有 FAIL；2 参数错误。
零第三方依赖。
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REGISTRY = HERE.parent.parent / "whitelist-registry.json"

REQUIRED_TOP = ("schema", "registry_id", "frozen_at", "status", "purpose", "semantics", "frameworks")
REQUIRED_SEMANTICS = ("whitelist_nominal", "whitelist_effective", "why_split", "s1_arithmetic", "pending_policy")
REQUIRED_FRAMEWORKS = ("autogen", "crewai", "langgraph")
REQUIRED_PATTERN = (
    "label",
    "scheduler_entity",
    "emits_chat_messages",
    "whitelist_nominal",
    "whitelist_effective",
    "status",
)
VALID_STATUS = ("verified", "pending")


def as_list(v) -> list:
    return v if isinstance(v, list) else []


def check(reg: dict) -> list[tuple[str, bool, str]]:
    """返回 [(检查项, 是否通过, 说明)]。"""
    out: list[tuple[str, bool, str]] = []

    def add(cid: str, ok: bool, msg: str) -> None:
        out.append((cid, ok, msg))

    # C1 顶层字段
    missing = [k for k in REQUIRED_TOP if k not in reg]
    add("C1 顶层字段齐全", not missing, "缺 " + ", ".join(missing) if missing else f"{len(REQUIRED_TOP)} 项齐备")
    add(
        "C1b schema 版本标记",
        str(reg.get("schema", "")).endswith("@1"),
        f"schema={reg.get('schema')!r}（须以 @1 结尾，便于后续升版时拒绝旧表）",
    )

    # C2 语义定义
    sem = reg.get("semantics") or {}
    miss_sem = [k for k in REQUIRED_SEMANTICS if k not in sem]
    add("C2 语义定义齐全", not miss_sem, "缺 " + ", ".join(miss_sem) if miss_sem else "nominal / effective 分列的定义在位")

    # C3 三框架齐全
    fws = reg.get("frameworks") or {}
    miss_fw = [k for k in REQUIRED_FRAMEWORKS if k not in fws]
    add("C3 三框架齐全", not miss_fw, "缺 " + ", ".join(miss_fw) if miss_fw else "autogen / crewai / langgraph 均在册")

    pat_total = pat_verified = pat_pending = 0
    fw_verified = fw_pending = 0

    for fname, fw in fws.items():
        st = fw.get("status")
        if st not in VALID_STATUS:
            add(f"C4 {fname} 状态取值", False, f"status={st!r} 不在 {VALID_STATUS}")
        elif st == "verified":
            fw_verified += 1
            ok = bool(fw.get("version_pin")) and bool(fw.get("verified_by"))
            add(f"C4 {fname} verified 需版本锚点", ok, f"version_pin={fw.get('version_pin')!r} verified_by={bool(fw.get('verified_by'))}")
        else:
            fw_pending += 1
            add(f"C4 {fname} pending 需理由", bool(fw.get("status_reason")), f"status_reason={bool(fw.get('status_reason'))}")

        pats = fw.get("patterns") or {}
        if not pats:
            add(f"C5 {fname} 形态非空", False, "patterns 为空")
            continue

        for pname, p in pats.items():
            tag = f"{fname}.{pname}"
            miss = [k for k in REQUIRED_PATTERN if k not in p]
            if miss:
                add(f"C5 {tag} 字段齐全", False, "缺 " + ", ".join(miss))
                continue

            pst = p.get("status")
            pat_total += 1
            if pst not in VALID_STATUS:
                add(f"C5 {tag} 状态取值", False, f"status={pst!r}")
                continue
            if pst == "verified":
                pat_verified += 1
            else:
                pat_pending += 1

            eff = as_list(p.get("whitelist_effective"))
            nom = as_list(p.get("whitelist_nominal"))
            emits = p.get("emits_chat_messages")
            ent = p.get("scheduler_entity")

            # C6 effective ⊆ nominal
            extra = [e for e in eff if e not in nom]
            add(f"C6 {tag} effective⊆nominal", not extra, "越界项 " + ", ".join(extra) if extra else f"eff={eff}")

            if pst == "verified":
                # C7 不发消息 ⇒ effective 必须为空（否则是空操作式豁免）
                if emits is False:
                    add(f"C7 {tag} 无消息实体不入 effective", eff == [], f"emits=False，effective={eff}（应为 []）")
                # C8 发消息 ⇒ 实体必须在 effective 中（否则豁免形同虚设）
                elif emits is True:
                    ok = bool(ent) and ent in eff
                    add(f"C8 {tag} 发消息实体须豁免", ok, f"emits=True，entity={ent!r}，effective={eff}")
                else:
                    add(f"C7 {tag} verified 须判定 emits", False, f"emits_chat_messages={emits!r}（verified 条目不得留空）")

                # C11 verified 必须有 evidence，且不得留 hypothesis 冒充证据
                has_ev = isinstance(p.get("evidence"), dict) and len(p["evidence"]) > 0
                add(f"C11 {tag} verified 须有 evidence", has_ev, "evidence 缺失" if not has_ev else f"{len(p['evidence'])} 条")
                add(
                    f"C11b {tag} 不得以 hypothesis 充当证据",
                    "hypothesis" not in p,
                    "verified 条目仍含 hypothesis 字段（预期不得与证据并存）" if "hypothesis" in p else "无 hypothesis",
                )
            else:
                # C9 pending 不得预先假装已治理
                add(f"C9 {tag} pending 不得预置豁免", eff == [], f"effective={eff}（pending 应为 []）")
                has_reason = bool(p.get("status_reason") or p.get("hypothesis"))
                add(
                    f"C9b {tag} pending 须说明待验内容",
                    has_reason,
                    "有 status_reason / hypothesis" if has_reason else "既无 status_reason 也无 hypothesis",
                )

    acct = reg.get("accounting") or {}
    expect = {
        "frameworks_total": len(fws),
        "frameworks_verified": fw_verified,
        "frameworks_pending": fw_pending,
        "patterns_total": pat_total,
        "patterns_verified": pat_verified,
        "patterns_pending": pat_pending,
    }
    bad = {k: (acct.get(k), v) for k, v in expect.items() if acct.get(k) != v}
    add("C10 计数与遍历一致", not bad, "不一致 " + json.dumps(bad, ensure_ascii=False) if bad else "6 项计数吻合")

    # C12 至少有一个 verified 形态可供执行——全 pending 等于表还没写完
    add("C12 至少一条 verified", pat_verified > 0, f"verified 形态 {pat_verified} 条")

    return out


def selftest(reg: dict) -> int:
    """逐条注入缺陷，对应检查项必须 FAIL。"""
    cases: list[tuple[str, str, callable]] = [
        ("C1 顶层字段齐全", "删 frozen_at", lambda r: r.pop("frozen_at")),
        ("C2 语义定义齐全", "删 pending_policy", lambda r: r["semantics"].pop("pending_policy")),
        ("C4 autogen verified 需版本锚点", "清空 version_pin", lambda r: r["frameworks"]["autogen"].update(version_pin=None)),
        ("C6 autogen.A effective⊆nominal", "塞入未登记实体", lambda r: r["frameworks"]["autogen"]["patterns"]["A"]["whitelist_effective"].append("GhostManager")),
        (
            "C7 autogen.A 无消息实体不入 effective",
            "把调度器塞进 effective",
            lambda r: r["frameworks"]["autogen"]["patterns"]["A"].update(whitelist_effective=["SelectorGroupChatManager"]),
        ),
        (
            "C8 autogen.B 发消息实体须豁免",
            "谎称发消息但 effective 为空",
            lambda r: r["frameworks"]["autogen"]["patterns"]["B"].update(emits_chat_messages=True),
        ),
        (
            "C9 autogen.B pending 不得预置豁免",
            "把已 verified 形态转 pending 并预置豁免",
            lambda r: r["frameworks"]["autogen"]["patterns"]["B"].update(
                status="pending", status_reason="反向测试构造", whitelist_effective=["SelectorGroupChatManager"]
            ),
        ),
        ("C11 autogen.B verified 须有 evidence", "清空 evidence", lambda r: r["frameworks"]["autogen"]["patterns"]["B"].update(evidence={})),
        (
            "C7 autogen.M 无消息实体不入 effective",
            "给攻击形态塞调度器豁免（M 的 selector 是确定性函数，仍不发消息）",
            lambda r: r["frameworks"]["autogen"]["patterns"]["M"].update(whitelist_effective=["SelectorGroupChatManager"]),
        ),
        (
            "C6 autogen.M effective⊆nominal",
            "攻击形态塞入未登记实体",
            lambda r: r["frameworks"]["autogen"]["patterns"]["M"].update(whitelist_effective=["GhostManager"]),
        ),
        (
            "C11b autogen.B 不得以 hypothesis 充当证据",
            "verified 保留 hypothesis",
            lambda r: r["frameworks"]["autogen"]["patterns"]["B"].update(hypothesis="待验"),
        ),
        (
            "C10 计数与遍历一致",
            "篡改计数（写成与遍历结果不同的值，注意不得用「本来就是该值」的空操作）",
            lambda r: r["accounting"].update(patterns_total=99),
        ),
        (
            "C12 至少一条 verified",
            "全部转 pending",
            lambda r: [p.update(status="pending") for fw in r["frameworks"].values() for p in fw["patterns"].values()],
        ),
    ]

    failures = 0
    for expect_id, desc, mutate in cases:
        probe = copy.deepcopy(reg)
        mutate(probe)
        results = check(probe)
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
    ap = argparse.ArgumentParser(description="校验白名单登记表结构")
    ap.add_argument("--registry", default=str(REGISTRY))
    ap.add_argument("--selftest", action="store_true", help="反向测试：注入缺陷，逐项确认可 FAIL")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    path = Path(args.registry)
    if not path.exists():
        print(f"[FAIL] 登记表不存在：{path}")
        return 2
    reg = json.loads(path.read_text(encoding="utf-8"))

    if args.selftest:
        return selftest(reg)

    results = check(reg)
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
