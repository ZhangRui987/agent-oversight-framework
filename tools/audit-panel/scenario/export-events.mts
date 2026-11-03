#!/usr/bin/env node
/**
 * export-events.mts —— 审计面板事件导出器（零依赖 · 确定性输出）
 *
 * 作用：让框架 L2 参照实现**真实执行**一遍预置场景，把 AppendOnlyAuditLog 的审计链
 *       投影成面板可消费的 JSONL。不是"抄一份实验报告"，也不是"手写假日志"——
 *       每条事件都由 index.ts 的 EntryGuard / ExitGuard / ResourceLedger 实际产生。
 *
 * 设计纪律（与 replicate-t0.mts 同形）：
 *   - 零外部依赖：仅用 node: 内置模块；不需要 npm/pip 安装，不访问网络。
 *   - 零侵入：不修改 index.ts、不修改 demo.ts。所有组件只依赖 `{ append }` 鸭子接口，
 *     因此注入本文件的 RecordingAuditLog 即可接管，同时保留框架自己的哈希链。
 *   - 确定性输出：事件时间戳在落盘时统一改写为合成单调值（BASE_TS + seq*1000），
 *     使同一版本框架的两次运行产出**逐字节相同**的 JSONL。原始墙钟时间只在终端摘要打印，不入库。
 *   - 不改基线：demo.ts 是 24 组 153 断言的 CI 基线，且内部有 14 个独立的
 *     AppendOnlyAuditLog 实例（各场景局部变量、事件不汇总），无法直接 dump。故独立成文件。
 *
 * 用法：
 *   node --experimental-transform-types tools/audit-panel/scenario/export-events.mts
 *   node --experimental-transform-types tools/audit-panel/scenario/export-events.mts --out=<路径>
 *   node --experimental-transform-types tools/audit-panel/scenario/export-events.mts --stdout
 *   node --experimental-transform-types tools/audit-panel/scenario/export-events.mts --quiet
 *
 * 输出：默认写 tools/audit-panel/data/events.jsonl；首行为 meta 记录（自描述），其后一行一事件。
 *
 * ⚠️ 依赖点（框架改版时必须复查，见文件末尾 assertFrameworkShape）：
 *     1. index.ts 导出 AppendOnlyAuditLog / EntryGuard / ExitGuard / ConfigReviewer / ResourceLedger
 *     2. AppendOnlyAuditLog#append 返回 { seq, hash } | null，且有 verifyChain(): boolean
 *     3. 事件类型取值仅为 entry_deny / exit_reject / ledger_signal
 *     4. 各 Guard 构造参数形状不变（见 makeEntryGuard / makeExitGuard）
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AppendOnlyAuditLog,
  ConfigReviewer,
  EntryGuard,
  ExitGuard,
  ResourceLedger,
  sha256,
} from '../../../reference/runtimes/l2-runtime-oversight/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 0. 常量与路径
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const DEFAULT_OUT = resolve(HERE, '../data/events.jsonl');

const SCHEMA_VERSION = 'aof-audit-panel/1';
const SESSION_ID = 'sess-v1-deterministic-001';
const AGENT_ID = 'agent-demo';

/**
 * 合成时间基准（固定值，非真实时钟）。
 * 取 2026-11-01T00:00:00Z 仅为了让 ts 落在"看起来像 2026 年"的区间；
 * 它不表示任何真实发生时刻——面板必须显示 ts_mode=synthetic-fixed。
 */
const BASE_TS = 1793491200000;
const TS_STEP_MS = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. 录制型审计日志（鸭子接口 + 保留框架真哈希链）
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedEvent {
  seq: number;
  type: string;
  data: unknown;
  /** 框架 AppendOnlyAuditLog 算出的链哈希（基于框架内部 ts，不可重算，只能整体 verifyChain）。 */
  hash: string;
  /** 墙钟时刻——仅用于终端摘要，不入库（入库会让输出不可复现）。 */
  wallClockTs: number;
}

/**
 * 实现 `{ append }` 鸭子接口，内部委托给真正的 AppendOnlyAuditLog。
 *
 * 为什么不自己算哈希：面板要展示"审计链是否被改"，那必须验的是**框架的链**，
 * 而不是导出器自己重算的链。委托实现让 verifyChain() 测的仍是框架原逻辑。
 *
 * 为什么不用 (log as any).events 读私有字段：TS 的 private 只是编译期约束，
 * 运行时确实可读，但那是对内部结构的脆弱依赖。append() 的返回值已给出 seq 与 hash，
 * 足够重建投影所需的一切，故不触碰私有字段。
 */
class RecordingAuditLog {
  private readonly inner = new AppendOnlyAuditLog();
  readonly recorded: RecordedEvent[] = [];

  append(type: string, data: unknown): { seq: number; hash: string } | null {
    const r = this.inner.append(type, data);
    // append 返回 null 表示写入失败（框架视为失租信号）——此时不记录，保持与链一致。
    if (r) {
      this.recorded.push({ seq: r.seq, type, data, hash: r.hash, wallClockTs: Date.now() });
    }
    return r;
  }

  verifyChain(): boolean {
    return this.inner.verifyChain();
  }

  get length(): number {
    return this.recorded.length;
  }
}

const audit = new RecordingAuditLog();

