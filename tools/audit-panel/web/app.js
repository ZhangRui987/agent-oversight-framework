/* 审计面板前端 · 原生 JS · loadXxx/renderXxx 配对模式（沿用 Zhuanye_app admin dashboard 惯例）
 * 数据源：/api/timeline /api/evidence /api/boundaries（全部只读；重放校验属 CLI，见诚实边界） */
'use strict';

const view = document.getElementById('view');
const foot = document.getElementById('foot');
const verifybar = document.getElementById('verifybar');
const state = { meta: null, events: [], evidence: null, boundaries: null, verification: null, disposition: null, orphanSeqs: new Set(), signalStates: new Map(), filter: { rule: '', cat: '', scen: '' } };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gradeBadge = (g) => `<span class="badge g${esc(g)}">效能 ${esc(g)} 级</span>`;
const fmtKV = (obj) => !obj ? '—' : Object.entries(obj).map(([k, v]) => `${esc(k)}=${esc(v)}`).join('；');

// ─────────────────────────────────────────────
// 通用：链可视化 + 筛选条 + 展开折叠 + URL 锚点
// ─────────────────────────────────────────────

/**
 * 链可视化：seq 方块按事件类型着色，箭头表示 prev 指针方向（seq N 的哈希覆盖 N-1）。
 * 悬停显示链哈希前缀；点击跳转到对应事件卡片（URL 锚点直达）。
 * 链校验状态来自 /api/verification 的启动时快照——PASS 绿 / FAIL 红。
 */
function chainViz(events, prefix, chainOk) {
  const boxes = events.map((e) => {
    const cls = e.event_type === 'ledger_signal' ? 'ck sig' : 'ck deny';
    const h = String(e.chain_hash || '').slice(0, 10);
    const p = String(e.chain_prev || '').slice(0, 10);
    return `<span class="${cls}" title="seq ${e.seq} · ${esc(e.category)}&#10;hash ${esc(h)}…&#10;prev ${esc(p || '(首条)')}…" onclick="jumpTo('${prefix}','${e.seq}')">${e.seq}</span>`;
  }).join('<span class="cl">→</span>');
  return `<div class="chainviz"><span class="v-time">审计链：</span>${boxes}<span class="${chainOk ? 'v-ok' : 'v-bad'}">链已校验</span></div>`;
}

/** 事件过滤（rule_id / category / 场景三维度；V1 按 source_scenario，V2 按 session_id）。 */
function filteredEvents(events) {
  const f = state.filter;
  return events.filter((e) =>
    (!f.rule || e.rule_id === f.rule) &&
    (!f.cat || e.category === f.cat) &&
    (!f.scen || (e.source_scenario ?? e.session_id) === f.scen));
}

function setFilter(key, val) {
  state.filter[key] = val;
  const active = document.querySelector('nav button.active');
  const v = active ? active.dataset.view : 'timeline';
  if (v === 'timeline') renderTimeline();
  else if (v === 'realagent') renderRealAgent();
}

function toggleAll(prefix, open) {
  document.querySelectorAll(`section.ev[data-prefix="${prefix}"]`).forEach((el) => el.classList.toggle('open', open));
}

/** 跳转到某条事件卡片（链图点击 / URL 锚点共用）。 */
function jumpTo(prefix, seq) {
  const el = document.getElementById(`${prefix}${seq}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('open');
    history.replaceState(null, '', `#${prefix}${seq}`);
  }
}

