/**
 * otel-adapter.ts —— L2 审计事件 → OpenTelemetry 兼容 JSON 日志的导出适配器
 * ================================================================================
 *
 * 作用（对应框架证据完整性 E3「固化外抛」的工程对接层）：
 *   L2 参照实现的 AppendOnlyAuditLog 产出的是自有格式的事件流；本适配器把
 *   该事件流转换为 OpenTelemetry Logs 的 OTLP/JSON 结构，使其能被任何
 *   OTLP collector（如 otel-collector / Elastic / Grafana Loki / Datadog）
 *   直接摄取——规范接入现有可观测性栈的最小桥。
 *
 * 输入（stdin，每行一条 JSON，即 AppendOnlyAuditLog.events 的逐条序列化）：
 *   {"seq":1,"type":"session_start","data":{...},"ts":1756819200000,"hash":"..."}
 *
 * 输出（stdout，OTLP/JSON Logs 的 resourceLogs → scopeLogs → logRecords）：
 *   {
 *     "resourceLogs": [{
 *       "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "agent-oversight.l2" } }] },
 *       "scopeLogs": [{
 *         "scope": { "name": "l2-runtime-oversight" },
 *         "logRecords": [
 *           {
 *             "timeUnixNano": "...",
 *             "severityText": "INFO",
 *             "severityNumber": 9,
 *             "body": { "stringValue": "session_start" },
 *             "attributes": [
 *               { "key": "l2.seq",      "value": { "intValue": "1" } },
 *               { "key": "l2.type",     "value": { "stringValue": "session_start" } },
 *               { "key": "l2.hash",     "value": { "stringValue": "..." } },
 *               { "key": "l2.data",     "value": { "stringValue": "{...}" } }
 *             ]
 *           }
 *         ]
 *       }]
 *     }]
 *   }
 *
 * 用法：
 *   node --experimental-transform-types otel-adapter.ts < audit-events.jsonl > otlp-export.json
 *   # 或管道直连（demo 侧逐条打印时）：
 *   node --experimental-transform-types demo.ts 2>/dev/null | node --experimental-transform-types otel-adapter.ts
 *
 * 管道用例（内置自检）：
 *   node --experimental-transform-types otel-adapter.ts --selftest
 *   # 退出码 0 = 自检 PASS（端到端转换 + 结构校验）
 *
 * 字段映射约定（L2 事件 → OTel 属性）：
 *   l2.seq / l2.type / l2.hash / l2.data —— 保留审计链的四要素；
 *   severity —— 拦截/拒绝/违规类事件（entry_deny / exit_reject / session_interrupted /
 *   session_end(status=failed)）升为 WARN(13) 或 ERROR(17)，其余 INFO(9)。
 *   severityNumber 遵循 OTel 规范：9=INFO, 13=WARN, 17=ERROR。
 *
 * 诚实边界：
 *   - 本适配器只做**格式转换**，不采集、不发送——真正接入需要运行
 *     otel-collector 或任何 OTLP/JSON 消费端（curl POST /v1/logs 即可摄取本输出）。
 *   - 不验证审计链完整性（那是 AppendOnlyAuditLog.verifyChain 的职责）；
 *     导入方应先 verifyChain 再导出，或在 collector 侧另行校验。
 *   - 无背压 / 批量 / 重试——生产接入应使用官方 OTel SDK 导出器。
 *
 * 许可证：Apache License 2.0（代码路径，见 LICENSING.md 的路径 ↔ 许可证映射）。
 */

import { AppendOnlyAuditLog } from './index.ts';

// ============================================================================
// 类型与常量
// ============================================================================

/** L2 审计事件的序列化形态（AppendOnlyAuditLog.events 的逐条）。 */
interface L2AuditEvent {
  seq: number;
  type: string;
  data: unknown;
  ts: number;
  hash: string;
}

/** OTel 严重级别（遵循 OTel Logs 规范的 severityNumber）。 */
const SEVERITY_INFO = 9;
const SEVERITY_WARN = 13;
const SEVERITY_ERROR = 17;

