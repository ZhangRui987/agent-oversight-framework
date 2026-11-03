/**
 * rule-map.mts —— category → 规则映射表（V1 导出器与 V2 runner 共用的单一真相源）
 *
 * 条款映射（tc260Measures / tc260Risks）自 v2.57.0 起外置到 mapping/tc260-3.0.json
 * （含 _meta.verification 核验字段），本模块启动时读取合并——数据与代码分离，
 * 非开发者可审阅条款文件本身。修改条款号必须回到原文 PDF 重新核对，
 * 并同步更新 JSON 的 _meta.verification。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export type Grade = 'A' | 'B' | 'C' | 'D' | 'G';

export interface RuleRef {
  ruleId: string;
  ruleName: string;
  /** 框架内部锚点（spec 文件名 + 大致章节；不写无法核实的行号）。 */
  specRef: string;
  /** TC260 框架 3.0 附件 2「二、防范措施」条款号（数据源：mapping/tc260-3.0.json）。 */
  tc260Measures: string[];
  /** TC260 框架 3.0 附件 2「一、智能体安全风险」条款号（数据源：mapping/tc260-3.0.json）。 */
  tc260Risks: string[];
  /** 该规则**技术效能主张**的证据等级（不是事件的等级）。 */
  efficiencyGrade: Grade;
  efficiencyBasis: string;
}

// ── 条款映射（外置 JSON）─────────────────────────────────────────────
// fail-loud：条款文件缺失或被改坏时拒绝启动，而不是静默产出无依据的事件。
const MAPPING_PATH = resolve(HERE, '../mapping/tc260-3.0.json');

interface Tc260File {
  _meta: {
    annex: string;
    usage_rule: string;
    verification: Record<string, string>;
  };
  byCategory: Record<string, { tc260Measures: string[]; tc260Risks: string[] }>;
}

function loadTc260(): Tc260File {
  const j = JSON.parse(readFileSync(MAPPING_PATH, 'utf-8')) as Tc260File;
  if (!j.byCategory || !j._meta?.verification) {
    throw new Error(`mapping/tc260-3.0.json 结构不合法（缺 byCategory 或 _meta.verification）——条款映射不可静默缺位`);
  }
  return j;
}

const TC260 = loadTc260();

/** 取某类别的条款映射；未登记即抛错（调用方应先把新类别登记进 JSON）。 */
export function tc260For(category: string): { tc260Measures: string[]; tc260Risks: string[] } {
  const m = TC260.byCategory[category];
  if (!m) {
    throw new Error(
      `类别 "${category}" 未在 mapping/tc260-3.0.json 登记条款映射——` +
        `面板会展示无依据的行为。请先核对原文附件 2 后登记，再重跑。`,
    );
  }
  return m;
}

/** 条款文件元信息（供 /report 与证据卡展示核验来源）。 */
export function tc260Meta(): Tc260File['_meta'] {
  return TC260._meta;
}

