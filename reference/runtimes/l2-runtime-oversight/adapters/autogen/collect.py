# -*- coding: utf-8 -*-
"""AOE-CALIB-007 · AutoGen 采集器（正式版）。

只做采集与映射，**不做任何判定、不算任何 share**。判定在 run-monitor.mts 里调用
SwarmMonitor 完成——检测器必须逐字复用（设计稿 §4.4），Python 侧若有第二套实现，
规格漂移将无法检出。

产物（写入 --out 目录，一条轨迹一个子目录）：
  swarm-msgs.jsonl     每行一个 SwarmMsg（5 必需字段 + `_` 前缀元字段）
  windows.jsonl        S3 输入：{windowId, concurrentAgents}
  snapshots.jsonl      S4 输入：{nodes:[{nodeId,sandbox}], edges:[{a,b}]}
  select-events.jsonl  H2 输入：调度器选中序列
  trace-meta.json      token 分侧记账、计数、映射统计、强度自检

用法：
  python collect.py --scenario benign-A --task T01 --out ./out
  python collect.py --scenario attack-concentrate --task T18 --out ./out
  python collect.py --scenario benign-B --task T21 --out ./out --repeat 1
  # R2 多厂商（预注册 §七）：不传则与 R1 行为逐字节一致
  python collect.py --scenario benign-A --task T01 --out ./out \
      --model qwen-flash --base-url https://dashscope.aliyuncs.com/compatible-mode/v1 \
      --key-var OVERSIGHT_QWEN_API_KEY
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # 允许以任意 cwd 调用时 import build_attack
# HERE = <repo>/reference/runtimes/l2-runtime-oversight/adapters/autogen
# parents: [0]=adapters [1]=l2-runtime-oversight [2]=runtimes [3]=reference [4]=<repo>
REPO = HERE.parents[4]
TASK_POOL = HERE.parents[1] / "task-pool-v1.json"
DEFAULT_ENV = REPO / "tools" / "audit-panel" / ".env"

MODEL = "deepseek-chat"
BASE_URL = "https://api.deepseek.com/v1"
KEY_VAR = "OVERSIGHT_LLM_API_KEY"

ASSIGN_MARK = re.compile(r"^\s*\[ASSIGN\]", re.IGNORECASE)
REPORT_MARK = re.compile(r"^\s*\[REPORT\]", re.IGNORECASE)
NOTE_MARK = re.compile(r"^\s*\[NOTE\]", re.IGNORECASE)

UNRESOLVED = "__unresolved__"


def load_key(var: str = KEY_VAR, env_file: Path | None = None) -> str:
    key = os.environ.get(var)
    if key:
        return key
    p = env_file or DEFAULT_ENV
    if not p.exists():
        raise SystemExit(f"未找到 API key：环境变量 {var} 未设置，且 {p} 不存在")
    for line in p.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*" + re.escape(var) + r"\s*=\s*(\S+)\s*$", line)
        if m:
            return m.group(1)
    raise SystemExit(f"{p} 中未找到 {var}")


class CountingClient:
    """token 分侧记账包装。转发一切属性，只拦 create / create_stream 记 usage。

    为什么必须分侧：SelectorGroupChat 每轮把完整对话喂给 selector，这部分调用
    不产生任何消息。按消息累加 usage 会 100% 漏算（pilot 实测 selector 占 44.1%）。
    """

    def __init__(self, inner, label: str, sink: dict):
        self._inner = inner
        self._label = label
        self._sink = sink
        sink.setdefault(label, {"prompt": 0, "completion": 0, "calls": 0})

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def _record(self, usage) -> None:
        slot = self._sink[self._label]
        slot["calls"] += 1
        if usage is not None:
            slot["prompt"] += getattr(usage, "prompt_tokens", 0) or 0
            slot["completion"] += getattr(usage, "completion_tokens", 0) or 0

    async def create(self, *args, **kwargs):
        r = await self._inner.create(*args, **kwargs)
        self._record(getattr(r, "usage", None))
        return r

    async def create_stream(self, *args, **kwargs):
        usage = None
        async for chunk in self._inner.create_stream(*args, **kwargs):
            u = getattr(chunk, "usage", None)
            if u is not None:
                usage = u
            yield chunk
        self._record(usage)


def _build_inner(model: str = MODEL, base_url: str = BASE_URL, key_var: str = KEY_VAR):
    from autogen_core.models import ModelInfo
    from autogen_ext.models.openai import OpenAIChatCompletionClient

    # 温度口径（R2 预注册 §七勘误）：刻意不设 temperature——与 R1 实跑口径
    # （厂商默认）一致，保证与 R1 对照臂分布可比；三厂商默认温度不同属
    # 跨模型对比的固有混杂，随结果登记。不得在此顺手加 temperature/seed。
    return OpenAIChatCompletionClient(
        model=model,
        api_key=load_key(key_var),
        base_url=base_url,
        model_info=ModelInfo(
            vision=False,
            function_calling=True,
            json_output=True,
            family=model,
            structured_output=False,
            multiple_system_messages=False,
        ),
    )


def make_clients(sink: dict, model: str = MODEL, base_url: str = BASE_URL,
                 key_var: str = KEY_VAR):
    """旧接口（CALIB-009 M0 默认值回归基准）：共享单 agent client + selector。

    保留原样：不传新参数时，返回的两个 client 行为与 v2.79.0 逐字节一致。
    新代码请用 make_client_bundle（CALIB-009 M0-a 逐 agent 计量）。
    """
    return CountingClient(_build_inner(model, base_url, key_var), "agent", sink), \
        CountingClient(_build_inner(model, base_url, key_var), "selector", sink)


class ClientBundle:
    """CALIB-009 M0-a：逐 agent 计量的客户端发放器。

    每 agent 独立 CountingClient（label = agent 名），selector 独立 label。
    不变量（K1，验收判据）：Σ(per-agent) ≡ 旧 agent 侧聚合。
    """

    def __init__(self, sink: dict, model: str = MODEL, base_url: str = BASE_URL,
                 key_var: str = KEY_VAR):
        self._sink = sink
        self._args = (model, base_url, key_var)
        self._created: list[CountingClient] = []

    def for_agent(self, name: str) -> CountingClient:
        c = CountingClient(_build_inner(*self._args), name, self._sink)
        self._created.append(c)
        return c

    def selector(self) -> CountingClient:
        c = CountingClient(_build_inner(*self._args), "selector", self._sink)
        self._created.append(c)
        return c

    def issued_labels(self) -> list[str]:
        """已发放的 client label（K1 覆盖检查用：须覆盖全部实际发言 agent）。"""
        return [c._label for c in self._created]

    async def close_all(self) -> None:
        for c in self._created:
            inner = getattr(c, "_inner", None)
            if inner is not None:
                try:
                    await inner.close()
                except Exception:  # noqa: BLE001
                    pass


# ── 映射：消息 → SwarmMsg ───────────────────────────────────────────────
def classify(text: str) -> tuple[str, str | None]:
    """正文首行标记 → SwarmMsg.type。无标记归为 chat（不计入 S1 分子）。"""
    if ASSIGN_MARK.match(text):
        return "task_assign", "ASSIGN"
    if REPORT_MARK.match(text):
        return "report", "REPORT"
    if NOTE_MARK.match(text):
        return "note", "NOTE"
    return "chat", None


def extract_chat(events: list) -> list[dict]:
    """从 stream 事件里抽出 chat 消息（保持原始顺序）。"""
    from autogen_agentchat.messages import BaseChatMessage

    out = []
    for ev in events:
        if not isinstance(ev, BaseChatMessage):
            continue
        content = getattr(ev, "content", "")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False, default=str)
        out.append(
            {
                "source": getattr(ev, "source", None),
                "content": content,
                "target": getattr(ev, "target", None),
                "class": type(ev).__name__,
            }
        )
    return out


def to_swarm_msgs(chat: list[dict], sandbox_of: dict, phase: str) -> tuple[list[dict], dict]:
    """chat 消息 → SwarmMsg 行。

    `to` 推导规则（冻结）：下一条「非 user」消息的 source；无后继则 __unresolved__。
    该规则不可靠（TextMessage 不携带收件人），S2/S4 结论须按设计稿 §十 第 9 条下调。
    """
    agent_idx = [i for i, m in enumerate(chat) if m["source"] != "user"]
    rows: list[dict] = []
    unresolved = 0
    for pos, i in enumerate(agent_idx):
        m = chat[i]
        nxt = chat[agent_idx[pos + 1]]["source"] if pos + 1 < len(agent_idx) else None
        to = nxt or UNRESOLVED
        if to == UNRESOLVED:
            unresolved += 1
        typ, mark = classify(m["content"])
        frm = m["source"]
        from_sb = sandbox_of.get(frm, "sandbox-0")
        # 保守映射：to 无法推导时视为同沙箱，避免制造「假跨沙箱边」——
        # 否则 S2 会对每条末位消息误报 unsigned，S4 会凭空多出跨沙箱新边。
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
                "_source_class": m["class"],
                "_content_len": len(m["content"]),
                "_content_head": m["content"][:160].replace("\n", " "),
                # 全文只进 sidecar，不进 swarm-msgs.jsonl：判定层只用 type/from/to，
                # 而人工语义核对（adapters/review/）必须看到完整正文，否则 160 字截断
                # 会把「派发对象/交付物/时限」全切掉，判类等于猜。
                "_content_full": m["content"],
                "_to_derived": True,
            }
        )
    return rows, {"to_unresolved": unresolved, "agent_messages": len(agent_idx)}


def snapshot_from(rows: list[dict], sandbox_of: dict) -> dict:
    nodes = sorted({n: sb for n, sb in sandbox_of.items()}.items())
    edges = sorted({(r["from"], r["to"]) for r in rows if r["to"] != UNRESOLVED})
    return {
        "nodes": [{"nodeId": n, "sandbox": sb} for n, sb in nodes],
        "edges": [{"a": a, "b": b} for a, b in edges],
    }


# ── 单轨迹执行 ──────────────────────────────────────────────────────────
async def run_track(scenario: str, task: dict, out_dir: Path, repeat_idx: int,
                    model: str = MODEL, base_url: str = BASE_URL,
                    key_var: str = KEY_VAR) -> dict:
    from autogen_agentchat.base import TaskResult
    from autogen_agentchat.messages import SelectSpeakerEvent

    from build_attack import BUILDERS

    sink: dict = {}
    # CALIB-009 M0-a：逐 agent 计量。bundle 发放 per-agent client（label = agent 名），
    # selector 独立。tokens_by_side 旧结构保持不变（默认值回归），tokens_by_agent 为新增明细。
    bundle = ClientBundle(sink, model, base_url, key_var)
    agent_client, team_client = bundle, bundle.selector()
    builder = BUILDERS[scenario]
    phases = builder(agent_client, team_client)

    all_rows: list[dict] = []
    windows: list[dict] = []
    snapshots: list[dict] = []
    selects: list[dict] = []
    phase_meta: list[dict] = []
    t_start = time.time()
    stop_reasons: list[str] = []
    err: str | None = None
    event_total = 0
    chat_total = 0
    result_chat = 0

    try:
        for pi, ph in enumerate(phases, 1):
            team = ph.team_factory()
            events = []
            result_msgs = 0
            async for ev in team.run_stream(task=task["prompt_template"]):
                events.append(ev)
                if isinstance(ev, TaskResult):
                    result_msgs = len(ev.messages)
                    stop_reasons.append(str(getattr(ev, "stop_reason", "")))
            event_total += len(events)
            chat = extract_chat(events)
            chat_total += len([m for m in chat if m["source"] != "user"])
            # TaskResult.messages 混装 chat + event，只数 chat 类做完整性比对
            from autogen_agentchat.messages import BaseChatMessage

            phase_rows, stat = to_swarm_msgs(chat, ph.sandbox_of, ph.name)
            all_rows.extend(phase_rows)

            sel = [e for e in events if isinstance(e, SelectSpeakerEvent)]
            for k, e in enumerate(sel, 1):
                chosen = getattr(e, "selected_speakers", None) or getattr(e, "content", None)
                selects.append({"phase": ph.name, "idx": k, "selected": chosen})

            windows.append({"windowId": pi, "concurrentAgents": ph.concurrency, "_phase": ph.name})
            snapshots.append({**snapshot_from(phase_rows, ph.sandbox_of), "_phase": ph.name})

            # TaskResult.messages 里的 chat 消息数（与 stream 捕获数比对，验完整性）
            tr = [e for e in events if isinstance(e, TaskResult)]
            tr_chat = (
                len([m for m in tr[-1].messages if isinstance(m, BaseChatMessage)]) if tr else 0
            )
            phase_meta.append(
                {
                    "phase": ph.name,
                    "note": ph.note,
                    "max_turns": ph.max_turns,
                    "concurrency": ph.concurrency,
                    "events": len(events),
                    "chat_messages": len([m for m in chat if m["source"] != "user"]),
                    "select_events": len(sel),
                    "task_result_messages": tr_chat,
                    **stat,
                }
            )
    except Exception as exc:  # noqa: BLE001
        err = f"{type(exc).__name__}: {exc}"
    finally:
        # CALIB-009 M0-a：bundle 统一关闭（含逐 agent 与 selector 全部 client）
        if isinstance(agent_client, ClientBundle):
            await agent_client.close_all()
        else:
            for c in (agent_client, team_client):
                inner = getattr(c, "_inner", None)
                if inner is not None:
                    try:
                        await inner.close()
                    except Exception:  # noqa: BLE001
                        pass

    wall_ms = int((time.time() - t_start) * 1000)
    total_tokens = sum(v["prompt"] + v["completion"] for v in sink.values())

    # ── CALIB-009 M0-a：逐 agent 计量与不变量 ──────────────────────────
    # bundle 模式下 sink = {agent 名: 账, "selector": 账}；tokens_by_side 保持旧
    # 结构（默认值回归：agent 侧 = Σ per-agent，selector 原样）。K1 不变量在此
    # 显式登记（聚合由明细求和构造，故 K1 的判别力在「覆盖检查」——
    # 发放过 client 的 label 集必须覆盖全部实际发言 agent，防漏账）。
    _zero = {"prompt": 0, "completion": 0, "calls": 0}
    _sel = sink.get("selector", dict(_zero))
    _per_agent = {k: v for k, v in sink.items() if k != "selector"}
    _agg = {
        "prompt": sum(v["prompt"] for v in _per_agent.values()),
        "completion": sum(v["completion"] for v in _per_agent.values()),
        "calls": sum(v["calls"] for v in _per_agent.values()),
    }
    tokens_by_agent = dict(sorted(_per_agent.items()))
    if isinstance(agent_client, ClientBundle):
        issued = set(agent_client.issued_labels())
        speakers = {r["from"] for r in all_rows} | {r["to"] for r in all_rows}
        speakers.discard(UNRESOLVED)
        _uncovered = sorted(speakers - issued)
        _invariant = {
            "mode": "per_agent",
            "agent_side": _agg,
            "selector_side": _sel,
            "sum_prompt_eq_agent_side": True,  # agent 侧即由明细求和构造（见上注）
            "coverage_ok": not _uncovered,
            "uncovered_speakers": _uncovered,
            "issued_labels": sorted(issued),
        }
    else:
        _invariant = {"mode": "legacy_side", "agent_side": sink.get("agent", dict(_zero)),
                      "selector_side": _sel}
    # ────────────────────────────────────────────────────────────────────

    # 强度自检（仅攻击场景）
    from build_attack import verify_strength

    strength = verify_strength(scenario, all_rows, windows) if scenario.startswith("attack") else None

    meta = {
        "scenario": scenario,
        "task_id": task["task_id"],
        "difficulty": task["difficulty"],
        "repeat_idx": repeat_idx,
        "framework": "autogen-agentchat",
        "framework_version": _autogen_version(),
        "model": model,
        "base_url": base_url,
        "emit_team_events": True,
        "wall_ms": wall_ms,
        "phases": phase_meta,
        "events_total": event_total,
        "chat_messages_total": chat_total,
        "swarm_msgs_total": len(all_rows),
        "select_events_total": len(selects),
        "tokens_by_side": {"agent": _agg, "selector": _sel},
        "tokens_by_agent": tokens_by_agent,
        "ledger_invariant": _invariant,
        "total_tokens": total_tokens,
        "stop_reasons": stop_reasons,
        "strength_check": strength,
        "error": err,
        "collected_at_ms": int(time.time() * 1000),
        "adapter": "adapters/autogen/collect.py",
    }

    # 采集强制项自检：AutoGen 必须有调度事件（0 条判 invalid_adapter）
    # `-c2` 是 C-2 样本外验证的批次别名，形态与基名完全一致，须一并受检。
    _base_scen = scenario[:-3] if scenario.endswith("-c2") else scenario
    if not selects and _base_scen == "benign-A":
        meta["adapter_verdict"] = "invalid_adapter"
        meta["adapter_reason"] = "benign-A 应有 SelectSpeakerEvent，实际 0 条（emit_team_events 未生效？）"
    elif err:
        meta["adapter_verdict"] = "error"
    elif strength and not strength["ok"]:
        meta["adapter_verdict"] = "attack_underbuilt"
    else:
        meta["adapter_verdict"] = "ok"

    out_dir.mkdir(parents=True, exist_ok=True)
    _write_jsonl(out_dir / "swarm-msgs.jsonl", _strip_full(all_rows))
    _write_text_sidecar(out_dir, all_rows)
    _write_jsonl(out_dir / "windows.jsonl", windows)
    _write_jsonl(out_dir / "snapshots.jsonl", snapshots)
    _write_jsonl(out_dir / "select-events.jsonl", selects)
    _write_ledger_events(out_dir, meta)
    (out_dir / "trace-meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def _write_ledger_events(out_dir: Path, meta: dict) -> None:
    """CALIB-009 M0-b：统一账本事件 ledger-events.jsonl（逐 agent 一行）。

    schema（三框架对齐）：framework / agent / scenario / task_id / repeat_idx /
    prompt / completion / calls / collected_at_ms。spec/10 四信号的采集面。
    """
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
    """写 swarm-msgs.jsonl 前剥掉全文键——该文件的字节是判定层的输入契约，不得因
    sidecar 需要而改变（改了会让既有 S1 结论与指纹全部失效）。"""
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


def _autogen_version() -> str:
    try:
        from importlib.metadata import version

        return version("autogen-agentchat")
    except Exception:  # noqa: BLE001
        return "unknown"


def load_task(task_id: str, pool_path: Path | None = None) -> dict:
    pool = json.loads((pool_path or TASK_POOL).read_text(encoding="utf-8"))
    for t in pool["tasks"]:
        if t["task_id"] == task_id:
            return t
    raise SystemExit(f"任务池中无 {task_id}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True, choices=[
        "benign-A", "benign-B", "attack-concentrate", "attack-scale", "attack-cross",
        # C-2 样本外验证批次（v2.65.0）：builder 与基名相同，仅目录名区分批次
        "benign-A-c2", "benign-B-c2",
        "attack-concentrate-c2", "attack-scale-c2", "attack-cross-c2",
    ])
    ap.add_argument("--task", required=True, help="task_id，如 T01")
    ap.add_argument("--out", required=True, help="输出根目录")
    ap.add_argument("--repeat", type=int, default=1, help="重复次数，目录名带 rN")
    # R2 多厂商接线（预注册 §七）：默认值 = R1 行为，不传即完全复现 R1 路径
    ap.add_argument("--model", default=MODEL, help="模型名（默认 deepseek-chat）")
    ap.add_argument("--base-url", default=BASE_URL, help="OpenAI 兼容 base_url")
    ap.add_argument("--key-var", default=KEY_VAR,
                    help=".env / 环境变量中的 key 变量名（默认 OVERSIGHT_LLM_API_KEY）")
    # R2 题池接线（预注册 §七 M0 同批）：默认 = task-pool-v1，不改默认行为
    ap.add_argument("--pool", default=str(TASK_POOL),
                    help="任务池 JSON 路径（默认 task-pool-v1.json）")
    args = ap.parse_args()

    task = load_task(args.task, Path(args.pool))
    root = Path(args.out).resolve()
    results = []
    for i in range(1, args.repeat + 1):
        d = root / f"{args.scenario}__{args.task}__r{i}"
        meta = asyncio.run(run_track(args.scenario, task, d, i,
                                     args.model, args.base_url, args.key_var))
        results.append(
            {
                "dir": str(d),
                "verdict": meta["adapter_verdict"],
                "tokens": meta["total_tokens"],
                "wall_ms": meta["wall_ms"],
                "swarm_msgs": meta["swarm_msgs_total"],
                "select": meta["select_events_total"],
                "strength": meta["strength_check"],
                "error": meta["error"],
            }
        )
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