/** 升级为 ERROR 的事件类型（确定性违规）。 */
const ERROR_TYPES = new Set(['tripwire_violation']);
/** 升级为 WARN 的事件类型（拦截/拒绝/中断/失败）。 */
const WARN_TYPES = new Set(['entry_deny', 'exit_reject', 'session_interrupted']);
/** WARN 的判定还包括 session_end 且 status=failed。 */

function severityFor(ev: L2AuditEvent): { text: string; number: number } {
  if (ERROR_TYPES.has(ev.type)) return { text: 'ERROR', number: SEVERITY_ERROR };
  if (WARN_TYPES.has(ev.type)) return { text: 'WARN', number: SEVERITY_WARN };
  const status = (ev.data as { status?: string } | null)?.status;
  if (ev.type === 'session_end' && status === 'failed') {
    return { text: 'WARN', number: SEVERITY_WARN };
  }
  return { text: 'INFO', number: SEVERITY_INFO };
}

// ============================================================================
// 转换：单条 L2 事件 → OTLP/JSON logRecord
// ============================================================================

interface OtlpValue {
  stringValue?: string;
  intValue?: string;
}
interface OtlpAttr {
  key: string;
  value: OtlpValue;
}

function attr(key: string, stringValue: string): OtlpAttr;
function attr(key: string, intValue: number): OtlpAttr;
function attr(key: string, v: string | number): OtlpAttr {
  return typeof v === 'string'
    ? { key, value: { stringValue: v } }
    : { key, value: { intValue: String(v) } };
}

/** 单条 L2 事件 → OTLP/JSON logRecord。 */
export function toLogRecord(ev: L2AuditEvent): unknown {
  const sev = severityFor(ev);
  return {
    timeUnixNano: String(ev.ts * 1_000_000), // ms → ns
    observedTimeUnixNano: String(ev.ts * 1_000_000),
    severityText: sev.text,
    severityNumber: sev.number,
    body: { stringValue: ev.type },
    attributes: [
      attr('l2.seq', ev.seq),
      attr('l2.type', ev.type),
      attr('l2.hash', ev.hash),
      attr('l2.data', JSON.stringify(ev.data)),
    ],
  };
}

/** 事件数组 → 完整 OTLP/JSON Logs 请求体。 */
export function toOtlpLogs(events: L2AuditEvent[], opts?: { serviceName?: string }): unknown {
  const serviceName = opts?.serviceName ?? 'agent-oversight.l2';
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [attr('service.name', serviceName)],
        },
        scopeLogs: [
          {
            scope: { name: 'l2-runtime-oversight', version: '1' },
            logRecords: events.map(toLogRecord),
          },
        ],
      },
    ],
  };
}

// ============================================================================
// stdin → stdout 管道模式
// ============================================================================

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** 从文本中逐行解析 JSON（容忍空行与注释行）。 */
export function parseEvents(text: string): L2AuditEvent[] {
  const out: L2AuditEvent[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || !s.startsWith('{')) continue;
    try {
      const obj = JSON.parse(s) as L2AuditEvent;
      if (typeof obj.seq === 'number' && typeof obj.type === 'string' && typeof obj.ts === 'number') {
        out.push(obj);
      }
    } catch {
      // 非 JSON 行（如 demo 的 PASS 输出）静默跳过——管道混入人类可读输出时不中断
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    process.exit(await selfTest() ? 0 : 1);
  }
  const text = await readStdin();
  const events = parseEvents(text);
  if (events.length === 0) {
    console.error('otel-adapter: 未从 stdin 解析到任何 L2 审计事件（期望 JSONL，每行一条 {"seq","type","data","ts","hash"}）');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(toOtlpLogs(events), null, 2) + '\n');
}

// ============================================================================
// 自检：端到端转换 + 结构校验（可作为 CI / demo 的一部分）
// ============================================================================

