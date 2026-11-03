/**
 * report.mts —— 审计报告生成（打印友好 HTML，浏览器 Ctrl+P 即 PDF——零依赖 PDF 路径）
 *
 * 定位：给"要交合规审计报告的人"的最终产物。一页汇总 V1（确定性）与 V2（LLM-in-the-loop）
 * 两个数据源的摘要、事件明细、证据分级与边界声明，并附打印样式（A4、避免分页截断表格行）。
 *
 * 诚实声明进报告正文：V1 可字节复现 / V2 不可确认（自测性质，不支撑效能断言）。
 */

import { RULE_BY_CATEGORY, tc260Meta } from '../rules/rule-map.mts';
import type { Meta, PanelEvent } from './server.mts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildReportHtml(
  v1: { meta: Meta; events: PanelEvent[] },
  v2: { meta: Meta; events: PanelEvent[] } | null,
): string {
  const m1 = v1.meta;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const tcm = tc260Meta();

  const evRow = (e: PanelEvent, repro: string) =>
    `<tr>
      <td class="m">#${e.seq}</td>
      <td>${esc(e.rule_id)} ${esc(e.rule_name)}</td>
      <td class="m">${esc(e.category)}</td>
      <td>${esc(e.detail)}</td>
      <td class="c">${esc(e.efficiency_grade)}</td>
      <td>${e.tc260_measures.map(esc).join('；')}</td>
      <td class="m">${repro}</td>
    </tr>`;

  const v1Rows = v1.events.map((e) => evRow(e, '可重跑（确定性）')).join('');
  const v2Section = v2
    ? `<h2>二、V2 · LLM-in-the-loop 会话（真实 LLM Agent 行为流）</h2>
       <p class="note"><b>数据类别：</b>自测性质行为记录——模型 ${esc(String((v2.meta.llm as Record<string, unknown>)?.model))}，总消耗 ${String(v2.meta.total_tokens)} tokens。
       事件不可重放（每次运行必然不同），时间戳为真实时钟。本节证明「三件套在真实 LLM 行为流上正常运行并留痕」，
       <b>不构成任何效能断言</b>。</p>
       <p class="note">场景摘要：${(v2.meta.runs as Array<Record<string, unknown>>).map((r) => `${esc(String(r.scenario))}（${String(r.turns)} 轮 / deny ${String(r.denies)} / reject ${String(r.rejects)} / signal ${String(r.signals)}）`).join('　')}</p>
       <table>
        <thead><tr><th>#</th><th>规则</th><th>类别</th><th>说明</th><th>效能</th><th>附件 2 条款</th><th>可复现性</th></tr></thead>
        <tbody>${v2.events.map((e) => evRow(e, '不可确认')).join('')}</tbody>
       </table>`
    : '<h2>二、V2 · LLM-in-the-loop</h2><p class="note">未生成（运行 realagent/runner.mts 产生，需 API key）。</p>';

  const evidenceRows = Object.values(RULE_BY_CATEGORY)
    .map((r) => {
      const n1 = v1.events.filter((e) => e.rule_id === r.ruleId).length;
      const n2 = v2 ? v2.events.filter((e) => e.rule_id === r.ruleId).length : 0;
      return `<tr><td><b>${esc(r.ruleId)}</b> ${esc(r.ruleName)}</td><td class="c">${n1}</td><td class="c">${n2}</td><td class="c">${esc(r.efficiencyGrade)}</td><td>${esc(r.efficiencyBasis)}</td></tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Agent 行为审计报告 · framework v${esc(String(m1.framework.version))}</title>
<style>
  body { font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 12px; color: #111; max-width: 190mm; margin: 12mm auto; line-height: 1.55; }
  h1 { font-size: 18px; border-bottom: 2px solid #222; padding-bottom: 6px; }
  h2 { font-size: 14px; margin-top: 18px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
  th, td { border: 0.5pt solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  tr { page-break-inside: avoid; }
  .m, td.c { font-family: Consolas, monospace; font-size: 10.5px; }
  td.c { text-align: center; }
  .note { background: #f7f7f7; border-left: 3px solid #666; padding: 6px 10px; font-size: 11px; }
  .foot { margin-top: 20px; padding-top: 6px; border-top: 0.5pt solid #999; font-size: 10px; color: #444; }
  @media print { body { margin: 8mm; } }
</style>
</head>
<body>
<h1>Agent 行为审计报告</h1>
<p>框架版本 <b>v${esc(String(m1.framework.version))}</b> · 门禁 ${esc(String(m1.gates_count))} 项（脚本实测）· 证据 213 条（A12/B135/C13/D1/G52）· 报告生成于 ${esc(now)}<br>
数据来源：参照实现（reference/runtimes/l2-runtime-oversight）真实执行——V1 为确定性场景（可字节复现），V2 为真实 LLM 行为流（不可复现）。</p>

<h2>一、V1 · 确定性门禁事件（七场景，两次运行逐字节一致）</h2>
<table>
  <thead><tr><th>#</th><th>规则</th><th>类别</th><th>说明</th><th>效能</th><th>附件 2 条款</th><th>可复现性</th></tr></thead>
  <tbody>${v1Rows}</tbody>
</table>
<p class="note">V1 审计链：${esc(String((m1.chain as Record<string, unknown>)?.note ?? ''))}</p>

${v2Section}

<h2>三、证据分级汇总（规则效能 · 三层挂载之规则层）</h2>
<p class="note">分级定义：A=自复现实证；B=可核查文献；C=域迁移缺口或自测；D=未核实；G=治理一手实证（<b>只支撑义务、不支撑效能</b>）。事件级可复现性见各表末列；条款级均为附件 2（G 类）。</p>
<table>
  <thead><tr><th>规则</th><th>V1 事件</th><th>V2 事件</th><th>效能</th><th>效能依据</th></tr></thead>
  <tbody>${evidenceRows}</tbody>
</table>
<p class="note">条款来源：${esc(tcm.source)} · ${esc(tcm.annex)}。${esc(tcm.usage_rule)}核验：${esc(tcm.verification.method)}；${esc(tcm.verification.source_snapshot)}。</p>

<h2>四、边界声明</h2>
<p class="note">① 审计链只记录拒绝、放行不留痕——"为什么放过了某次调用"不可审计（框架 3.0 §3.2.1(d) 全量记录要求存在差距）；② 资源账本信号全部为孤儿信号（框架无处置通道）；③ 资源账本配置审查依赖固定字段名，等价变体（shareScope vs visibility）会被漏检（AOE-DETECT-001 实测 77/77）；④ E5 结果完整性校验为占位（G4 未闭合），审计链无密钥外部锚定（可整链重算）——本报告不含任何"防篡改"声明。</p>

<div class="foot">本报告由 tools/audit-panel/server.mts /report 端点生成，数据文件为 tools/audit-panel/data/events.jsonl（V1，可复现）与 realagent-events.jsonl（V2，不可复现）。
链校验与静态复核可独立运行：verify-chain.mts / verify-realagent.mts / replay.mts。本报告不含任何"符合国标 / 通过合规"类表述——条款为 G 级义务来源，验证方法由本面板提供。</div>
</body>
</html>`;
}