// ─────────────────────────────────────────────────────────────────────────────
// 2. 规则映射表（对应《审计面板_方案_v4.0》§10；条款号须逐条核对原文后才可改）
// ─────────────────────────────────────────────────────────────────────────────

type Grade = 'A' | 'B' | 'C' | 'D' | 'G';

interface RuleRef {
  ruleId: string;
  ruleName: string;
  /** 框架内部锚点（spec 文件名 + 大致章节；不写无法核实的行号）。 */
  specRef: string;
  /** TC260 框架 3.0 附件 2「二、防范措施」条款号。 */
  tc260Measures: string[];
  /** TC260 框架 3.0 附件 2「一、智能体安全风险」条款号。 */
  tc260Risks: string[];
  /** 该规则**技术效能主张**的证据等级（不是事件的等级）。 */
  efficiencyGrade: Grade;
  efficiencyBasis: string;
}

/**
 * category → 规则映射。
 * 条款号来源：附件 2 二、防范措施（7 类 34 细项）与 一、智能体安全风险（9 类）；
 * 逐条对照原文 p.38–45 核对，核验记录见 tools/audit-panel/mapping/tc260-3.0.json#_verification。
 */
const RULE_BY_CATEGORY: Record<string, RuleRef> = {
  'tool-not-allowed': {
    ruleId: 'R1',
    ruleName: '准入门（工具白名单）',
    specRef: 'spec/02-architecture（能力注册与准入）',
    tc260Measures: ['二、5(2) 建立安全护栏', '二、2(1) 身份管理', '二、4(1) 工具调用管理'],
    tc260Risks: ['一、5(2) 工具越权', '一、9(4) 系统权限滥用'],
    efficiencyGrade: 'A',
    efficiencyBasis: '确定性判定（白名单集合成员），demo [17] 可重跑验证；无需阈值标定',
  },
  'arg-policy-violation': {
    ruleId: 'R1',
    ruleName: '准入门（参数策略）',
    specRef: 'spec/02-architecture（参数策略）',
    tc260Measures: ['二、5(2) 建立安全护栏', '二、2(2) 权限管理'],
    tc260Risks: ['一、5(2) 工具越权'],
    efficiencyGrade: 'A',
    efficiencyBasis: '确定性判定（调用方声明式策略），demo [17] 可重跑验证',
  },
  'config-review-fail': {
    ruleId: 'R4',
    ruleName: '配置内容审查（配置权即攻击面）',
    specRef: 'spec/02-architecture 第四条',
    tc260Measures: ['二、2(3) 凭证管理', '二、3(2) 设置人工控制节点', '二、5(4) 通信安全管理', '二、6(2) 加强数据管理'],
    tc260Risks: ['一、9(3) 行为逃逸', '一、6(1) 记忆留存不当'],
    efficiencyGrade: 'A',
    efficiencyBasis:
      'AOE-DETECT-001（预注册 160 样本）：直检正例 50/50=100%、混淆类变体 77/77 未检出、常规良性 FPR 0/20；覆盖边界由规则结构决定',
  },
  'resource-over-budget': {
    ruleId: 'R2',
    ruleName: '出口门（结果资源预算）',
    specRef: 'spec/02-architecture（E5 出口裁决）；spec/10-resource-ledger（预算）',
    tc260Measures: ['二、6(1) 异常阻断', '二、5(5) 自主执行控制'],
    tc260Risks: ['一、7(2) 实施恶意行为'],
    efficiencyGrade: 'A',
    efficiencyBasis: '确定性比较（actual > budget），demo [17] 可重跑验证',
  },
  'output-policy-violation': {
    ruleId: 'R2',
    ruleName: '出口门（输出策略）',
    specRef: 'spec/02-architecture（E5 出口裁决）',
    tc260Measures: ['二、6(1) 异常阻断', '二、5(2) 输出结果的安全规则'],
    tc260Risks: ['一、7(1) 敏感违法信息内容输出'],
    efficiencyGrade: 'A',
    efficiencyBasis: '确定性判定（输出策略谓词），demo [17] 可重跑验证',
  },
  'integrity-check-failed': {
    ruleId: 'R2',
    ruleName: '出口门（结果完整性）',
    specRef: 'spec/02-architecture E5；PRODUCTION-GAPS G4',
    tc260Measures: ['二、4(3) 工具异常检测', '二、5(2) 建立安全护栏'],
    tc260Risks: ['一、7(2) 实施恶意行为'],
    efficiencyGrade: 'C',
    efficiencyBasis:
      '⚠️ 本实现中 integrityCheck 为注入钩子（默认恒真），本场景显式注入 false 以演示分支；真实 E5 需独立信任域签名比对——PRODUCTION-GAPS G4 未闭合，故效能无 A 级支撑',
  },
  'budget-exceeded': {
    ruleId: 'R3',
    ruleName: '资源账本（预算比）',
    specRef: 'spec/10-resource-ledger（信号①）',
    tc260Measures: ['二、5(5) 自主执行控制（资源消耗参数化）'],
    tc260Risks: ['一、5(1) 工具投毒（异常消耗）'],
    efficiencyGrade: 'A',
    efficiencyBasis: 'AOE-CALIB-001 影子比/预算阈值自复现标定；信号为审计而非拦截（spec/10 原文）',
  },
  'shadow-deviation': {
    ruleId: 'R3',
    ruleName: '资源账本（影子比）',
    specRef: 'spec/10-resource-ledger（信号②）',
    tc260Measures: ['二、5(5) 自主执行控制'],
    tc260Risks: ['一、5(1) 工具投毒（异常消耗）'],
    efficiencyGrade: 'A',
    efficiencyBasis:
      'AOE-CALIB-001 阈值标定；跨模型阈值跨度 1.00–1.98（AOE-CALIB-002 扩展实验），生产须按 provider 独立标定',
  },
  'memory-write-audited': {
    ruleId: 'R3',
    ruleName: '资源账本（记忆写入最高级审计）',
    specRef: 'spec/10-resource-ledger（信号③）',
    tc260Measures: ['二、5(3) 记忆留存管理', '二、6(3) 日志管理'],
    tc260Risks: ['一、6(3) 记忆污染'],
    efficiencyGrade: 'A',
    efficiencyBasis: 'AOE-ABSTAIN-001/002 提供动机侧实证；本条为登记动作而非检出器，效能主张限于"写入必留痕"',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. 场景编排（七组，全部走真实代码路径）
// ─────────────────────────────────────────────────────────────────────────────

type ScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7';

/** 每个场景的重放规格（写入该场景全部事件的 replay 字段）。 */
const replayInputs = new Map<ScenarioId, ReplaySpec>();

const scenarioOf = new Map<number, ScenarioId>();
const summaries: Array<{
  id: ScenarioId;
  title: string;
  events: number;
  categories: string[];
}> = [];

/** 执行一个场景，并把其产生的事件打上场景标签。 */
function scenario(id: ScenarioId, title: string, body: () => void): void {
  const before = audit.length;
  body();
  const added = audit.recorded.slice(before);
  for (const e of added) scenarioOf.set(e.seq, id);
  summaries.push({
    id,
    title,
    events: added.length,
    categories: [...new Set(added.map((e) => categoryOf(e)))],
  });
}

/** 白名单：模拟一次被授权的 Agent 工作流可用的工具集。 */
const ALLOWED = new Set(['search_docs', 'shell_exec', 'update_workflow_config', 'memory_write']);

/** 构造共用同一个 audit 的 EntryGuard（配置审查注入后，S3 才会走 R4 分支）。 */
function makeEntryGuard(opts: {
  allowed?: ReadonlySet<string>;
  argPolicies?: ConstructorParameters<typeof EntryGuard>[1];
  withConfigReview?: boolean;
} = {}): EntryGuard {
  return new EntryGuard(
    opts.allowed ?? ALLOWED,
    opts.argPolicies ?? [],
    audit,
    opts.withConfigReview ? new ConfigReviewer() : undefined,
    opts.withConfigReview ? new Set(['update_workflow_config']) : undefined,
  );
}

/** 构造 ExitGuard。注意第 3 参是 integrityCheck，第 4 参才是 audit（默认值在中间，不可省略传参）。 */
function makeExitGuard(
  budget: { maxTokens?: number; maxMemoryMb?: number; maxDurationMs?: number },
  outputPolicies: ConstructorParameters<typeof ExitGuard>[1] = [],
  integrityCheck: (req: never, result: never) => boolean = () => true,
): ExitGuard {
  return new ExitGuard(budget, outputPolicies, integrityCheck as never, audit);
}

// —— S1：工具不在白名单（R1 / tool-not-allowed）——
replayInputs.set('S1', {
  kind: 'entry',
  tool: 'delete_production_db',
  allowed: [...ALLOWED],
  expect: 'tool-not-allowed',
});
scenario('S1', '非白名单工具被拦在执行前', () => {
  const guard = makeEntryGuard();
  guard.check({
    tool: 'delete_production_db',
    args: { db: 'prod' },
    callerId: 'agent-demo',
  });
});

// —— S2：参数违反声明式策略（R1 / arg-policy-violation）——
replayInputs.set('S2', {
  kind: 'entry',
  tool: 'shell_exec',
  args: { cmd: 'rm -rf /var/data' },
  allowed: [...ALLOWED],
  argPolicy: { type: 'forbidden-substring', value: 'rm -rf', stringify: 'json' },
  expect: 'arg-policy-violation',
});
scenario('S2', '参数命中禁止模式被拦', () => {
  const guard = makeEntryGuard({
    argPolicies: [
      {
        name: 'deny-destructive-shell',
        tools: new Set(['shell_exec']),
        check: (args) => !JSON.stringify(args).includes('rm -rf'),
        reason: () => 'destructive shell pattern "rm -rf" is forbidden',
      },
    ],
  });
  guard.check({
    tool: 'shell_exec',
    args: { cmd: 'rm -rf /var/data' },
    callerId: 'agent-demo',
  });
});

// —— S3：配置内容审查（R4 / config-review-fail，多项命中）——
replayInputs.set('S3', {
  kind: 'entry',
  tool: 'update_workflow_config',
  args: {
    config: {
      apiKey: 'sk-live-REDACTED0123456789', // → inline-credential 命中
      requireApproval: false, //              → approval-disabled 命中
      shareScope: 'org-wide', //              → 等价变体，未命中（漏检样本，见 B6）
    },
  },
  allowed: [...ALLOWED],
  configReview: true,
  expect: 'config-review-fail',
});
scenario('S3', '白名单内工具的配置内容被审出两项风险（第三项等价变体被漏检）', () => {
  const guard = makeEntryGuard({ withConfigReview: true });
  // update_workflow_config 本身在白名单内、参数也不违反参数策略——
  // 恶意性完全藏在配置内容里（这正是 spec/02「配置权即攻击面」的形态）。
  //
  // ⚠️ 刻意保留一个"漏检样本"：shareScope 是共享范围扩大，语义上等价于 visibility=org-wide，
  // 但 ConfigReviewer 的 share-scope-widened 只认 visibility / share / shareWith / accessLevel
  // 四个字段名（index.ts:802-804），故本项**不会被检出**。
  // 这不是 bug 而是可测的覆盖边界——与 AOE-DETECT-001「混淆类变体 77/77 未检出」同源，
  // 面板应把它当"看起来危险却没被拦"的实证样本展示（见边界 B6）。
  guard.check({
    tool: 'update_workflow_config',
    args: {
      config: {
        apiKey: 'sk-live-REDACTED0123456789', // → inline-credential 命中
        requireApproval: false, //              → approval-disabled 命中
        shareScope: 'org-wide', //              → 等价变体，未命中（漏检样本）
      },
    },
    callerId: 'agent-demo',
  });
});

// —— S4：结果超预算（R2 / resource-over-budget）——
replayInputs.set('S4', {
  kind: 'exit',
  tool: 'search_docs',
  budget: { maxTokens: 8000 },
  result: { ok: true, output: 'ok', resources: { tokens: 12480 } },
  expect: 'resource-over-budget',
});
scenario('S4', '工具返回的消耗超出预算被拒绝采纳', () => {
  const guard = makeExitGuard({ maxTokens: 8000 });
  guard.check(
    { tool: 'search_docs', args: { q: 'oversight' }, callerId: 'agent-demo' },
    { ok: true, output: 'ok', resources: { tokens: 12480 } },
  );
});

// —— S5：输出策略违规（R2 / output-policy-violation）——
replayInputs.set('S5', {
  kind: 'exit',
  tool: 'search_docs',
  outputPolicy: { type: 'forbidden-substring', value: 'AKIA' },
  result: { ok: true, output: 'found: AKIAIOSFODNN7EXAMPLE' },
  expect: 'output-policy-violation',
});
scenario('S5', '结果含禁止字段被拒绝采纳', () => {
  const guard = makeExitGuard(
    {},
    [
      {
        name: 'deny-access-key-leak',
        tools: new Set(['search_docs']),
        check: (result) => !String(result.output).includes('AKIA'),
        reason: () => 'output contains an access key identifier',
      },
    ],
  );
  guard.check(
    { tool: 'search_docs', args: { q: 'creds' }, callerId: 'agent-demo' },
    { ok: true, output: 'found: AKIAIOSFODNN7EXAMPLE' },
  );
});

// —— S6：完整性校验失败（R2 / integrity-check-failed，占位钩子显式返回 false）——
replayInputs.set('S6', {
  kind: 'exit',
  tool: 'search_docs',
  result: { ok: true, output: 'ok' },
  integrityHook: 'always-false',
  // 诚实标注：integrityCheck 是注入钩子（框架默认恒真，PRODUCTION-GAPS G4 未闭合）。
  // 重放只能验证「钩子返回 false 时分支可达且判定正确」，不能证明真实完整性校验有效。
  expect: 'integrity-check-failed',
});
scenario('S6', '完整性校验不通过（占位钩子，非真实签名比对）', () => {
  const guard = makeExitGuard({}, [], () => false);
  guard.check(
    { tool: 'search_docs', args: { q: 'signed' }, callerId: 'agent-demo' },
    { ok: true, output: 'ok' },
  );
});

// —— S7：资源账本三信号（R3：budget-exceeded / shadow-deviation / memory-write-audited）——
replayInputs.set('S7', {
  kind: 'ledger',
  calls: [
    {
      op: 'record',
      taskId: 'task-oversight-001',
      tool: 'search_docs',
      usage: { tokens: 12480 },
      budget: {
        taskId: 'task-oversight-001',
        maxTokens: 8000,
        shadowBaseline: { tokens: 3000 },
        shadowRatioThreshold: 2.0,
      },
    },
    {
      op: 'auditMemoryWrite',
      taskId: 'task-oversight-001',
      target: 'memory',
      writeDetail: { tool: 'memory_write', fieldsChanged: ['preferred_language', 'retention_days'], bytes: 128 },
    },
  ],
  // 注意：periodic-egress（信号④）不在预期内——需真实时间窗，见 COVERAGE.r3 的缺口说明。
  expect: ['budget-exceeded', 'shadow-deviation', 'memory-write-audited'],
});
scenario('S7', '资源账本产出三条审计信号（均为信号，非拦截）', () => {
  const ledger = new ResourceLedger(audit);

  // 信号①（预算比）+ 信号②（影子比）：一次调用同时越过预算上限与基线偏离。
  ledger.record(
    'task-oversight-001',
    'search_docs',
    { tokens: 12480 },
    {
      taskId: 'task-oversight-001',
      maxTokens: 8000,
      shadowBaseline: { tokens: 3000 },
      shadowRatioThreshold: 2.0,
    },
  );

  // 信号③（记忆写入最高级审计）：写入必须留痕，不依赖任何预算阈值。
  ledger.auditMemoryWrite('task-oversight-001', 'memory', {
    tool: 'memory_write',
    fieldsChanged: ['preferred_language', 'retention_days'],
    bytes: 128,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 投影（raw 事件 → 面板契约）
// ─────────────────────────────────────────────────────────────────────────────

function dataOf(e: RecordedEvent): Record<string, unknown> {
  return e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {};
}

function categoryOf(e: RecordedEvent): string {
  const d = dataOf(e);
  if (typeof d.category === 'string') return d.category; // entry_deny / exit_reject
  if (typeof d.kind === 'string') return d.kind; // ledger_signal
  return 'unknown';
}

function detailOf(e: RecordedEvent): string {
  const d = dataOf(e);
  if (typeof d.reason === 'string') return d.reason;
  if (typeof d.detail === 'string') return d.detail;
  return '';
}

/**
 * measured / threshold 的归一化。
 * 框架三种事件的 payload 形状不同，不可统一挂字段：
 *   - ledger_signal：原生有 measured / threshold
 *   - exit_reject：有 metric / actual / budget（仅超预算分支）、无实测值的分支则缺省
 *   - entry_deny：完全没有实测值（只有 tool / callerId / category / reason）
 */
function statsOf(e: RecordedEvent): {
  measured: Record<string, number> | null;
  threshold: Record<string, number> | null;
} {
  const d = dataOf(e);
  if (e.type === 'ledger_signal') {
    return {
      measured: (d.measured as Record<string, number> | undefined) ?? null,
      threshold: (d.threshold as Record<string, number> | undefined) ?? null,
    };
  }
  if (e.type === 'exit_reject') {
    const metric = typeof d.metric === 'string' ? d.metric : undefined;
    const actual = typeof d.actual === 'number' ? d.actual : undefined;
    const budget = typeof d.budget === 'number' ? d.budget : undefined;
    if (metric && actual !== undefined && budget !== undefined) {
      return { measured: { [metric]: actual }, threshold: { [metric]: budget } };
    }
  }
  return { measured: null, threshold: null };
}

function findingsOf(e: RecordedEvent): unknown[] | null {
  const d = dataOf(e);
  return Array.isArray(d.findings) ? (d.findings as unknown[]) : null;
}

/**
 * 落盘链哈希——覆盖**本文件实际落盘的契约字段**，使链可被任何第三方独立重算。
 *
 * 为什么不用框架原哈希：框架 hash 基于真实 Date.now()，每次运行都不同（实测两次 md5 不一致），
 * 且其输入含未落盘的原始 data（ledger_signal 的 data 里带真实 ts），外部无法复算。
 *
 * 为什么不用「原始 data + 合成 ts」重算：同样依赖未落盘的 data，外部仍无法复算。
 *
 * 因此定义：chain_hash = sha256(prev_hash + "|" + JSON.stringify(body))
 *   - body = 本条事件去掉 chain_hash / chain_prev 之后的全部字段（key 顺序由构造顺序固定）
 *   - prev_hash 在首条为空串
 * 任何人都能拿落盘的 JSONL 按此规则重算验证——这比"相信我算过"更有意义。
 *
 * ⚠️ 两套链必须区分（见 meta.chain.note）：落盘链证明"文件未被事后篡改"，
 * 不能替代框架运行期的 verifyChain()，也不证明事件发生在合成时间点。
 */
function canonicalChainHash(prevHash: string, body: Record<string, unknown>): string {
  return sha256(prevHash + '|' + JSON.stringify(body));
}

interface ContractEvent {
  record_type: 'event';
  seq: number;
  ts: number;
  ts_mode: 'synthetic-fixed';
  session_id: string;
  agent_id: string;
  event_type: string;
  category: string;
  rule_id: string;
  rule_name: string;
  source_scenario: string;
  detail: string;
  measured: Record<string, number> | null;
  threshold: Record<string, number> | null;
  findings?: unknown[];
  chain_hash: string;
  chain_prev: string;
  spec_ref: string;
  tc260_measures: string[];
  tc260_risks: string[];
  efficiency_grade: Grade;
  efficiency_basis: string;
  /**
   * 重放所需的最小判定输入与预期裁决（rules/replay.mts 消费）。
   * 设计原则：重放不靠"猜当时的 guard 配置"——输入显式落盘，重放器独立重建执行并比对。
   * 策略谓词不可序列化，故以声明式描述（type + value），由重放器重建。
   */
  replay?: ReplaySpec;
}

/** 重放规格——见 ContractEvent.replay 注释。 */
export type ReplaySpec =
  | {
      kind: 'entry';
      tool: string;
      args?: unknown;
      allowed: string[];
      argPolicy?: { type: 'forbidden-substring'; value: string; stringify: 'json' };
      configReview?: boolean;
      expect: string;
    }
  | {
      kind: 'exit';
      tool: string;
      budget?: { maxTokens?: number };
      outputPolicy?: { type: 'forbidden-substring'; value: string };
      result: { ok: boolean; output?: unknown; resources?: { tokens?: number } };
      /** S6 专用：integrityCheck 为注入钩子，重放仅验证"钩子返回 false 时分支可达"。 */
      integrityHook?: 'always-false';
      expect: string;
    }
  | {
      kind: 'ledger';
      /** 与框架 record() / auditMemoryWrite() 同形的声明式调用序列。 */
      calls: Array<
        | { op: 'record'; taskId: string; tool: string; usage: Record<string, number>; budget?: Record<string, unknown> }
        | { op: 'auditMemoryWrite'; taskId: string; target: string; writeDetail: Record<string, unknown> }
      >;
      /** 预期产出的信号 kind 集合（按序）。 */
      expect: string[];
    };

function project(e: RecordedEvent, prevHash: string): ContractEvent {
  const category = categoryOf(e);
  const rule = RULE_BY_CATEGORY[category];
  if (!rule) {
    throw new Error(
      `未登记的事件类别：${category}（事件 seq=${e.seq}, type=${e.type}）。` +
        `新增类别必须先在 RULE_BY_CATEGORY 中登记规则与条款映射，否则面板会展示无依据的行为。`,
    );
  }
  const { measured, threshold } = statsOf(e);
  const findings = findingsOf(e);
  const ts = BASE_TS + e.seq * TS_STEP_MS;

  const out: ContractEvent = {
    record_type: 'event',
    seq: e.seq,
    ts,
    ts_mode: 'synthetic-fixed',
    session_id: SESSION_ID,
    agent_id: AGENT_ID,
    event_type: e.type,
    category,
    rule_id: rule.ruleId,
    rule_name: rule.ruleName,
    source_scenario: scenarioOf.get(e.seq) ?? 'unknown',
    detail: detailOf(e),
    measured,
    threshold,
    // 占位，稍后按落盘内容重算（见 canonicalChainHash 注释）
    chain_hash: '',
    chain_prev: prevHash,
    spec_ref: rule.specRef,
    tc260_measures: rule.tc260Measures,
    tc260_risks: rule.tc260Risks,
    efficiency_grade: rule.efficiencyGrade,
    efficiency_basis: rule.efficiencyBasis,
  };
  if (findings) out.findings = findings;

  // 重放规格与事件同链落盘：链覆盖 replay 字段，篡改重放输入同样会被验出。
  const replaySpec = replayInputs.get(scenarioOf.get(e.seq) ?? '');
  if (replaySpec) out.replay = replaySpec;

  // 链覆盖"本条落盘内容"（不含两个链字段本身），因此外部可独立重算验证。
  const body: Record<string, unknown> = { ...out };
  delete body.chain_hash;
  delete body.chain_prev;
  out.chain_hash = canonicalChainHash(prevHash, body);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 覆盖矩阵（如实呈现"没做到什么"，这是面板的第一条诚实边界）
// ─────────────────────────────────────────────────────────────────────────────

const COVERAGE = {
  note:
    '覆盖率按代码实读得出，不是按类型定义推断。未覆盖项在面板"诚实边界"页必须原样展示。',
  r1_entry_deny: {
    declared: ['tool-not-allowed', 'arg-policy-violation', 'config-review-fail', 'rate-limit', 'budget-exhausted'],
    implemented: ['tool-not-allowed', 'arg-policy-violation', 'config-review-fail'],
    covered_by_export: ['tool-not-allowed', 'arg-policy-violation', 'config-review-fail'],
    gap:
      "rate-limit 与 budget-exhausted 仅存在于 EntryDenyCategory 类型定义（index.ts:704-705），" +
      'EntryGuard.check 中没有任何分支会产生这两个 category——属于"已声明未实现"。',
  },
  r2_exit_reject: {
    declared: ['output-policy-violation', 'resource-over-budget', 'integrity-check-failed'],
    implemented: ['output-policy-violation', 'resource-over-budget', 'integrity-check-failed'],
    covered_by_export: ['output-policy-violation', 'resource-over-budget', 'integrity-check-failed'],
    gap:
      'integrity-check-failed 在本场景中由显式注入 integrityCheck=()=>false 触发，' +
      '属"分支可达性演示"，不代表真实完整性校验能力（PRODUCTION-GAPS G4 未闭合）。',
  },
  r3_ledger_signal: {
    declared: ['budget-exceeded', 'shadow-deviation', 'memory-write-audited', 'periodic-egress'],
    implemented: ['budget-exceeded', 'shadow-deviation', 'memory-write-audited', 'periodic-egress'],
    covered_by_export: ['budget-exceeded', 'shadow-deviation', 'memory-write-audited'],
    gap:
      'periodic-egress 未覆盖：该信号依赖同一任务 8 次出站调用的真实时间间隔方差。' +
      '导出器若用紧循环触发，间隔接近 0ms、方差必然极小，会产出"假阳性周期信号"——' +
      '那验证的是阈值比较能跑通，不是周期检测有效。为避免用构造数据冒充检测能力，本导出不覆盖该信号。',
  },
  r5_audit_chain: {
    declared: ['sha256-chain + verifyChain'],
    implemented: ['sha256-chain + verifyChain'],
    covered_by_export: ['verifyChain'],
    gap:
      '链已实现且本次运行校验结果见 meta.chain.verified；但哈希链在被观测进程内计算，' +
      '进程被攻陷时可被整体重算（PRODUCTION-GAPS G4/E5 未闭合）——面板不得表述为"防篡改"。',
  },
} as const;

const BOUNDARIES = [
  {
    id: 'B1-audit-chain',
    title: '审计链：链已实现，但无密钥与外部锚定',
    detail:
      'SHA-256 哈希链已实现，等长篡改会被 verifyChain 检出（PRODUCTION-GAPS G2，演示级闭合）。' +
      '未闭合的是：哈希链在被观测进程内计算，进程被攻陷时整条链可被整体重算（G4 / E5 未闭合）。' +
      '注意区分：ExitGuard.integrityCheck 的"占位钩子、默认恒真"属于工具结果完整性（E5），' +
      '与审计链完整性是两件事，不得混引。',
    ref: 'PRODUCTION-GAPS.md G2 / G4；index.ts:404-447, 968-969',
  },
  {
    id: 'B2-deny-only',
    title: '审计链只记录拒绝，放行不留痕',
    detail:
      'EntryGuard / ExitGuard 仅在 deny / reject 分支调用 audit.append；allow / accept 不写事件。' +
      '因此本文件的事件序列不是完整会话，而是"全部被拦下的行为"——' +
      '"为什么放过了某次调用"在当前实现中不可审计。这与框架 3.0 §3.2.1(d) 的"全量记录"要求存在差距。',
    ref: 'index.ts:886-947（仅 deny 分支 append）, 997-1059；框架 3.0 §3.2.1(d)',
  },
  {
    id: 'B3-orphan-signals',
    title: '资源账本的信号全部是孤儿信号',
    detail:
      'ResourceLedger 产出 ledger_signal 后即返回，框架不提供任何处置通道（不拦截、不阻断、无回调）。' +
      'spec/10 的设计取向正是"审计而非拦截"，但这也意味着：每条信号都"记了但没人处置"。' +
      '本导出无法产生"处置"事件，因为代码里不存在这样的路径。',
    ref: 'index.ts:1207-1351；spec/10-resource-ledger（超支可能合理但必须解释）；PRODUCTION-GAPS G5',
  },
  {
    id: 'B4-synthetic-ts',
    title: '时间戳为合成值，非真实时钟',
    detail:
      '为保证输出逐字节可复现，落盘 ts 统一改写为 BASE_TS + seq*1000。' +
      '原始墙钟时间不写入文件（写入即破坏可复现）。因此本文件不能用于推断事件真实发生时刻或间隔。',
    ref: 'export-events.mts 常量 BASE_TS / TS_STEP_MS',
  },
  {
    id: 'B5-projection',
    title: '契约字段有一半是导出器补写的元数据',
    detail:
      '框架 AuditEvent 只有 { type, data, ts } 三个字段。session_id / agent_id / rule_id / ' +
      'source_scenario / spec_ref / tc260_* 全部由导出器按映射表补写，不是框架原生结构。' +
      '这些字段的正确性取决于映射表，不取决于框架。',
    ref: 'index.ts:39-43（AuditEvent 定义）',
  },
  {
    id: 'B6-fieldname-variant',
    title: '配置审查依赖固定字段名，等价变体会被静默放过',
    detail:
      'ConfigReviewer 的 share-scope-widened 只识别 visibility / share / shareWith / accessLevel 四个字段名；' +
      '语义等价的字段（如 shareScope）不触发。S3 场景刻意保留了这个漏检样本：' +
      'config 里 shareScope="org-wide" 与 visibility="org-wide" 风险相同，但只报出 2 项 findings、不是 3 项。' +
      '这与 AOE-DETECT-001 实测的「混淆类变体 77/77 未检出」同源——形态规则的上界由字段白名单决定。' +
      '面板不得把"未报错"呈现为"配置安全"。',
    ref: 'index.ts:801-807；AOE-DETECT-001（CALIBRATION-REPORT-CONFIG-REVIEWER.md）；PRODUCTION-GAPS G9',
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 6. 框架形状断言（框架改版后第一时间失败，而不是静默产出错数据）
// ─────────────────────────────────────────────────────────────────────────────

function assertFrameworkShape(): void {
  const checks: Array<[string, boolean]> = [
    ['AppendOnlyAuditLog 可构造', typeof AppendOnlyAuditLog === 'function'],
    ['EntryGuard 可构造', typeof EntryGuard === 'function'],
    ['ExitGuard 可构造', typeof ExitGuard === 'function'],
    ['ConfigReviewer 可构造', typeof ConfigReviewer === 'function'],
    ['ResourceLedger 可构造', typeof ResourceLedger === 'function'],
    ['审计链可校验', typeof audit.verifyChain === 'function' && audit.verifyChain() === true],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    throw new Error(
      '框架形状与导出器预期不符，可能已改版：\n' +
        failed.map(([name]) => `  - ${name}`).join('\n') +
        '\n请复查 export-events.mts 文件头的「依赖点」清单。',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 主流程
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { out: string; toStdout: boolean; quiet: boolean } {
  let out = DEFAULT_OUT;
  let toStdout = false;
  let quiet = false;
  for (const a of argv) {
    if (a.startsWith('--out=')) out = resolve(a.slice('--out='.length));
    else if (a === '--stdout') toStdout = true;
    else if (a === '--quiet') quiet = true;
  }
  return { out, toStdout, quiet };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // 先校验形状：链校验必须在场景执行后才有意义，故此处只校验构造能力。
  for (const [name, fn] of Object.entries({ AppendOnlyAuditLog, EntryGuard, ExitGuard, ConfigReviewer, ResourceLedger })) {
    if (typeof fn !== 'function') {
      throw new Error(`框架形状不符：${name} 未导出（框架可能已改版，见文件头依赖点）`);
    }
  }

  if (audit.length === 0) {
    throw new Error('场景未产出任何事件——导出器逻辑或框架行为已变化，拒绝生成空数据集。');
  }

  const chainVerified = audit.verifyChain();
  assertFrameworkShape();

  // —— 投影 ——
  const events: ContractEvent[] = [];
  let prevHash = '';
  for (const raw of audit.recorded) {
    events.push(project(raw, prevHash));
    // 注意：这里用的是**确定性链**的前一哈希，不是 raw.hash（后者含真实 ts，不可复现）。
    prevHash = events[events.length - 1]!.chain_hash;
  }

  // —— meta（首行，自描述）——
  let frameworkVersion = 'unknown';
  try {
    frameworkVersion = readFileSync(resolve(REPO_ROOT, 'VERSION'), 'utf-8').trim();
  } catch {
    /* VERSION 缺失不阻断导出，但 meta 会显式标 unknown */
  }

  // 门禁项数由脚本实测派生（数 ^check( 行），不手写——与 README 计数声明同一来源。
  let gatesCount: number | null = null;
  try {
    const gateSrc = readFileSync(resolve(REPO_ROOT, 'scripts/verify_consistency.py'), 'utf-8');
    const m = gateSrc.match(/^check\(/gm);
    gatesCount = m ? m.length : null;
  } catch {
    /* 门禁脚本缺失不阻断导出 */
  }

  const meta = {
    record_type: 'meta',
    schema_version: SCHEMA_VERSION,
    generator: 'tools/audit-panel/scenario/export-events.mts',
    generator_run_at_mode: 'omitted-for-determinism',
    framework: {
      version: frameworkVersion,
      entry: 'reference/runtimes/l2-runtime-oversight/index.ts',
    },
    gates_count: gatesCount,
    session_id: SESSION_ID,
    agent_id: AGENT_ID,
    event_count: events.length,
    chain: {
      algorithm: 'chain_hash = sha256(prev_hash + "|" + JSON.stringify(本行去掉 chain_hash/chain_prev 后的全部字段))',
      recompute_recipe:
        '逐行解析 JSONL → 取上一条的 chain_hash 作为 prev（首条用空串）→ 删除本条 chain_hash 与 chain_prev → ' +
        'sha256(prev + "|" + JSON.stringify(其余字段)) → 与落盘 chain_hash 比对。key 顺序须保持文件原序。',
      framework_verified_at_run: chainVerified,
      deterministic_rebuild: true,
      note:
        '存在两套链，面板不得混用：①运行期框架链——框架 AppendOnlyAuditLog 基于真实 Date.now() 计算，' +
        '仅在本次运行内有效，结果见 framework_verified_at_run；②落盘链——按上述 recipe 覆盖落盘内容计算，' +
        '可跨运行逐字节比对、可被第三方独立重算，但只能证明「本文件未被事后篡改」，' +
        '不能替代框架运行期校验，也不证明事件发生在合成时间点。',
    },
    scenarios: summaries,
    coverage: COVERAGE,
    boundaries: BOUNDARIES,
  };

  const lines = [JSON.stringify(meta), ...events.map((e) => JSON.stringify(e))];
  const payload = lines.join('\n') + '\n';

  if (args.toStdout) {
    process.stdout.write(payload);
  } else {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, payload, 'utf-8');
  }

  if (!args.quiet) {
    const span = audit.recorded.length > 1
      ? audit.recorded[audit.recorded.length - 1]!.wallClockTs - audit.recorded[0]!.wallClockTs
      : 0;
    const out = [
      '',
      '审计面板事件导出 · 完成',
      '─'.repeat(58),
      `  框架版本        v${frameworkVersion}`,
      `  事件总数        ${events.length}`,
      `  运行期链校验    ${chainVerified ? 'PASS（框架 verifyChain）' : 'FAIL'}`,
      `  落盘链          确定性重建（合成 ts，可逐字节比对）`,
      `  真实耗时跨度    ${span} ms（仅终端显示，不入库）`,
      `  输出            ${args.toStdout ? '(stdout)' : args.out}`,
      '',
      '  场景明细：',
      ...summaries.map(
        (s) => `    ${s.id}  ${String(s.events).padStart(2)} 条  ${s.title}\n         ${s.categories.join(', ')}`,
      ),
      '',
      '  覆盖缺口（面板诚实边界页须原样展示）：',
      `    R1  ${COVERAGE.r1_entry_deny.gap}`,
      `    R3  ${COVERAGE.r3_ledger_signal.gap}`,
      '',
    ].join('\n');
    process.stdout.write(out);
  }

  // 断言：本次导出必须覆盖 R1/R2/R3 三族，否则说明场景编排失效
  const familySeen = new Set(events.map((e) => e.event_type));
  for (const t of ['entry_deny', 'exit_reject', 'ledger_signal']) {
    if (!familySeen.has(t)) {
      throw new Error(`导出结果缺少事件族 ${t}——场景编排失效，拒绝以残缺数据集交付。`);
    }
  }
}

main();
