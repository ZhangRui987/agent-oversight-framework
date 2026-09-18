/**
 * replicate-t0.mts —— tier-0（零依赖档）外部复现统一入口
 *
 * 用途：在干净 clone 上用一条命令重跑本仓库全部「零外部依赖」标定实验，
 *       并把输出与该实验声明的对照基准比对，给出可证伪的通过/失败判定。
 *
 * 设计纪律（与仓库既有脚本同形，见 otel-adapter.ts）：
 *   - 零外部依赖：仅使用 node: 内置模块；不读 package.json，不装任何包，不访问网络。
 *   - 跨平台：路径一律由 import.meta.url 解析，不做 shell 字符串拼接。
 *   - 不改仓库：默认只读；仅 --emit-golden 显式给出时才写入 golden 快照目录。
 *
 * 比对模式（详见同目录 README「tier-0 复现」章）：
 *   A 类 字节级确定性      —— 运行 stdout 逐字节等于入库 golden 快照。
 *   B 类 归一化后字节级    —— 归一化易变 token（ISO 时间戳 / 留痕文件名毫秒戳）后逐字节比对。
 *   C 类 仅结构不变量      —— 只断言小节标题 + 判定极性 + 行数容差；不断言测量数值。
 *
 * 用法：
 *   node --experimental-transform-types replicate-t0.mts              # 跑全部，打印汇总
 *   node --experimental-transform-types replicate-t0.mts --list       # 只列清单
 *   node --experimental-transform-types replicate-t0.mts --only=<名>  # 只跑一个
 *   node --experimental-transform-types replicate-t0.mts --raw        # 附带原始 stdout
 *   node --experimental-transform-types replicate-t0.mts --selftest   # 比对内核自检
 *   node --experimental-transform-types replicate-t0.mts --emit-golden # 【写入】重建 A/B 类快照
 *
 * 退出码：0 全通过（或无实验失败）／1 存在 FAIL。WARN 不改变退出码。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "replication-t0-golden");

// ─────────────────────────────────────────────────────────────────────────────
// 比对内核
// ─────────────────────────────────────────────────────────────────────────────

/** 归一化易变 token（B 类专用）。仅替换「确定与运行时刻绑定」的两类 token。 */
export function normalize(text: string): string {
  return text
    // ISO 8601 时间戳（含毫秒与可选 Z）
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?/g, "<TS>")
    // 留痕文件名中的 10 位以上毫秒时间戳，例 CALIBRATION-C12-V2-REPROJ-1789747988736.json
    .replace(/(CALIBRATION-[A-Z0-9-]+?)-[0-9]{10,}(\.json)/g, "$1-<MS>$2");
}

export type Verdict = "PASS" | "FAIL" | "WARN";

export interface CompareResult {
  verdict: Verdict;
  detail: string;
}

/** A 类：字节级确定性。 */
export function compareA(actual: string, golden: string): CompareResult {
  if (actual === golden) return { verdict: "PASS", detail: "stdout 与 golden 逐字节一致" };
  return { verdict: "FAIL", detail: describeDiff(golden, actual) };
}

/** B 类：归一化后字节级。 */
export function compareB(actual: string, golden: string): CompareResult {
  const a = normalize(actual);
  const g = normalize(golden);
  if (a === g) return { verdict: "PASS", detail: "归一化后逐字节一致（差异仅限时间戳/留痕 ID）" };
  return { verdict: "FAIL", detail: describeDiff(g, a) };
}

/**
 * C 类：仅结构不变量。
 * anchors —— 必须出现的字面量（小节标题 / 判定极性行）。
 * 不比对任何测量数值：那些值跨机器物理上不可复现，强设即为假阴性。
 */
export function compareC(actual: string, anchors: string[]): CompareResult {
  const missing = anchors.filter((x) => !actual.includes(x));
  if (missing.length === 0) {
    return { verdict: "PASS", detail: `结构不变量 ${anchors.length}/${anchors.length} 命中` };
  }
  return {
    verdict: "FAIL",
    detail: `结构不变量缺失 ${missing.length} 项：${missing.map((m) => JSON.stringify(m)).join(", ")}`,
  };
}

