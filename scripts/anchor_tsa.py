#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
anchor_tsa.py —— 外锚摘要串的 RFC 3161 可信时间戳（v2.77.0 新增 / 折进门禁第 52 项 P6）

── 为什么需要这一层 ──────────────────────────────────────────────────────────
v2.70.0 的外锚（anchor.jsonl + 摘要串发布）已如实登记过边界：锚与链、发布记录同处
一个可写域，「能改链者通常也能改锚」——删链尾 + 改 meta 后验链器全绿，只有外锚报
truncated，而外锚本身也可以被一起改。本脚本把摘要串再交给**域外**的 RFC 3161 时间
戳机构（TSA，现为 freetsa.org）签署：TSA 回执内嵌 (digest, genTime) 并带 TSA 签名，
篡改者要抹掉见证必须伪造一份「时间更早的假回执」或攻破 TSA——两者都超出「同账号
改仓库」的能力范围。

── 三条诚实边界（与 spec/10 10-D11.7 同文，不得拆开引用）────────────────────
  1. 本层**不主张防篡改**：能改仓库者也能改 chain.pem（同一可写域）。真正收窄的是：
     旧 (digest, genTime) 一经任何第三方留存（Release 订阅者 / archive.org / 手抄
     摘要串），即可对照出「同一 count 出现两份不同 last_hash 的时间戳」。
  2. **根证书指纹无法自证**：chain.pem 从首次回执提取后 pin 入库，能改仓库者也能改
     它。审计者应把指纹与 freetsa.org 官网/其 GitHub 独立对照（--fingerprints 打印）。
  3. **验证是纯离线的**：TSA 只在「新锚提交」时需要；freetsa 无 SLA，提交失败时该
     锚登记 status=pending，P6 对当前锚的 pending 行显式 FAIL（不静默通过）。

── 锚格式不重实现 ───────────────────────────────────────────────────────────
  摘要串一律消费 `check-anchor.mts --emit-digests`（与 check_anchor_publish.py 同一
  加载器），本脚本不解析 anchor.jsonl、不拼串。

── 证明的登记粒度 ───────────────────────────────────────────────────────────
  按**唯一 digest** 登记，不按版本：--publish-lines 每版重述同一串（v2.70.0 起
  digest 未变过），同一 digest 无需重复提交。锚重锚产生新 digest 时再提交新证明。

── 用法 ─────────────────────────────────────────────────────────────────────
  python scripts/anchor_tsa.py submit        # 联网：对当前锚逐条提交 freetsa（幂等）
  python scripts/anchor_tsa.py verify        # 离线：全部证明 openssl 验签 + 当前锚覆盖
  python scripts/anchor_tsa.py fingerprints  # 离线：打印 chain.pem 内各证书 sha256 指纹
  python scripts/anchor_tsa.py selftest      # 离线：基线 + 4 条反向测试

