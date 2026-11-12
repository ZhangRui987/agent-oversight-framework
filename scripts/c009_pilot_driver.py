#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CALIB-009 pilot 驱动（预注册 §2.2）。

AutoGen 3 臂 × 3 题（R2 冻结良性题前 3：HE000/HE003/HE020）× benign-A × 1 轮 = 9 条。
输出隔离目录 out/run-20261112-c009-pilot/（不复用 R1/R2 目录——R2 覆写事故教训）。
预算熔断 500K（预注册 §四）。可续跑：verdict!=error 的轨迹跳过。

CrewAI / LangGraph 各 1 条 M0 验收条：本机依赖未安装（crewai/langgraph
ModuleNotFoundError），按预注册翻车分支如实记「未采」，不冒充。
进度逐条追加 JSONL：pilot-driver.log。
"""
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
LT = REPO / "reference" / "runtimes" / "l2-runtime-oversight"
POOL = LT / "task-pool-humaneval-r2.json"
OUT_ROOT = LT / "adapters" / "autogen" / "out" / "run-20261112-c009-pilot"
PY = r"C:/Users/21777/AppData/Local/Programs/Python/Python313/python.exe"
COLLECT = LT / "adapters" / "autogen" / "collect.py"
BUDGET = 500_000
TASKS = ["HE000", "HE003", "HE020"]

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
    log_path = OUT_ROOT / "pilot-driver.log"
    log = open(log_path, "a", encoding="utf-8", newline="\n")

    def rec(**kv):
        kv["ts"] = int(time.time())
        kv["arm"] = arm
        log.write(json.dumps(kv, ensure_ascii=False) + "\n")
        log.flush()
        print(json.dumps(kv, ensure_ascii=False), flush=True)

    tokens_total = 0
    done = fail = skip = 0
    for task in TASKS:
        scen, rep = "benign-A", 1
        d = out_root / f"{scen}__{task}__r{rep}"
        meta_p = d / "trace-meta.json"
        if meta_p.exists():
            m = json.loads(meta_p.read_text(encoding="utf-8"))
            if m.get("adapter_verdict") != "error" and not m.get("error"):
                skip += 1
                tokens_total += m.get("total_tokens", 0)
                continue
            rec(event="retry", task=task, reason=f"{m.get('adapter_verdict')}/{m.get('error')}")
        t0 = time.time()
        try:
            r = subprocess.run(
                [PY, str(COLLECT), "--scenario", scen, "--task", task, "--out", str(out_root),
                 "--pool", str(POOL), "--model", cfg["model"], "--base-url", cfg["base_url"],
                 "--key-var", cfg["key_var"]],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                cwd=str(COLLECT.parent))
        except subprocess.TimeoutExpired:
            rec(event="trace_timeout", task=task)
            fail += 1
            continue
        if meta_p.exists():
            m = json.loads(meta_p.read_text(encoding="utf-8"))
            tokens_total += m.get("total_tokens", 0)
            inv = m.get("ledger_invariant", {})
            done += 1
            rec(event="trace", task=task, verdict=m.get("adapter_verdict"),
                tokens=m.get("total_tokens"), msgs=m.get("swarm_msgs_total"),
                per_agent=len(m.get("tokens_by_agent", {})),
                coverage_ok=inv.get("coverage_ok"),
                uncovered=inv.get("uncovered_speakers"),
                wall_ms=int((time.time() - t0) * 1000), cum_tokens=tokens_total)
        else:
            fail += 1
            rec(event="trace_failed", task=task, stderr=(r.stderr or "")[-300:])
        if tokens_total > BUDGET:
            rec(event="budget_stop", cum_tokens=tokens_total, cap=BUDGET)
            break
    rec(event="done", done=done, skipped=skip, failed=fail, cum_tokens=tokens_total)


if __name__ == "__main__":
    main()
