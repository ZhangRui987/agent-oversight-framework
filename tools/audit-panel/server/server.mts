#!/usr/bin/env node
/**
 * server.mts —— 审计面板服务端（node:http 单文件，零依赖，四个只读端点）
 *
 * 端点：
 *   GET /                → 三视图单页（web/index.html + web/app.js）
 *   GET /api/timeline    → meta + 全部事件（时间线数据源）
 *   GET /api/evidence    → 按规则聚合的证据卡（三层分级：事件可复现性 / 规则效能 / 条款）
 *   GET /api/boundaries  → 诚实边界（meta.boundaries + 覆盖矩阵 + 链状态）
 *   GET /api/export      → CSV 下载（列名与数据契约一致，带 UTF-8 BOM——Excel 中文不乱码）
 *
 * 设计纪律：
 *   - 零依赖：仅 node: 内置模块。数据从 data/events.jsonl 只读加载，启动后驻内存。
 *   - 只读服务：不写任何文件、不执行重放（重放属 CLI 工具 rules/replay.mts；
 *     面板如实标注"重放校验请运行命令行"，不伪造"已在页面上验证过"的状态）。
 *   - 数据不新鲜即明示：响应头 X-Data-Generated-At-Mode 携带 meta 的 ts 模式；
 *     页脚显示 meta.framework.version（由导出器从 VERSION 实测，非手写）。
 *
 * 用法：
 *   node --experimental-transform-types tools/audit-panel/server/server.mts
 *   node --experimental-transform-types tools/audit-panel/server/server.mts --port=8080
 *
 * 然后浏览器打开 http://127.0.0.1:7727
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_ROOT = resolve(HERE, '..');
const DATA_FILE = join(PANEL_ROOT, 'data', 'events.jsonl');
const WEB_ROOT = join(PANEL_ROOT, 'web');
const DEFAULT_PORT = 7727;

// ─────────────────────────────────────────────────────────────────────────────
// 数据加载（只读一次，驻内存）
// ─────────────────────────────────────────────────────────────────────────────

interface Meta {
  record_type: string;
  schema_version: string;
  framework: { version: string; entry: string };
  gates_count: number | null;
  session_id: string;
  agent_id: string;
  event_count: number;
  chain: Record<string, unknown>;
  scenarios: Array<Record<string, unknown>>;
  coverage: Record<string, unknown>;
  boundaries: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

interface PanelEvent {
  record_type: string;
  seq: number;
  event_type: string;
  category: string;
  rule_id: string;
  rule_name: string;
  source_scenario: string;
  detail: string;
  measured: Record<string, number> | null;
  threshold: Record<string, number> | null;
  findings?: unknown[];
  spec_ref: string;
  tc260_measures: string[];
  tc260_risks: string[];
  efficiency_grade: string;
  efficiency_basis: string;
  replay?: Record<string, unknown>;
  chain_hash: string;
  chain_prev: string;
  [k: string]: unknown;
}

function loadData(): { meta: Meta; events: PanelEvent[] } {
  const raw = readFileSync(DATA_FILE, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const meta = JSON.parse(lines[0]!) as Meta;
  const events = lines.slice(1).map((l) => JSON.parse(l) as PanelEvent);
  if (meta.record_type !== 'meta') throw new Error('events.jsonl 首行不是 meta 记录');
  if (meta.event_count !== events.length) {
    throw new Error(`meta.event_count(${meta.event_count}) 与实际事件数(${events.length}) 不一致——请先重跑导出器`);
  }
  return { meta, events };
}

let data: { meta: Meta; events: PanelEvent[] };
try {
  data = loadData();
} catch (err) {
  console.error('✗ 数据加载失败：', err instanceof Error ? err.message : err);
  console.error('  请先运行：node --experimental-transform-types tools/audit-panel/scenario/export-events.mts');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 证据卡聚合（三层分级）
// ─────────────────────────────────────────────────────────────────────────────

interface EvidenceCard {
  rule_id: string;
  rule_name: string;
  event_count: number;
  categories: string[];
  spec_ref: string;
  tc260_measures: string[];
  tc260_risks: string[];
  efficiency_grade: string;
  efficiency_basis: string;
  /** 事件级可复现性：本面板全部事件由确定性场景导出，可重跑（export-events.mts）。 */
  event_reproducibility: string;
  /** 条款级：G 类官方条款，只支撑义务、不支撑效能。 */
  clause_grade: 'G';
}