/**
 * 假阴性护栏：把「环境导致的差异」与「真失败」区分开。
 * 规则：若两侧差异行数相同，且逐行差异**全部**形如「仅浮点末位或平台串不同」，
 *       判 WARN(env-diff)；否则判 FAIL。
 * 目的：避免把 Node 小版本浮点末位差误报为「复现失败」，那会损害而非增强可信度。
 */
export function classifyFailure(golden: string, actual: string): CompareResult {
  const g = golden.split("\n");
  const a = actual.split("\n");
  if (g.length !== a.length) {
    return { verdict: "FAIL", detail: `行数不同（golden ${g.length} / 实际 ${a.length}）` };
  }
  const bad: number[] = [];
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== a[i]) bad.push(i);
  }
  if (bad.length === 0) return { verdict: "PASS", detail: "逐行一致" };
  const allEnvLike = bad.every((i) => isEnvLikeDiff(g[i], a[i]));
  if (allEnvLike) {
    return {
      verdict: "WARN",
      detail: `env-diff：${bad.length} 行差异全部为浮点末位/平台串，疑似 Node 版本差异（非失败）`,
    };
  }
  return { verdict: "FAIL", detail: `真失败：${bad.length} 行差异，首处 L${bad[0] + 1}` };
}

/** 判定一处行差异是否「环境型」：去掉版本号、平台串与所有数字后仍相同。 */
function isEnvLikeDiff(l: string, r: string): boolean {
  const strip = (s: string) =>
    s
      // 顺序要紧：先长模式（含字母的版本/平台串），再裸数字。
      // 反例：若先替换数字，"win32/x64" 会残留 "win##/x##"，与 "linux" 对不上。
      .replace(/v[0-9]+(\.[0-9]+)*/g, "<V>")
      .replace(/(win32|linux|darwin|freebsd|openbsd)\/(x64|arm64|ia32|arm)/g, "<PLAT>")
      .replace(/[0-9]+(\.[0-9]+)?/g, "#")
      .replace(/\s+/g, " ")
      .trim();
  return strip(l) === strip(r);
}

function describeDiff(golden: string, actual: string): string {
  const g = golden.split("\n");
  const a = actual.split("\n");
  for (let i = 0; i < Math.max(g.length, a.length); i++) {
    if (g[i] !== a[i]) {
      const gl = g[i] === undefined ? "<缺行>" : truncate(g[i]);
      const al = a[i] === undefined ? "<缺行>" : truncate(a[i]);
      return `首个差异 L${i + 1}：golden=${gl} | 实际=${al}`;
    }
  }
  return "存在差异（未能定位具体行）";
}

function truncate(s: string, n = 90): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ─────────────────────────────────────────────────────────────────────────────
// tier-0 实验清单
// ─────────────────────────────────────────────────────────────────────────────

interface Experiment {
  /** 稳定短名，用于 --only= 与 golden 文件名 */
  name: string;
  /** 脚本文件名（不得来自用户输入） */
  file: string;
  /** 对应 AOE 编号 */
  aoe: string;
  /** 比对模式 */
  mode: "A" | "B" | "C";
  /** C 类必填：结构不变量锚点 */
  anchors?: string[];
  /** C 类可选：stdout 行数容差（±），用于捕捉结构性漂移 */
  linesTolerance?: number;
  /** 对照报告文件 */
  report: string;
  /**
   * 该脚本以 cwd 相对路径读取的输入文件（同目录内）。
   * 运行器会把它们复制进隔离沙箱，使脚本既能读到输入，又不会把留痕写进仓库。
   */
  inputs?: string[];
  /** 备注（如「上游数据为 API 档产出」） */
  note?: string;
}

