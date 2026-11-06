#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
create_release.py —— 发版（建 GitHub Release），**预检是代码路径的一部分**

── 为什么把它搬进仓库 ──────────────────────────────────────────────────────
v2.71.0 之前，发版靠工作区里的 `.workbuddy/create_release_v*.py`：每版把上一版复制
一份，改三处（tag / 标题 / 说明路径）。预检则写在文档里，靠人先跑一遍。两个失效模式
都真实发生过：
  · 复制旧模板时漏改字段 —— tag 建对了，正文贴的是上一版；
  · 预检忘了跑，或者跑了，但看的不是**将要发出的那份正文**。
于是「发版 checklist」在这一步仍然只是纪律。版本化的脚本 + 强制预检把这一步变成
不变量：预检和 POST 在同一个函数里，中间没有「人去记得」的位置。

── 两项预检，任一失败即不创建 ──────────────────────────────────────────────
  A 锚摘要串发布预检：把**将要发出的正文原样**（同一份内存字节，落临时文件）交给
    `check_anchor_publish.py --release-body=… --version=…` 跑 P1–P5，
    含「该版本没有任何发布登记」这一空集形态（空集不算通过）。
  B tag 必须已存在于 origin：GitHub 在 tag 不存在时会把它建在默认分支 HEAD 上，
    于是 Release 指向一个你并不打算发布的提交——静默错误，事后只能删 tag 重来。

没有 `--force` 之类可以跳过预检的开关：能跳过就等于没有。`--dry-run` 只跑到预检为止。

── 用法 ───────────────────────────────────────────────────────────────────
  python scripts/create_release.py --notes=<说明文件> --title="v2.72.0 — …（minor）"
  python scripts/create_release.py --notes=<说明文件> --dry-run   # 只跑预检，不建
  python scripts/create_release.py --selftest                     # 6 条自检（离线）

  --tag 缺省取 `v` + VERSION；标题缺省取说明文件首行去掉 `# `。

