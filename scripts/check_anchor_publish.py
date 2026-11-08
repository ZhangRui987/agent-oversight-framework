#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_anchor_publish.py —— 外锚摘要串「发布」的机器校验（v2.71.0 新增 / 门禁第 52 项）

── 为什么需要这一层 ──────────────────────────────────────────────────────────
`aof-anchor/v1:…` 摘要串是「锚尾被整体删掉」唯一能被域外检出的载体（spec/10 10-D11）。
在 v2.70.0 之前，这一步完全靠人：把串贴进 Release 说明。漏贴、贴了旧串、重锚后忘了
重新发布——三种情况仓库内部**都看不出来**，因为锚日志自己是对的，链也是对的。
「承诺靠纪律维护必然漂移」在 Release 节奏上已经应验过一次（30 个 tag 无 Release），
这里不再重犯：把 checklist 变成可校验不变量。

── 五项校验（P1–P3 离线；P4–P5 需 Release 正文）──────────────────────────────
  P1 覆盖      每条链的**当前**锚必须在 published-anchors.jsonl 有记录，且串逐字相等；
               同一锚被多次登记（重复公布）时，各条不得给出不同串。
  P2 可溯      每条记录必须指向锚日志里真实存在的 (chain_id, anchor_seq)，且串与之相符
               ——防「先写一条『已发布』记录，再声称已发布」。
  P3 仓内声明  CHANGELOG 的当前 VERSION 小节必须逐字含当前串；该小节内出现的合法串
               必须属于当前集合（贴了旧串即 FAIL，不会被「至少有一条对」蒙过）。
  P4 域外     每条记录所在版本 v<version> 的 Release 正文必须含该串。
               `--release-body= --version=` 指定单个版本时，若**没有任何登记属于该版本**，
               报 FAIL 而不是空集通过——否则「忘了 --publish-lines」时这一项没检查对象，
               预检会给出绿灯（10-D5「空集返回 null 不返回 0」同一条纪律）。
  P5 双向闭包 任何 Release 正文里的合法串都必须有对应记录——否则删掉记录即可绕过 P4。
  P6 时间戳   RFC 3161 可信时间戳子检查（v2.77.0，实现在 scripts/anchor_tsa.py）：
               P6a proofs.jsonl 每条证明可溯、存在且离线 openssl 验签 OK；
               P6b 每条当前锚都有 status=ok 的 TSA 见证。纯离线，TSA 只在 submit 时需要。

── 四条设计约束 ─────────────────────────────────────────────────────────────
  1. **不读 anchor.jsonl**：锚格式与锚链规则只在 `check-anchor.mts` 里实现一份，
     本脚本消费 `--emit-digests` 的 JSON。两套规格并行必然漂移（仓库老教训）。
  2. **只认严格匹配的串**：正则要求 64 位 hex 末哈希 + 16 位锚哈希前缀。Release 正文里
     的格式模板 `aof-anchor/v1:<chain_id>:<anchor_seq>:…` 是说明不是断言——naive grep
     会把它算成「一条未登记的串」而误报。误报会让人关掉检查，比没有检查更差。
  3. **门禁只跑离线部分**：P1–P3 + 反向测试，确定性、不联网；P4/P5 只在 `--release`
     或 `--release-body=` 下跑，避免 CI 因网络抖动变红。
  4. **反向测试断言「指定项」命中**，不是「任意一项 FAIL」——否则被别的检查顺带拦住
     也会显示 PASS，判别力虚高（D-5 同类陷阱，本仓库犯过两次）。

── 用法 ─────────────────────────────────────────────────────────────────────
  python scripts/check_anchor_publish.py                     # 离线：P1–P3
  python scripts/check_anchor_publish.py --release           # 联网：额外 P4–P5（GitHub API）
  python scripts/check_anchor_publish.py --release-body=FILE --version=2.71.0
                                                             # 发版前用本地说明文件预检
  python scripts/check_anchor_publish.py --selftest          # 基线 + 8 条反向测试