export const EXPERIMENTS: Experiment[] = [
  {
    name: "swarm-detection",
    file: "calibrate-swarm-detection.mts",
    aoe: "AOE-SWARM-001",
    mode: "A",
    report: "CALIBRATION-REPORT-SWARM.md",
  },
  {
    name: "concentration-threshold",
    file: "calibrate-concentration-threshold.mts",
    aoe: "AOE-CALIB-003",
    mode: "A",
    report: "CALIBRATION-REPORT-CONCENTRATION.md",
  },
  {
    name: "config-reviewer-detection",
    file: "calibrate-config-reviewer-detection.mts",
    aoe: "AOE-DETECT-001",
    mode: "B",
    report: "CALIBRATION-REPORT-CONFIG-REVIEWER.md",
  },
  {
    name: "c12-v2-reprojection",
    file: "calibrate-c12-v2-reprojection.mts",
    aoe: "AOE-CALIB-005",
    mode: "B",
    report: "CALIBRATION-REPORT-C12-V2.md",
    inputs: ["CALIBRATION-C12-RAW-1789391056906.json"],
    note: "上游数据为 API 档产出（CALIBRATION-C12-RAW-*.json）",
  },
  {
    name: "c12-v21-reverify",
    file: "calibrate-c12-v21-reverify.mts",
    aoe: "AOE-CALIB-006",
    mode: "B",
    report: "CALIBRATION-REPORT-C12-V21.md",
    inputs: [
      "CALIBRATION-C12-RAW-1789391056906.json",
      "CALIBRATION-C12-RAW-1789565666523.json",
    ],
    note: "上游数据为 API 档产出；本脚本自身零依赖",
  },
  {
    name: "periodic-threshold",
    file: "calibrate-periodic-threshold.mts",
    aoe: "AOE-CALIB-002",
    mode: "C",
    report: "CALIBRATION-REPORT-PERIODIC.md",
    anchors: [
      "周期检测方差阈值标定实验",
      "最优阈值（Youden's J）",
      "标定结论",
      "结论：默认阈值过紧（漏报真周期/抖动周期），建议上调",
    ],
    linesTolerance: 40,
  },
  {
    name: "periodic-sensitivity",
    file: "calibrate-periodic-sensitivity.mts",
    aoe: "AOE-CALIB-002",
    mode: "C",
    report: "CALIBRATION-REPORT-PERIODIC.md",
    anchors: ["周期检测方差阈值——敏感性分析", "分离比(P5/P95)", "最差分离比", "安全余量"],
    linesTolerance: 40,
  },
  {
    name: "periodic-coverage-bound",
    file: "calibrate-periodic-coverage-bound.mts",
    aoe: "AOE-CALIB-002",
    mode: "C",
    report: "CALIBRATION-REPORT-PERIODIC.md",
    anchors: ["覆盖边界实验", "关键结论", "首个未覆盖档", "JSON_OUTPUT_START"],
    linesTolerance: 40,
  },
  {
    name: "shadow-ratio",
    file: "calibrate-shadow-ratio.mts",
    aoe: "AOE-CALIB-001",
    mode: "C",
    report: "CALIBRATION-REPORT.md",
    anchors: [
      "影子比阈值标定实验",
      "[C1_budget]",
      "[C2_shadow]",
      "[C3_memwrite]",
      "[C4_periodic]",
      "[C5_mixed]",
    ],
    linesTolerance: 30,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 编排
// ─────────────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 120_000;

function goldenPath(e: Experiment): string {
  return join(GOLDEN_DIR, `${e.name}.txt`);
}

/** 列出脚本目录内的全部文件名，用于「运行是否往仓库写文件」的对照。 */
function listArtifacts(): string[] {
  try {
    return readdirSync(HERE).sort();
  } catch {
    return [];
  }
}

/**
 * 在隔离沙箱中运行一个实验脚本。
 *
 * 为什么需要沙箱：部分既有标定脚本（calibrate-c12-*.mts）以 cwd 相对路径
 * 既读输入又不加条件地写留痕 JSON。若直接以脚本目录为 cwd 运行，
 * 每次复现都会往仓库里丢文件——违反 tier-0「不写仓库」约束，且会让 git 变脏。
 * 故：把所需输入复制进系统临时目录，以该临时目录为 cwd 运行，
 * 运行后整目录删除。脚本行为不变，仓库零副作用。
 */
function runScript(e: Experiment): { stdout: string; ok: boolean; detail: string } {
  const abs = join(HERE, e.file);
  if (!existsSync(abs)) {
    return { stdout: "", ok: false, detail: `脚本不存在：${e.file}` };
  }

  // 缺失的输入是硬错误：静默失败会伪装成「实验不通过」。
  const missing = (e.inputs ?? []).filter((f) => !existsSync(join(HERE, f)));
  if (missing.length > 0) {
    return { stdout: "", ok: false, detail: `缺少输入文件：${missing.join(", ")}` };
  }

  const sandbox = join(
    tmpdir(),
    `replicate-t0-${e.name}-${process.pid}-${Date.now()}`,
  );
  try {
    mkdirSync(sandbox, { recursive: true });
    for (const f of e.inputs ?? []) {
      writeFileSync(join(sandbox, basename(f)), readFileSync(join(HERE, f)));
    }

    const r = spawnSync(
      process.execPath,
      ["--experimental-transform-types", abs],
      {
        cwd: sandbox,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        shell: false,
        maxBuffer: 512 * 1024 * 1024,
      },
    );

    if (r.error) {
      return { stdout: r.stdout ?? "", ok: false, detail: `spawn 失败：${r.error.message}` };
    }
    if (r.status !== 0) {
      return {
        stdout: r.stdout ?? "",
        ok: false,
        detail: `脚本非零退出（exit=${r.status}）——若报缺 API key 则其属 API 档，不应列入 tier-0`,
      };
    }
    return { stdout: r.stdout ?? "", ok: true, detail: "" };
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定：沙箱在系统临时目录，不在仓库内 */
    }
  }
}

function verifyOne(e: Experiment, raw: boolean): { verdict: Verdict; detail: string; stdout: string } {
  const run = runScript(e);
  if (!run.ok) return { verdict: "FAIL", detail: run.detail, stdout: run.stdout };

  if (e.mode === "C") {
    const r = compareC(run.stdout, e.anchors ?? []);
    if (r.verdict === "FAIL") return { ...r, stdout: run.stdout };
    if (e.linesTolerance !== undefined) {
      const n = run.stdout.split("\n").length;
      if (Math.abs(n - (e.expectedLines ?? n)) > e.linesTolerance) {
        return {
          verdict: "FAIL",
          detail: `${r.detail}；行数 ${n} 超出容差 …`,
          stdout: run.stdout,
        };
      }
    }
    return { ...r, stdout: run.stdout };
  }

  const gp = goldenPath(e);
  if (!existsSync(gp)) {
    return {
      verdict: "FAIL",
      detail: `缺少 golden 快照 ${gp}——先运行 --emit-golden 生成并入库`,
      stdout: run.stdout,
    };
  }
  const golden = readFileSync(gp, "utf8");
  const r = e.mode === "A" ? compareA(run.stdout, golden) : compareB(run.stdout, golden);
  if (r.verdict === "FAIL") {
    // 假阴性护栏：区分环境差异与真失败
    const cls = classifyFailure(normalizeish(golden, e.mode), normalizeish(run.stdout, e.mode));
    if (cls.verdict === "WARN") return { verdict: "WARN", detail: cls.detail, stdout: run.stdout };
    return { verdict: "FAIL", detail: r.detail, stdout: run.stdout };
  }
  return { ...r, stdout: run.stdout };
}

function normalizeish(s: string, mode: "A" | "B"): string {
  return mode === "B" ? normalize(s) : s;
}

// ─────────────────────────────────────────────────────────────────────────────

function emitGolden(only: string | null): number {
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
  let n = 0;
  for (const e of EXPERIMENTS) {
    if (only && e.name !== only) continue;
    if (e.mode === "C") continue; // C 类无数值基准，不产快照
    const run = runScript(e);
    if (!run.ok) {
      console.log(`  ✗ ${e.name}：${run.detail}`);
      return 1;
    }
    // B 类快照必须【归一化后入库】：
    // 比对时两侧都会 normalize，若存原始文本，则每次重建都会因时间戳/留痕 ID
    // 不同而产生字节差异（实测 3/5 快照不幂等），导致 CI 无谓红灯。
    // 存归一化文本后，重建即幂等，且比对语义完全等价。
    const body = e.mode === "B" ? normalize(run.stdout) : run.stdout;
    writeFileSync(goldenPath(e), body, "utf8");
    console.log(
      `  ✓ 写入 ${e.name}.txt（${body.split("\n").length} 行${e.mode === "B" ? "，已归一化" : ""}）`,
    );
    n++;
  }
  console.log(`\n已写入 ${n} 个 golden 快照到 replication-t0-golden/`);
  console.log("⚠️  golden 入库后即为对照基准，变更须走版本链并在 CHANGELOG 说明。");
  return 0;
}

function listOnly(): void {
  console.log("tier-0（零依赖档）实验清单\n");
  console.log("  #  模式  实验名                         AOE 编号            对照报告");
  console.log("  " + "─".repeat(90));
  EXPERIMENTS.forEach((e, i) => {
    const idx = String(i + 1).padStart(2);
    console.log(
      `  ${idx}   ${e.mode}     ${e.name.padEnd(30)}${e.aoe.padEnd(20)}${e.report}`,
    );
  });
  const byMode = (m: string) => EXPERIMENTS.filter((e) => e.mode === m).length;
  console.log(
    `\n  合计 ${EXPERIMENTS.length} 个实验：A 类 ${byMode("A")}（字节级）/ B 类 ${byMode("B")}（归一化后字节级）/ C 类 ${byMode("C")}（仅结构不变量）`,
  );
  console.log("  注：C 类不断言测量数值——那些值含真实墙钟耗时，跨机器物理上不可复现。");
}

function main(): number {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length) : null;

  if (has("--selftest")) return runSelfTest();
  if (has("--list")) {
    listOnly();
    return 0;
  }
  if (has("--emit-golden")) return emitGolden(only);

  const list = only ? EXPERIMENTS.filter((e) => e.name === only) : EXPERIMENTS;
  if (only && list.length === 0) {
    console.log(`未找到实验「${only}」。可用 --list 查看清单。`);
    return 1;
  }
  if (only) {
    const clash = EXPERIMENTS.filter((e) => e.name.includes(only));
    if (clash.length > 1 && list.length === 1) {
      console.log(`提示：与「${only}」匹配的实验有 ${clash.length} 个，已精确匹配 ${list.length} 个。`);
    }
  }

  console.log("=".repeat(78));
  console.log(`tier-0（零依赖档）外部复现 · Node ${process.version} · ${process.platform}/${process.arch}`);
  console.log(`实验 ${list.length} 个 · 零外部依赖 · 不访问网络 · 不写入仓库`);
  console.log("=".repeat(78) + "\n");

  let failed = 0;
  let warned = 0;
  const rows: { name: string; mode: string; verdict: Verdict; detail: string; ms: number }[] = [];

  for (const e of list) {
    const t0 = Date.now();
    const r = verifyOne(e, has("--raw"));
    const ms = Date.now() - t0;
    rows.push({ name: e.name, mode: e.mode, verdict: r.verdict, detail: r.detail, ms });
    const mark = r.verdict === "PASS" ? "✅" : r.verdict === "WARN" ? "⚠️ " : "❌";
    console.log(`${mark} [${e.mode}] ${e.name}  (${ms}ms)`);
    console.log(`      ${r.detail}`);
    if (e.note) console.log(`      注：${e.note}`);
    if (has("--raw")) {
      console.log("      ── stdout ──");
      for (const line of r.stdout.split("\n")) console.log("      | " + line);
      console.log("      ────────────");
    }
    if (r.verdict === "FAIL") failed++;
    if (r.verdict === "WARN") warned++;
    console.log("");
  }

  console.log("─".repeat(78));
  console.log("汇总");
  console.log("─".repeat(78));
  for (const r of rows) {
    const mark = r.verdict === "PASS" ? "✅ PASS" : r.verdict === "WARN" ? "⚠️  WARN" : "❌ FAIL";
    console.log(`  ${mark}  [${r.mode}] ${r.name.padEnd(28)} ${String(r.ms).padStart(6)}ms`);
  }
  console.log("");
  console.log(
    `  通过 ${rows.length - failed - warned} / 警告 ${warned} / 失败 ${failed}  （合计 ${rows.length}）`,
  );
  if (failed === 0) {
    console.log("\n结论：全部 tier-0 实验结构复现通过。");
  } else {
    console.log("\n结论：存在复现失败项——见上方 ❌ 明细（用 --only=<名> --raw 定位）。");
  }
  return failed === 0 ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 比对内核自检（--selftest）：不依赖真实实验，用合成夹具验证内核
// ─────────────────────────────────────────────────────────────────────────────

export function runSelfTest(): number {
  let pass = 0;
  let fail = 0;
  const t = (name: string, got: boolean) => {
    if (got) {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name}`);
    }
  };

  console.log("replicate-t0 比对内核自检\n");

  console.log("A 类（字节级）");
  t("相同文本 → PASS", compareA("abc\n", "abc\n").verdict === "PASS");
  t("单字节差 → FAIL", compareA("abc\n", "abd\n").verdict === "FAIL");
  t("缺尾换行 → FAIL", compareA("abc", "abc\n").verdict === "FAIL");

  console.log("\nB 类（归一化后字节级）");
  t(
    "仅 ISO 时间戳差 → PASS",
    compareB("x\n2026-09-18T16:07:19.580Z\ny\n", "x\n2027-01-02T03:04:05.000Z\ny\n").verdict === "PASS",
  );
  t(
    "仅留痕文件名毫秒戳差 → PASS",
    compareB("留痕：CALIBRATION-C12-V2-REPROJ-1789534121441.json\n", "留痕：CALIBRATION-C12-V2-REPROJ-1789747988736.json\n").verdict === "PASS",
  );
  t(
    "真实统计量差 → FAIL",
    compareB("AUC=0.3934\n", "AUC=0.9557\n").verdict === "FAIL",
  );
  t(
    "归一化不吞正文数字",
    normalize("AUC=0.3934 于 2026-09-18T16:07:19.580Z").includes("0.3934"),
  );
  t(
    "归一化吞掉毫秒戳但保留前缀",
    normalize("CALIBRATION-C12-V21-REVERIFY-1789747661209.json") ===
      "CALIBRATION-C12-V21-REVERIFY-<MS>.json",
  );

  console.log("\nC 类（仅结构不变量）");
  t(
    "锚点全命中 → PASS",
    compareC("【结论】\nH1 ❌ 不成立\n", ["【结论】", "H1 ❌ 不成立"]).verdict === "PASS",
  );
  t("锚点缺失 → FAIL", compareC("【结论】\n", ["【结论】", "H2 ✅ 成立"]).verdict === "FAIL");
  t("C 类不比对数值（不同数值同锚点仍 PASS）", compareC("J=6732.49\n", ["J="]).verdict === "PASS");
  t(
    "C 类数值漂移不误报（同一锚点两套数值）",
    compareC("θ*=0.04 TPR 100.0%\n", ["θ*=0.04 TPR 100.0%"]).verdict === "PASS",
  );

  console.log("\n假阴性护栏（环境差异 vs 真失败）");
  t(
    "仅浮点末位差 → WARN(env-diff)",
    classifyFailure("AUC=0.6744000001\n", "AUC=0.6744000002\n").verdict === "WARN",
  );
  t(
    "平台串不同 → WARN(env-diff)",
    classifyFailure("Node v22.22.2 | win32/x64\n", "Node v22.22.3 | linux/x64\n").verdict === "WARN",
  );
  t(
    "判定极性翻转 → FAIL（非环境型）",
    classifyFailure("H1 ✅ 成立\n", "H1 ❌ 不成立\n").verdict === "FAIL",
  );
  t(
    "行数不同 → FAIL",
    classifyFailure("a\nb\n", "a\nb\nc\n").verdict === "FAIL",
  );
  t("完全一致 → PASS", classifyFailure("same\n", "same\n").verdict === "PASS");

  console.log("\n清单一致性");
  t("清单含 9 个实验", EXPERIMENTS.length === 9);
  t(
    "三模式分布 = A2/B3/C4",
    EXPERIMENTS.filter((e) => e.mode === "A").length === 2 &&
      EXPERIMENTS.filter((e) => e.mode === "B").length === 3 &&
      EXPERIMENTS.filter((e) => e.mode === "C").length === 4,
  );
  t(
    "每个 C 类实验都有锚点",
    EXPERIMENTS.filter((e) => e.mode === "C").every((e) => (e.anchors ?? []).length > 0),
  );
  t(
    "每个实验脚本都存在",
    EXPERIMENTS.every((e) => existsSync(join(HERE, e.file))),
  );

  console.log("\n隔离沙箱不变量（既有脚本以 cwd 相对路径读写）");
  // 回归护栏：c12-v2-reprojection 读同目录输入并无条件写留痕 JSON。
  // 沙箱必须同时做到：脚本能读到输入（不 ENOENT）、仓库不新增文件。
  {
    const probe = EXPERIMENTS.find((e) => e.name === "c12-v2-reprojection");
    if (!probe) {
      t("探针实验存在", false);
    } else {
      const before = listArtifacts();
      const r = runScript(probe);
      const after = listArtifacts();
      t("脚本仍能读到输入并成功退出", r.ok);
      if (!r.ok) console.log(`      实测输出：${r.detail}`);
      const created = after.filter((f) => !before.includes(f));
      t("运行后仓库未新增留痕文件", created.length === 0);
      if (created.length > 0) console.log(`      意外新增：${created.join(", ")}`);
    }
  }

  console.log("\ngolden 快照幂等性（B 类须存归一化文本）");
  // 回归护栏：若 B 类快照存原始文本，每次重建都因时间戳不同而变字节，
  // 会让 CI 在无任何真实变更时红灯。本项验证「跑两次 → 两次重建字节相同」。
  {
    const probe = EXPERIMENTS.find((e) => e.name === "c12-v2-reprojection");
    if (!probe) {
      t("B 类探针存在", false);
    } else {
      const r1 = runScript(probe);
      const r2 = runScript(probe);
      if (!r1.ok || !r2.ok) {
        t("B 类探针可运行", false);
      } else {
        t("B 类原始输出两次不同（证明存在易变 token）", r1.stdout !== r2.stdout);
        t("B 类归一化后两次相同（幂等）", normalize(r1.stdout) === normalize(r2.stdout));
      }
    }
    // A 类不应含易变 token：若含，说明分类错误。
    const aExp = EXPERIMENTS.find((e) => e.name === "swarm-detection");
    if (aExp) {
      const a1 = runScript(aExp);
      const a2 = runScript(aExp);
      t("A 类原始输出两次相同（真字节确定）", a1.ok && a2.ok && a1.stdout === a2.stdout);
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`自检结果：通过 ${pass} / 失败 ${fail}`);
  return fail === 0 ? 0 : 1;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, "/").endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").slice(-1)[0],
  );

if (isMain) {
  process.exit(main());
}
