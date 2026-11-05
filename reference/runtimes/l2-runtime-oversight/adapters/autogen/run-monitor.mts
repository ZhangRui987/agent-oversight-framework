/**
 * AOE-CALIB-007 · AutoGen 判定层（消费采集产物，调用冻结检测器）。
 *
 * 设计原则：**不重写任何 S1 公式**。所有与检测器同构的量都通过构造不同参数的
 * SwarmMonitor 探针取得，保证「标定的就是检测器实际统计量」（设计稿 §二）。
 *
 *   S1_raw          θ = -1 强制告警 → 取 evidence.share
 *   S1_raw_nofilter 把全部消息 type 改为 assign，同一探针 → 取 evidence.share
 *   S1_cond         topC / assign 消息总数（纯算术，非检测器逻辑）
 *   share_node      逐节点 assign 数 / 全部消息数（描述性）
 *   share_select    调度事件选中次数 / 事件总数（事件序列，非消息）
 *
 * 用法：
 *   node --experimental-transform-types run-monitor.mts --dir=<轨迹目录> \
 *     --registry=../../whitelist-registry.json --framework=autogen --pattern=A
 *   node --experimental-transform-types run-monitor.mts --dir=<轨迹目录> --whitelist=a,b
 *
 * 白名单优先从冻结的 whitelist-registry.json 取（只认 status=verified 的形态）；
 * --whitelist 仅用于临时调试，正式轨迹必须走登记表，否则白名单来源不可复审。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SwarmMonitor, type SwarmMsg, type SwarmAlert } from '../../index.ts';

const ASSIGN_TYPES = new Set(['task_assign', 'dispatch', 'delegate', 'subtask_assign']);

function readJsonl<T>(file: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

interface MsgRow extends SwarmMsg {
  _phase?: string;
  _format_mark?: string | null;
  _content_len?: number;
}

interface SelectRow {
  phase: string;
  idx: number;
  selected: string[] | string | null;
}

/** 探针：θ = -1 强制 S1 告警，只为读出 share。不改变检测器逻辑。 */
function probeShare(msgs: SwarmMsg[], whitelist: Set<string>): { share: number; topSender: string } | null {
  if (msgs.length === 0) return null;
  const probe = new SwarmMonitor({ schedulerWhitelist: whitelist, concentrationThreshold: -1 });
  probe.ingestMsgs(msgs);
  const s1 = probe.evaluate().find((a) => a.signal === 'S1');
  if (!s1) return null;
  return {
    share: Number(s1.evidence.share),
    topSender: String(s1.evidence.topSender ?? ''),
  };
}

export interface TrackResult {
  dir: string;
  msgs: number;
  s1_raw: number | null;
  s1_raw_nofilter: number | null;
  s1_cond: number | null;
  share_node: Record<string, number>;
  share_node_max: number;
  share_select: Record<string, number>;
  share_select_top: number;
  facts: {
    sched_in_msgflow: boolean;
    sched_assign_count: number;
    assign_total: number;
    top_sender: string;
    whitelist: string[];
    scheduler_roles: string[];
  };
  alerts: Array<{ signal: string; evidence: Record<string, unknown> }>;
  thresholds: { concentration: number; alerted: boolean };
}