function buildEvidence(): EvidenceCard[] {
  const byRule = new Map<string, EvidenceCard>();
  for (const e of data.events) {
    let card = byRule.get(e.rule_id);
    if (!card) {
      card = {
        rule_id: e.rule_id,
        rule_name: e.rule_name,
        event_count: 0,
        categories: [],
        spec_ref: e.spec_ref,
        tc260_measures: e.tc260_measures,
        tc260_risks: e.tc260_risks,
        efficiency_grade: e.efficiency_grade,
        efficiency_basis: e.efficiency_basis,
        event_reproducibility: '可重跑（export-events.mts 确定性场景，两次运行逐字节一致）',
        clause_grade: 'G',
      };
      byRule.set(e.rule_id, card);
    }
    card.event_count += 1;
    if (!card.categories.includes(e.category)) card.categories.push(e.category);
  }

  // R5 审计链没有事件形态——从 meta.chain 补一张卡（如实标注来源）。
  byRule.set('R5', {
    rule_id: 'R5',
    rule_name: '审计链完整性（AppendOnlyAuditLog）',
    event_count: 0,
    categories: [],
    spec_ref: 'spec/02-architecture E3/E5；PRODUCTION-GAPS G2/G4',
    tc260_measures: ['二、6(3) 日志管理（防篡改）', '二、6(4) 安全审计', '二、3(3) 留存人工审批日志（防篡改、可校验）'],
    tc260_risks: ['一、9(2) 日志缺失'],
    efficiency_grade: 'C',
    efficiency_basis:
      'SHA-256 哈希链已实现（G2 演示级闭合，等长篡改必检出）；未闭合：无密钥与外部锚定，进程被攻陷时整链可重算（G4/E5）。' +
      '不得表述为"防篡改"。本卡无事件计数——链是结构属性，不是事件。',
    event_reproducibility: 'verify-chain.mts 可重跑（落盘链逐条重算）',
    clause_grade: 'G',
  });

  return [...byRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV 导出（列名与数据契约一致；UTF-8 BOM 保证 Excel 中文不乱码）
// ─────────────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'seq', 'ts', 'ts_mode', 'session_id', 'agent_id', 'event_type', 'category',
  'rule_id', 'rule_name', 'source_scenario', 'detail', 'measured', 'threshold',
  'findings', 'chain_hash', 'chain_prev', 'spec_ref', 'tc260_measures', 'tc260_risks',
  'efficiency_grade', 'efficiency_basis', 'replay_kind',
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const e of data.events) {
    rows.push([
      e.seq, e.ts, e.ts_mode, e.session_id, e.agent_id, e.event_type, e.category,
      e.rule_id, e.rule_name, e.source_scenario, e.detail, e.measured, e.threshold,
      e.findings ?? null, e.chain_hash, e.chain_prev, e.spec_ref, e.tc260_measures,
      e.tc260_risks, e.efficiency_grade, e.efficiency_basis,
      e.replay ? (e.replay as Record<string, unknown>).kind : null,
    ].map(csvEscape).join(','));
  }
  // BOM：Excel 识别 UTF-8 的前提，缺失即乱码。
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 服务
// ─────────────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function sendJson(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body, null, 1), 'utf-8');
  res.writeHead(code, {
    'Content-Type': MIME['.json'],
    'Content-Length': buf.length,
    'X-Data-Framework-Version': `v${data.meta.framework.version}`,
    'X-Data-Ts-Mode': String(data.meta.ts_mode ?? 'synthetic-fixed'),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

function sendFile(res: import('node:http').ServerResponse, path: string): void {
  if (!existsSync(path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const buf = readFileSync(path);
  const ext = path.slice(path.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': buf.length });
  res.end(buf);
}

const evidenceCache = buildEvidence();
const csvCache = buildCsv();

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]!;

  switch (url) {
    case '/':
    case '/index.html':
      return sendFile(res, join(WEB_ROOT, 'index.html'));
    case '/app.js':
      return sendFile(res, join(WEB_ROOT, 'app.js'));
    case '/api/timeline':
      return sendJson(res, 200, { meta: data.meta, events: data.events });
    case '/api/evidence':
      return sendJson(res, 200, { cards: evidenceCache, chain: data.meta.chain });
    case '/api/boundaries':
      return sendJson(res, 200, {
        boundaries: data.meta.boundaries,
        coverage: data.meta.coverage,
        scenarios: data.meta.scenarios,
      });
    case '/api/export': {
      const buf = Buffer.from(csvCache, 'utf-8');
      res.writeHead(200, {
        'Content-Type': MIME['.csv'],
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="audit-events-v${data.meta.framework.version}.csv"`,
      });
      return res.end(buf);
    }
    default:
      return sendFile(res, normalize(join(WEB_ROOT, url)));
  }
});

let port = DEFAULT_PORT;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--port=')) port = Number(a.slice('--port='.length)) || DEFAULT_PORT;
}

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('Agent 行为审计面板 · V1');
  console.log('─'.repeat(58));
  console.log(`  数据        ${DATA_FILE}`);
  console.log(`  事件        ${data.meta.event_count} 条 | 框架 v${data.meta.framework.version} | 门禁 ${data.meta.gates_count ?? '?'} 项`);
  console.log(`  时间戳模式  ${String(data.meta.ts_mode ?? 'synthetic-fixed')}（合成值，非真实时钟）`);
  console.log(`  地址        http://127.0.0.1:${port}`);
  console.log('');
  console.log('  重放校验不在本服务内执行（保持只读快）。命令行：');
  console.log('    node --experimental-transform-types tools/audit-panel/rules/replay.mts');
  console.log('');
});