export const RULE_BY_CATEGORY: Record<string, RuleRef> = {
  'tool-not-allowed': {
    ruleId: 'R1',
    ruleName: '准入门（工具白名单）',
    specRef: 'spec/02-architecture（能力注册与准入）',
    tc260Measures: tc260For('tool-not-allowed').tc260Measures,
    tc260Risks: tc260For('tool-not-allowed').tc260Risks,
    efficiencyGrade: 'A',
    efficiencyBasis: '确定性判定（白名单集合成员），demo [17] 可重跑验证；无需阈值标定',
  },
  'arg-policy-violation': {
    ruleId: 'R1',
    ruleName: '准入门（参数策略）',
    specRef: 'spec/02-architecture（参数策略）',
    tc260Measures: tc260For('arg-policy-violation').tc260Measures,
    tc260Risks: tc260For('arg-policy-violation').tc260Risks,
    efficiencyGrade: 'A',
    efficiencyBasis: '确定性判定（调用方声明式策略），demo [17] 可重跑验证',
  },
  'config-review-fail': {
    ruleId: 'R4',
    ruleName: '配置内容审查（配置权即攻击面）',
    specRef: 'spec/02-architecture 第四条',
    tc260Measures: tc260For('config-review-fail').tc260Measures,
    tc260Risks: tc260For('config-review-fail').tc260Risks,
    efficiencyGrade: 'A',
    efficiencyBasis:
      'AOE-DETECT-001（预注册 160 样本）：直检正例 50/50=100%、混淆类变体 77/77 未检出、常规良性 FPR 0/20；覆盖边界由规则结构决定',
  },
  'resource-over-budget': {
    ruleId: 'R2',
    ruleName: '出口门（结果资源预算）',
    specRef: 'spec/02-architecture（E5 出口裁决）；spec/10-resource-ledger（预算）',
    tc260Measures: tc260For('resource-over-budget').tc260Measures,
    tc260Risks: tc260For('resource-over-budget').tc260Risks,
    efficiencyGrade: 'A',
    efficiencyBasis: '确定性比较（actual > budget），demo [17] 可重跑验证',
  },
  'output-policy-violation': {
    ruleId: 'R2',
    ruleName: '出口门（输出策略）',
    specRef: 'spec/02-architecture（E5 出口裁决）',
    tc260Measures: tc260For('output-policy-violation').tc260Measures,
    tc260Risks: tc260For('output-policy-violation').tc260Risks,
    efficiencyGrade: 'A',
    efficiencyBasis: '确定性判定（输出策略谓词），demo [17] 可重跑验证',
  },
  'integrity-check-failed': {
    ruleId: 'R2',
    ruleName: '出口门（结果完整性）',
    specRef: 'spec/02-architecture E5；PRODUCTION-GAPS G4',
    tc260Measures: tc260For('integrity-check-failed').tc260Measures,
    tc260Risks: tc260For('integrity-check-failed').tc260Risks,
    efficiencyGrade: 'C',
    efficiencyBasis:
      '⚠️ 本实现中 integrityCheck 为注入钩子（默认恒真），本场景显式注入 false 以演示分支；真实 E5 需独立信任域签名比对——PRODUCTION-GAPS G4 未闭合，故效能无 A 级支撑',
  },
  'budget-exceeded': {
    ruleId: 'R3',
    ruleName: '资源账本（预算比）',
    specRef: 'spec/10-resource-ledger（信号①）',
    tc260Measures: tc260For('budget-exceeded').tc260Measures,
    tc260Risks: tc260For('budget-exceeded').tc260Risks,
    efficiencyGrade: 'A',
    efficiencyBasis: 'AOE-CALIB-001 影子比/预算阈值自复现标定；信号为审计而非拦截（spec/10 原文）',
  },
  'shadow-deviation': {
    ruleId: 'R3',
    ruleName: '资源账本（影子比）',
    specRef: 'spec/10-resource-ledger（信号②）',
    tc260Measures: tc260For('shadow-deviation').tc260Measures,
    tc260Risks: tc260For('shadow-deviation').tc260Risks,
    efficiencyGrade: 'A',
    efficiencyBasis:
      'AOE-CALIB-001 阈值标定；跨模型阈值跨度 1.00–1.98（AOE-CALIB-002 扩展实验），生产须按 provider 独立标定',
  },
  'memory-write-audited': {
    ruleId: 'R3',
    ruleName: '资源账本（记忆写入最高级审计）',
    specRef: 'spec/10-resource-ledger（信号③）',
    tc260Measures: tc260For('memory-write-audited').tc260Measures,
    tc260Risks: tc260For('memory-write-audited').tc260Risks,
    efficiencyGrade: 'A',
    efficiencyBasis: 'AOE-ABSTAIN-001/002 提供动机侧实证；本条为登记动作而非检出器，效能主张限于"写入必留痕"',
  },
};