退出码：0 = 全通过；1 = 有失败；2 = 环境问题（node / 文件缺失）。
"""
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION_FILE = ROOT / "VERSION"
CHANGELOG = ROOT / "CHANGELOG.md"
PUBLISHED = ROOT / "tools" / "disposition" / "data" / "published-anchors.jsonl"
ANCHOR_SCRIPT = ROOT / "tools" / "disposition" / "check-anchor.mts"

OWNER, REPO = "ZhangRui987", "agent-oversight-framework"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"

# 发布记录的键序冻结：手抄容易漏/错位，机器比对前先卡结构。
FIELDS = ["published_version", "chain_id", "anchor_seq", "digest"]

# 严格匹配：末尾 (?![0-9a-f]) 防止把更长的 hex 串截断后当成命中。
DIGEST_RE = re.compile(
    r"(?<![0-9a-zA-Z])aof-anchor/v(?P<ver>\d+):(?P<chain>[a-z0-9][a-z0-9._/-]*)"
    r":(?P<seq>\d+):(?P<count>\d+):(?P<last>[0-9a-f]{64}):(?P<prefix>[0-9a-f]{16})(?![0-9a-f])"
)


class Check:
    def __init__(self, cid, name, ok, detail):
        self.id, self.name, self.ok, self.detail = cid, name, ok, detail


def digests_in(text):
    """取出文本里所有**合法**摘要串（去重、保序）。格式模板不会被匹配。"""
    out, seen = [], set()
    for m in DIGEST_RE.finditer(text or ""):
        s = m.group(0)
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 输入：锚（来自 Node）、发布记录、CHANGELOG
# ─────────────────────────────────────────────────────────────────────────────

def load_anchors():
    """消费 check-anchor.mts --emit-digests；解析失败一律视为环境问题。"""
    if not ANCHOR_SCRIPT.exists():
        raise RuntimeError(f"缺少 {ANCHOR_SCRIPT.relative_to(ROOT)}")
    st = subprocess.run(
        ["node", "--experimental-transform-types", str(ANCHOR_SCRIPT), "--emit-digests"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=120, cwd=str(ROOT),
    )
    if st.returncode != 0:
        err = [ln.strip() for ln in (st.stdout or "").splitlines() + (st.stderr or "").splitlines()
               if ln.strip() and "ExperimentalWarning" not in ln and "trace-warnings" not in ln]
        raise RuntimeError("锚输出失败：" + (" | ".join(err[-3:]) or "无输出"))
    rows = []
    for ln in (st.stdout or "").splitlines():
        if not ln.strip():
            continue
        try:
            rows.append(json.loads(ln))
        except json.JSONDecodeError as e:
            raise RuntimeError(f"--emit-digests 第 {len(rows) + 1} 行不是 JSON：{e}")
    if not rows:
        raise RuntimeError("--emit-digests 无输出（锚日志为空？）")
    return rows


def load_published(path=PUBLISHED):
    if not path.exists():
        raise RuntimeError(f"缺少 {path}——用 `--publish-lines` 生成待追加行")
    rows = []
    for i, ln in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not ln.strip():
            continue
        try:
            obj = json.loads(ln)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"{path.name} 第 {i} 行不是 JSON：{e}")
        if list(obj.keys()) != FIELDS:
            raise RuntimeError(
                f"{path.name} 第 {i} 行键序不符：应为 {FIELDS}，实为 {list(obj.keys())}"
            )
        rows.append(obj)
    if not rows:
        raise RuntimeError(f"{path.name} 为空——至少要有当前锚的发布记录")
    return rows


def changelog_section(text, version):
    """取 `## v<version>` 小节（到下一个小节前）。返回 (存在?, 小节正文)。"""
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith(f"## v{version}"):
            start = i
            break
    if start is None:
        return False, ""
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return True, "\n".join(lines[start:end])


# ─────────────────────────────────────────────────────────────────────────────
# 校验主体（纯函数：输入全部来自参数，便于反向测试直接变异）
# ─────────────────────────────────────────────────────────────────────────────

def run_checks(anchors, published, changelog_text, version, bodies=None, p4_scope=None):
    """
    anchors    : --emit-digests 的行（含 latest 标记）
    published  : published-anchors.jsonl 的行
    bodies     : {version: Release 正文}；None 表示跳过 P4/P5（离线模式）
    p4_scope   : 只对这些版本的登记做 P4（--release-body= 单版本预检用；None = 全部）
    """
    latest = [a for a in anchors if a.get("latest")]
    current = {a["chain_id"]: a for a in latest}
    current_digests = {a["digest"] for a in latest}
    by_key = {(a["chain_id"], a["anchor_seq"]): a for a in anchors}
    checks = []

    # P1 覆盖：当前锚必须被记录，且串逐字相等；同一锚的多次登记不得互相矛盾
    #
    # 「不得矛盾」这一条是实测补上的：一个版本可能在多个版本里被重复登记（重复公布是
    # 允许的、也是鼓励的），此时只查「存在一条对得上」会让「其中一条被改坏」静默通过。
    # 同一 (chain_id, anchor_seq) 出现两个不同串，至少有一条是错的——必须报出来。
    miss, drift, conflict = [], [], []
    by_anchor = {}
    for p in published:
        by_anchor.setdefault((p["chain_id"], p["anchor_seq"]), set()).add(p["digest"])
    for (chain_id, seq), ds in sorted(by_anchor.items()):
        if len(ds) > 1:
            conflict.append(f"{chain_id} seq={seq}：{len(ds)} 条登记给出不同串（自相矛盾）")
    for a in latest:
        rows = [p for p in published if p["chain_id"] == a["chain_id"]]
        if not rows:
            miss.append(f"{a['chain_id']}（锚 seq={a['anchor_seq']} 无任何发布记录）")
        elif not any(p["digest"] == a["digest"] for p in rows):
            last = rows[-1]
            drift.append(
                f"{a['chain_id']}：记录 seq={last['anchor_seq']} 的串 ≠ 当前锚 seq={a['anchor_seq']}"
                f"（{last['digest'][:44]}… vs {a['digest'][:44]}…）"
            )
    checks.append(Check(
        "P1",
        "每条链的当前锚都有发布记录，串逐字相等，且同一锚的多次登记不矛盾",
        not miss and not drift and not conflict,
        "；".join(miss + drift + conflict) if (miss or drift or conflict)
        else f"{len(latest)} 条链均有记录且串一致（{len(by_anchor)} 个锚·版本组合无矛盾）",
    ))

    # P2 可溯：记录必须指向真实锚行，且串与之相符
    bad = []
    for p in published:
        row = by_key.get((p["chain_id"], p["anchor_seq"]))
        if row is None:
            bad.append(f"{p['chain_id']} seq={p['anchor_seq']}：锚日志里不存在该锚（记录凭空而来）")
        elif row["digest"] != p["digest"]:
            bad.append(f"{p['chain_id']} seq={p['anchor_seq']}：记录串与该锚行派生串不一致（手抄错？）")
    checks.append(Check(
        "P2",
        "每条发布记录都能指回真实锚行，且串与该锚行相符",
        not bad,
        "；".join(bad[:4]) if bad else f"{len(published)} 条记录全部可溯",
    ))

    # P3 仓内声明：CHANGELOG 当前版本小节
    exists, section = changelog_section(changelog_text, version)
    if not exists:
        checks.append(Check("P3", "CHANGELOG 当前版本小节声明当前锚串且不含旧串", False,
                            f"CHANGELOG 找不到 `## v{version}` 小节"))
    else:
        in_section = digests_in(section)
        missing = sorted(current_digests - set(in_section))
        stale = [d for d in in_section if d not in current_digests]
        detail = []
        if missing:
            detail.append(f"缺 {len(missing)} 条当前串：" + "；".join(m[:52] + "…" for m in missing))
        for d in stale:
            m = DIGEST_RE.search(d)
            detail.append(f"存在非当前锚的串（{m.group('chain')} seq={m.group('seq')}）——重锚后未更新？")
        checks.append(Check(
            "P3",
            "CHANGELOG 当前版本小节逐字含当前锚串，且不残留旧串",
            not missing and not stale,
            "；".join(detail) if detail else f"v{version} 小节含 {len(current_digests)} 条当前串，无旧串",
        ))

    # P4 / P5 只在拿到 Release 正文时跑
    if bodies is not None:
        bad = []
        scope = [p for p in published
                 if p4_scope is None or p["published_version"] in p4_scope]
        # 空集必须报 FAIL，不能 vacuous PASS（10-D5 同一条纪律：空集返回 null，不返回 0）。
        # 构造：发了新版但忘了 `--publish-lines` 追加登记，于是 P4 的 scope 为空——
        # 此时「正文里没有该版本的串」这件事根本没人检查，预检会给出绿灯。
        if p4_scope is not None and not scope:
            bad.append(
                "v%s：没有任何发布登记属于该版本——先跑 `--publish-lines` 追加再预检"
                % "/".join(sorted(p4_scope))
            )
        for p in scope:
            body = bodies.get(p["published_version"])
            if body is None:
                bad.append(f"v{p['published_version']}：找不到该版本的 Release 正文（minor 必发政策）")
            elif p["digest"] not in digests_in(body):
                bad.append(f"v{p['published_version']}：正文缺 {p['chain_id']} seq={p['anchor_seq']} 的串")
        checks.append(Check(
            "P4",
            "每条发布记录所在版本的 Release 正文都逐字含该串",
            not bad,
            "；".join(sorted(set(bad))[:4]) if bad else f"{len(scope)} 条记录均已在对应 Release 正文中",
        ))

        known = {p["digest"] for p in published}
        bad = []
        for ver, body in sorted(bodies.items()):
            for d in digests_in(body):
                if d not in known:
                    m = DIGEST_RE.search(d)
                    bad.append(f"v{ver} 正文含未登记串（{m.group('chain')} seq={m.group('seq')}）")
        checks.append(Check(
            "P5",
            "Release 正文里的合法串都已登记（删记录绕不过 P4）",
            not bad,
            "；".join(bad[:4]) if bad else f"{len(bodies)} 个版本正文无未登记串",
        ))

    return checks


# ─────────────────────────────────────────────────────────────────────────────
# 输出与入口
# ─────────────────────────────────────────────────────────────────────────────

def report(checks):
    bad = [c for c in checks if not c.ok]
    print()
    print("外锚摘要串 · 发布校验")
    print("─" * 76)
    for c in checks:
        print(f"[{'PASS' if c.ok else 'FAIL'}] {c.id} {c.name}")
        print(f"       {c.detail}")
    print("─" * 76)
    print(f"合计 {len(checks)} 项：PASS {len(checks) - len(bad)} / FAIL {len(bad)}")
    print()
    return 0 if not bad else 1


def fetch_release_bodies():
    bodies, page = {}, 1
    while True:
        url = f"{API}/releases?per_page=100&page={page}"
        req = urllib.request.Request(url, headers={
            "User-Agent": "anchor-publish-check",
            "Accept": "application/vnd.github+json",
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            batch = json.load(r)
        if not batch:
            break
        for rel in batch:
            tag = rel.get("tag_name") or ""
            if re.fullmatch(r"v\d+\.\d+\.\d+", tag):
                bodies[tag[1:]] = rel.get("body") or ""
        if len(batch) < 100:
            break
        page += 1
    return bodies


def selftest():
    """基线 + 8 条变异。每条变异断言**指定项**命中（不是「任意 FAIL」）。"""
    anchors = load_anchors()
    published = load_published()
    version = VERSION_FILE.read_text(encoding="utf-8").strip()
    text = CHANGELOG.read_text(encoding="utf-8")
    latest = [a for a in anchors if a.get("latest")]
    # 合成 Release 正文：让 P4/P5 有输入可跑（真实正文由 --release 提供）
    bodies = {}
    for p in published:
        bodies.setdefault(p["published_version"], "")
    for p in published:
        bodies[p["published_version"]] += p["digest"] + "\n"

    base = run_checks(anchors, published, text, version, bodies)
    base_bad = [c for c in base if not c.ok]
    print(f"[基线] PASS={len(base) - len(base_bad)} FAIL={len(base_bad)}")
    if base_bad:
        for c in base_bad:
            print(f"  FAIL {c.id} {c.name} → {c.detail}")
        print("基线不通过，反向测试无意义。")
        return 1

    def with_seq(anchor, seq):
        """把一条锚改成「同链的另一个 seq」——用于构造旧串。仅测试用。"""
        row = json.loads(json.dumps(anchor))
        row["anchor_seq"] = seq
        row["digest"] = re.sub(
            r"(aof-anchor/v\d+:[^:]+:)\d+:", r"\g<1>%d:" % seq, anchor["digest"], count=1
        )
        return row

    clone = lambda o: json.loads(json.dumps(o))  # noqa: E731
    old = with_seq(latest[0], latest[0]["anchor_seq"] + 7)

    cases = [
        ("S1 删掉当前锚的发布记录（重锚后忘了登记）", "P1",
         lambda st: st.__setitem__("published", [p for p in st["published"] if p["chain_id"] != latest[0]["chain_id"]])),
        ("S2 其中一条登记的串被改成同链旧锚的串（同锚两条记录自相矛盾）", "P1",
         lambda st: st["published"][0].__setitem__("digest", old["digest"])),
        ("S3 记录指向不存在的 anchor_seq（编造一条「已发布」）", "P2",
         lambda st: (st["published"][0].__setitem__("anchor_seq", 999),
                     st["published"][0].__setitem__("digest", with_seq(latest[0], 999)["digest"]))),
        ("S4 CHANGELOG 当前小节删掉一条当前串", "P3",
         lambda st: st.__setitem__("text", st["text"].replace(latest[0]["digest"], "", 1))),
        ("S5 CHANGELOG 当前小节贴了同链旧串（旧串未清）", "P3",
         lambda st: st.__setitem__("text", st["text"].replace(latest[0]["digest"], old["digest"], 1))),
        ("S6 Release 正文缺一条串（只贴了一半）", "P4",
         lambda st: st["bodies"].__setitem__(published[0]["published_version"],
                                             st["bodies"][published[0]["published_version"]]
                                             .replace(published[0]["digest"], "", 1))),
        ("S7 Release 正文多出一条未登记的合法串", "P5",
         lambda st: st["bodies"].__setitem__(published[0]["published_version"],
                                             st["bodies"][published[0]["published_version"]]
                                             + old["digest"] + "\n")),
    ]

    bad = 0
    for i, (label, expect, mutate) in enumerate(cases, 1):
        st = {"published": clone(published), "text": text, "bodies": clone(bodies)}
        mutate(st)
        rows = run_checks(anchors, st["published"], st["text"], version, st["bodies"])
        hit = [c.id for c in rows if not c.ok]
        ok = expect in hit
        print(f"[{'PASS' if ok else 'FAIL'}] 反测 {i}：{label} → 命中[{','.join(hit) or '无'}]（应含 {expect}）")
        if not ok:
            bad += 1
            row = next((c for c in rows if c.id == expect), None)
            print(f"       期望项 {expect} 未命中：{row.detail if row else '不存在'}")

    # S8（形态与上面七条不同：P4 的 scope 为空）——发版预检的必经路径。
    # 记这条的原因：P4 只对「已登记为该版本」的记录做检查，忘了追加登记时 scope 为空，
    # 于是「正文里有没有这串」根本没人查，预检给出绿灯。空集不能算通过（10-D5 同一纪律）。
    s8_label = "S8 为新版本预检但没有任何该版本的发布登记（忘了 --publish-lines）"
    s8_ver = "9.9.9"
    s8_rows = run_checks(anchors, clone(published), text, s8_ver, {s8_ver: ""}, {s8_ver})
    s8_hit = [c.id for c in s8_rows if not c.ok]
    s8_ok = "P4" in s8_hit
    print(f"[{'PASS' if s8_ok else 'FAIL'}] 反测 8：{s8_label} → 命中[{','.join(s8_hit) or '无'}]（应含 P4）")
    if not s8_ok:
        bad += 1
        print("       空集被当成通过——P4 对此版本根本没有检查对象")

    total = len(cases) + 1
    print(f"\nselftest PASS={total - bad} FAIL={bad}（基线 {len(base)} 项 + 反测 {total} 项）")
    if bad:
        return 1

    # P6 时间戳子检查（v2.77.0 折进本项，不新增门禁编号）：anchor_tsa 自带
    # 基线 + 4 条 TSA 反测（digest 被改 / 文件缺失 / 回执改 1 字节 / pending）。
    import anchor_tsa
    tsa_bad = anchor_tsa.selftest()
    return 0 if tsa_bad == 0 else 1


def main(argv):
    version = VERSION_FILE.read_text(encoding="utf-8").strip()
    body_arg = next((a.split("=", 1)[1] for a in argv if a.startswith("--release-body=")), None)
    ver_arg = next((a.split("=", 1)[1] for a in argv if a.startswith("--version=")), None)
    if ver_arg:
        version = ver_arg

    try:
        anchors = load_anchors()
        published = load_published()
    except (RuntimeError, FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"FAIL {e}")
        return 2

    if body_arg is not None:
        try:
            bodies = {version: pathlib.Path(body_arg).read_text(encoding="utf-8")}
        except OSError as e:
            print(f"FAIL 读不了发版说明文件（{body_arg}）：{e}")
            return 2
        scope = {version}
    elif "--release" in argv:
        try:
            bodies = fetch_release_bodies()
        except Exception as e:  # noqa: BLE001 —— 网络失败要报清楚，不能静默当成通过
            print(f"FAIL 取 Release 正文失败（{type(e).__name__}: {e}）")
            return 2
        scope = None
    else:
        bodies, scope = None, None

    text = CHANGELOG.read_text(encoding="utf-8")
    checks = run_checks(anchors, published, text, version, bodies, scope)
    try:
        import anchor_tsa  # 同目录模块；懒加载避免循环 import
        checks += anchor_tsa.tsa_checks(anchors)
    except Exception as e:  # noqa: BLE001 —— 环境坏要报清楚，不能静默跳过
        print(f"FAIL RFC 3161 时间戳子检查加载失败（{type(e).__name__}: {e}）")
        return 2
    return report(checks)


if __name__ == "__main__":
    ARGV = sys.argv[1:]
    sys.exit(selftest() if "--selftest" in ARGV else main(ARGV))