export function evaluateTrack(dir: string, whitelist: string[], schedulerRoles: string[] = whitelist): TrackResult {
  const wl = new Set(whitelist);
  // 判定「调度器是否在消息流里」必须用登记名（nominal），不能用豁免集（effective）——
  // effective 在 AutoGen / CrewAI 上是空集，用它会恒得 false，那是循环论证。
  const sched = new Set(schedulerRoles.length ? schedulerRoles : whitelist);
  const rows = readJsonl<MsgRow>(resolve(dir, 'swarm-msgs.jsonl'));
  const windows = readJsonl<{ windowId: number; concurrentAgents: number }>(resolve(dir, 'windows.jsonl')).map((w) => ({
    windowId: w.windowId,
    concurrentAgents: w.concurrentAgents,
  }));
  const snapshots = readJsonl<{ nodes: { nodeId: string; sandbox: string }[]; edges: { a: string; b: string }[] }>(
    resolve(dir, 'snapshots.jsonl'),
  ).map((s) => ({ nodes: s.nodes, edges: s.edges }));
  const selects = readJsonl<SelectRow>(resolve(dir, 'select-events.jsonl'));

  // 只取 SwarmMsg 的必需字段——元字段不进入检测器
  const msgs: SwarmMsg[] = rows.map((r) => ({
    from: r.from,
    to: r.to,
    fromSandbox: r.fromSandbox,
    toSandbox: r.toSandbox,
    type: r.type,
    ...(r.signature ? { signature: r.signature } : {}),
    ...(r.keyId ? { keyId: r.keyId } : {}),
  }));

  // ① 真实配置下的告警（θ 默认 0.10）——判定以此为准
  const monitor = new SwarmMonitor({ schedulerWhitelist: wl });
  monitor.ingestMsgs(msgs);
  monitor.ingestWindows(windows);
  for (const s of snapshots) monitor.ingestSnapshot(s);
  const alerts: SwarmAlert[] = monitor.evaluate();

  // ② 探针读数
  const raw = probeShare(msgs, wl);
  const allAssign: SwarmMsg[] = msgs.map((m) => ({ ...m, type: 'task_assign' }));
  const rawNoFilter = probeShare(allAssign, wl);

  // ③ 纯算术量
  const assignTotal = msgs.filter((m) => ASSIGN_TYPES.has(m.type)).length;
  const topC = raw ? Math.round(raw.share * msgs.length) : 0;
  const s1Cond = assignTotal > 0 ? topC / assignTotal : null;

  const nodeCount = new Map<string, number>();
  for (const m of msgs) {
    if (!ASSIGN_TYPES.has(m.type)) continue;
    nodeCount.set(m.from, (nodeCount.get(m.from) ?? 0) + 1);
  }
  const shareNode: Record<string, number> = {};
  for (const [n, c] of nodeCount) shareNode[n] = Math.round((c / msgs.length) * 10000) / 10000;

  const selCount = new Map<string, number>();
  let selTotal = 0;
  for (const s of selects) {
    const list = Array.isArray(s.selected) ? s.selected : s.selected ? [s.selected] : [];
    for (const name of list) {
      selCount.set(String(name), (selCount.get(String(name)) ?? 0) + 1);
      selTotal += 1;
    }
  }
  const shareSelect: Record<string, number> = {};
  for (const [n, c] of selCount) shareSelect[n] = Math.round((c / selTotal) * 10000) / 10000;

  const schedInFlow = msgs.some((m) => sched.has(m.from));
  const schedAssign = msgs.filter((m) => sched.has(m.from) && ASSIGN_TYPES.has(m.type)).length;

  const result: TrackResult = {
    dir,
    msgs: msgs.length,
    s1_raw: raw ? raw.share : null,
    s1_raw_nofilter: rawNoFilter ? rawNoFilter.share : null,
    s1_cond: s1Cond === null ? null : Math.round(s1Cond * 10000) / 10000,
    share_node: shareNode,
    share_node_max: Object.values(shareNode).length ? Math.max(...Object.values(shareNode)) : 0,
    share_select: shareSelect,
    share_select_top: Object.values(shareSelect).length ? Math.max(...Object.values(shareSelect)) : 0,
    facts: {
      sched_in_msgflow: schedInFlow,
      sched_assign_count: schedAssign,
      assign_total: assignTotal,
      top_sender: raw ? raw.topSender : '',
      whitelist,
      scheduler_roles: [...sched],
    },
    alerts: alerts.map((a) => ({ signal: a.signal, evidence: a.evidence })),
    thresholds: {
      concentration: 0.1,
      alerted: alerts.some((a) => a.signal === 'S1'),
    },
  };

  writeFileSync(resolve(dir, 'track-result.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

interface RegistryPattern {
  status?: string;
  whitelist_effective?: string[];
  whitelist_nominal?: string[];
  scheduler_entity?: string | null;
  emits_chat_messages?: boolean | null;
}

/**
 * 从冻结的白名单登记表取两组名字：
 *   effective —— 实际传给检测器的豁免集（只认 status=verified 的形态）
 *   nominal   —— 调度实体的登记名，用来**判定它是否出现在消息流里**
 *
 * 两组必须分开：如果用 effective 去判定「调度器在不在流里」，在 AutoGen / CrewAI 这种
 * effective 为空集的框架上会恒得 false——那是循环论证（空集里当然没有这个名字），
 * 不是「调度器不在流中」的证据。实测踩到过。
 */
function resolveRegistry(
  registryPath: string,
  framework: string,
  pattern: string,
): { effective: string[]; nominal: string[] } {
  const reg = JSON.parse(readFileSync(resolve(registryPath), 'utf8')) as {
    frameworks?: Record<string, { status?: string; patterns?: Record<string, RegistryPattern> }>;
  };
  const fw = reg.frameworks?.[framework];
  if (!fw) throw new Error(`登记表无框架 ${framework}（在册：${Object.keys(reg.frameworks ?? {}).join(', ')}）`);
  if (fw.status !== 'verified') throw new Error(`框架 ${framework} 状态为 ${fw.status ?? '未声明'}，禁止用于正式执行`);
  const p = fw.patterns?.[pattern];
  if (!p) throw new Error(`框架 ${framework} 无形态 ${pattern}（在册：${Object.keys(fw.patterns ?? {}).join(', ')}）`);
  if (p.status !== 'verified') throw new Error(`形态 ${framework}.${pattern} 状态为 ${p.status ?? '未声明'}，禁止用于正式执行`);
  if (p.emits_chat_messages === true && !(p.whitelist_effective ?? []).includes(String(p.scheduler_entity))) {
    throw new Error(`形态 ${framework}.${pattern} 声明调度器发消息但未豁免，登记表与检测口径不一致`);
  }
  const effective = p.whitelist_effective ?? [];
  const nominal = p.whitelist_nominal ?? [];
  return { effective, nominal };
}

function parseArgs(argv: string[]): { dir: string; whitelist: string[]; source: string; scheduler: string[] } {
  let dir = '';
  let whitelist: string[] = [];
  let scheduler: string[] = [];
  let registry = '';
  let framework = '';
  let pattern = '';
  for (const a of argv) {
    if (a.startsWith('--dir=')) dir = resolve(a.slice('--dir='.length));
    if (a.startsWith('--whitelist=')) {
      whitelist = a
        .slice('--whitelist='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (a.startsWith('--scheduler=')) {
      scheduler = a
        .slice('--scheduler='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (a.startsWith('--registry=')) registry = a.slice('--registry='.length);
    if (a.startsWith('--framework=')) framework = a.slice('--framework='.length);
    if (a.startsWith('--pattern=')) pattern = a.slice('--pattern='.length);
  }
  if (!dir) {
    console.error(
      '用法：run-monitor.mts --dir=<轨迹目录> [--registry=<登记表> --framework=autogen --pattern=A | --whitelist=a,b] [--scheduler=x,y]',
    );
    process.exit(2);
  }
  let source = 'cli';
  if (registry) {
    if (!framework || !pattern) {
      console.error('--registry 需同时给 --framework 与 --pattern');
      process.exit(2);
    }
    const r = resolveRegistry(registry, framework, pattern);
    whitelist = r.effective;
    scheduler = r.nominal.length ? r.nominal : r.effective;
    source = whitelist.length
      ? `registry:${framework}.${pattern}`
      : `registry:${framework}.${pattern}（空集，该形态无非消息调度实体）`;
  } else if (whitelist.length) {
    source = 'cli';
    if (!scheduler.length) scheduler = whitelist;
  } else {
    source = 'empty';
  }
  return { dir, whitelist, source, scheduler };
}

if (process.argv[1] && process.argv[1].endsWith('run-monitor.mts')) {
  let parsed: { dir: string; whitelist: string[]; source: string };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[拒绝] ${(err as Error).message}`);
    process.exit(2);
  }
  const { dir, whitelist, source, scheduler } = parsed;
  const r = evaluateTrack(dir, whitelist, scheduler);
  const out = [
    '',
    'AOE-CALIB-007 · 单轨迹判定',
    '─'.repeat(52),
    `  目录            ${r.dir}`,
    `  白名单          [${whitelist.join(', ')}]  来源=${source}`,
    `  消息数          ${r.msgs}`,
    `  S1_raw          ${r.s1_raw ?? '—'}（检测器默认 θ=0.10，告警：${r.thresholds.alerted ? '是' : '否'}）`,
    `  S1_raw_nofilter ${r.s1_raw_nofilter ?? '—'}`,
    `  S1_cond         ${r.s1_cond ?? '—'}（assign 总数 ${r.facts.assign_total}）`,
    `  share_node max  ${r.share_node_max}`,
    `  share_select top ${r.share_select_top}`,
    `  污染源          调度器进消息流=${r.facts.sched_in_msgflow}，调度器 assign=${r.facts.sched_assign_count}`,
    `  告警            ${r.alerts.length ? r.alerts.map((a) => a.signal).join(' / ') : '无'}`,
    '',
  ];
  process.stdout.write(out.join('\n'));
}
