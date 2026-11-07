/**
 * cli-entry.mts —— 「本文件是不是被 `node` 直接执行」的判定（零依赖）
 *
 * 为什么需要它：被 `import` 的模块若在顶层调用 `main()`，导入方会连带执行 CLI 逻辑，
 * 既污染宿主输出，又把 `process.exitCode = 1` 留在宿主进程上。
 * v2.72.7 之前 `tools/audit-panel/rules/*.mts` 三处都是这种形态（server 一 import 就打印整段
 * 验证报告，验链失败还会让 server 以非 0 退出）。
 *
 * 判定方式（三重比较，任一命中即视为入口）：
 *   1. `fileURLToPath(import.meta.url)` === `resolve(process.argv[1])`
 *   2. 两者 realpath 相等（符号链接、目录联接）
 *   3. Windows 上大小写不敏感比较（8.3 短路径与盘符大小写）
 *
 * ⚠️ 守卫失效的后果不对称：判错成「不是入口」⇒ CLI 静默不执行且退出 0，
 *    即「检查没跑却被当成通过」——这是本仓库反复记录过的最坏失败形态。
 *    因此凡使用本函数的位置，都必须有一条门禁断言「CLI 仍然会执行」。
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : false;
}

export function isEntryPoint(metaUrl: string, arg1: string | undefined = process.argv[1]): boolean {
  if (!arg1) return false;

  let selfPath: string;
  try {
    selfPath = fileURLToPath(metaUrl);
  } catch {
    return false;
  }
  const argvPath = resolve(arg1);

  if (samePath(selfPath, argvPath)) return true;

  try {
    if (samePath(realpathSync(selfPath), realpathSync(argvPath))) return true;
  } catch {
    /* 任一侧不存在（如被删除）：退回直接比较 */
  }

  // 刻意不做「同文件名即入口」这类猜测：误判成入口会让库被导入时又跑一遍 CLI，
  // 与加守卫的初衷相反。判不出来就当作不是入口，由门禁的「CLI 仍活」断言兜住。
  return false;
}
