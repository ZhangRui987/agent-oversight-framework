/* 审计面板前端 · 原生 JS · loadXxx/renderXxx 配对模式（沿用 Zhuanye_app admin dashboard 惯例）
 * 数据源：/api/timeline /api/evidence /api/boundaries（全部只读；重放校验属 CLI，见诚实边界） */
'use strict';

const view = document.getElementById('view');
const foot = document.getElementById('foot');
const state = { meta: null, events: [], evidence: null, boundaries: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gradeBadge = (g) => `<span class="badge g${esc(g)}">效能 ${esc(g)} 级</span>`;
const fmtKV = (obj) => !obj ? '—' : Object.entries(obj).map(([k, v]) => `${esc(k)}=${esc(v)}`).join('；');

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

function renderTimeline() {
  const m = state.meta;
  const denyN = state.events.filter((e) => e.event_type === 'entry_deny' || e.event_type === 'exit_reject').length;
  const sigN = state.events.length - denyN;
  const html = [];
  html.push(`<div class="warn"><b>本时间线只包含被拦下的行为。</b>审计链仅记录拒绝（deny / reject / signal），放行不留痕——"为什么放过了某次调用"当前不可审计（边界 B2）。</div>`);
  html.push(`<div style="color:var(--ink-3);font-size:12.5px;margin-bottom:10px;font-family:var(--mono)">session ${esc(m.session_id)} · ${denyN} 拦截 + ${sigN} 信号 = ${state.events.length} 条 · 时间戳 ${esc(m.ts_mode)}（合成值）· 点击行展开依据</div>`);
  for (const e of state.events) {
    const cls = e.event_type === 'ledger_signal' ? 'signal' : 'deny';
    const badge = cls === 'signal' ? '<span class="badge signal">信号·未拦截</span>' : '<span class="badge deny">拦截</span>';
    html.push(`
<section class="card ev ${cls}" data-seq="${e.seq}">
  <div class="ev-head" onclick="this.parentElement.classList.toggle('open')">
    <span class="seq">#${String(e.seq).padStart(2, '0')}</span>
    ${badge}
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
      <dt>链位置</dt><dd>hash ${esc(String(e.chain_hash).slice(0, 16))}… ← prev ${esc(String(e.chain_prev).slice(0, 16))}…</dd>
    </dl>
    <div class="tc"><b>TC260 框架 3.0 附件 2 映射（G 级——支撑义务，不支撑效能）</b><br>
      措施：${e.tc260_measures.map(esc).join('；')}<br>风险：${e.tc260_risks.map(esc).join('；')}</div>
  </div>
</section>`);
  }
  view.innerHTML = html.join('');
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
// Tab 路由
// ─────────────────────────────────────────────

const routes = { timeline: loadTimeline, evidence: loadEvidence, boundaries: loadBoundaries };

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

loadTimeline();
