#!/usr/bin/env node
/**
 * verify-chain.mts（scenario 入口）—— 落盘事件链的独立验证器 · **CLI 入口**
 *
 * 兑现 export-events.mts 在 meta.chain.recompute_recipe 里的承诺：任何人拿 events.jsonl
 * 都能按同一规则重算链哈希，不需要相信导出器。
 *
 * 实现只有一份：`../rules/chain-core.mts`（v2.72.7 收口）。
 * 本文件曾经自带一份完整实现，与本目录之外的 rules 版本漂移 191 行、且判定相反；
 * 现在它只负责「按本目录解析默认文件」并转交 CLI 运行时。
 *
 * 用法：
 *   node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts
 *   node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --file=<路径>
 *   node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --tamper-demo
 *   node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --source=session --file=<V2 文件>
 *
 * 入口口径（--source）：缺省 scenario（要求 source_scenario，对应 data/events.jsonl）；
 * 验 data/realagent-events.jsonl 这类只有 session_id 的流必须显式 --source=session。
 *
 * 退出码：0 验链通过（--tamper-demo 时还要求演示确实检出篡改）；1 有失败 / 演示未检出 / 参数非法。
 * 详见 ../rules/chain-core.mts 头注释。
 *
 * 本文件是**纯入口**：不导出任何东西、也不被任何模块 import，故不加 `isEntryPoint` 守卫——
 * 守卫若判错会让命令静默不执行并退出 0，对纯入口是净风险。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChainCli } from '../rules/chain-core.mts';

const HERE = dirname(fileURLToPath(import.meta.url));

runChainCli(process.argv.slice(2), resolve(HERE, '../data/events.jsonl'));
