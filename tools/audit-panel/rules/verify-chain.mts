#!/usr/bin/env node
/**
 * verify-chain.mts（rules 入口）—— 落盘事件链验证的 **library 入口** + CLI
 *
 * 双形态：
 *   - 库：`import { verifyChainFile } from '../rules/verify-chain.mts'`（server 启动时当场验证快照）
 *   - CLI：node --experimental-transform-types tools/audit-panel/rules/verify-chain.mts [--file=] [--tamper-demo] [--source=]
 *
 * 实现只有一份：`./chain-core.mts`（v2.72.7 收口）。本文件此前自带一份完整实现，
 * 与 `../scenario/verify-chain.mts` 漂移 191 行、对「缺依据字段」判定相反；现在只剩再导出 + 守卫。
 *
 * 为什么加 `isEntryPoint` 守卫：本模块**被 server import**。守卫之前，`main()` 在顶层无条件执行，
 * server 一启动就先打印整段 CLI 验证报告，且验链失败会把 `process.exitCode = 1` 留给 server 进程——
 * 于是「验链失败」与「端口占用 / 数据缺失」共用同一个退出码信号。
 *
 * 退出码（CLI）：0 通过（--tamper-demo 时还要求演示确实检出篡改）；1 有失败 / 演示未检出 / 参数非法。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from '../cli-entry.mts';
import { runChainCli } from './chain-core.mts';

export { verifyChainFile, readEventFile } from './chain-core.mts';
export type { ChainFail, ChainVerifyResult, SourceProfile, VerifyOptions } from './chain-core.mts';

const HERE = dirname(fileURLToPath(import.meta.url));

if (isEntryPoint(import.meta.url)) {
  runChainCli(process.argv.slice(2), resolve(HERE, '../data/events.jsonl'));
}
