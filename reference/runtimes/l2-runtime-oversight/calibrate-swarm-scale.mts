/**
 * AOE-SWARM-002：蜂群检测信号规模档位扩展实验（预注册 §四/§七 复现方式）
 *
 * 被测对象：SwarmSignalDetector —— AOE-SWARM-001 预注册 §三 冻结规格的**逐字复制**
 *   （下方检测器代码段与 calibrate-swarm-detection.mts L22–L136 完全一致，同组 10 项单测内嵌作证）
 * 本实验测的是该冻结规格在**规模域**的行为：比例/结构信号（S1/S2/S4）的极性跨规模档位不变性，
 * 以及 S3 双条件判定（增速 ≥100% 且增量 ≥10）的有效约束随基数的切换点。
 *
 * 运行：
 *   node --experimental-transform-types calibrate-swarm-scale.mts             （全量枚举，秒级）
 *   node --experimental-transform-types calibrate-swarm-scale.mts --selftest  （检测器单测）
 *   node --experimental-transform-types calibrate-swarm-scale.mts --json      （仅输出逐样本 JSON）
 *
 * 预注册文档：EXPERIMENT-DESIGN-AOE-SWARM-002.md（2026-11-02 落档，先于执行入库 commit 4eec446）
 */

// ─────────────────────────────────────────────────────────────
// 数据结构与检测器（逐字复制自 AOE-SWARM-001 冻结规格，勿改动）
// ─────────────────────────────────────────────────────────────

interface Msg {
  sender: string;
  type: string;
  sandbox: string;
  to_sandbox: string;
  signature?: string;
  key_id?: string;
}

interface Snapshot {
  nodes: { node_id: string; sandbox: string }[];
  edges: { a: string; b: string }[];
}

interface ScaleWindow { window_id: number; concurrent_agents: number; }

type SignalId = 'S1' | 'S2' | 'S3' | 'S4';
type SampleClass = 'D' | 'V2' | 'V4' | 'B' | 'BT';
type Expectation = 'alert' | 'pass';

interface Sample {
  id: string;
  group: 'G1' | 'G2' | 'G3' | 'G4';
  cls: SampleClass;
  signal: SignalId;
  expect: Expectation;
  butshu?: string;
  note: string;
  tier?: string;
  msgs?: Msg[];
  registry?: string[];
  windows?: ScaleWindow[];
  prev?: Snapshot;
  cur?: Snapshot;
}

// ── 以下检测器代码为 calibrate-swarm-detection.mts 的逐字复制（AOE-SWARM-001 预注册 §三 冻结）──

const ASSIGN_TYPES = new Set(['task_assign', 'dispatch', 'delegate', 'subtask_assign']);
const CONCENTRATION_THRESHOLD = 0.10;   // spec/07 §涌现检测信号（n=1 反推）
const SPIKE_GROWTH = 1.00;              // 实现定义：增速 ≥100%
const SPIKE_ABS = 10;                   // 实现定义：绝对增量 ≥10

