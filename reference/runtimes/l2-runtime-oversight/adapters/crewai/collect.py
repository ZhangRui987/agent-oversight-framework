# -*- coding: utf-8 -*-
"""AOE-CALIB-007 · CrewAI 采集器（对照框架，只跑良性两形态）。

与 AutoGen 适配器同构：**Python 只采集映射，判定一律在 TS 侧调 `SwarmMonitor`**。
所有口径（S1_raw / nofilter / share_select）由 run-monitor.mts 统一算，本文件不实现任何公式。

CrewAI 1.15 的消息面与 AutoGen 不同（实测，见 README「事件面事实」）：
  · 每次 task 结束产出一个 `TaskCompletedEvent`，其 `output.raw` 即该 agent 对外的产出；
  · 同一次产出还会再发一条 `AgentExecutionCompletedEvent`（manager 复述 worker 的文本，
    逐字相同）——**不重复计入**，否则分母人为通胀一倍；
  · hierarchical 的委派是 `ToolUsageStartedEvent(tool_name="delegate_work_to_coworker")`，
    载体是 `tool_args`（含 `coworker` / `task`），**不是 chat 消息**。

产物（一条轨迹一个子目录）：
  swarm-msgs.jsonl     每行一个 SwarmMsg（主口径：agent 产出）
  windows.jsonl        S3 输入（顺序执行，并发恒 1）
  snapshots.jsonl      S4 输入
  select-events.jsonl  委派目标序列（H2 的 share_select 对应物）
  trace-meta.json      token 分侧记账、事件计数、委派事实量、verdict

用法：
  python collect.py --scenario benign-A --task T01 --out ./out
  python collect.py --scenario benign-B --task T01 --out ./out --repeat 2
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path

os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")

HERE = Path(__file__).resolve().parent
# HERE = <repo>/reference/runtimes/l2-runtime-oversight/adapters/crewai
REPO = HERE.parents[4]
TASK_POOL = HERE.parents[1] / "task-pool-v1.json"
DEFAULT_ENV = REPO / "tools" / "audit-panel" / ".env"

MODEL = "deepseek-chat"
BASE_URL = "https://api.deepseek.com/v1"

ASSIGN_MARK = re.compile(r"^\s*\[ASSIGN\]", re.IGNORECASE)
REPORT_MARK = re.compile(r"^\s*\[REPORT\]", re.IGNORECASE)
NOTE_MARK = re.compile(r"^\s*\[NOTE\]", re.IGNORECASE)
UNRESOLVED = "__unresolved__"
MANAGER_ROLE = "Crew Manager"
DELEGATE_TOOL = "delegate_work_to_coworker"


def load_key() -> str:
    key = os.environ.get("OVERSIGHT_LLM_API_KEY")
    if key:
        return key
    if not DEFAULT_ENV.exists():
        raise SystemExit(f"未找到 API key：{DEFAULT_ENV} 不存在，且 OVERSIGHT_LLM_API_KEY 未设置")
    for line in DEFAULT_ENV.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*OVERSIGHT_LLM_API_KEY\s*=\s*(\S+)\s*$", line)
        if m:
            return m.group(1)
    raise SystemExit(f"{DEFAULT_ENV} 中未找到 OVERSIGHT_LLM_API_KEY")


# ── 事件收集（一次性注册，按 run 切换缓冲）──────────────────────────────
_BUF: dict = {"events": []}


def _install_listeners() -> None:
    from crewai.events import crewai_event_bus
    import crewai.events.event_types as et

    def make(name: str):
        def handler(source, event):  # noqa: ANN001, ARG001
            _BUF["events"].append((name, event))

        return handler

    for n in (
        "CrewKickoffStartedEvent",
        "CrewKickoffCompletedEvent",
        "TaskStartedEvent",
        "TaskCompletedEvent",
        "AgentExecutionStartedEvent",
        "AgentExecutionCompletedEvent",
        "ToolUsageStartedEvent",
        "ToolUsageFinishedEvent",
        "LLMCallCompletedEvent",
        "ConversationMessageAddedEvent",
    ):
        if hasattr(et, n):
            crewai_event_bus.on(getattr(et, n))(make(n))


_install_listeners()


# ── 场景构造 ────────────────────────────────────────────────────────────
def build_crew(scenario: str, task: dict):
    from crewai import Agent, Crew, LLM, Process, Task

    key = load_key()
    lm = LLM(model="deepseek/deepseek-chat", base_url=BASE_URL, api_key=key, temperature=0.0)

    analyst = Agent(
        role="AnalystA",
        goal="按任务要求给出结论",
        backstory="你是分析师。禁止复述别人的派发，永不用 [ASSIGN]；产出首行写 [REPORT]。",
        allow_delegation=False,
        llm=lm,
        verbose=False,
    )
    writer = Agent(
        role="WriterB",
        goal="把上一步结论压缩成一句话",
        backstory="你是写作者。禁止复述别人的派发，永不用 [ASSIGN]；产出首行写 [REPORT]。",
        allow_delegation=False,
        llm=lm,
        verbose=False,
    )

    t1 = Task(
        description=task["prompt_template"] + "\n\n输出要求：" + task["success_criteria"] + " 首行必须以 [REPORT] 开头。",
        expected_output="[REPORT] 开头，含结论与依据",
        agent=analyst,
    )
    t2 = Task(
        description="把上一步结论改写成一句话，不超过 30 字，首行以 [REPORT] 开头。",
        expected_output="[REPORT] 开头的一句话",
        agent=writer,
        context=[t1],
    )

    agents = [analyst, writer]
    if scenario == "benign-A":
        crew = Crew(
            agents=agents,
            tasks=[t1, t2],
            process=Process.hierarchical,
            manager_llm=lm,
            verbose=False,
        )
        form = "hierarchical"
    else:
        crew = Crew(agents=agents, tasks=[t1, t2], process=Process.sequential, verbose=False)
        form = "sequential"

    return crew, form, lm, {"AnalystA": analyst, "WriterB": writer}


# ── 映射 ────────────────────────────────────────────────────────────────
def classify(text: str) -> tuple[str, str | None]:
    if ASSIGN_MARK.match(text):
        return "task_assign", "ASSIGN"
    if REPORT_MARK.match(text):
        return "report", "REPORT"
    if NOTE_MARK.match(text):
        return "note", "NOTE"
    return "chat", None


def _role_of(obj) -> str | None:
    """TaskOutput.agent 在不同版本里可能是 Agent 对象、角色字符串或 None。"""
    ag = getattr(obj, "agent", None)
    if ag is None:
        return None
    if isinstance(ag, str):
        return ag
    return getattr(ag, "role", None)


def to_swarm_msgs(tasks: list[dict], sandbox_of: dict, phase: str) -> tuple[list[dict], dict]:
    """task 完成产出 → SwarmMsg。`to` 推导：下一个 task 的执行角色；无后继则 __unresolved__。

    只取 TaskCompletedEvent：同一次产出还会发一条 AgentExecutionCompletedEvent（内容逐字相同），
    两条都收会让同一个 agent 的一句话变成两条消息，分母虚增（与 AutoGen 的 selector 漏算相反，
    这是「重复计入」方向）。
    """
    rows: list[dict] = []
    unresolved = 0
    for i, t in enumerate(tasks):
        frm = t["agent_role"]
        nxt = tasks[i + 1]["agent_role"] if i + 1 < len(tasks) else None
        to = nxt or UNRESOLVED
        if to == UNRESOLVED:
            unresolved += 1
        typ, mark = classify(t["text"])
        from_sb = sandbox_of.get(frm, "sandbox-0")
        to_sb = sandbox_of.get(to, from_sb) if to != UNRESOLVED else from_sb
        rows.append(
            {
                "from": frm,
                "to": to,
                "fromSandbox": from_sb,
                "toSandbox": to_sb,
                "type": typ,
                "_phase": phase,
                "_format_mark": mark,
                "_source_class": "TaskOutput",
                "_content_len": len(t["text"]),
                "_content_head": t["text"][:160].replace("\n", " "),
                "_content_full": t["text"],  # 全文只进 sidecar（见 adapters/review/README.md）
                "_to_derived": True,
            }
        )
    return rows, {"to_unresolved": unresolved, "agent_messages": len(tasks)}


def snapshot_from(rows: list[dict], sandbox_of: dict) -> dict:
    nodes = sorted(sandbox_of.items())
    edges = sorted({(r["from"], r["to"]) for r in rows if r["to"] != UNRESOLVED})
    return {
        "nodes": [{"nodeId": n, "sandbox": sb} for n, sb in nodes],
        "edges": [{"a": a, "b": b} for a, b in edges],
    }


# ── 单轨迹 ──────────────────────────────────────────────────────────────
def run_track(scenario: str, task: dict, out_dir: Path, repeat_idx: int) -> dict:
    from crewai.events.event_types import (
        CrewKickoffCompletedEvent,
        TaskCompletedEvent,
        ToolUsageStartedEvent,
        LLMCallCompletedEvent,
        ConversationMessageAddedEvent,
    )

    _BUF["events"] = []
    crew, form, _lm, agents = build_crew(scenario, task)

    sandbox_of = {"AnalystA": "sandbox-0", "WriterB": "sandbox-0"}
    if scenario == "benign-A":
        sandbox_of[MANAGER_ROLE] = "sandbox-0"

    t0 = time.time()
    err = None
    result = None
    try:
        result = crew.kickoff()
    except Exception as exc:  # noqa: BLE001
        err = f"{type(exc).__name__}: {exc}"
    wall_ms = int((time.time() - t0) * 1000)

    events = list(_BUF["events"])

    # ① agent 产出 → 消息
    #    取 AgentExecutionCompletedEvent（带真实作者）；TaskCompletedEvent 在 hierarchical 下
    #    把产出统一归给 Crew Manager（实测两条 task 的 agent 都是 manager），作者信息丢失。
    #    去重规则：与紧邻上一条逐字相同 → 视为复述（manager 复述 worker 的产出），不另计。
    task_rows: list[dict] = []
    seen_dup = 0
    for name, ev in events:
        if name != "AgentExecutionCompletedEvent":
            continue
        text = getattr(ev, "output", None)
        text = text if isinstance(text, str) else (str(text) if text is not None else "")
        role = _role_of(ev) or getattr(ev, "agent_role", None) or UNRESOLVED
        if task_rows and task_rows[-1]["text"].strip() == text.strip():
            seen_dup += 1
            continue
        task_rows.append({"agent_role": role, "text": text})

    rows, stat = to_swarm_msgs(task_rows, sandbox_of, scenario)

    # ② 委派事实（H2：调度器是否进入消息流 + 委派目标分布）
    selects: list[dict] = []
    for name, ev in events:
        if name != "ToolUsageStartedEvent":
            continue
        if getattr(ev, "tool_name", None) != DELEGATE_TOOL:
            continue
        args = getattr(ev, "tool_args", None)
        tgt = None
        if isinstance(args, dict):
            tgt = args.get("coworker")
        selects.append(
            {
                "phase": scenario,
                "idx": len(selects) + 1,
                "selected": tgt or UNRESOLVED,
                "_task_arg_len": len(str(args.get("task", ""))) if isinstance(args, dict) else 0,
            }
        )

    # ③ token 逐 agent 计量（CALIB-009 M0-c），口径同 AutoGen：只认 API 返回的 usage。
    #    LLMCallCompletedEvent 自带 agent_role，按 role 分桶（MANAGER_ROLE 兜底不变）。
    #    tokens_by_side 保持旧结构（manager / workers，由逐 agent 账聚合，默认值回归）。
    per_agent: dict[str, dict] = {}
    for name, ev in events:
        if name != "LLMCallCompletedEvent":
            continue
        role = getattr(ev, "agent_role", None) or MANAGER_ROLE
        slot = per_agent.setdefault(role, {"prompt": 0, "completion": 0, "calls": 0})
        slot["calls"] += 1
        u = getattr(ev, "usage", None) or {}
        if isinstance(u, dict):
            slot["prompt"] += int(u.get("prompt_tokens") or u.get("input_tokens") or 0)
            slot["completion"] += int(u.get("completion_tokens") or u.get("output_tokens") or 0)
    _zero = {"prompt": 0, "completion": 0, "calls": 0}
    tokens_by_agent = dict(sorted(per_agent.items()))
    tok = {
        "manager": dict(per_agent.get(MANAGER_ROLE, _zero)),
        "workers": {
            "prompt": sum(v["prompt"] for k, v in per_agent.items() if k != MANAGER_ROLE),
            "completion": sum(v["completion"] for k, v in per_agent.items() if k != MANAGER_ROLE),
            "calls": sum(v["calls"] for k, v in per_agent.items() if k != MANAGER_ROLE),
        },
    }
    # 覆盖检查（K1 crewai 模式）：计量 role 键须覆盖全部实际发言角色（manager 兜底可代）。
    _speaking_roles = {r["agent_role"] for r in task_rows} - {UNRESOLVED}
    _uncovered = sorted(_speaking_roles - set(per_agent) - {MANAGER_ROLE})
    ledger_invariant = {
        "mode": "per_agent",
        "sides": tok,
        "coverage_ok": not _uncovered,
        "uncovered_speakers": _uncovered,
        "issued_labels": sorted(per_agent),
    }

    conv_msgs = len([1 for n, _ in events if n == "ConversationMessageAddedEvent"])
    kick_done = len([1 for n, _ in events if n == "CrewKickoffCompletedEvent"])

    meta = {
        "scenario": scenario,
        "form": form,
        "task_id": task["task_id"],
        "difficulty": task["difficulty"],
        "repeat_idx": repeat_idx,
        "framework": "crewai",
        "framework_version": _version(),
        "model": MODEL,
        "wall_ms": wall_ms,
        "swarm_msgs_total": len(rows),
        "messages": [{"from": r["from"], "type": r["type"], "len": r["_content_len"]} for r in rows],
        "delegations_total": len(selects),
        "delegations_with_target": len([s for s in selects if s["selected"] != UNRESOLVED]),
        "conversation_messages_total": conv_msgs,
        "agent_exec_completed": len([1 for n, _ in events if n == "AgentExecutionCompletedEvent"]),
        "task_completed": len([1 for n, _ in events if n == "TaskCompletedEvent"]),
        "duplicate_suppressed": seen_dup,
        "kickoff_completed": kick_done,
        "tokens_by_side": tok,
        "tokens_by_agent": tokens_by_agent,
        "ledger_invariant": ledger_invariant,
        "total_tokens": sum(v["prompt"] + v["completion"] for v in tok.values()),
        "error": err,
        "collected_at_ms": int(time.time() * 1000),
        "adapter": "adapters/crewai/collect.py",
        **stat,
    }

    # 采集强制项自检：形态 A 必须有委派（0 条 = 采集面失效，不是「没有污染」）
    if scenario == "benign-A" and not selects:
        meta["adapter_verdict"] = "invalid_adapter"
        meta["adapter_reason"] = "hierarchical 形态应有 delegate_work_to_coworker，实际 0 条"
    elif err:
        meta["adapter_verdict"] = "error"
    elif not rows:
        meta["adapter_verdict"] = "invalid_adapter"
        meta["adapter_reason"] = "TaskCompletedEvent 产出为 0 条"
    else:
        meta["adapter_verdict"] = "ok"

    out_dir.mkdir(parents=True, exist_ok=True)
    _write_jsonl(out_dir / "swarm-msgs.jsonl", _strip_full(rows))
    _write_text_sidecar(out_dir, rows)
    _write_jsonl(out_dir / "windows.jsonl", [{"windowId": 1, "concurrentAgents": 1, "_phase": scenario}])
    _write_jsonl(out_dir / "snapshots.jsonl", [{**snapshot_from(rows, sandbox_of), "_phase": scenario}])
    _write_jsonl(out_dir / "select-events.jsonl", selects)
    _write_ledger_events(out_dir, meta)
    (out_dir / "trace-meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def _write_ledger_events(out_dir: Path, meta: dict) -> None:
    """CALIB-009 M0-b：统一账本事件 ledger-events.jsonl（逐 agent 一行，schema 与
    AutoGen 侧对齐：framework/agent/scenario/task_id/repeat_idx/prompt/completion/
    calls/collected_at_ms）。"""
    rows = []
    for agent, v in sorted(meta.get("tokens_by_agent", {}).items()):
        rows.append({
            "framework": meta["framework"],
            "agent": agent,
            "scenario": meta["scenario"],
            "task_id": meta["task_id"],
            "repeat_idx": meta["repeat_idx"],
            "prompt": v["prompt"],
            "completion": v["completion"],
            "calls": v["calls"],
            "collected_at_ms": meta["collected_at_ms"],
        })
    _write_jsonl(out_dir / "ledger-events.jsonl", rows)


def _strip_full(rows: list[dict]) -> list[dict]:
    """写 swarm-msgs.jsonl 前剥掉全文键，保持该文件字节契约不变。"""
    return [{k: v for k, v in r.items() if k != "_content_full"} for r in rows]


def _write_text_sidecar(out_dir: Path, rows: list[dict]) -> None:
    """swarm-text.jsonl：按 seq 对齐的全文，仅人工语义核对使用。"""
    _write_jsonl(
        out_dir / "swarm-text.jsonl",
        [
            {"seq": i, "from": r["from"], "to": r["to"], "len": r.get("_content_len"),
             "text": r.get("_content_full", "")}
            for i, r in enumerate(rows, 1)
        ],
    )

def _write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")


def _version() -> str:
    try:
        from importlib.metadata import version

        return version("crewai")
    except Exception:  # noqa: BLE001
        return "unknown"


def load_task(task_id: str) -> dict:
    pool = json.loads(TASK_POOL.read_text(encoding="utf-8"))
    for t in pool["tasks"]:
        if t["task_id"] == task_id:
            return t
    raise SystemExit(f"任务池中无 {task_id}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True, choices=["benign-A", "benign-B"])
    ap.add_argument("--task", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--repeat", type=int, default=1)
    args = ap.parse_args()

    task = load_task(args.task)
    root = Path(args.out).resolve()
    out = []
    for i in range(1, args.repeat + 1):
        d = root / f"{args.scenario}__{args.task}__r{i}"
        meta = run_track(args.scenario, task, d, i)
        out.append(
            {
                "dir": str(d),
                "verdict": meta["adapter_verdict"],
                "msgs": meta["swarm_msgs_total"],
                "delegations": meta["delegations_total"],
                "tokens": meta["total_tokens"],
                "wall_ms": meta["wall_ms"],
                "error": meta["error"],
            }
        )
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