/** 页面加载 / hash 变化时应用锚点（#e5 = V1 seq5，#r3 = V2 seq3）。 */
function applyHash() {
  const m = location.hash.match(/^#([er])(\d+)$/);
  if (m) jumpTo(m[1], m[2]);
}
window.addEventListener('hashchange', applyHash);

// ─────────────────────────────────────────────
// 当场验证条：loadVerification（服务启动时快照，非实时）
// ─────────────────────────────────────────────

async function loadVerification() {
  try {
    const r = await fetch('/api/verification');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const v = await r.json();
    state.verification = v;
    state.orphanSeqs = new Set(v.replay.orphans.map((o) => o.seq));
    state.signalStates = new Map((v.replay.signals || []).map((s) => [s.seq, s]));
    const mark = (ok) => ok ? '<span class="v-ok">✓ PASS</span>' : '<span class="v-bad">✗ FAIL</span>';
    const d = v.disposition || { present: false, ok: false, rows: 0 };
    const dispMark = !d.present
      ? '<span class="v-time">未创建（全部信号按未处置）</span>'
      : `${mark(d.ok)} <span class="v-time">${d.rows} 条处置记录</span>`;
    verifybar.className = 'verifybar';
    verifybar.innerHTML =
      `<span class="v">落盘链 ${mark(v.chain.ok)} <span class="v-time">${v.chain.eventCount} 事件重算一致</span></span>` +
      `<span class="v">重放 ${mark(v.replay.ok)} <span class="v-time">${v.replay.matched}/${v.replay.total} MATCH</span></span>` +
      `<span class="v">处置台账 ${dispMark}</span>` +
      `<span class="v">V2 静态复核 ${mark(v.realagentVerify.ok)} <span class="v-time">${v.realagentVerify.eventCount} 事件</span></span>` +
      `<span class="v v-time">启动时快照 ${esc(v.verifiedAt)} · 独立复核：verify-chain / replay / verify-realagent</span>`;
    // 时间线可能先于验证返回而渲染（徽章依赖三重态）：到达后补一次渲染，避免首屏缺徽章。
    const active = document.querySelector('nav button.active');
    if (active && active.dataset.view === 'timeline' && state.events.length) renderTimeline();
  } catch (e) {
    verifybar.className = 'verifybar';
    verifybar.innerHTML = `<span class="v-bad">✗ 当场验证失败：${esc(e.message)}</span>`;
  }
}

// ─────────────────────────────────────────────
// 时间线：loadTimeline / renderTimeline
// ─────────────────────────────────────────────

async function loadTimeline() {
  view.innerHTML = '<div class="loading">加载时间线…</div>';
  try {
    const r = await fetch('/api/timeline');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    state.meta = j.meta; state.events = j.events;
    renderTimeline(); renderFoot();
  } catch (e) {
    view.innerHTML = `<div class="err">时间线加载失败：${esc(e.message)}。请先运行 export-events.mts 生成数据。</div>`;
  }
}

/**
 * 处置状态徽章（三态）。
 * route_to_human 归入「已转人工·未闭合」——转交不等于处置完成，避免被读成已闭合。
 */
function dispositionBadge(seq) {
  const s = state.signalStates.get(seq);
  if (!s) return '';
  if (s.state === 'closed') return `<span class="badge closed">已闭合 · disp ${esc(s.disp_seq)}</span>`;
  if (s.state === 'observing') return `<span class="badge observing">观察中 · disp ${esc(s.disp_seq)}</span>`;
  if (s.disp_seq) return '<span class="badge orphan">已转人工 · 未闭合</span>';
  return '<span class="badge orphan">孤儿信号 · 未处置</span>';
}

function renderTimeline() {
  const m = state.meta;
  const events = filteredEvents(state.events);
  const denyN = events.filter((e) => e.event_type === 'entry_deny' || e.event_type === 'exit_reject').length;
  const sigN = events.length - denyN;
  const chainOk = !!(state.verification && state.verification.chain.ok);
  const html = [];
  html.push(`<div class="warn"><b>本时间线只包含被拦下的行为。</b>审计链仅记录拒绝（deny / reject / signal），放行不留痕——"为什么放过了某次调用"当前不可审计（边界 B2）。</div>`);
  html.push(chainViz(events, 'e', chainOk));
  html.push(`<div class="filters">
    <select onchange="setFilter('rule',this.value)">${[...new Set(state.events.map((e) => e.rule_id))].sort().map((r) => `<option value="${esc(r)}" ${state.filter.rule === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
    <select onchange="setFilter('cat',this.value)">${[...new Set(state.events.map((e) => e.category))].sort().map((c) => `<option value="${esc(c)}" ${state.filter.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select onchange="setFilter('scen',this.value)">${[...new Set(state.events.map((e) => e.source_scenario))].sort().map((s) => `<option value="${esc(s)}" ${state.filter.scen === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
    <button class="mini" onclick="toggleAll('e',true)">展开全部</button>
    <button class="mini" onclick="toggleAll('e',false)">折叠全部</button>
    <span class="v-time">${events.length}/${state.events.length} 条 · session ${esc(m.session_id)} · 时间戳 ${esc(m.ts_mode)}（合成值）</span>
  </div>`);

  for (const e of events) {
    const cls = e.event_type === 'ledger_signal' ? 'signal' : 'deny';
    const badge = cls === 'signal' ? '<span class="badge signal">信号·未拦截</span>' : '<span class="badge deny">拦截</span>';
    const orphan = cls === 'signal' ? dispositionBadge(e.seq) : '';
    html.push(`
<section class="card ev ${cls}" id="e${e.seq}" data-prefix="e" data-seq="${e.seq}">
  <div class="ev-head" onclick="toggleEv(this.parentElement)">
    <span class="seq">#${String(e.seq).padStart(2, '0')}</span>
    ${badge}${orphan}
    <span class="rule">${esc(e.rule_id)} ${esc(e.rule_name)}</span>
    <span class="detail">${esc(e.detail)}</span>
  </div>
  <div class="ev-body">
    <dl class="kv">
      <dt>类别</dt><dd>${esc(e.category)}（事件类型 ${esc(e.event_type)} · 场景 ${esc(e.source_scenario)}）</dd>
      <dt>实测 / 阈值</dt><dd>${esc(fmtKV(e.measured))} / ${esc(fmtKV(e.threshold))}</dd>
      ${e.findings ? `<dt>配置审查命中</dt><dd>${e.findings.map((f) => esc(f.rule)).join('、')}</dd>` : ''}
      <dt>规则依据</dt><dd>${esc(e.spec_ref)}</dd>
      <dt>效能依据</dt><dd>${gradeBadge(e.efficiency_grade)} ${esc(e.efficiency_basis)}</dd>
      <dt>重放规格</dt><dd>${e.replay ? `已随链落盘（kind=${esc(e.replay.kind)}，expect=${esc(e.replay.expect)}）——重放执行：rules/replay.mts` : '—'}</dd>
      ${e.event_type === 'ledger_signal' ? `<dt>处置状态</dt><dd>${esc((state.signalStates.get(e.seq) || {}).note || '—')}<br><span class="v-time">台账：tools/disposition/data/disposition.jsonl（工具侧补口，非框架处置通道）</span></dd>` : ''}
      <dt>链位置</dt><dd>hash ${esc(String(e.chain_hash).slice(0, 16))}… ← prev ${esc(String(e.chain_prev).slice(0, 16))}… · 锚点 <a href="#e${e.seq}" onclick="event.preventDefault();jumpTo('e','${e.seq}')">#e${e.seq}</a></dd>
    </dl>
    <div class="tc"><b>TC260 框架 3.0 附件 2 映射（G 级——支撑义务，不支撑效能）</b><br>
      措施：${e.tc260_measures.map(esc).join('；')}<br>风险：${e.tc260_risks.map(esc).join('；')}</div>
  </div>
</section>`);
  }
  view.innerHTML = html.join('');
  applyHash();
}

/** 单卡片展开/折叠（同步 URL 锚点，不污染历史）。 */
function toggleEv(card) {
  card.classList.toggle('open');
  const prefix = card.dataset.prefix;
  const seq = card.dataset.seq;
  if (prefix && seq) {
    history.replaceState(null, '', card.classList.contains('open') ? `#${prefix}${seq}` : location.pathname);
  }
}

// ─────────────────────────────────────────────
// 证据卡：loadEvidence / renderEvidence
// ─────────────────────────────────────────────

async function loadEvidence() {
  view.innerHTML = '<div class="loading">加载证据卡…</div>';
  try {
    const r = await fetch('/api/evidence');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.evidence = await r.json();
    renderEvidence();
  } catch (e) {
    view.innerHTML = `<div class="err">证据卡加载失败：${esc(e.message)}</div>`;
  }
}

function renderEvidence() {
  const { cards, chain } = state.evidence;
  const html = [];
  html.push(`<div class="warn"><b>分级是三层，不是一层：</b>事件级（可复现性）· 规则级（效能 A/B/C/D/G）· 条款级（G 类官方条款，<b>只支撑义务、不支撑效能</b>）。把"条款是 G 级"当成"机制有效"是用错方法论。</div>`);
  html.push('<div class="cards">');
  for (const c of cards) {
    html.push(`
<div class="ecard">
  <h3>${esc(c.rule_id)} · ${esc(c.rule_name)}</h3>
  <div class="meta">事件 ${c.event_count} 条${c.categories.length ? ' · ' + c.categories.map(esc).join(' / ') : ' · 结构属性（非事件）'}</div>
  <div>${gradeBadge(c.efficiency_grade)}</div>
  <div class="basis">${esc(c.efficiency_basis)}</div>
  <div class="tc260"><b>附件 2 措施：</b>${c.tc260_measures.map(esc).join('；')}<br><b>附件 2 风险：</b>${c.tc260_risks.map(esc).join('；')}</div>
  <div class="meta" style="margin-top:8px">事件可复现性：${esc(c.event_reproducibility)}</div>
</div>`);
  }
  html.push('</div>');
  html.push(`<h2 class="sec">审计链状态（meta.chain，由导出器实测写入）</h2>
<table><tr><th>项</th><th>值</th></tr>
<tr><td>算法</td><td class="mono">${esc(chain.algorithm)}</td></tr>
<tr><td>运行期框架链</td><td>${chain.framework_verified_at_run ? '<span class="badge gA">verifyChain PASS</span>' : '<span class="badge deny">FAIL</span>'}（真实 ts，仅本次运行内有效）</td></tr>
<tr><td>落盘链</td><td>确定性重建，可跨运行比对、可第三方按 recipe 重算</td></tr>
<tr><td>边界</td><td>${esc(chain.note)}</td></tr></table>`);
  view.innerHTML = html.join('');
}

// ─────────────────────────────────────────────
// 诚实边界：loadBoundaries / renderBoundaries
// ─────────────────────────────────────────────

async function loadBoundaries() {
  view.innerHTML = '<div class="loading">加载诚实边界…</div>';
  try {
    const r = await fetch('/api/boundaries');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.boundaries = await r.json();
    renderBoundaries();
  } catch (e) {
    view.innerHTML = `<div class="err">诚实边界加载失败：${esc(e.message)}</div>`;
  }
}

function renderBoundaries() {
  const { boundaries, coverage, scenarios } = state.boundaries;
  const html = [];
  html.push('<h2 class="sec">边界声明（导出器写入 meta，页面原样展示）</h2>');
  for (const b of boundaries) {
    html.push(`<div class="card bc"><h3>${esc(b.id)} · ${esc(b.title)}</h3><p>${esc(b.detail)}</p><div class="ref">${esc(b.ref)}</div></div>`);
  }
  html.push('<h2 class="sec">覆盖矩阵（按代码实读，不按类型定义推断）</h2>');
  html.push(`<div style="font-size:12.5px;color:var(--ink-3);margin-bottom:8px">${esc(coverage.note)}</div>`);
  html.push('<table><tr><th>规则</th><th>类型声明</th><th>代码实现</th><th>本导出覆盖</th></tr>');
  for (const key of ['r1_entry_deny', 'r2_exit_reject', 'r3_ledger_signal', 'r5_audit_chain']) {
    const c = coverage[key];
    if (!c) continue;
    html.push(`<tr><td><b>${esc(key.split('_')[0].toUpperCase())}</b></td><td class="mono">${esc(c.declared.join(' '))}</td><td class="mono">${esc(c.implemented.join(' '))}</td><td class="mono">${esc(c.covered_by_export.join(' '))}</td></tr>`);
    html.push(`<tr><td colspan="4"><div class="gap" style="margin:0"><b>缺口：</b>${esc(c.gap)}</div></td></tr>`);
  }
  html.push('</table>');
  html.push('<h2 class="sec">场景明细（每条事件的真实来源）</h2>');
  html.push('<table><tr><th>场景</th><th>构造</th><th>事件</th><th>类别</th></tr>');
  for (const s of scenarios) {
    html.push(`<tr><td><b>${esc(s.id)}</b></td><td>${esc(s.title)}</td><td>${esc(s.events)}</td><td class="mono">${esc((s.categories || []).join(', ') || '—')}</td></tr>`);
  }
  html.push('</table>');
  html.push(`<div class="warn" style="margin-top:14px"><b>重放校验不在页面内执行</b>（本服务保持只读）。请运行：<span style="font-family:var(--mono)">node --experimental-transform-types tools/audit-panel/rules/replay.mts</span> —— 独立重执行每条判定并比对日志，当前基线 9/9 MATCH。</div>`);
  view.innerHTML = html.join('');
}

// ─────────────────────────────────────────────
// 页脚三件套（全部读 meta，不手写）
// ─────────────────────────────────────────────

function renderFoot() {
  const m = state.meta;
  foot.textContent = `framework v${m.framework.version} · ${m.event_count} events · schema ${m.schema_version} · gates ${m.gates_count ?? '?'} (scripted) · ts ${m.ts_mode} · data by export-events.mts`;
}

// ─────────────────────────────────────────────
// real-agent 会话：loadRealAgent / renderRealAgent
// ─────────────────────────────────────────────

async function loadRealAgent() {
  view.innerHTML = '<div class="loading">加载 real-agent 会话…</div>';
  try {
    const r = await fetch('/api/realagent');
    if (r.status === 404) {
      const j = await r.json();
      view.innerHTML = `<div class="err">V2 数据尚未生成：${esc(j.error)}</div>`;
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    state.realagent = j;
    renderRealAgent();
  } catch (e) {
    view.innerHTML = `<div class="err">real-agent 加载失败：${esc(e.message)}</div>`;
  }
}

function renderRealAgent() {
  const { meta, events: allEvents } = state.realagent;
  const events = filteredEvents(allEvents);
  const chainOk = !!(state.verification && state.verification.realagentVerify.ok);
  const html = [];
  html.push(`<div class="warn"><b>本视图的数据来自真实 LLM Agent（${esc(meta.llm.model)}）的行为，每次运行都不同——时间戳为真实时钟，事件不可重放。</b>这是自测性质的行为记录，不构成任何效能断言；它证明的是「三件套在真实 LLM 行为流上正常运行并留痕」。</div>`);
  html.push(`<div style="color:var(--ink-3);font-size:12.5px;margin-bottom:10px;font-family:var(--mono)">${meta.runs.map((r) => `${esc(r.scenario)}: ${r.turns}轮 / ${r.totalTokens}tok / deny ${r.denies} · reject ${r.rejects} · signal ${r.signals} → ${esc(r.finalOutcome)}`).join('　|　')}　|　合计 ${meta.event_count} 事件 · ${meta.total_tokens} tokens</div>`);
  html.push(chainViz(events, 'r', chainOk));
  html.push(`<div class="filters">
    <select onchange="setFilter('rule',this.value)">${[...new Set(allEvents.map((e) => e.rule_id))].sort().map((r) => `<option value="${esc(r)}" ${state.filter.rule === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
    <select onchange="setFilter('cat',this.value)">${[...new Set(allEvents.map((e) => e.category))].sort().map((c) => `<option value="${esc(c)}" ${state.filter.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select onchange="setFilter('scen',this.value)">${[...new Set(allEvents.map((e) => e.session_id))].sort().map((s) => `<option value="${esc(s)}" ${state.filter.scen === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
    <button class="mini" onclick="toggleAll('r',true)">展开全部</button>
    <button class="mini" onclick="toggleAll('r',false)">折叠全部</button>
    <span class="v-time">${events.length}/${allEvents.length} 条</span>
  </div>`);

  let lastSession = '';
  for (const e of events) {
    const cls = e.event_type === 'ledger_signal' ? 'signal' : 'deny';
    if (e.session_id !== lastSession) {
      lastSession = e.session_id;
      html.push(`<h2 class="sec" style="font-family:var(--mono);color:var(--ink-2)">${esc(e.session_id)}</h2>`);
    }
    const badge = cls === 'signal' ? '<span class="badge signal">信号·未拦截</span>' : '<span class="badge deny">拦截</span>';
    html.push(`
<section class="card ev ${cls}" id="r${e.seq}" data-prefix="r" data-seq="${e.seq}">
  <div class="ev-head" onclick="toggleEv(this.parentElement)">
    <span class="seq">#${String(e.seq).padStart(2, '0')}</span>
    ${badge}
    <span class="rule">${esc(e.rule_id)} ${esc(e.rule_name)}</span>
    <span class="detail">${esc(e.detail)}</span>
  </div>
  <div class="ev-body">
    <dl class="kv">
      <dt>类别</dt><dd>${esc(e.category)}（${esc(e.event_type)}）</dd>
      <dt>实测 / 阈值</dt><dd>${esc(fmtKV(e.measured))} / ${esc(fmtKV(e.threshold))}</dd>
      <dt>规则依据</dt><dd>${esc(e.spec_ref)}</dd>
      <dt>效能依据</dt><dd>${gradeBadge(e.efficiency_grade)} ${esc(e.efficiency_basis)}</dd>
      <dt>可复现性</dt><dd><b>${esc(e.event_reproducibility)}</b>（LLM 输入不可重放；ts 为真实时钟）</dd>
      <dt>运行</dt><dd>provider=${esc(e.run.provider)} · model=${esc(e.run.model)}</dd>
      <dt>锚点</dt><dd><a href="#r${e.seq}" onclick="event.preventDefault();jumpTo('r','${e.seq}')">#r${e.seq}</a></dd>
    </dl>
    <div class="tc"><b>TC260 框架 3.0 附件 2 映射（G 级——支撑义务，不支撑效能）</b><br>
      措施：${e.tc260_measures.map(esc).join('；')}<br>风险：${e.tc260_risks.map(esc).join('；')}</div>
  </div>
</section>`);
  }
  view.innerHTML = html.join('');
}

// ─────────────────────────────────────────────
// 处置台账：loadDisposition / renderDisposition
// 数据源 /api/disposition（只读消费 tools/disposition/ 产物）
// ─────────────────────────────────────────────

async function loadDisposition() {
  view.innerHTML = '<div class="loading">加载处置台账…</div>';
  try {
    const r = await fetch('/api/disposition');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.disposition = await r.json();
    renderDisposition();
  } catch (e) {
    view.innerHTML = `<div class="err">处置台账加载失败：${esc(e.message)}</div>`;
  }
}

const ACTION_LABEL = {
  confirm_false_positive: '判为误报（关闭信号）',
  escalate: '升级（改变处置等级）',
  route_to_human: '转人工（未闭合）',
  park_for_observation: '挂起观察',
};

function fmtLatency(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 0) return `${Math.round(ms / 60000)} 分钟（时钟倒挂）`;
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderDisposition() {
  const d = state.disposition;
  const chainTxt = !d.present
    ? '台账未创建'
    : d.chainOk
      ? `链 PASS（${d.rows} 条，其中被更正 ${d.superseded} 条）`
      : '链 FAIL（内容不可采信，全部信号按未处置处理）';
  const isDemo = (d.entries || []).some((e) => String(e.actor).startsWith('demo-'));
  const html = [];

  html.push(`<div class="warn"><b>处置记录存在 ≠ 处置有效；本页时延为自报值，不可验证。</b><br>${esc(d.boundary)}</div>`);
  if (isDemo) {
    html.push(`<div class="gap"><b>当前台账含演示数据：</b>actor 以 <code>demo-</code> 开头、rationale 以「演示数据」开头的记录，用于演示孤儿清单如何收敛，<b>不是真实运维处置</b>。</div>`);
  }
  if (d.warning) html.push(`<div class="err">${esc(d.warning)}</div>`);

  html.push(`<div class="metrics">
    <div class="metric"><span class="n">${d.counts.total}</span><span class="l">账本信号</span></div>
    <div class="metric bad"><span class="n">${d.counts.unhandled}</span><span class="l">未处置（孤儿）</span></div>
    <div class="metric warnm"><span class="n">${d.counts.observing}</span><span class="l">观察中</span></div>
    <div class="metric ok"><span class="n">${d.counts.closed}</span><span class="l">已闭合</span></div>
    <div class="metric"><span class="n">${d.mismatched}</span><span class="l">错位引用</span></div>
  </div>`);

  // 10-D5 二阶信号：处置通道自身的完整性（度量监察行为，不度量被监察行为）
  const c = d.completeness || null;
  if (c) {
    const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
    const prov = c.provisional
      ? `<div class="gap">存在 ${c.n_signals_undeclared} 条<b>类别未登记</b>的信号，未计入分母——下列两个比例只覆盖 ${c.n_signals_declared} 条可判定信号，<b>不代表全部</b>。先补义务注册表，再读比例。</div>`
      : '';
    html.push(`<h2 class="sec">处置完整性（二阶信号 · spec/10 10-D5）</h2>
      <div class="metrics">
        <div class="metric"><span class="n">${pct(c.undisposed_rate)}</span><span class="l">undisposed_rate（${c.n_undisposed}/${c.n_signals_declared}）</span></div>
        <div class="metric ${c.n_overdue > 0 ? 'bad' : 'ok'}"><span class="n">${pct(c.overdue_rate)}</span><span class="l">overdue_rate（${c.n_overdue}/${c.n_signals_declared}）</span></div>
        <div class="metric"><span class="n">${c.n_undisposed}</span><span class="l">未处置信号</span></div>
        <div class="metric ${c.clock_skew > 0 ? 'warnm' : ''}"><span class="n">${c.clock_skew}</span><span class="l">时钟倒挂（已剔除）</span></div>
      </div>
      ${prov}
      <table><tr><th>项</th><th>值</th></tr>
      <tr><td>基准时刻</td><td class="mono">${esc(c.now_iso)}<br><span class="v-time">${esc(c.now_source)}</span></td></tr>
      <tr><td>分母口径</td><td>${esc(c.basis)}</td></tr>
      <tr><td>信号全集来源</td><td>面板事件流的 <code>ledger_signal</code> 事件（当前为演示数据）；生产接入后应为真实信号流。<b>不得用台账当分母</b>——台账只含被处置过的 seq。</td></tr>
      <tr><td>使用限制</td><td>${esc(c.note)}</td></tr></table>`);
  }

  // 10-D4 信号级视图：每类信号的级别、时限与超期判定
  if (d.signals && d.signals.length > 0) {
    const o = d.obligations || {};
    html.push(`<h2 class="sec">信号级处置状态<span class="v-time">（spec/10 10-D4；时限为工程占位，未标定）</span></h2>
      <table><tr><th>seq</th><th>信号类别</th><th>级别 / 时限</th><th>责任角色</th><th>已过时长</th><th>状态</th><th>超期</th></tr>` +
      d.signals.map((s) => `<tr>
        <td class="mono">${s.seq}</td>
        <td class="mono">${esc(s.category)}</td>
        <td>${esc(s.priority)} / ${s.sla_hours === null ? '—' : `${s.sla_hours}h`}</td>
        <td>${esc(s.owner_role)}</td>
        <td class="mono">${s.clock_skew ? '倒挂' : `${s.elapsed_hours.toFixed(1)}h`}</td>
        <td>${esc(s.state)}</td>
        <td class="${s.overdue ? 'v-bad' : 'v-time'}">${s.overdue ? '已超期' : '—'}</td>
      </tr>`).join('') + '</table>' +
      `<p class="v-time">义务注册表 <code>${esc(o.file || '')}</code> · 标定状态 <b>${esc(o.calibration_status || '')}</b>（承接 ${esc(o.calibration_owner || '')}）${o.error ? ` · <b>加载错误：${esc(o.error)}</b>` : ''}</p>`);
  }

  html.push(`<h2 class="sec">动作分布<span class="v-time">（生效处置记录，按动作计）</span></h2>`);
  const actions = Object.entries(d.actions || {});
  html.push(actions.length === 0
    ? '<p class="v-time">暂无处置记录。</p>'
    : `<table><tr><th>动作</th><th>含义</th><th>条数</th></tr>${actions.map(([a, n]) => `<tr><td class="mono">${esc(a)}</td><td>${esc(ACTION_LABEL[a] || '—')}</td><td>${n}</td></tr>`).join('')}</table>`);

  html.push(`<h2 class="sec">自报处置时延</h2>
    <table><tr><th>分位</th><th>值</th><th>样本</th><th>口径</th></tr>
    <tr><td>P50</td><td class="mono">${fmtLatency(d.latency.p50)}</td><td rowspan="2">${d.latency.n} 条生效处置</td><td rowspan="2">${esc(d.latency.note)}${d.latency.negative ? `；另有 ${d.latency.negative} 条时钟倒挂已剔除` : ''}</td></tr>
    <tr><td>P90</td><td class="mono">${fmtLatency(d.latency.p90)}</td></tr></table>`);

  html.push(`<h2 class="sec">台账记录<span class="v-time">（append-only；被更正的记录保留但不计入当前状态）</span></h2>`);
  if (!d.entries || d.entries.length === 0) {
    html.push(`<p class="v-time">台账为空：${esc(chainTxt)}。</p>`);
  } else {
    html.push(`<table><tr><th>disp</th><th>目标信号</th><th>动作</th><th>处置者 / 复核</th><th>状态</th><th>自报时延</th><th>依据</th></tr>`);
    for (const e of d.entries) {
      const stateCls = e.state === 'closed' ? 'ok' : e.state === 'superseded' ? 'v-time' : 'bad';
      html.push(`<tr>
        <td class="mono">${e.disp_seq}${e.supersedes ? `<br><span class="v-time">更正 disp ${e.supersedes}</span>` : ''}</td>
        <td class="mono">seq ${e.target_seq}<br><span class="v-time">${esc(e.signal_category)}</span></td>
        <td>${esc(ACTION_LABEL[e.action] || e.action)}${e.plan ? `<br><span class="v-time">预案：${esc(e.plan)}</span>` : ''}</td>
        <td>${esc(e.actor)}<br><span class="v-time">复核 ${esc(e.reviewed_by || '—')}</span></td>
        <td class="${stateCls}">${esc(e.state === 'superseded' ? '已被更正' : e.state)}<br><span class="v-time">${esc(e.stateNote)}</span></td>
        <td class="mono">${fmtLatency(e.latency_ms)}</td>
        <td>${esc(e.rationale)}<br><span class="v-time">hash ${esc(String(e.chain_hash).slice(0, 16))}…</span></td>
      </tr>`);
    }
    html.push('</table>');
  }

  html.push(`<h2 class="sec">台账链校验</h2>
    <table><tr><th>文件</th><th>结果</th><th>说明</th></tr>
    <tr><td class="mono">${esc(d.file)}</td><td class="${d.chainOk ? 'v-ok' : 'v-bad'}">${esc(chainTxt)}</td>
    <td>链规则 <code>sha256(prev + "|" + JSON.stringify(body))</code>，键序冻结；<b>Python 参照实现</b>可独立复算：<code>python tools/disposition/verify_chain.py</code>。只能证明「文件未被事后改写」，不能证明处置者身份或时效。</td></tr></table>`);

  view.innerHTML = html.join('');
}

// ─────────────────────────────────────────────
// Tab 路由
// ─────────────────────────────────────────────

const routes = { timeline: loadTimeline, realagent: loadRealAgent, disposition: loadDisposition, evidence: loadEvidence, boundaries: loadBoundaries };

document.querySelectorAll('nav button[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button[data-view]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    routes[btn.dataset.view]();
  });
});

document.getElementById('btn-export').addEventListener('click', () => {
  window.location.href = '/api/export';
});

loadVerification();
loadTimeline();
