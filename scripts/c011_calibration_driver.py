#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CALIB-011 正式标定驱动（预注册 EXPERIMENT-DESIGN-AOE-CALIB-011.md §1.1–1.3，
用户裁决 B 档：3 臂 × 9 题 × 3 repeat = 81 条）。

自 c010_calibration_driver.py 派生，改动仅两处：加题维循环；预算改「单臂 750K +
全局 2.2M（跨臂共享预算文件）」。继承 c010 全部缺陷修正：
- 只跳过 verdict=="ok" 的轨迹（invalid_adapter / error 必须重采）；
- 失败轨迹归档改名到 .invalid/（不 rmtree，规避沙箱批量删除拦截）；
- timeout 600s；trace 级 JSONL 进度日志。
用法：python c011_calibration_driver.py <deepseek|qwen|glm>
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
OUT_ROOT = LT / "adapters" / "autogen" / "out" / "run-20261113-c011"
GLOBAL_BUDGET_FILE = OUT_ROOT / "global-budget.json"
PY = r"C:/Users/21777/AppData/Local/Programs/Python/Python313/python.exe"
COLLECT = LT / "adapters" / "autogen" / "collect.py"

# 预注册 §1.1 冻结：题序前 9 题 × r=3
TASKS = ["HE000", "HE003", "HE020", "HE021", "HE027", "HE051", "HE057", "HE067", "HE076"]
N_REPEAT = 3
BUDGET_PER_ARM = 750_000
BUDGET_GLOBAL = 2_200_000

ARMS = {
    "deepseek": {"model": "deepseek-chat", "base_url": "https://api.deepseek.com/v1",
                 "key_var": "OVERSIGHT_LLM_API_KEY"},
    "qwen": {"model": "qwen-flash", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
             "key_var": "OVERSIGHT_QWEN_API_KEY"},
    "glm": {"model": "glm-4-flash", "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "key_var": "OVERSIGHT_GLM_API_KEY"},
}


def read_global_budget() -> int:
    if GLOBAL_BUDGET_FILE.exists():
        return json.loads(GLOBAL_BUDGET_FILE.read_text(encoding="utf-8")).get("cum_tokens", 0)
    return 0


def add_global_budget(delta: int) -> int:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    cur = read_global_budget() + delta
    GLOBAL_BUDGET_FILE.write_text(json.dumps({"cum_tokens": cur}, ensure_ascii=False), encoding="utf-8")
    return cur


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ARMS:
        print("用法: c011_calibration_driver.py <deepseek|qwen|glm>", file=sys.stderr)
        sys.exit(2)
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

    rec(event="start", tasks=TASKS, repeat=N_REPEAT,
        budget_arm=BUDGET_PER_ARM, budget_global=BUDGET_GLOBAL,
        global_before=read_global_budget())
    tokens_arm = 0
    done = fail = skip = 0
    for task in TASKS:
        for rep in range(1, N_REPEAT + 1):
            if read_global_budget() >= BUDGET_GLOBAL:
                rec(event="global_budget_stop", global_tokens=read_global_budget())
                rec(event="done", done=done, skipped=skip, failed=fail, cum_tokens=tokens_arm)
                return
            d = out_root / f"benign-A__{task}__r{rep}"
            meta_p = d / "trace-meta.json"
            if meta_p.exists():
                m = json.loads(meta_p.read_text(encoding="utf-8"))
                # 只跳过 verdict==ok：invalid_adapter / error 必须重采（c010 修正）
                if m.get("adapter_verdict") == "ok" and not m.get("error"):
                    skip += 1
                    tokens_arm += m.get("total_tokens", 0)
                    continue
                rec(event="retry", task=task, rep=rep,
                    reason=f"{m.get('adapter_verdict')}/{m.get('error')}")
            t0 = time.time()
            tmp = out_root / ".tmp-rep"
            try:
                r = subprocess.run(
                    [PY, str(COLLECT), "--scenario", "benign-A", "--task", task,
                     "--out", str(tmp), "--repeat", "1", "--pool", str(POOL),
                     "--model", cfg["model"], "--base-url", cfg["base_url"],
                     "--key-var", cfg["key_var"]],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=600, cwd=str(COLLECT.parent))
            except subprocess.TimeoutExpired:
                rec(event="trace_timeout", task=task, rep=rep)
                fail += 1
                continue
            produced = tmp / f"benign-A__{task}__r1"
            if produced.exists():
                if d.exists():
                    # 失败轨迹归档改名而非删除（c010 修正：rmtree 触发沙箱批量删除拦截）
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
                tk = m.get("total_tokens", 0)
                tokens_arm += tk
                g = add_global_budget(tk)
                inv = m.get("ledger_invariant", {})
                if m.get("adapter_verdict") == "ok" and not m.get("error"):
                    done += 1
                else:
                    fail += 1  # verdict 计数修正：invalid_adapter / error 不计 done
                    rec(event="trace_invalid", task=task, rep=rep,
                        verdict=m.get("adapter_verdict"), error=str(m.get("error"))[:120])
                rec(event="trace", task=task, rep=rep, verdict=m.get("adapter_verdict"),
                    tokens=tk, msgs=m.get("swarm_msgs_total"),
                    coverage_ok=inv.get("coverage_ok"),
                    global_tokens=g, wall_ms=int((time.time() - t0) * 1000),
                    cum_tokens=tokens_arm)
                if tokens_arm > BUDGET_PER_ARM:
                    rec(event="budget_stop", cum_tokens=tokens_arm, cap=BUDGET_PER_ARM)
                    break
            else:
                fail += 1
                rec(event="trace_failed", task=task, rep=rep, stderr=(r.stderr or "")[-300:])
        else:
            continue
        break  # 单臂熔断后跳出题循环
    rec(event="done", done=done, skipped=skip, failed=fail, cum_tokens=tokens_arm)


if __name__ == "__main__":
    main()