退出码：0 = 全通过；1 = 有失败；2 = 环境问题（node / openssl / 文件缺失）。
"""
import datetime
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from check_anchor_publish import Check, load_anchors  # noqa: E402  摘要串单一实现

ROOT = pathlib.Path(__file__).resolve().parents[1]
TSA_DIR = ROOT / "tools" / "disposition" / "data" / "tsa"
CHAIN_PEM = TSA_DIR / "chain.pem"
PROOFS = TSA_DIR / "proofs.jsonl"
TSA_URL = "http://freetsa.org/tsr"
TSA_NAME = "freetsa.org"

# proofs.jsonl 键序冻结（与 published-anchors.jsonl 同一纪律：手抄易错位，机器先卡结构）
FIELDS = ["chain_id", "anchor_seq", "digest", "tsa", "proof_file",
          "gen_time", "submitted_at", "signer_fp", "root_fp", "status"]


class TsaError(RuntimeError):
    pass


def _run(cmd, **kw):
    """跑外部命令；openssl 的 stderr 里混着无害的 configuration 提示，原样带回。"""
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=60, **kw)
    except FileNotFoundError as e:
        raise TsaError(f"找不到 {cmd[0]}（PATH 里没有？）：{e}")
    except subprocess.TimeoutExpired as e:
        raise TsaError(f"{cmd[0]} 超时：{e}")


def proof_file_name(digest):
    m = re.match(r"aof-anchor/v\d+:(?P<chain>[^:]+):(?P<seq>\d+):(?P<count>\d+):", digest)
    if not m:
        raise TsaError(f"digest 串格式异常，无法命名证明文件：{digest[:50]}…")
    safe = m.group("chain").replace("/", "--")
    return f"{safe}__seq{m.group('seq')}__c{m.group('count')}.tsr"


def load_proofs():
    if not PROOFS.exists():
        return []
    rows = []
    for i, ln in enumerate(PROOFS.read_text(encoding="utf-8").splitlines(), 1):
        if not ln.strip():
            continue
        try:
            obj = json.loads(ln)
        except json.JSONDecodeError as e:
            raise TsaError(f"{PROOFS.name} 第 {i} 行不是 JSON：{e}")
        if list(obj.keys()) != FIELDS:
            raise TsaError(f"{PROOFS.name} 第 {i} 行键序不符：应为 {FIELDS}，实为 {list(obj.keys())}")
        rows.append(obj)
    return rows


def _save_proofs(by_digest):
    """整体重写 proofs.jsonl（这是清单不是哈希链；同一 digest 以最新一次提交为准）。"""
    PROOFS.parent.mkdir(parents=True, exist_ok=True)
    with PROOFS.open("w", encoding="utf-8", newline="\n") as f:
        for r in by_digest.values():
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def cmd_submit():
    anchors = load_anchors()
    TSA_DIR.mkdir(parents=True, exist_ok=True)
    by_digest = {r["digest"]: r for r in load_proofs()}
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    fails = 0

    for a in anchors:
        digest, fname = a["digest"], proof_file_name(a["digest"])
        path = TSA_DIR / fname
        old = by_digest.get(digest)
        if old and old["status"] == "ok" and path.exists():
            ok, _ = _verify_one(digest, path)
            if ok:
                print(f"[SKIP] {a['chain_id']} seq={a['anchor_seq']}：证明已存在且验签 OK（{fname}）")
                continue
            print(f"[REDO] {a['chain_id']}：现有证明验签不过，重新提交并覆盖登记")
        try:
            gen_time = _query_and_post(digest, path)
        except TsaError as e:
            print(f"[PENDING] {a['chain_id']}：{e}")
            by_digest[digest] = {"chain_id": a["chain_id"], "anchor_seq": a["anchor_seq"],
                                 "digest": digest, "tsa": TSA_NAME, "proof_file": fname,
                                 "gen_time": "", "submitted_at": now,
                                 "signer_fp": "", "root_fp": "", "status": "pending"}
            _save_proofs(by_digest)
            fails += 1
            continue
        # 首次提交：把回执内嵌证书链固化（此后所有验证只用这份 pin）
        if not CHAIN_PEM.exists():
            extract_certs(path, CHAIN_PEM)
            print("[PIN]  证书链已从回执提取并固化：")
            for subj, fp in pem_cert_fingerprints(CHAIN_PEM.read_text(encoding="ascii")):
                print(f"       sha256 {fp}\n         {subj}")
        ok, detail = _verify_one(digest, path)
        if not ok:
            print(f"[FAIL] {a['chain_id']}：提交成功但离线验签不过（{detail[0] if detail else '无输出'}）")
            fails += 1
            continue
        fps = pem_cert_fingerprints(CHAIN_PEM.read_text(encoding="ascii"))
        # 签名证书 = subject 带 TSA 的那张；Root CA = 链上最后一张（issuer 侧）
        signer_fp = next((fp for subj, fp in fps if "TSA" in subj), fps[0][1])
        root_fp = fps[-1][1]
        by_digest[digest] = {"chain_id": a["chain_id"], "anchor_seq": a["anchor_seq"],
                             "digest": digest, "tsa": TSA_NAME, "proof_file": fname,
                             "gen_time": gen_time, "submitted_at": now,
                             "signer_fp": signer_fp, "root_fp": root_fp, "status": "ok"}
        _save_proofs(by_digest)
        print(f"[OK]   {a['chain_id']} seq={a['anchor_seq']} → {fname}（genTime {gen_time}）")

    pending = sum(1 for r in by_digest.values() if r["status"] == "pending")
    if pending:
        print(f"\n注意：{pending} 条 pending——TSA 恢复后重跑 submit 补齐；"
              f"pending 期间门禁第 52 项 P6 对当前锚 FAIL。")
    return 0 if fails == 0 and pending == 0 else 1


# ─────────────────────────────────────────────────────────────────────────────
# 证书链提取与指纹
# ─────────────────────────────────────────────────────────────────────────────

def extract_certs(tsr_path, out_pem):
    """回执（TimeStampResp）→ token → 内嵌证书 PEM（2 张：签名证书 + Root CA）。"""
    token = TSA_DIR / ".tmp-token.der"
    st = _run(["openssl", "ts", "-reply", "-in", str(tsr_path), "-token_out", "-out", str(token)])
    if st.returncode != 0:
        raise TsaError("回执里提取 token 失败：" + (st.stderr or "").strip()[-200:])
    st = _run(["openssl", "pkcs7", "-inform", "DER", "-in", str(token), "-print_certs",
               "-out", str(out_pem)])
    token.unlink(missing_ok=True)
    if st.returncode != 0:
        raise TsaError("token 里提取证书链失败：" + (st.stderr or "").strip()[-200:])


def pem_cert_fingerprints(pem_text):
    """拆开 PEM 里多张证书，逐张算 sha256 指纹。返回 [(subject, fingerprint)]。"""
    out = []
    blocks = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
                        pem_text, re.S)
    for blk in blocks:
        der = pathlib.Path(TSA_DIR / ".tmp-cert.pem")
        der.write_text(blk + "\n", encoding="ascii")
        st = _run(["openssl", "x509", "-in", str(der), "-noout", "-subject", "-fingerprint", "-sha256"])
        der.unlink(missing_ok=True)
        if st.returncode != 0:
            raise TsaError("单张证书指纹计算失败：" + (st.stderr or "").strip()[-200:])
        subject = re.search(r"subject=(.*)", st.stdout)
        fp = re.search(r"sha256 Fingerprint=((?:[0-9A-F]{2}:)+[0-9A-F]{2})", st.stdout)
        out.append((subject.group(1).strip() if subject else "?",
                    fp.group(1) if fp else "?"))
    return out


def print_fingerprints():
    if not CHAIN_PEM.exists():
        print(f"FAIL 尚未固化证书链（{CHAIN_PEM.relative_to(ROOT)} 不存在）——先跑 submit")
        return 2
    fps = pem_cert_fingerprints(CHAIN_PEM.read_text(encoding="ascii"))
    print(f"{CHAIN_PEM.relative_to(ROOT)} 内共 {len(fps)} 张证书：")
    for subj, fp in fps:
        print(f"  sha256 {fp}\n    {subj}")
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# submit：对当前锚逐条提交（幂等：已存在且验签 OK 的 digest 跳过）
# ─────────────────────────────────────────────────────────────────────────────

def _query_and_post(digest, out_tsr):
    """digest 串的 UTF-8 字节 → RFC 3161 query → POST TSA → 回执落盘。"""
    q = TSA_DIR / ".tmp-query.tsr"
    st = _run(["openssl", "ts", "-query", "-data", str(_msg_file(digest)), "-sha256",
               "-cert", "-out", str(q)])
    if st.returncode != 0:
        raise TsaError("生成 timestamp query 失败：" + (st.stderr or "").strip()[-200:])
    req = urllib.request.Request(TSA_URL, data=q.read_bytes(), method="POST",
                                 headers={"Content-Type": "application/timestamp-query",
                                          "User-Agent": "aof-anchor-tsa/1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
    except Exception as e:  # noqa: BLE001 —— 网络失败要报清楚，不许静默
        q.unlink(missing_ok=True)
        raise TsaError(f"POST {TSA_URL} 失败（{type(e).__name__}: {e}）——锚登记将标记 pending")
    q.unlink(missing_ok=True)
    out_tsr.write_bytes(body)
    r = _run(["openssl", "ts", "-reply", "-in", str(out_tsr), "-text"])
    if r.returncode != 0:
        raise TsaError("TSA 响应不是合法回执（前 80 字节：" + repr(body[:80]) + "）")
    ts = re.search(r"Time stamp:\s*(.+)", r.stdout)
    return ts.group(1).strip() if ts else ""


_MSG_TMP = TSA_DIR / ".tmp-msg.txt"


def _msg_file(digest):
    TSA_DIR.mkdir(parents=True, exist_ok=True)
    _MSG_TMP.write_bytes(digest.encode("utf-8"))  # 二进制写，杜绝 CRLF 混入被签字节
    return _MSG_TMP


def _verify_one(digest, tsr_path):
    """对单份证明做离线 openssl 验签。返回 (ok, detail)。"""
    if not CHAIN_PEM.exists():
        raise TsaError(f"证书链未固化（{CHAIN_PEM.relative_to(ROOT)} 缺失）")
    st = _run(["openssl", "ts", "-verify", "-data", str(_msg_file(digest)),
               "-in", str(tsr_path), "-CAfile", str(CHAIN_PEM)])
    _MSG_TMP.unlink(missing_ok=True)
    ok = st.returncode == 0 and "Verification: OK" in st.stdout
    return ok, ((st.stdout or "") + (st.stderr or "")).strip().splitlines()[-1:] or [""]


# ─────────────────────────────────────────────────────────────────────────────
# verify / P6 检查（纯离线；供本脚本与本 check_anchor_publish.py 共用）
# ─────────────────────────────────────────────────────────────────────────────

def tsa_checks(anchors):
    """P6：①当前锚每条都有 status=ok 的证明且离线验签 OK；②proofs.jsonl 每行可溯、
    digest 属于锚日志的某个真实锚行、证明文件存在且验签 OK。返回 Check 列表。"""
    checks = []
    try:
        proofs = load_proofs()
        anchor_digests = {a["digest"] for a in anchors}
        current = [a for a in anchors if a.get("latest")]
        if not CHAIN_PEM.exists():
            return [Check("P6", "当前锚全部有 RFC 3161 可信时间戳且离线验签 OK", False,
                          "证书链未固化（tools/disposition/data/tsa/chain.pem 缺失）——先跑 anchor_tsa.py submit")]
        if not proofs:
            return [Check("P6", "当前锚全部有 RFC 3161 可信时间戳且离线验签 OK", False,
                          "proofs.jsonl 为空——当前锚没有任何域外时间戳，先跑 anchor_tsa.py submit")]

        # ② 全量行体检（含历史证明：证明文件被换/被改必须在此现形）
        bad = []
        for r in proofs:
            path = TSA_DIR / r["proof_file"]
            if r["digest"] not in anchor_digests:
                bad.append(f"{r['chain_id']} seq={r['anchor_seq']}：证明的 digest 不属于锚日志任何锚行（凭空/被改）")
                continue
            if r["status"] != "ok":
                bad.append(f"{r['chain_id']}：status={r['status']}（TSA 提交未完成）")
                continue
            if not path.exists():
                bad.append(f"{r['chain_id']}：证明文件缺失（{r['proof_file']}）")
                continue
            ok, detail = _verify_one(r["digest"], path)
            if not ok:
                bad.append(f"{r['chain_id']}：离线验签不过（{detail[0] if detail else '无输出'}）")
        checks.append(Check(
            "P6a", "proofs.jsonl 每条证明可溯、存在且离线验签 OK",
            not bad, "；".join(bad[:4]) if bad else f"{len(proofs)} 条证明全部验签 OK",
        ))

        # ① 当前锚覆盖：每条当前锚必须有 status=ok 且验签 OK 的证明
        ok_digests = {r["digest"] for r in proofs if r["status"] == "ok"}
        miss = [a for a in current if a["digest"] not in ok_digests]
        checks.append(Check(
            "P6b", "每条当前锚都有 status=ok 的可信时间戳证明",
            not miss,
            "；".join(f"{a['chain_id']}（当前锚无域外时间戳/pending）" for a in miss)
            if miss else f"{len(current)} 条当前锚全部有时间戳见证",
        ))
    except TsaError as e:
        checks.append(Check("P6a", "proofs.jsonl 每条证明可溯、存在且离线验签 OK", False, str(e)))
    return checks


def cmd_verify():
    anchors = load_anchors()
    checks = tsa_checks(anchors)
    print()
    print("外锚摘要串 · RFC 3161 可信时间戳校验（P6，纯离线）")
    print("─" * 76)
    for c in checks:
        print(f"[{'PASS' if c.ok else 'FAIL'}] {c.id} {c.name}")
        print(f"       {c.detail}")
    print("─" * 76)
    bad = [c for c in checks if not c.ok]
    print(f"合计 {len(checks)} 项：PASS {len(checks) - len(bad)} / FAIL {len(bad)}")
    print()
    return 0 if not bad else 1


# ─────────────────────────────────────────────────────────────────────────────
# selftest：基线 + 4 条反向测试（断言指定项命中，不是「任意 FAIL」）
# ─────────────────────────────────────────────────────────────────────────────

def selftest():
    anchors = load_anchors()
    base = tsa_checks(anchors)
    print("[基线] " + "；".join(f"{c.id} {'PASS' if c.ok else 'FAIL'}" for c in base))
    if any(not c.ok for c in base):
        for c in base:
            if not c.ok:
                print(f"       {c.id} → {c.detail}")
        print("基线不通过，反向测试无意义。")
        return 1

    current = next(a for a in anchors if a.get("latest"))
    proofs = load_proofs()
    row = next(r for r in proofs if r["digest"] == current["digest"])

    def rows_with(target):
        """只替换目标行、保留其余行——保证反测命中只来自被变异的那一行。"""
        return [dict(r, **target) if r["digest"] == row["digest"] else r for r in proofs]

    bad = 0

    def run_case(label, rows, expect):
        """跑一条反测；断言指定项命中（不是「任意 FAIL」），未命中时打印各项 detail。"""
        checks = _p6_only(anchors, rows)
        hit_ids = [c.id for c in checks if not c.ok]
        ok = expect in hit_ids
        print(f"[{'PASS' if ok else 'FAIL'}] 反测 {label} → 命中[{','.join(hit_ids) or '无'}]（应含 {expect}）")
        if not ok:
            for c in checks:
                if not c.ok:
                    print(f"       {c.id} → {c.detail}")
        return 0 if ok else 1

    # T1 证明行 digest 被改（换史后拿旧证明蒙混）→ P6a 必须命中
    mutated = dict(row)
    mutated["digest"] = re.sub(r"(aof-anchor/v\d+:[^:]+:\d+:\d+:)[0-9a-f]{4}",
                               r"\g<1>0000", row["digest"], count=1)
    bad += run_case("T1：证明行 digest 被改（与锚日志对不上）", rows_with(mutated), "P6a")

    # T2 证明文件缺失 → P6a 必须命中
    bad += run_case("T2：证明文件缺失", rows_with({"proof_file": "no-such-file.tsr"}), "P6a")

    # T3 回执被改一字节（密码学判别力）→ P6a 必须命中
    path = TSA_DIR / row["proof_file"]
    raw = path.read_bytes()
    tampered = TSA_DIR / ".tmp-tampered.tsr"
    tampered.write_bytes(raw[:-3] + bytes([raw[-3] ^ 0x01]) + raw[-2:])
    bad += run_case("T3：回执被改 1 字节", rows_with({"proof_file": tampered.name}), "P6a")
    tampered.unlink(missing_ok=True)

    # T4 当前锚的证明 pending（TSA 提交未完成）→ P6b 必须命中
    bad += run_case("T4：当前锚证明 status=pending", rows_with({"status": "pending"}), "P6b")

    print(f"\nselftest PASS={4 - bad} FAIL={bad}（基线 2 项 + 反测 4 项）")
    return 0 if bad == 0 else 1


def _p6_only(anchors, proof_rows):
    """把 proofs.jsonl 的行在内存里替换成 proof_rows 后跑 P6（不落盘）。"""
    global load_proofs
    orig = load_proofs
    load_proofs = lambda: proof_rows  # noqa: E731
    try:
        return tsa_checks(anchors)
    finally:
        load_proofs = orig


def main(argv):
    try:
        if "submit" in argv:
            return cmd_submit()
        if "verify" in argv:
            return cmd_verify()
        if "selftest" in argv:
            return selftest()
        if "fingerprints" in argv:
            return print_fingerprints()
    except TsaError as e:
        print(f"FAIL {e}")
        return 2
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
