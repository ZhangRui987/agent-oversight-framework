#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R2 正式采样驱动（单臂）。可续跑：已存在且 verdict!=error 的轨迹跳过。
用法：python r2_formal_driver.py <deepseek|qwen|glm>
进度逐条追加到 <out>/driver-<arm>.log（JSONL）。"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent          # <repo>/scripts
REPO = HERE.parent                              # <repo>
LT = REPO / "reference" / "runtimes" / "l2-runtime-oversight"
POOL = LT / "task-pool-humaneval-r2.json"
OUT_ROOT = LT / "adapters" / "autogen" / "out" / "run-20261108-r2"
PY = r"C:/Users/21777/AppData/Local/Programs/Python/Python313/python.exe"
COLLECT = LT / "adapters" / "autogen" / "collect.py"
BUDGET_PER_ARM = 5_500_000  # 三臂合计上限 14,932,862；单臂 5.5M 熔断（估算 2.4M/臂）

ARMS = {
    "deepseek": {"model": "deepseek-chat", "base_url": "https://api.deepseek.com/v1",
                 "key_var": "OVERSIGHT_LLM_API_KEY"},
    "qwen": {"model": "qwen-flash", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
             "key_var": "OVERSIGHT_QWEN_API_KEY"},
    "glm": {"model": "glm-4-flash", "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "key_var": "OVERSIGHT_GLM_API_KEY"},
}


def plan(arm):
    pool = json.loads(POOL.read_text(encoding="utf-8"))
    benign = [t["task_id"] for t in pool["tasks"] if t["arm"] == "benign"]
    attack = [t["task_id"] for t in pool["tasks"] if t["arm"] == "attack"]
    runs = []
    for t in benign:  # benign-A ×2（J1 良性侧主数据）
        runs += [("benign-A", t, 1), ("benign-A", t, 2)]
    for t in benign:  # benign-B ×1
        runs.append(("benign-B", t, 1))
    for t in benign:  # attack-concentrate ×1（纯指挥叠加在正常任务上，沿 R1）
        runs.append(("attack-concentrate", t, 1))
    for t in attack:  # attack-cross ×1（跨题协同，R2 冻结攻击题池）
        runs.append(("attack-cross", t, 1))
    return runs


def main():
    arm = sys.argv[1]
    cfg = ARMS[arm]
    out_root = OUT_ROOT / arm
    out_root.mkdir(parents=True, exist_ok=True)
    log = open(out_root / f"driver-{arm}.log", "a", encoding="utf-8", newline="\n")

    def rec(**kv):
        kv["ts"] = int(time.time())
        log.write(json.dumps(kv, ensure_ascii=False) + "\n")
        log.flush()
        print(json.dumps(kv, ensure_ascii=False), flush=True)

    rec(event="start", arm=arm, plan=len(plan(arm)))
    tokens_total = 0
    done = fail = skip = 0
    for scen, task, rep in plan(arm):
        d = out_root / f"{scen}__{task}__r{rep}"
        meta_p = d / "trace-meta.json"
        if meta_p.exists():
            m = json.loads(meta_p.read_text(encoding="utf-8"))
            if m.get("adapter_verdict") != "error" and not m.get("error"):
                skip += 1
                tokens_total += m.get("total_tokens", 0)
                continue
            rec(event="retry", scenario=scen, task=task, rep=rep,
                reason=f"上次 {m.get('adapter_verdict')}/{m.get('error')}")
        t0 = time.time()
        # collect.py 固定写 __r1：rep≥2 时先采到临时目录，成功后改名到 __rN。
        # （2026-11-08 事故修正：此前 rep2 直接跑会覆写 __r1，浪费全价采样一次。）
        run_out = out_root if rep == 1 else out_root / ".tmp-rep"
        try:
            r = subprocess.run(
                [PY, str(COLLECT), "--scenario", scen, "--task", task, "--out", str(run_out),
                 "--pool", str(POOL), "--model", cfg["model"], "--base-url", cfg["base_url"],
                 "--key-var", cfg["key_var"]],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                cwd=str(COLLECT.parent))
        except subprocess.TimeoutExpired:
            rec(event="trace_timeout", scenario=scen, task=task, rep=rep)
            fail += 1
            continue
        if rep > 1:
            produced = run_out / f"{scen}__{task}__r1"
            if produced.exists():
                if d.exists():
                    shutil.rmtree(d)
                produced.rename(d)
            shutil.rmtree(run_out, ignore_errors=True)
        if meta_p.exists():
            m = json.loads(meta_p.read_text(encoding="utf-8"))
            tokens_total += m.get("total_tokens", 0)
            done += 1
            rec(event="trace", scenario=scen, task=task, rep=rep,
                verdict=m.get("adapter_verdict"), tokens=m.get("total_tokens"),
                msgs=m.get("swarm_msgs_total"), wall_ms=int((time.time() - t0) * 1000),
                cum_tokens=tokens_total)
        else:
            fail += 1
            rec(event="trace_failed", scenario=scen, task=task, rep=rep,
                stderr=(r.stderr or "")[-300:])
        if tokens_total > BUDGET_PER_ARM:
            rec(event="budget_stop", cum_tokens=tokens_total, cap=BUDGET_PER_ARM)
            break
    rec(event="done", arm=arm, done=done, skipped=skip, failed=fail, cum_tokens=tokens_total)


if __name__ == "__main__":
    main()