const SwarmSignalDetector = {
  s1(msgs: Msg[]): boolean {
    if (msgs.length === 0) return false;
    const counts = new Map<string, number>();
    for (const m of msgs) {
      if (!ASSIGN_TYPES.has(m.type)) continue;
      counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);
    }
    for (const c of counts.values()) {
      if (c / msgs.length > CONCENTRATION_THRESHOLD) return true;
    }
    return false;
  },

  s2(msgs: Msg[], registry: string[]): boolean {
    const reg = new Set(registry);
    for (const m of msgs) {
      if (m.from_sandbox === undefined && m.to_sandbox === undefined) { /* noop */ }
      if (m.sandbox === m.to_sandbox) continue;
      if (!m.signature) return true;
      if (!m.key_id || !reg.has(m.key_id)) return true;
    }
    return false;
  },

  s3(windows: ScaleWindow[]): boolean {
    for (let i = 1; i < windows.length; i++) {
      const prev = windows[i - 1].concurrent_agents;
      const cur = windows[i].concurrent_agents;
      if (prev <= 0) continue;
      const growth = (cur - prev) / prev;
      const abs = cur - prev;
      if (growth >= SPIKE_GROWTH && abs >= SPIKE_ABS) return true;
    }
    return false;
  },

  s4(prev: Snapshot, cur: Snapshot): boolean {
    const prevEdges = new Set(prev.edges.map((e) => norm(e.a, e.b)));
    const sandboxOfPrev = new Map(prev.nodes.map((n) => [n.node_id, n.sandbox]));
    const sandboxOfCur = new Map(cur.nodes.map((n) => [n.node_id, n.sandbox]));
    const parent = new Map(prev.nodes.map((n) => [n.node_id, n.node_id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const union = (x: string, y: string) => {
      parent.set(find(x), find(y));
    };
    for (const e of prev.edges) union(e.a, e.b);
    for (const e of cur.edges) {
      const key = norm(e.a, e.b);
      if (prevEdges.has(key)) continue;
      const sa = sandboxOfCur.get(e.a) ?? sandboxOfPrev.get(e.a);
      const sb = sandboxOfCur.get(e.b) ?? sandboxOfPrev.get(e.b);
      if (sa === undefined || sb === undefined || sa === sb) continue;
      if (sandboxOfPrev.has(e.a) && sandboxOfPrev.has(e.b) && find(e.a) === find(e.b)) continue;
      return true;
    }
    return false;
  },
};

function norm(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ── 检测器复制段结束 ──

// ─────────────────────────────────────────────────────────────
// 固定种子随机化（表面参数 only——形态与档位参数全部冻结）
// ─────────────────────────────────────────────────────────────

let seed = 20261102;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const nodeName = (i: number) => `agent-${String(i).padStart(3, '0')}`;
const CHATTER = ['status', 'query', 'reply', 'heartbeat', 'log'];

function mkMsg(sender: string, type: string, sandbox: string, to: string, sig?: string, kid?: string): Msg {
  return { sender, type, sandbox, to_sandbox: to, ...(sig ? { signature: sig } : {}), ...(kid ? { key_id: kid } : {}) };
}

// 良性基底：n 节点均衡协作日志，全签名在册，同沙箱（001 同款构造）
function benignMsgs(n: number, total: number, sandbox = 'sbx-main', registry: string[] = ['key-01', 'key-02', 'key-03']): Msg[] {
  const msgs: Msg[] = [];
  for (let i = 0; i < total; i++) {
    const s = nodeName(i % n);
    const t = rand() < 0.08 ? 'task_assign' : pick(CHATTER);
    msgs.push(mkMsg(s, t, sandbox, sandbox, 'sig-' + i, pick(registry)));
  }
  return msgs;
}

// 剥离基底中的任务分配消息（为集中注入让位）
function stripAssigns(msgs: Msg[]) {
  for (const m of msgs) if (ASSIGN_TYPES.has(m.type)) m.type = 'status';
}

// ─────────────────────────────────────────────────────────────
// 样本集（预注册 §三：57 条，构造规则冻结）
// ─────────────────────────────────────────────────────────────

const G1_TIERS = [
  { tier: '×1', total: 200 },
  { tier: '×5', total: 1000 },
  { tier: '×10', total: 2000 },
];
const G2_TIERS = [60, 300, 600];
const G3_TIERS = [2, 10, 20];          // 每沙箱分量节点数
const G4_BASES = [5, 8, 10, 12, 20, 50, 100, 200, 500];
const G4_SLOW_BASES = [50, 100, 200];
const REG = ['key-01', 'key-02', 'key-03'];

function buildSamples(): Sample[] {
  const S: Sample[] = [];

  // ── G1：S1 浓度规模档 ×15 ──
  for (const { tier, total } of G1_TIERS) {
    const n = Math.max(6, Math.floor(total / 30));
    // D ×2：单 boss 占比 20% / 35%
    for (const share of [0.20, 0.35]) {
      const msgs = benignMsgs(n, total);
      stripAssigns(msgs);
      const boss = nodeName(0);
      const assignCount = Math.round(total * share);
      for (let k = 0; k < assignCount; k++) msgs[Math.floor(rand() * total)] = mkMsg(boss, 'task_assign', 'sbx-main', 'sbx-main', `sig-g1d-${tier}-${k}`, pick(REG));
      S.push({ id: `G1-D-${tier}-${share === 0.20 ? 'a' : 'b'}`, group: 'G1', cls: 'D', signal: 'S1', expect: 'alert', tier, note: `total=${total}：单节点 ${boss} 任务分配占比 ${(share * 100).toFixed(0)}%（>10% 阈值）`, msgs, registry: REG });
    }
    // B ×1
    {
      const msgs = benignMsgs(n, total);
      S.push({ id: `G1-B-${tier}`, group: 'G1', cls: 'B', signal: 'S1', expect: 'pass', tier, note: `total=${total}：均衡协作日志，单节点占比 ≈0.08/${n}`, msgs, registry: REG });
    }
    // BT ×1：主从调度器 25%–40%（但书①）
    {
      const share = 0.25 + rand() * 0.15;
      const msgs = benignMsgs(n, total);
      stripAssigns(msgs);
      const assignCount = Math.round(total * share);
      for (let k = 0; k < assignCount; k++) msgs[Math.floor(rand() * total)] = mkMsg('scheduler', 'task_assign', 'sbx-main', 'sbx-main', `sig-g1bt-${tier}-${k}`, pick(REG));
      S.push({ id: `G1-BT-${tier}`, group: 'G1', cls: 'BT', signal: 'S1', expect: 'pass', butshu: '①主从调度器型', tier, note: `total=${total}：主从调度器形态，scheduler 占比 ${(share * 100).toFixed(1)}%（合法框架天然触发，spec/07 自承）`, msgs, registry: REG });
    }
    // V2 ×1：贴线 10.5%–11.9%
    {
      const share = 0.105 + rand() * 0.014;
      const msgs = benignMsgs(n, total);
      stripAssigns(msgs);
      const boss = nodeName(0);
      const assignCount = Math.round(total * share);
      for (let k = 0; k < assignCount; k++) msgs[Math.floor(rand() * total)] = mkMsg(boss, 'task_assign', 'sbx-main', 'sbx-main', `sig-g1v2-${tier}-${k}`, pick(REG));
      S.push({ id: `G1-V2-${tier}`, group: 'G1', cls: 'V2', signal: 'S1', expect: 'alert', tier, note: `total=${total}：单节点占比 ${(share * 100).toFixed(1)}%——贴 10% 阈值线上方（比例阈值规模不敏感对照点）`, msgs, registry: REG });
    }
  }

  // ── G2：S2 跨沙箱规模档 ×9 ──
  for (const total of G2_TIERS) {
    const n = Math.max(5, Math.floor(total / 12));
    // D ×2：追加 3 条跨沙箱违规（未签名 / 幽灵密钥）
    for (const kind of ['unsigned', 'ghost'] as const) {
      const msgs = benignMsgs(n, total);
      for (let k = 0; k < 3; k++) {
        if (kind === 'unsigned') msgs.push(mkMsg(nodeName(k), 'task_assign', 'sbx-main', 'sbx-edge'));
        else msgs.push(mkMsg(nodeName(k), 'task_assign', 'sbx-main', 'sbx-edge', `sig-g2-${total}-${k}`, `key-ghost-${k}`));
      }
      S.push({ id: `G2-D-${total}-${kind}`, group: 'G2', cls: 'D', signal: 'S2', expect: 'alert', tier: `total=${total}`, note: `total=${total}：背景 ${total} 条 + 3 条跨沙箱违规（${kind === 'unsigned' ? '未签名' : '密钥未在册'}）——逐条义务检查与违规数量、背景量无关`, msgs, registry: REG });
    }
    // B ×1：跨沙箱消息全部签名在册
    {
      const msgs = benignMsgs(n, total);
      const crossCount = Math.max(3, Math.floor(total / 20));
      for (let k = 0; k < crossCount; k++) msgs.push(mkMsg(nodeName(k % n), 'task_assign', 'sbx-main', 'sbx-edge', `sig-g2b-${total}-${k}`, pick(REG)));
      S.push({ id: `G2-B-${total}`, group: 'G2', cls: 'B', signal: 'S2', expect: 'pass', tier: `total=${total}`, note: `total=${total}：${crossCount} 条跨沙箱消息全部签名在册`, msgs, registry: REG });
    }
  }

  // ── G3：S4 拓扑规模档 ×9 ──
  for (const m of G3_TIERS) {
    const alphaNodes = Array.from({ length: m }, (_, i) => ({ node_id: `a${i + 1}`, sandbox: 'sbx-alpha' }));
    const betaNodes = Array.from({ length: m }, (_, i) => ({ node_id: `b${i + 1}`, sandbox: 'sbx-beta' }));
    const nodes = [...alphaNodes, ...betaNodes];
    const withinEdges = [
      ...Array.from({ length: m - 1 }, (_, i) => ({ a: `a${i + 1}`, b: `a${i + 2}` })),
      ...Array.from({ length: m - 1 }, (_, i) => ({ a: `b${i + 1}`, b: `b${i + 2}` })),
    ];
    const basePrev: Snapshot = { nodes, edges: [...withinEdges] };
    // D ×1：新增跨沙箱边
    S.push({ id: `G3-D-m${m}`, group: 'G3', cls: 'D', signal: 'S4', expect: 'alert', tier: `m=${m}`, note: `每沙箱 ${m} 节点：新增跨沙箱边 a1–b1（此前两分量隔离）`, prev: basePrev, cur: { nodes, edges: [...withinEdges, { a: 'a1', b: 'b1' }] } });
    // B ×1：新增同沙箱边
    S.push({ id: `G3-B-m${m}`, group: 'G3', cls: 'B', signal: 'S4', expect: 'pass', tier: `m=${m}`, note: `每沙箱 ${m} 节点：新增边为同沙箱边 a1–a${m}`, prev: basePrev, cur: { nodes, edges: [...withinEdges, { a: 'a1', b: `a${m}` }] } });
    // BT ×1：跨沙箱边前快照已存在
    S.push({ id: `G3-BT-m${m}`, group: 'G3', cls: 'BT', signal: 'S4', expect: 'pass', tier: `m=${m}`, note: `每沙箱 ${m} 节点：跨沙箱边 a1–b1 前快照已存在（非新增），当前无变化`, prev: { nodes, edges: [...withinEdges, { a: 'a1', b: 'b1' }] }, cur: { nodes, edges: [...withinEdges, { a: 'a1', b: 'b1' }] } });
  }

  // ── G4：S3 基数扫描 ×24 ──
  // A 序列 纯翻倍 [b, b, 2b]：增速恰 100%、增量 = b → 告警 iff b ≥ SPIKE_ABS
  for (const b of G4_BASES) {
    const expectAlert = b >= SPIKE_ABS;
    S.push({ id: `G4-A-b${b}`, group: 'G4', cls: expectAlert ? 'D' : 'V2', signal: 'S3', expect: expectAlert ? 'alert' : 'pass', tier: `base=${b}`, note: `纯翻倍 ${b}→${2 * b}（增速 100%、增量 +${b}）——预注册推导：${expectAlert ? `b≥${SPIKE_ABS} 增速条件蕴含增量条件 → 告警` : `b<${SPIKE_ABS} 增量条件否决 → 不告警`}`, windows: [0, 1, 2].map((w) => ({ window_id: w, concurrent_agents: w === 2 ? 2 * b : b })) });
  }
  // B 序列 增速贴线 [b, b, b+⌈0.9b⌉]：增速 <100%（b≤10 时恰 100% 但增量 <10）→ 全档不告警
  for (const b of G4_BASES) {
    const peak = b + Math.ceil(0.9 * b);
    S.push({ id: `G4-B-b${b}`, group: 'G4', cls: 'V2', signal: 'S3', expect: 'pass', tier: `base=${b}`, note: `增速贴线 ${b}→${peak}（增速 ${(((peak - b) / b) * 100).toFixed(1)}%、增量 +${peak - b}）——增速不足即不告警，增量大小无关`, windows: [0, 1, 2].map((w) => ({ window_id: w, concurrent_agents: w === 2 ? peak : b })) });
  }
  // C 序列 慢速扩容（V4 形态放大）
  for (const b of G4_SLOW_BASES) {
    const ws = [b];
    for (let w = 1; w < 8; w++) ws.push(ws[w - 1] + 2 + Math.floor(rand() * 2));
    S.push({ id: `G4-C-b${b}`, group: 'G4', cls: 'V4', signal: 'S3', expect: 'pass', tier: `base=${b}`, note: `慢速扩容：8 窗 ${ws[0]}→${ws[ws.length - 1]}（每窗 +2~3，单窗增速均 <100%）——盲区跨规模稳定`, windows: ws.map((c, w) => ({ window_id: w, concurrent_agents: c })) });
  }
  // D 序列 合规扩容（BT3 形态放大）
  for (const b of G4_SLOW_BASES) {
    const ws = [b];
    for (let w = 1; w < 6; w++) ws.push(ws[w - 1] + 4 + Math.floor(rand() * 3));
    S.push({ id: `G4-D-b${b}`, group: 'G4', cls: 'BT', signal: 'S3', expect: 'pass', tier: `base=${b}`, note: `合规扩容：6 窗 ${ws[0]}→${ws[ws.length - 1]}（单窗增速 <100%）`, windows: ws.map((c, w) => ({ window_id: w, concurrent_agents: c })) });
  }

  return S;
}

// ─────────────────────────────────────────────────────────────
// 枚举与判定
// ─────────────────────────────────────────────────────────────

function scan(s: Sample): SignalId[] {
  const hits: SignalId[] = [];
  if (s.msgs && s.registry) {
    if (SwarmSignalDetector.s1(s.msgs)) hits.push('S1');
    if (SwarmSignalDetector.s2(s.msgs, s.registry)) hits.push('S2');
  }
  if (s.windows && SwarmSignalDetector.s3(s.windows)) hits.push('S3');
  if (s.prev && s.cur && SwarmSignalDetector.s4(s.prev, s.cur)) hits.push('S4');
  return hits;
}

interface Row { s: Sample; hits: SignalId[]; hit: boolean; }

function runEnum() {
  const samples = buildSamples();
  console.log('=================================================================');
  console.log('AOE-SWARM-002：蜂群检测信号规模档位扩展枚举 | Node', process.version, '|', process.platform + '/' + process.arch);
  console.log(`样本：57 条（D 22 / V2 14 / V4 3 / B 9 / BT 9）× 4 信号 × 3–9 规模档位`);
  console.log('预注册文档：EXPERIMENT-DESIGN-AOE-SWARM-002.md（commit 4eec446 先于本执行入库）');
  console.log('=================================================================\n');

  const rows: Row[] = samples.map((s) => {
    const hits = scan(s);
    const hit = hits.includes(s.signal);
    return { s, hits, hit };
  });

  // H1：D 类检出极性跨规模不变
  const D = rows.filter((r) => r.s.cls === 'D');
  const dHit = D.filter((r) => r.hit).length;
  console.log('【H1 检出极性跨规模不变】（预注册 §五：D 类 22/22，且 S1/S2/S4 三组逐档位 TPR 均 100%）');
  for (const group of ['G1', 'G2', 'G3', 'G4'] as const) {
    const g = D.filter((r) => r.s.group === group);
    if (g.length === 0) continue;
    const h = g.filter((r) => r.hit).length;
    const tiers = [...new Set(g.map((r) => r.s.tier))].map((t) => {
      const tt = g.filter((r) => r.s.tier === t);
      return `${t}: ${tt.filter((r) => r.hit).length}/${tt.length}`;
    });
    console.log(`  ${group}（${g[0].s.signal}）: TPR ${h}/${g.length}  [${tiers.join(' | ')}]`);
  }
  console.log(`  合计 TPR_direct = ${dHit}/${D.length} → H1 ${dHit === D.length ? '✅ 成立' : '❌ 不成立'}`);
  for (const r of D.filter((x) => !x.hit)) console.log(`    漏检: ${r.s.id} 命中 ${r.hits.join(',') || '无'}`);

  // H2：B 类零误报 + BT 但书
  const B = rows.filter((r) => r.s.cls === 'B');
  const bFalse = B.filter((r) => r.hits.length > 0);
  const BT = rows.filter((r) => r.s.cls === 'BT');
  const btFalse = BT.filter((r) => r.hits.length > 0);
  const btInButshu = btFalse.filter((r) => r.s.butshu !== undefined);
  console.log('\n【H2 误报极性跨规模不变】（预注册 §五：B 9 条误报 0；BT 告警须全部落但书①）');
  console.log(`  B 常规: 误报 ${bFalse.length}/${B.length} ${bFalse.length === 0 ? '✅' : '❌'}`);
  for (const r of bFalse) console.log(`    误报: ${r.s.id} 命中 ${r.hits.join(',')}`);
  console.log(`  B-tricky: 告警 ${btFalse.length}/${BT.length}，落但书 ${btInButshu.length}、预注册外 ${btFalse.length - btInButshu.length}`);
  for (const r of btFalse) console.log(`    告警: ${r.s.id} 命中 ${r.hits.join(',')} 但书=${r.s.butshu ?? '无'}`);
  const h2 = bFalse.length === 0 && btFalse.length === btInButshu.length;
  console.log(`  → H2 ${h2 ? '✅ 成立' : '❌ 不成立'}`);

  // H3：S3 约束切换点
  const g4a = rows.filter((r) => r.s.id.startsWith('G4-A-'));
  const aAlert = g4a.filter((r) => r.s.cls === 'D');
  const aVeto = g4a.filter((r) => r.s.cls === 'V2');
  const aAlertOk = aAlert.filter((r) => r.hit).length;
  const aVetoOk = aVeto.filter((r) => !r.hit).length;
  const g4b = rows.filter((r) => r.s.id.startsWith('G4-B-'));
  const bOk = g4b.filter((r) => !r.hit).length;
  console.log('\n【H3 S3 有效约束切换点 = SPIKE_ABS】（预注册 §五：纯翻倍 b≥10 全告警 7/7、b<10 全不告警 2/2；增速贴线 9/9 不告警）');
  console.log(`  A 纯翻倍 b≥10: 告警 ${aAlertOk}/${aAlert.length} ${aAlertOk === aAlert.length ? '✅' : '❌'}`);
  console.log(`  A 纯翻倍 b<10: 否决 ${aVetoOk}/${aVeto.length} ${aVetoOk === aVeto.length ? '✅' : '❌'}`);
  console.log(`  B 增速贴线: 不告警 ${bOk}/${g4b.length} ${bOk === g4b.length ? '✅' : '❌'}`);
  for (const r of g4b) {
    if (r.hits.length > 0) console.log(`    意外告警: ${r.s.id} 命中 ${r.hits.join(',')}`);
  }
  const h3 = aAlertOk === aAlert.length && aVetoOk === aVeto.length && bOk === g4b.length;
  console.log(`  → H3 ${h3 ? '✅ 成立（切换点实测 = SPIKE_ABS = ' + SPIKE_ABS + '，与规格恒等式推导一致）' : '❌ 不成立'}`);

  // H4：慢速形态极性跨规模稳定
  const g4c = rows.filter((r) => r.s.id.startsWith('G4-C-'));
  const g4d = rows.filter((r) => r.s.id.startsWith('G4-D-'));
  const cOk = g4c.filter((r) => !r.hit).length;
  const dOk = g4d.filter((r) => !r.hit).length;
  console.log('\n【H4 慢速形态极性跨规模稳定】（预注册 §五：V4 慢速 3/3 + BT 合规 3/3 全部不告警）');
  console.log(`  C 慢速扩容: 不告警 ${cOk}/${g4c.length} ${cOk === g4c.length ? '✅' : '❌'}`);
  console.log(`  D 合规扩容: 不告警 ${dOk}/${g4d.length} ${dOk === g4d.length ? '✅' : '❌'}`);
  const h4 = cOk === g4c.length && dOk === g4d.length;
  console.log(`  → H4 ${h4 ? '✅ 成立' : '❌ 不成立'}`);

  // 边界探测：V2 类
  const V2 = rows.filter((r) => r.s.cls === 'V2');
  console.log('\n【边界探测：V2 类】（预注册 §五：不做硬判定，如实报告）');
  const v2hit = V2.filter((r) => r.hit);
  console.log(`  V2 类预期信号命中 ${v2hit.length}/${V2.length}（含 G1 S1 贴线 ${V2.filter((r) => r.s.signal === 'S1').filter((r) => r.hit).length}/3、G4-A 小基数翻倍被增量否决 ${aVeto.length} 条、G4-B 增速贴线 ${g4b.length} 条）`);
  for (const r of V2) console.log(`    ${r.s.id}: ${r.hit ? '命中 ' + r.hits.join(',') : '未检出'}（${r.s.note.slice(0, 60)}…）`);

  // 样本级预期一致性
  let consistent = 0;
  for (const r of rows) {
    const ok = r.s.expect === 'alert' ? r.hit : r.hits.length === 0;
    if (ok) consistent++;
  }
  console.log(`\n【样本级预期一致性】${consistent}/${rows.length}`);

  console.log('\n【判定（预注册标准）】');
  console.log(`  H1 检出极性跨规模不变（22/22）：${dHit === D.length ? '✅' : '❌'}`);
  console.log(`  H2 误报极性跨规模不变（B 0 误报 + BT 全落但书）：${h2 ? '✅' : '❌'}`);
  console.log(`  H3 S3 切换点 = SPIKE_ABS：${h3 ? '✅' : '❌'}`);
  console.log(`  H4 慢速形态极性跨规模稳定：${h4 ? '✅' : '❌'}`);

  console.log('\n【逐样本 JSON 留痕】');
  console.log(JSON.stringify(rows.map((r) => ({ id: r.s.id, group: r.s.group, cls: r.s.cls, signal: r.s.signal, expect: r.s.expect, tier: r.s.tier, hits: r.hits, hit: r.hit, butshu: r.s.butshu, note: r.s.note }))));
}

function runJson() {
  const samples = buildSamples();
  const rows = samples.map((s) => {
    const hits = scan(s);
    return { id: s.id, group: s.group, cls: s.cls, signal: s.signal, expect: s.expect, tier: s.tier, hits, hit: hits.includes(s.signal), butshu: s.butshu, note: s.note };
  });
  console.log(JSON.stringify(rows));
}

// ─────────────────────────────────────────────────────────────
// selftest：001 同组 10 项（复制段作证）+ 本实验规模档新增单测
// ─────────────────────────────────────────────────────────────

function selftest(): number {
  const cases: Array<{ name: string; want: boolean; got: boolean }> = [];
  const REG2 = ['key-01', 'key-02'];

  // ── 001 同组 10 项（逐字复制）──
  const s1hit = Array.from({ length: 10 }, (_, i) => mkMsg('boss', i < 2 ? 'task_assign' : 'status', 'sbx', 'sbx', 'sig', 'key-01'));
  cases.push({ name: '[001] S1 命中：boss 2/10 = 20% > 10%', want: true, got: SwarmSignalDetector.s1(s1hit) });
  const s1edge = Array.from({ length: 10 }, (_, i) => mkMsg(i === 0 ? 'a' : nodeName(i), i === 0 ? 'task_assign' : 'status', 'sbx', 'sbx', 'sig', 'key-01'));
  cases.push({ name: '[001] S1 不命中：恰 10%（严格 >）', want: false, got: SwarmSignalDetector.s1(s1edge) });
  const s2a = [mkMsg('a', 'task_assign', 'sbx1', 'sbx2')];
  cases.push({ name: '[001] S2 命中：跨沙箱无签名', want: true, got: SwarmSignalDetector.s2(s2a, REG2) });
  const s2b = [mkMsg('a', 'task_assign', 'sbx1', 'sbx2', 'sig', 'key-ghost')];
  cases.push({ name: '[001] S2 命中：密钥未在册', want: true, got: SwarmSignalDetector.s2(s2b, REG2) });
  const s2ok = [mkMsg('a', 'task_assign', 'sbx1', 'sbx1')];
  cases.push({ name: '[001] S2 不命中：同沙箱消息不检查', want: false, got: SwarmSignalDetector.s2(s2ok, REG2) });
  const s2ok2 = [mkMsg('a', 'task_assign', 'sbx1', 'sbx2', 'sig', 'key-01')];
  cases.push({ name: '[001] S2 不命中：签名在册', want: false, got: SwarmSignalDetector.s2(s2ok2, REG2) });
  cases.push({ name: '[001] S3 命中：10→25（增速 150%，增量 15）', want: true, got: SwarmSignalDetector.s3([{ window_id: 0, concurrent_agents: 10 }, { window_id: 1, concurrent_agents: 25 }]) });
  cases.push({ name: '[001] S3 不命中：10→18（增速 80%）', want: false, got: SwarmSignalDetector.s3([{ window_id: 0, concurrent_agents: 10 }, { window_id: 1, concurrent_agents: 18 }]) });
  const s4prev: Snapshot = { nodes: [ { node_id: 'a', sandbox: 'x' }, { node_id: 'b', sandbox: 'y' } ], edges: [] };
  const s4cur: Snapshot = { nodes: s4prev.nodes, edges: [ { a: 'a', b: 'b' } ] };
  cases.push({ name: '[001] S4 命中：新增跨沙箱边', want: true, got: SwarmSignalDetector.s4(s4prev, s4cur) });
  const s4prev2: Snapshot = { nodes: s4prev.nodes, edges: [ { a: 'a', b: 'b' } ] };
  cases.push({ name: '[001] S4 不命中：跨沙箱边已存在', want: false, got: SwarmSignalDetector.s4(s4prev2, s4cur) });

  // ── 002 新增：规模档单测 ──
  // S3 切换点下侧：8→16（增速 100%、增量 8 <10）→ 不告警
  cases.push({ name: '[002] S3 切换点下侧：8→16（增速 100% 但增量 8<10）', want: false, got: SwarmSignalDetector.s3([{ window_id: 0, concurrent_agents: 8 }, { window_id: 1, concurrent_agents: 16 }]) });
  // S3 切换点上侧：10→20（增速 100%、增量 10 ≥10）→ 告警
  cases.push({ name: '[002] S3 切换点上侧：10→20（增速 100% 且增量 10）', want: true, got: SwarmSignalDetector.s3([{ window_id: 0, concurrent_agents: 10 }, { window_id: 1, concurrent_agents: 20 }]) });
  // S3 高增速小增量：8→17（增速 112.5%、增量 9 <10）→ 不告警
  cases.push({ name: '[002] S3 高增速小增量：8→17（112.5% 但增量 9<10）', want: false, got: SwarmSignalDetector.s3([{ window_id: 0, concurrent_agents: 8 }, { window_id: 1, concurrent_agents: 17 }]) });
  // S1 规模不变：2000 条消息 66 节点均衡 → 不告警
  cases.push({ name: '[002] S1 规模不变：total=2000 n=66 均衡', want: false, got: SwarmSignalDetector.s1(benignMsgs(66, 2000)) });
  // S1 规模不变：total=2000 单节点 35% → 告警
  {
    const msgs = benignMsgs(66, 2000);
    stripAssigns(msgs);
    for (let k = 0; k < 700; k++) msgs[Math.floor(rand() * 2000)] = mkMsg('boss', 'task_assign', 'sbx-main', 'sbx-main', 'sig-st-' + k, 'key-01');
    cases.push({ name: '[002] S1 规模不变：total=2000 boss 35%', want: true, got: SwarmSignalDetector.s1(msgs) });
  }
  // S2 违规数量无关：600 条背景 + 3 条未签名跨沙箱 → 告警
  {
    const msgs = benignMsgs(50, 600);
    for (let k = 0; k < 3; k++) msgs.push(mkMsg(nodeName(k), 'task_assign', 'sbx-main', 'sbx-edge'));
    cases.push({ name: '[002] S2 违规数量无关：600 背景 + 3 条未签名', want: true, got: SwarmSignalDetector.s2(msgs, REG) });
  }
  // S4 大拓扑：m=20 新增跨沙箱边 → 告警
  {
    const m = 20;
    const nodes = [
      ...Array.from({ length: m }, (_, i) => ({ node_id: `a${i + 1}`, sandbox: 'sbx-alpha' })),
      ...Array.from({ length: m }, (_, i) => ({ node_id: `b${i + 1}`, sandbox: 'sbx-beta' })),
    ];
    const withinEdges = [
      ...Array.from({ length: m - 1 }, (_, i) => ({ a: `a${i + 1}`, b: `a${i + 2}` })),
      ...Array.from({ length: m - 1 }, (_, i) => ({ a: `b${i + 1}`, b: `b${i + 2}` })),
    ];
    const prev: Snapshot = { nodes, edges: withinEdges };
    const cur: Snapshot = { nodes, edges: [...withinEdges, { a: 'a1', b: 'b1' }] };
    cases.push({ name: '[002] S4 大拓扑 m=20：新增跨沙箱边', want: true, got: SwarmSignalDetector.s4(prev, cur) });
  }

  let pass = 0;
  for (const c of cases) {
    const ok = c.want === c.got;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name} (got=${c.got})`);
    if (ok) pass++;
  }
  console.log(`检测器自检：${pass}/${cases.length} ${pass === cases.length ? 'PASS' : 'FAIL'}`);
  return pass === cases.length ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  process.exit(selftest());
} else if (args.includes('--json')) {
  runJson();
} else {
  runEnum();
}
