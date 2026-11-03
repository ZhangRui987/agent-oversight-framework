/**
 * rule-map.mts —— category → 规则映射表（V1 导出器与 V2 runner 共用的单一真相源）
 *
 * 从 export-events.mts 抽出（v2.56.0 轮）：两处各自维护同一张表必然漂移。
 * 条款号来源：《人工智能安全治理框架 3.0》附件 2（p.38–45），逐条对照原文核对；
 * 修改任何条款号必须回到原文 PDF 重新核对，核验记录见 tools/audit-panel/README.md。
 */

export type Grade = 'A' | 'B' | 'C' | 'D' | 'G';

export interface RuleRef {
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

export const RULE_BY_CATEGORY: Record<string, RuleRef> = {
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