async function selfTest(): Promise<boolean> {
  let failures = 0;
  const check = (name: string, cond: boolean): void => {
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`);
    if (!cond) failures++;
  };

  console.log('\n[otel-adapter selftest] L2 审计事件 → OTLP/JSON 转换');

  // 1) 用真实的 AppendOnlyAuditLog 产出事件流（含一次 entry_deny 升 WARN）
  const audit = new AppendOnlyAuditLog();
  audit.append('session_start', { workerId: 'wk-1' });
  audit.append('entry_deny', { tool: 'exec_shell', category: 'arg-policy-violation' });
  audit.append('session_end', { status: 'failed', error: 'boom' });

  // 取出内部 events（与 demo TamperableAuditLog 同款手法，仅测试用）
  const events = (audit as unknown as {
    events: Array<{ type: string; data: unknown; ts: number; seq: number; hash: string }>;
  }).events as L2AuditEvent[];

  // 2) 序列化 → parseEvents 往返（模拟 stdin 管道）
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n');
  const parsed = parseEvents(jsonl);
  check('JSONL 往返：3 条事件全部解析', parsed.length === 3);
  check('parseEvents 容忍人类可读噪声行（混入 PASS 行不中断）',
    parseEvents('  PASS  某断言\n' + jsonl + '\n=== 结果：ALL PASS ===').length === 3);

  // 3) 转换为 OTLP 结构
  const otlp = toOtlpLogs(parsed) as {
    resourceLogs: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
      scopeLogs: Array<{ scope: { name: string }; logRecords: unknown[] }>;
    }>;
  };
  check('resourceLogs[0] 存在且 service.name = agent-oversight.l2',
    otlp.resourceLogs?.[0]?.resource?.attributes?.[0]?.value?.stringValue === 'agent-oversight.l2');
  check('scope 名 = l2-runtime-oversight',
    otlp.resourceLogs[0].scopeLogs[0].scope.name === 'l2-runtime-oversight');
  check('logRecords 数量 = 3', otlp.resourceLogs[0].scopeLogs[0].logRecords.length === 3);

  // 4) 逐条校验 logRecord 结构
  const recs = otlp.resourceLogs[0].scopeLogs[0].logRecords as Array<{
    severityText: string;
    severityNumber: number;
    body: { stringValue: string };
    attributes: OtlpAttr[];
    timeUnixNano: string;
  }>;
  check('session_start → INFO(9)',
    recs[0].severityText === 'INFO' && recs[0].severityNumber === 9);
  check('entry_deny → WARN(13)',
    recs[1].severityText === 'WARN' && recs[1].severityNumber === 13);
  check('session_end(failed) → WARN(13)',
    recs[2].severityText === 'WARN' && recs[2].severityNumber === 13);
  check('body.stringValue = 事件类型', recs[0].body.stringValue === 'session_start');
  check('l2.seq 属性保留审计序号',
    recs[1].attributes.find((a) => a.key === 'l2.seq')?.value.intValue === '2');
  check('l2.hash 属性保留链哈希', recs[1].attributes.find((a) => a.key === 'l2.hash')?.value.stringValue !== undefined);
  check('l2.data 属性为 JSON 字符串',
    (recs[1].attributes.find((a) => a.key === 'l2.data')?.value.stringValue ?? '').startsWith('{'));
  check('timeUnixNano 为纳秒（毫秒 × 10⁶）',
    recs[0].timeUnixNano.length >= 18 && !recs[0].timeUnixNano.includes('.'));

  // 5) 端到端 JSON 序列化（确保可直接 POST 给 OTLP collector）
  const json = JSON.stringify(toOtlpLogs(parsed));
  check('整体可序列化为合法 JSON', JSON.parse(json) !== null && json.includes('resourceLogs'));

  console.log(`\n=== otel-adapter 自检：${failures === 0 ? 'ALL PASS ✅' : `${failures} FAIL ❌`} ===`);
  return failures === 0;
}

void main();
