#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CALIB-010 正式标定驱动（预注册 §2.1，用户裁决 N=30 / HE000 / 点火）。

3 臂 × benign-A × HE000 × 30 repeat = 90 条；逐条采集（collect.py --repeat 1
写 __r1 到临时目录 → 成功后改名 __rN，沿 R2 覆写事故修正逻辑），可续跑：
已存在且 verdict!=error 的轨迹跳过。输出隔离 out/run-20261112-c010/。
预算：单臂熔断 800K（三臂合计 2.4M ≤ 预注册上限 2.5M）。
进度逐条追加 JSONL：calibration-driver.log。
"""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
LT = REPO / "reference" / "runtimes" / "l2-runtime-oversight"
POOL = LT / "task-pool-humaneval-r2.json"
OUT_ROOT = LT / "adapters" / "autogen" / "out" / "run-20261112-c010"
PY = r"C:/Users/21777/AppData/Local/Programs/Python/Python313/python.exe"
COLLECT = LT / "adapters" / "autogen" / "collect.py"
N_REPEAT = 30
BUDGET_PER_ARM = 800_000
TASK = "HE000"

ARMS = {
    "deepseek": {"model": "deepseek-chat", "base_url": "https://api.deepseek.com/v1",
                 "key_var": "OVERSIGHT_LLM_API_KEY"},
    "qwen": {"model": "qwen-flash", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
             "key_var": "OVERSIGHT_QWEN_API_KEY"},
    "glm": {"model": "glm-4-flash", "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "key_var": "OVERSIGHT_GLM_API_KEY"},
}


def main():
    arm = sys.argv[1]
    cfg = ARMS[arm]
    out_root = OUT_ROOT / arm
    out_root.mkdir(parents=True, exist_ok=True)
    log = open(OUT_ROOT / "calibration-driver.log", "a", encoding="utf-8", newline="\n")

    def rec(**kv):
        kv["ts"] = int(time.time())
        kv["arm"] = arm
        log.write(json.dumps(kv, ensure_ascii=False) + "\n")
        log.flush()
        print(json.dumps(kv, ensure_ascii=False), flush=True)

    rec(event="start", n=N_REPEAT, task=TASK)
    tokens_total = 0
    done = fail = skip = 0
    for rep in range(1, N_REPEAT + 1):
        d = out_root / f"benign-A__{TASK}__r{rep}"
        meta_p = d / "trace-meta.json"
        if meta_p.exists():
            m = json.loads(meta_p.read_text(encoding="utf-8"))
            # 只跳过 verdict==ok 的轨迹：invalid_adapter（采集面失效）与 error
            # 都必须重采（2026-11-12 缺陷修正——旧条件 verdict!='error' 会把
            # invalid_adapter 跳过导致补采失效，qwen 18 条连接错误被漏掉）
            if m.get("adapter_verdict") == "ok" and not m.get("error"):
                skip += 1
                tokens_total += m.get("total_tokens", 0)
                continue
            rec(event="retry", rep=rep, reason=f"{m.get('adapter_verdict')}/{m.get('error')}")
        t0 = time.time()
        # collect.py 固定写 __r1：先采到临时目录，成功后改名 __rN（R2 覆写事故修正逻辑）
        tmp = out_root / ".tmp-rep"
        try:
            r = subprocess.run(
                [PY, str(COLLECT), "--scenario", "benign-A", "--task", TASK,
                 "--out", str(tmp), "--repeat", "1", "--pool", str(POOL),
                 "--model", cfg["model"], "--base-url", cfg["base_url"],
                 "--key-var", cfg["key_var"]],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=600, cwd=str(COLLECT.parent))
        except subprocess.TimeoutExpired:
            rec(event="trace_timeout", rep=rep)
            fail += 1
            continue
        produced = tmp / f"benign-A__{TASK}__r1"
        if produced.exists():
            if d.exists():
                # 失败轨迹归档改名而非删除（2026-11-12：rmtree 触发沙箱批量删除
                # 确认拦截；且失败样本保留 .invalid/ 下有审计价值，不物理删除）
                bad_dir = out_root / ".invalid"
                bad_dir.mkdir(parents=True, exist_ok=True)
                bad = bad_dir / d.name
                if bad.exists():
                    shutil.rmtree(bad, ignore_errors=True)
                d.rename(bad)
            produced.rename(d)
        shutil.rmtree(tmp, ignore_errors=True)
        if meta_p.exists():
            m = json.loads(meta_p.read_text(encoding="utf-8"))
            tokens_total += m.get("total_tokens", 0)
            inv = m.get("ledger_invariant", {})
            if m.get("adapter_verdict") == "ok" and not m.get("error"):
                done += 1
            else:
                fail += 1  # verdict 计数修正：invalid_adapter / error 不计 done
                rec(event="trace_invalid", rep=rep, verdict=m.get("adapter_verdict"),
                    error=str(m.get("error"))[:120])
            rec(event="trace", rep=rep, verdict=m.get("adapter_verdict"),
                tokens=m.get("total_tokens"), msgs=m.get("swarm_msgs_total"),
                coverage_ok=inv.get("coverage_ok"),
                wall_ms=int((time.time() - t0) * 1000), cum_tokens=tokens_total)
        else:
            fail += 1
            rec(event="trace_failed", rep=rep, stderr=(r.stderr or "")[-300:])
        if tokens_total > BUDGET_PER_ARM:
            rec(event="budget_stop", cum_tokens=tokens_total, cap=BUDGET_PER_ARM)
            break
    rec(event="done", done=done, skipped=skip, failed=fail, cum_tokens=tokens_total)


if __name__ == "__main__":
    main()