退出码：0 = 已创建（或 dry-run 预检通过）；1 = 预检未过 / 创建失败；2 = 环境问题。
"""
import ctypes
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from ctypes import wintypes

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION_FILE = ROOT / "VERSION"
PUBLISH_CHECK = ROOT / "scripts" / "check_anchor_publish.py"
PUBLISHED = ROOT / "tools" / "disposition" / "data" / "published-anchors.jsonl"
ANCHOR_SCRIPT = ROOT / "tools" / "disposition" / "check-anchor.mts"

OWNER, REPO = "ZhangRui987", "agent-oversight-framework"
API = "https://api.github.com/repos/%s/%s" % (OWNER, REPO)
UA = "create-release-script"
TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")


class Step:
    def __init__(self, sid, name, ok, detail):
        self.id, self.name, self.ok, self.detail = sid, name, ok, detail


# ─────────────────────────────────────────────────────────────────────────────
# 计划解析（纯函数：tag / 版本 / 标题三者必须自洽）
# ─────────────────────────────────────────────────────────────────────────────

def resolve_plan(tag, version_file_text, title, body):
    """返回 (plan, error)。三者不一致就报错——不一致本身就是「贴错正文」的信号。"""
    ver = version_file_text.strip()
    tag = tag or ("v" + ver)
    if not TAG_RE.match(tag):
        return None, "tag 形态不符（应为 vX.Y.Z）：%r" % tag
    if tag[1:] != ver:
        return None, "tag %s 与 VERSION %s 不一致——正文很可能是上一版的" % (tag, ver)
    if not body.strip():
        return None, "说明文件为空"
    title = (title or body.lstrip().splitlines()[0]).strip()
    title = re.sub(r"^#+\s*", "", title)
    if not title.startswith(tag):
        return None, "标题未以 tag 开头（%s）：Release 列表里会认不出这是哪一版" % title[:40]
    return {"tag": tag, "version": ver, "title": title, "body": body}, None


# ─────────────────────────────────────────────────────────────────────────────
# 预检 A：锚摘要串发布（消费已有实现，不重写规则）
# ─────────────────────────────────────────────────────────────────────────────

def real_checker(body, version):
    """把正文原样落到临时文件，再交 check_anchor_publish.py 预检。

    刻意不传「说明文件路径」而是传正文本身：调用方读了一次文件就把字符串拿在手上，
    预检与 POST 用的是同一个字符串，中间文件被改也不会造成「检的和发的不是一份」。
    """
    with tempfile.TemporaryDirectory(prefix="aof-release-") as td:
        p = pathlib.Path(td) / "release-body.md"
        p.write_bytes(body.encode("utf-8"))  # 写字节，避免 Windows 换行翻译改变内容
        st = subprocess.run(
            [sys.executable, str(PUBLISH_CHECK),
             "--release-body=%s" % p, "--version=%s" % version],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=180, cwd=str(ROOT),
        )
    out = ((st.stdout or "") + (st.stderr or "")).strip()
    return st.returncode == 0, out


# ─────────────────────────────────────────────────────────────────────────────
# 预检 B：tag 必须已在 origin
# ─────────────────────────────────────────────────────────────────────────────

def real_gitstate(tag):
    st = subprocess.run(
        ["git", "ls-remote", "origin", "refs/tags/%s" % tag, "refs/tags/%s^{}" % tag],
        capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(ROOT),
    )
    if st.returncode != 0:
        return False, "git ls-remote 失败：%s" % (st.stderr or "").strip()[:160]
    refs = [ln.split()[1] for ln in (st.stdout or "").splitlines() if ln.strip()]
    if "refs/tags/%s" % tag not in refs:
        return False, "origin 上没有 tag %s——先 push，否则 Release 会把 tag 建在默认分支 HEAD 上" % tag
    return True, "origin 已有 tag %s（%d 个 ref）" % (tag, len(refs))


# ─────────────────────────────────────────────────────────────────────────────
# 流程：预检 → （可选）dry-run → 创建 → 事后复核
# ─────────────────────────────────────────────────────────────────────────────

def run_pipeline(plan, checker, gitstate, creator):
    """返回 (exit_code, steps, created)。

    creator 为 None 表示 dry-run：预检照跑，通过后到此为止，**不创建**。
    —— 这一条是实测补的：初版 dry-run 只跳过取令牌、没跳过创建，于是带着 None
    令牌直接 POST 出去换了个 401。能发出请求就不叫 dry-run。
    """
    steps, created = [], None

    ok, detail = checker(plan["body"], plan["version"])
    steps.append(Step("A", "锚摘要串发布预检（P1–P5，对本版正文逐字）", ok, detail))

    ok2, detail2 = gitstate(plan["tag"])
    steps.append(Step("B", "tag 已存在于 origin（否则 Release 会把 tag 建在 main HEAD 上）", ok2, detail2))

    if not (ok and ok2):
        return 1, steps, None


    if creator is None:
        steps.append(Step("C", "创建 Release", True, "dry-run：跳过（预检已通过）"))
        return 0, steps, None

    created = creator(plan)
    steps.append(Step("C", "创建 Release", True,
                      "id=%s %s" % (created.get("id"), created.get("html_url"))))
    return 0, steps, created


def print_steps(steps, indent="       "):
    for s in steps:
        print("[%s] %s %s" % ("PASS" if s.ok else "FAIL", s.id, s.name))
        for ln in (s.detail or "").splitlines():
            print(indent + ln)
        print()


# ─────────────────────────────────────────────────────────────────────────────
# GitHub：令牌与创建（Windows 凭据管理器；CI 从不跑本脚本）
# ─────────────────────────────────────────────────────────────────────────────

def _credread(target):
    CRED_TYPE_GENERIC = 1

    class CREDENTIAL(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD),
            ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR),
            ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
            ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR),
            ("UserName", wintypes.LPWSTR),
        ]

    try:
        advapi32 = ctypes.WinDLL("advapi32")
    except OSError:
        return None, None
    cred_ptr = ctypes.POINTER(CREDENTIAL)()
    if not advapi32.CredReadW(target, CRED_TYPE_GENERIC, 0, ctypes.byref(cred_ptr)):
        return None, None
    c = cred_ptr.contents
    blob = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize) if c.CredentialBlobSize else b""
    user = c.UserName or ""
    ctypes.windll.advapi32.CredFree(cred_ptr)

    # GCM 可能以 UTF-16LE 或 UTF-8 存；解码错会在令牌里留 NUL 字节，Authorization 头被污染（HTTP 400）
    cands = []
    if len(blob) % 2 == 0:
        cands.append(blob.decode("utf-16-le", "replace"))
    cands.append(blob.decode("utf-8", "replace"))
    for tok in cands:
        tok = tok.strip().strip("\x00")
        if tok and "\x00" not in tok and (
            tok[:4] in ("gho_", "ghp_", "ghu_", "ghs_") or tok.startswith("github_pat_")
        ):
            return tok, user
    return (cands[0].strip().strip("\x00") if cands else ""), user


def get_token():
    for t in ("git:https://github.com", "git:https://ZhangRui987@github.com",
              "github.com", "https://github.com"):
        pwd, user = _credread(t)
        if pwd:
            print("[token] CredReadW target=%r user=%s (len %d)" % (t, user, len(pwd)))
            return pwd
    print("[token] CredReadW 未取到；回退 git credential fill")
    env = dict(os.environ)
    env.update({"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never", "GCM_GUI_PROMPT": "false"})
    try:
        p = subprocess.run(
            ["git", "-c", "credential.interactive=never", "credential", "fill"],
            input="protocol=https\nhost=github.com\n\n",
            capture_output=True, text=True, timeout=20, env=env,
        )
    except subprocess.TimeoutExpired:
        print("[token] git credential fill 超时")
        return None
    if p.returncode != 0:
        print("[token] git credential fill rc=%d" % p.returncode)
        return None
    for line in p.stdout.splitlines():
        k, _, v = line.partition("=")
        if k == "password" and v:
            print("[token] 取自 GCM（前缀 %s***，len %d）" % (v[:4], len(v)))
            return v
    return None


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕开注入的代理


def real_creator(plan, token):
    body = json.dumps({
        "tag_name": plan["tag"], "name": plan["title"],
        "body": plan["body"], "draft": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        "%s/releases" % API, data=body, method="POST",
        headers={
            "Authorization": "Bearer %s" % token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
    )
    with _opener().open(req, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


def post_verify(tag):
    """建完之后再核一遍：正文里的串是否真的落到 GitHub 上了（P4/P5 联网）。"""
    st = subprocess.run(
        [sys.executable, str(PUBLISH_CHECK), "--release"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=180, cwd=str(ROOT),
    )
    out = ((st.stdout or "") + (st.stderr or "")).strip()
    return st.returncode == 0, out


# ─────────────────────────────────────────────────────────────────────────────
# 自检（离线）：证明预检**挡在前面**，不是并列的一步
# ─────────────────────────────────────────────────────────────────────────────

def selftest():
    ver = VERSION_FILE.read_text(encoding="utf-8").strip()
    body = "# v%s — selftest\n\n说明\n" % ver

    def plan_for(body_text=body, tag=None):
        plan, err = resolve_plan(tag, ver, None, body_text)
        assert err is None, err
        return plan

    calls = []

    def ok_creator(p):
        calls.append(p)
        return {"id": 1, "html_url": "https://example/1"}

    # 每条用例包成函数：断言失败要报「哪一条」，抛异常也要报「哪一条」。
    # 直接写成一串求值的话，某条一崩，traceback 会把「第几条」淹掉（v2.68.1 修过同款）。
    def t1():
        calls.clear()
        code, _, created = run_pipeline(plan_for(), lambda b, v: (True, "ok"),
                                        lambda t: (True, "ok"), ok_creator)
        return code == 0 and len(calls) == 1 and created is not None

    def t2():
        calls.clear()
        code, _, created = run_pipeline(plan_for(), lambda b, v: (False, "A 未过"),
                                        lambda t: (True, "ok"), ok_creator)
        return code == 1 and not calls and created is None

    def t3():
        calls.clear()
        code, _, created = run_pipeline(plan_for(), lambda b, v: (True, "ok"),
                                        lambda t: (False, "B 未过"), ok_creator)
        return code == 1 and not calls and created is None

    def _full_body():
        anchors = _emit_digests()
        return anchors, "\n".join(a["digest"] for a in anchors) + "\n", _latest_published_version()

    def t4():
        _, full, ver_pub = _full_body()
        ok, _ = real_checker(full, ver_pub)
        return ok

    def t5():
        anchors, full, ver_pub = _full_body()
        ok, out = real_checker(full.replace(anchors[0]["digest"], "", 1), ver_pub)
        return (not ok) and "P4" in out

    def t6():
        _, err2 = resolve_plan("v0.0.1", ver, None, body)
        return err2 is not None

    def t7():
        code, steps, created = run_pipeline(plan_for(), lambda b, v: (True, "ok"),
                                            lambda t: (True, "ok"), None)
        return (code == 0 and created is None
                and any(s.id == "C" and "dry-run" in s.detail for s in steps))

    cases = [
        ("T1 预检全通过 → 创建 Release 一次", t1),
        ("T2 锚发布预检失败 → 未创建（预检挡在创建之前）", t2),
        ("T3 tag 未推 origin → 未创建", t3),
        ("T4 真实 checker：正文含全部当前串 → 通过", t4),
        ("T5 真实 checker：漏一条串 → 失败且报 P4", t5),
        ("T6 tag 与 VERSION 不一致 → 拒绝", t6),
        ("T7 dry-run：预检通过但未创建", t7),
    ]

    bad = 0
    for label, fn in cases:
        try:
            ok, note = fn(), ""
        except Exception as e:  # noqa: BLE001 —— 用例自身崩了也是「这一条没过」，不是整轮失败
            ok, note = False, "（抛 %s: %s）" % (type(e).__name__, str(e)[:80])
        print("[%s] %s%s" % ("PASS" if ok else "FAIL", label, note))
        if not ok:
            bad += 1
    print("\nselftest PASS=%d FAIL=%d（%d 条）" % (len(cases) - bad, bad, len(cases)))
    return 0 if bad == 0 else 1


def _emit_digests():
    st = subprocess.run(
        ["node", "--experimental-transform-types", str(ANCHOR_SCRIPT), "--emit-digests"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=120, cwd=str(ROOT),
    )
    if st.returncode != 0:
        raise RuntimeError("--emit-digests 失败")
    return [json.loads(ln) for ln in (st.stdout or "").splitlines() if ln.strip()]


def _latest_published_version():
    rows = [json.loads(ln) for ln in PUBLISHED.read_text(encoding="utf-8").splitlines() if ln.strip()]
    return max(r["published_version"] for r in rows)


# ─────────────────────────────────────────────────────────────────────────────
# 入口
# ─────────────────────────────────────────────────────────────────────────────

def main(argv):
    def arg(name, default=None):
        hit = next((a for a in argv if a.startswith("--%s=" % name)), None)
        return hit.split("=", 1)[1] if hit else default

    notes_path = arg("notes")
    if not notes_path:
        print("FAIL 缺少 --notes=<说明文件>")
        return 2
    try:
        body = pathlib.Path(notes_path).read_text(encoding="utf-8")
    except OSError as e:
        print("FAIL 读不了说明文件（%s）：%s" % (notes_path, e))
        return 2

    plan, err = resolve_plan(arg("tag"), VERSION_FILE.read_text(encoding="utf-8"), arg("title"), body)
    if err:
        print("[ABORT] %s" % err)
        return 1

    print("发版计划：%s · 正文 %d 字节 · 标题 %s" % (plan["tag"], len(plan["body"].encode("utf-8")), plan["title"]))
    print()

    dry = "--dry-run" in argv
    token = None
    if not dry:
        token = get_token()
        if not token:
            print("NO_TOKEN")
            return 2

    creator = None if dry else (lambda p: real_creator(p, token))

    code, steps, created = run_pipeline(plan, real_checker, real_gitstate, creator)
    print_steps(steps)
    if code != 0:
        print("[ABORT] 预检未通过 —— Release 未创建。没有 --force：能跳过就等于没有预检。")
        return 1

    if dry:
        print("[dry-run] 预检通过，未创建 Release。")
        return 0

    print("Release: %s（%s）" % (created.get("html_url"), created.get("tag_name")))
    ok, out = post_verify(plan["tag"])
    print()
    print("事后复核（--release，联网）：%s" % ("PASS" if ok else "FAIL"))
    for ln in out.splitlines():
        print("  " + ln)
    if not ok:
        print("[WARN] Release 已创建但事后复核未通过——不要当它已发布。")
        return 1
    return 0


if __name__ == "__main__":
    ARGV = sys.argv[1:]
    sys.exit(selftest() if "--selftest" in ARGV else main(ARGV))
