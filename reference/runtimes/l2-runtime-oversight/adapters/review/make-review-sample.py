#!/usr/bin/env python3
"""AOE-CALIB-007 · 标记/语义双人核对 —— 分层抽样与盲化出表

为什么要这个脚本：抽检必须是**可复现**的。如果抽样是「随手挑 20 条」，
那么一致性率就变成可以由挑样本的人调出来的数字。这里把「抽哪些」写死成
种子 + 算法，任何人重跑都得到同一批消息（幂等），并且输出语料指纹，
使得「换一批语料重跑」这件事本身可被检出。

设计要点
--------
1. **分层维度 = 消息自带标记**。理由：不一致风险高度集中在「标记为 assign」的
   消息上；按标记分层是方差缩减，不是自证（见下）。
2. **但抽检结果不用于估计总体不一致率**。这是校验映射表的质量闸门，不是总体
   估计；报告只给「本批次样本内」的比例，并披露各层实际条数。禁止外推。
3. **过采样调度侧**：assign 层配额 10/20，因为派发语义的误判几乎全落在这一层。
4. **盲化 = 遮蔽标记，不遮蔽作者**。判类人看不到 type/_format_mark/_tool_calls/
   轨道名（轨道名会泄漏 attack/benign），但必须看到 from/to —— 否则无法判断
   「谁把什么派给谁」。故本核对是「标记盲」，不是「场景盲」，这一限制写入 README。
5. **确定性抽样**：SEED 为固定字面量；候选按 sid 排序后入池；层内先按轨道
   轮转（保证跨轨道覆盖），轨道内用 seed 派生的 rng 打乱。
6. **示例即答案**：规约示例都带判类结论，故 `examples-lock.json` 里登记的 sid
   **永久排除**（读入即剔除 + 抽样后二次 assert，命中退 5）。缺表或空表直接拒抽。
7. **不得复用上一批**：`--exclude <上一批 sample-frame.json>` 把该批 sid 全部剔除；
   换批次必须换 `--seed` 并登记。旧 frame 在覆盖前自动归档到 `out/_archive/`。

用法
----
    python make-review-sample.py                 # 生成到 ./out
    python make-review-sample.py --check         # 只打印分层可用量（已扣示例与排除项）
    python make-review-sample.py --lock-check    # 只校验示例锁定表
    python make-review-sample.py --seed "AOE-CALIB-007::REVIEW::v1.1::<日>" \
        --exclude out/_archive/sample-frame_<上一批>.json
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import shutil
import sys
import time
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTERS = os.path.dirname(HERE)  # .../adapters
FRAMEWORKS = ("autogen", "crewai", "langgraph")

# 示例锁定表：规约示例带判类结论 ⇒ 示例条目永久排除于样本池（示例即答案）。
# 这是机制而不是检查：读入即从候选池剔除，抽样后再 assert 一次（命中退 5）。
EXAMPLES_LOCK = os.path.join(HERE, "examples-lock.json")

# 抽样种子：冻结字面量。改它 = 换一批样本 = 视为核对方案修订，须重出记录。
SEED = "AOE-CALIB-007::REVIEW::v1::2026-11-04"

# 每框架配额，合计 20。assign 层过采样（10/20），因为派发语义误判几乎全在这一层。
QUOTA = {"assign": 10, "freeform": 5, "report": 5}
TARGET_PER_FRAMEWORK = sum(QUOTA.values())

# 标记 → 分层。assign 类严格对齐检测器 index.ts:1397 的 SWARM_ASSIGN_TYPES。
ASSIGN_TYPES = {"task_assign", "dispatch", "delegate", "subtask_assign"}
FREEFORM_TYPES = {"chat", "note", "status", "ack"}

TEXT_LIMIT = 4000      # 本条正文上限（字符）；超限时显式标注原文长度，供判类人打 trunc 标
PREV_LIMIT = 160       # 上一条摘要上限
SHEET_COLS = [
    "序号", "别名", "位置", "发送者", "接收者",
    "上一条发送者", "上一条摘要", "本条正文",
    "判类(D/H/R/C)", "疑难(Y/N)", "备注",
]


def stratum_of(mtype: str) -> str:
    if mtype in ASSIGN_TYPES:
        return "assign"
    if mtype in FREEFORM_TYPES:
        return "freeform"
    if mtype == "report":
        return "report"
    return "other"


def load_examples_lock(path: str = EXAMPLES_LOCK) -> tuple[set[str], str]:
    """读示例锁定表，返回（锁定 sid 集合, 表内指纹）。

    缺表或空表一律硬失败：**宁可拒绝抽样，也不可在「无锁定」状态下出表**——
    静默放行等于把「示例即答案」这条硬约束降级成口头约定。
    """
    if not os.path.isfile(path):
        raise SystemExit(f"缺少示例锁定表 {path}：示例带判类结论，无锁定表不得抽样。")
    raw = open(path, "rb").read()
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"示例锁定表无法解析（{e}）：{path}")
    sids = {e["sid"] for e in (obj.get("entries") or []) if e.get("sid")}
    if not sids:
        raise SystemExit(f"示例锁定表 entries 为空或格式不对：{path}")
    return sids, hashlib.sha256(raw).hexdigest()


def load_excluded_frames(paths: list[str]) -> set[str]:
    """读历史 sample-frame.json 的 sid 集合，用于「本批不得复用上一批样本」。"""
    out: set[str] = set()
    for p in paths:
        if not os.path.isfile(p):
            raise SystemExit(f"--exclude 指向的文件不存在：{p}")
        fr = json.load(open(p, encoding="utf-8"))
        sids = {v["sid"] for v in (fr.get("alias_map") or {}).values()}
        if not sids:
            raise SystemExit(f"--exclude 的文件里没有 alias_map.sid：{p}")
        out |= sids
    return out


def clean(text: str, limit: int) -> str:
    t = (text or "").replace("\r", "").replace("\n", " ⏎ ").strip()
    if len(t) <= limit:
        return t
    return t[:limit] + f"…（已截断，原文 {len(t)} 字符）"


def load_candidates() -> tuple[list[dict], str]:
    """读三框架全部轨迹，返回候选消息 + 语料指纹。

    正文优先取 `swarm-text.jsonl`（全文 sidecar）。没有 sidecar 时退回 `_content_head`
    （仅 160 字）并标 `head_only`——这种行判类基本靠猜，出表时会在清单里显式警示。
    """
    cands: list[dict] = []
    h = hashlib.sha256()
    head_only = 0
    for fw in FRAMEWORKS:
        out_root = os.path.join(ADAPTERS, fw, "out")
        if not os.path.isdir(out_root):
            continue
        for track in sorted(os.listdir(out_root)):
            p = os.path.join(out_root, track, "swarm-msgs.jsonl")
            if not os.path.isfile(p):
                continue
            with open(p, "rb") as f:
                h.update(f.read())
            rows = [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
            # 全文 sidecar：seq → text
            full: dict[int, str] = {}
            sp = os.path.join(out_root, track, "swarm-text.jsonl")
            if os.path.isfile(sp):
                for l in open(sp, encoding="utf-8"):
                    if l.strip():
                        o = json.loads(l)
                        full[o["seq"]] = o.get("text") or ""
            prev = None
            for seq, r in enumerate(rows, 1):
                raw = full.get(seq)
                if raw is None:
                    raw = r.get("_content_head") or ""
                    head_only += 1
                cands.append({
                    "sid": f"{fw}/{track}#{seq}",
                    "framework": fw,
                    "track": track,
                    "pos": seq,
                    "from": r.get("from") or "?",
                    "to": r.get("to") or "?",
                    "prev_from": prev.get("from") if prev else "",
                    "prev_text": clean(prev.get("_content_head") or "", PREV_LIMIT) if prev else "",
                    "text": clean(raw, TEXT_LIMIT),
                    "raw_len": len(raw),
                    # 以下仅协调人可见，不进判类表
                    "marker": stratum_of(r.get("type") or ""),
                    "marker_raw": r.get("type") or "",
                })
                prev = r
    if head_only:
        print(f"⚠️ {head_only} 条无全文 sidecar，退回 160 字 head（判类不可靠）", file=sys.stderr)
    return cands, h.hexdigest()


def draw(cands: list[dict], rng_seed: str) -> tuple[list[dict], dict]:
    """按层配额抽样；层内跨轨道轮转，保证不集中在单条轨迹上。"""
    by_stratum: dict[str, list[dict]] = defaultdict(list)
    for c in cands:
        by_stratum[c["marker"]].append(c)
    for k in by_stratum:
        by_stratum[k].sort(key=lambda x: x["sid"])

    chosen: list[dict] = []
    picked: set[str] = set()
    log: dict[str, dict] = {}
    leftover: dict[str, list[dict]] = {}

    for st in ("assign", "freeform", "report", "other"):
        pool = by_stratum.get(st, [])
        want = QUOTA.get(st, 0)
        picked_here = _take_layered(pool, want, rng_seed + "::" + st)
        chosen.extend(picked_here)
        picked.update(c["sid"] for c in picked_here)
        leftover[st] = [c for c in pool if c["sid"] not in {x["sid"] for x in picked_here}]
        log[st] = {"quota": want, "available": len(pool), "taken": len(picked_here)}

    # 配额回填：某层结构性为空时，把缺口按「剩余可用量降序」逐条回填
    deficit = TARGET_PER_FRAMEWORK - len(chosen)
    realloc: list[str] = []
    while deficit > 0:
        order = sorted(
            (k for k, v in leftover.items() if v),
            key=lambda k: (-len(leftover[k]), k),
        )
        if not order:
            break
        k = order[0]
        take = _take_layered(leftover[k], 1, rng_seed + "::refill::" + k + str(deficit))
        if not take:
            leftover[k] = []
            continue
        chosen.append(take[0])
        leftover[k] = [c for c in leftover[k] if c["sid"] != take[0]["sid"]]
        log[k]["taken"] += 1
        realloc.append(f"{k}+1")
        deficit -= 1

    return chosen, {"strata": log, "reallocation": realloc, "achieved": len(chosen),
                    "shortfall": deficit}


def _take_layered(pool: list[dict], want: int, seed: str) -> list[dict]:
    """层内抽样：按轨道轮转，轨道顺序固定，轨道内用 seed 打乱。"""
    if want <= 0 or not pool:
        return []
    rng = random.Random(seed)
    buckets: dict[str, list[dict]] = defaultdict(list)
    for c in pool:
        buckets[c["track"]].append(c)
    for k in buckets:
        buckets[k].sort(key=lambda x: x["pos"])
        rng.shuffle(buckets[k])
    order = sorted(buckets)
    out: list[dict] = []
    while len(out) < want and any(buckets[k] for k in order):
        for k in order:
            if buckets[k] and len(out) < want:
                out.append(buckets[k].pop())
    return out


def assign_aliases(rows: list[dict], fw_index: int, prefix: str | None = None) -> None:
    """别名：框架字母 + 序号，不含场景信息。同一轨道内序号连续，便于判类人跨条推理。

    跨批次同名不同物是记录失真的高发点（v1 的 `A-08` 与 v1.1 的 `A-08` 是两条不同消息），
    故允许 `--alias-prefix` 给新批次换一个与前批不相交的前缀。
    """
    prefix = prefix or chr(ord("A") + fw_index)
    for i, r in enumerate(rows, 1):
        r["alias"] = f"{prefix}-{i:02d}"


def filled_rows(path: str) -> int:
    """已填写的判类行数；文件不存在或列不全时返回 0。"""
    if not os.path.isfile(path):
        return 0
    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            return sum(1 for r in csv.DictReader(f) if (r.get("判类(D/H/R/C)") or "").strip())
    except Exception:
        return 0


def write_sheets(rows: list[dict], fw: str, out_dir: str, judge: str, force: bool = False) -> str:
    path = os.path.join(out_dir, f"判类表_{fw}_{judge}.csv")
    n_filled = filled_rows(path)
    if n_filled and not force:
        raise SystemExit(
            f"拒绝覆盖：{path} 已有 {n_filled} 条判类填好。抽样重跑会清空人工判类结果。\n"
            f"如确需重抽，先把 {os.path.basename(path)} 备份到 out/_archive/ 再传 --force。"
        )
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(SHEET_COLS)
        for i, r in enumerate(rows, 1):
            w.writerow([
                i, r["alias"], f"#{r['pos']}", r["from"], r["to"],
                r["prev_from"], r["prev_text"], r["text"], "", "", "",
            ])
    return path


def write_checklist(rows: list[dict], fw: str, out_dir: str, meta: dict) -> str:
    path = os.path.join(out_dir, f"抽检清单_{fw}.md")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"# 抽检清单 · {fw}\n\n")
        f.write(f"- 抽样种子：`{meta.get('seed') or SEED}`\n")
        f.write(f"- 语料指纹：`{meta['corpus_sha256'][:16]}…`\n")
        f.write(f"- 示例锁定表：`{meta.get('examples_lock_sha256', '—')[:16]}…`（示例条目已从候选池剔除）\n")
        if meta.get("census"):
            f.write("- 模式：**全量普查**（候选已扣除示例锁定与历史批次，不做配额抽样）\n")
        else:
            f.write(f"- 配额：assign {QUOTA['assign']} / freeform {QUOTA['freeform']} / report {QUOTA['report']}"
                    f" = {TARGET_PER_FRAMEWORK}\n")
        f.write(f"- 实际抽取：{meta['achieved']} 条"
                + (f"（缺口 {meta['shortfall']} 条，可用量耗尽）" if meta["shortfall"] else "") + "\n")
        s = meta["strata"]
        f.write("\n| 层 | 配额 | 可用 | 实取 |\n|---|---|---|---|\n")
        for k in ("assign", "freeform", "report", "other"):
            v = s.get(k) or {"quota": 0, "available": 0, "taken": 0}
            if v["available"] == 0 and v["quota"] == 0:
                continue
            flag = "**结构性空层**" if v["available"] == 0 else ""
            f.write(f"| {k} | {v['quota']} | {v['available']} | {v['taken']} {flag}|\n")
        if meta["reallocation"]:
            f.write(f"\n回填记录：{', '.join(meta['reallocation'])}\n")
        f.write("\n## 样本明细（含标记，协调人专用，**不得交判类人**）\n\n")
        f.write("| 别名 | sid | 发送者→接收者 | 标记 | 正文摘要 |\n|---|---|---|---|---|\n")
        for r in rows:
            # 正文可能自带 `|`：不转义会把 Markdown 表格撑成多列（门禁会判「列数与分隔行不一致」）
            head = r["text"][:60].replace("|", "\\|")
            f.write(f"| {r['alias']} | `{r['sid']}` | {r['from']}→{r['to']} "
                    f"| {r['marker_raw']} | {head} |\n")
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--check", action="store_true", help="只打印分层可用量")
    ap.add_argument("--force", action="store_true", help="允许覆盖已填写的判类表（会清空人工判类）")
    ap.add_argument("--seed", default=SEED, help="抽样种子；换批次必须换种子并登记")
    ap.add_argument("--exclude", action="append", default=[],
                    metavar="FRAME.json", help="上一批 sample-frame.json，其 sid 全部排除（可重复）")
    ap.add_argument("--lock-check", action="store_true", help="只校验示例锁定表并打印 sid 指纹")
    ap.add_argument("--frameworks", default=",".join(FRAMEWORKS),
                    help="只出这些框架的表，逗号分隔（如 autogen）；默认三个都出")
    ap.add_argument("--census", action="store_true",
                    help="全量普查：取该框架全部候选，不做配额抽样（候选已被示例/历史批次筛过时用）")
    ap.add_argument("--alias-prefix", default=None,
                    help="别名前缀（默认按框架字母）；新批次建议换前缀，避免与上一批同名不同物")
    args = ap.parse_args()

    fws = [s.strip() for s in args.frameworks.split(",") if s.strip()]
    bad = [f for f in fws if f not in FRAMEWORKS]
    if bad or not fws:
        print(f"--frameworks 非法：{bad or '(空)'}；可选 {list(FRAMEWORKS)}", file=sys.stderr)
        return 6

    locked, lock_sha = load_examples_lock()
    if args.lock_check:
        print(f"示例锁定表：{len(locked)} 条 / sha256 {lock_sha[:16]}…")
        for s in sorted(locked):
            print(f"  - {s}")
        return 0

    cands, fingerprint = load_candidates()
    if not cands:
        print("未找到任何轨迹。先跑各框架的 collect.py。", file=sys.stderr)
        return 2

    excluded = load_excluded_frames(args.exclude)
    n_all = len(cands)
    locked_hit = [c for c in cands if c["sid"] in locked]
    cands = [c for c in cands if c["sid"] not in locked and c["sid"] not in excluded]

    print(f"语料：{n_all} 条消息 / 指纹 {fingerprint[:16]}…")
    print(f"排除：示例锁定 {len(locked)} 条（命中 {len(locked_hit)}）、"
          f"历史批次 {len(excluded)} 条 ⇒ 候选 {len(cands)} 条")
    if len(locked_hit) < len(locked):
        missing = sorted(locked - {c["sid"] for c in locked_hit})
        print(f"⚠️ 锁定表中 {len(missing)} 条在当前语料里不存在（语料换过或 sid 写错）：{missing}",
              file=sys.stderr)
    for fw in fws:
        sub = [c for c in cands if c["framework"] == fw]
        cnt = Counter(c["marker"] for c in sub)
        print(f"  {fw:10s} 可用 {len(sub):3d}  " +
              "  ".join(f"{k}={cnt.get(k, 0)}" for k in ("assign", "freeform", "report", "other")))

    if args.check:
        return 0

    # 覆盖保护：整批预检，任一表已填就整体中止，不留「前几张被清空」的半成品
    if not args.force:
        conflicts = []
        for fw in fws:
            for judge in ("A", "B"):
                p = os.path.join(args.out, f"判类表_{fw}_{judge}.csv")
                n = filled_rows(p)
                if n:
                    conflicts.append((os.path.basename(p), n))
        if conflicts:
            print("拒绝覆盖：以下判类表已有人工判类，重抽会清空这些结果。", file=sys.stderr)
            for name, n in conflicts:
                print(f"  - {name}：已填 {n} 条", file=sys.stderr)
            print("如确需重抽，先备份到 out/_archive/ 再传 --force。", file=sys.stderr)
            return 3

    os.makedirs(args.out, exist_ok=True)
    seed = args.seed
    manifest = {
        "protocol": "AOE-CALIB-007 · 标记/语义双人核对",
        "seed": seed,
        "alias_prefix": args.alias_prefix,
        "census": bool(args.census),
        "frameworks_included": fws,
        "corpus_sha256": fingerprint,
        "corpus_size": len(cands),
        "corpus_size_before_exclusion": n_all,
        "examples_lock_sha256": lock_sha,
        "excluded_sids_count": len(excluded),
        "quota_per_framework": QUOTA,
        "target_per_framework": TARGET_PER_FRAMEWORK,
        "text_limit": TEXT_LIMIT,
        "blind": "遮蔽 type/_format_mark/_tool_calls 与轨道名；保留 from/to",
        "frameworks": {},
        "alias_map": {},
    }

    for idx, fw in enumerate(fws):
        sub = [c for c in cands if c["framework"] == fw]
        if args.census:
            rows = sorted(sub, key=lambda r: (r["track"], r["pos"]))
            cnt = Counter(c["marker"] for c in sub)
            meta = {
                "strata": {k: {"quota": 0, "available": cnt.get(k, 0), "taken": cnt.get(k, 0)}
                           for k in ("assign", "freeform", "report", "other")},
                "reallocation": [], "achieved": len(rows), "shortfall": 0, "census": True,
            }
        else:
            rows, meta = draw(sub, seed + "::" + fw)
        # 二次闸门：即使上游过滤有漏，抽样结果也不得命中示例
        hit = sorted({r["sid"] for r in rows} & locked)
        if hit:
            print(f"抽样结果命中示例锁定表：{hit} —— 示例即答案，拒绝出表。", file=sys.stderr)
            return 5
        rows.sort(key=lambda r: (r["track"], r["pos"]))
        assign_aliases(rows, idx, args.alias_prefix if len(fws) == 1 else None)
        write_sheets(rows, fw, args.out, "A", args.force)
        write_sheets(rows, fw, args.out, "B", args.force)
        write_checklist(rows, fw, args.out, {**meta, "corpus_sha256": fingerprint, "seed": seed})
        manifest["frameworks"][fw] = meta
        for r in rows:
            manifest["alias_map"][r["alias"]] = {
                "sid": r["sid"], "marker_raw": r["marker_raw"], "stratum": r["marker"],
                "from": r["from"], "to": r["to"],
            }
        print(f"  → {fw}: 抽 {meta['achieved']} 条"
              + (f"（缺口 {meta['shortfall']}）" if meta["shortfall"] else ""))

    frame_path = os.path.join(args.out, "sample-frame.json")
    if os.path.isfile(frame_path):
        arch = os.path.join(args.out, "_archive")
        os.makedirs(arch, exist_ok=True)
        dst = os.path.join(arch, f"sample-frame_{time.strftime('%Y%m%dT%H%M%S')}.json")
        shutil.copyfile(frame_path, dst)
        print(f"\n上一批 frame 已归档：{dst}（可用作 --exclude 输入）")
    with open(frame_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"\n产物目录：{args.out}")
    print("判类表（A/B 两份内容相同，供两人独立填写）、抽检清单（含标记，勿外传）、sample-frame.json（抽样凭据）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
