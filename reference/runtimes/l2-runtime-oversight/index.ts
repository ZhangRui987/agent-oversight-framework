/**
 * l2-runtime-oversight —— agent-oversight-framework 的 L2 运行时监察最小参照实现
 * ================================================================================
 * 机制提炼自 OpenMAIC 的 lib/server/agent-runtime/runner.ts（集中调度式 Agent 运行器），
 * 按本框架 spec/02（五层结构与两条审计线）、spec/09（看门狗/二号/三号）、
 * spec/10（资源账本）的术语与边界改写，作为「L2 运行时监察长什么样」的可运行工程范例。
 *
 * 设计定位（与框架一致）：
 *   - 本实现是「L2 运行时监察」的设计草图，不是沙箱、不是规则引擎、不是观测平台。
 *   - 判定全部是确定性硬规则（租约/心跳/事件序/白名单），不依赖任何 AI 判断——
 *     这是 spec/09「看门狗不可被 AI 关闭」的直接落地。
 *
 * 诚实边界（呼应 spec/13 的诚实传统，**逐项详解见同目录 PRODUCTION-GAPS.md**）：
 *   - 租约权威：内存 InMemoryLeaseAuthority（纯内存场景）或 SqliteLeaseAuthority（G1 演示级闭合，
 *     Node 22+ 内置 node:sqlite，崩溃后可恢复）；生产应换 PostgreSQL 或独立信任域存储。
 *   - 审计链为 append-only + SHA-256 哈希链（G2 演示级闭合，node:crypto）；
 *     未做 E1 内核侧采集（spec/02）/ E5 独立信任域固化，对抗性多 Agent 场景（P3）下               ← G3 / G4
 *     不能单独用作信任根。
 *   - 无资源账本（预算比/影子比/记忆写入审计，spec/10）、无三号公证机（spec/09 要求                ← G5 / G6
 *     独立硬件信任域 + 三号甲/乙拆分）、无信用分与信用回避（spec/04）、无群治理（spec/07）。        ← G7 / G8
 *
 * G1、G2 已演示级闭合（SQLite 持久化 + SHA-256）；G3–G8 需外部系统配合。
 * 完整说明见同目录 PRODUCTION-GAPS.md。
 *
 * 许可证：Apache License 2.0（代码路径，见 LICENSING.md 的路径 ↔ 许可证映射）。
 * 无外部依赖，纯 TypeScript 接口 + 内存参考实现，Node 22+ 可直接运行。
 */

// ============================================================================
// 0. 公共类型
// ============================================================================

/** 任意可序列化事件（审计载荷）。 */
export interface AuditEvent {
  readonly type: string;
  readonly data: unknown;
  readonly ts: number;
}

/** owner 对某资源的访问裁决 —— 对应「不经过一号文书」的责任锚定。 */
export type AccessVerdict =
  | { kind: 'owned'; resourceName: string }
  | { kind: 'foreign' } // 属于别人，禁止
  | { kind: 'missing' } // 不存在
  | { kind: 'tombstoned' }; // 已删除

/** 生命周期事件类型集合（事件序 tripwire 的白名单）。 */
export const LIFECYCLE_EVENTS = new Set<string>([
  'session_start',
  'session_resumed',
  'session_interrupted',
  'session_end',
]);

/** 租约丢失错误 —— 不依赖任何 AI 判断的确定性失败信号。 */
export class LeaseLostError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly workerId: string,
    public readonly attempt: number,
  ) {
    super(`lease lost: session=${sessionId} worker=${workerId} attempt=${attempt}`);
    this.name = 'LeaseLostError';
  }
}

export function isLeaseLostError(err: unknown): boolean {
  let cur: unknown = err;
  const seen = new WeakSet<object>();
  while (cur && typeof cur === 'object' && !seen.has(cur as object)) {
    if (cur instanceof LeaseLostError) return true;
    seen.add(cur as object);
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// ============================================================================
// 1. LeaseAuthority —— 对应 L2 看门狗「确定性硬闸门」+「PG 为权威」
//    spec/09-oversight.md: 看门狗不依赖任何 AI 判断；租约/心跳是确定性规则。
// ============================================================================

export interface ClaimOptions {
  leaseTtlMs: number;
  maxAttempts: number;
}

export interface ClaimedSession {
  id: string;
  ownerId: string;
  attempt: number;
  claimSeq: number;
  lease: { workerId: string; generation: number; expiresAt: number };
}

/**
 * 租约权威。OpenMAIC 用 PostgreSQL 当权威；此处用内存占位，
 * 接口形态刻意贴近其 store.claimNextSession / heartbeat / releaseLease。
 */
export interface LeaseAuthority {
  /** 抢占下一个待处理会话；无可抢占返回 null。 */
  claimNext(workerId: string, pid: number, opts: ClaimOptions): Promise<ClaimedSession | null>;
  /** 续租；返回 false 表示租约已不在本 worker 手中（被窃取/过期）。 */
  heartbeat(id: string, workerId: string): Promise<boolean>;
  /** 释放租约（正常结束或放弃）。 */
  release(id: string, workerId: string): Promise<void>;
  /** 检查 (session, worker, attempt) 是否仍持有当前代际租约。 */
  assertActiveLease(id: string, workerId: string, attempt: number): Promise<void>;
}

/** 内存参考实现（占位，非生产）。 */
export class InMemoryLeaseAuthority implements LeaseAuthority {
  private sessions = new Map<string, ClaimedSession>();
  private pending: ClaimedSession[] = [];
  private gen = 0;

  constructor(private readonly ttlMs: number) {}

  /** Demo/test 辅助：入队一个待抢占会话（真实实现里由扫描循环提交）。 */
  submit(id: string, ownerId: string, attempt = 1): void {
    this.pending.push({
      id,
      ownerId,
      attempt,
      claimSeq: this.pending.length + 1,
      lease: { workerId: '', generation: 0, expiresAt: 0 },
    });
  }

  async claimNext(workerId: string): Promise<ClaimedSession | null> {
    const next = this.pending.shift();
    if (!next) return null;
    next.lease = { workerId, generation: ++this.gen, expiresAt: Date.now() + this.ttlMs };
    this.sessions.set(next.id, next);
    return next;
  }
  async heartbeat(id: string, workerId: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.lease.workerId !== workerId) return false;
    s.lease.expiresAt = Date.now() + this.ttlMs;
    return true;
  }
  async release(id: string, workerId: string): Promise<void> {
    this.sessions.delete(id);
  }
  async assertActiveLease(id: string, workerId: string, attempt: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.lease.workerId !== workerId || s.attempt !== attempt) {
      throw new LeaseLostError(id, workerId, attempt);
    }
  }
}

// ============================================================================
// 1b. SqliteLeaseAuthority —— LeaseAuthority 的 SQLite 持久化实现
//     覆盖 G1（租约权威存储从内存升级到磁盘持久化）：
//       - 进程崩溃后租约状态可恢复（关键差距闭合）；
//       - 同接口形态——替换后端不改任何监察逻辑。
//     使用 Node 22+ 内置的 node:sqlite（实验性 API，零外部依赖）。
//     生产环境应换 PostgreSQL（独立进程 / 独立信任域）——本实现是演示级持久化。
//
//     ⚠️ node:sqlite 在 Node 22 中为实验性 API，运行时需要：
//        node --experimental-sqlite demo.ts
//     若 Node 版本不支持或未启用该 flag，本类构造会抛错——
//     调用方应 fallback 到 InMemoryLeaseAuthority 或 PostgresLeaseAuthority。
// ============================================================================

import { DatabaseSync } from 'node:sqlite';

export class SqliteLeaseAuthority implements LeaseAuthority {
  private readonly db: DatabaseSync;
  private gen = 0;

  /**
   * @param dbPath SQLite 数据库文件路径。传 ':memory:' 即纯内存（同 InMemory 但走 SQLite 引擎）。
   * @param ttlMs 租约 TTL（与 InMemoryLeaseAuthority 一致）。
   */
  constructor(
    dbPath: string,
    private readonly ttlMs: number,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        claimSeq INTEGER NOT NULL,
        workerId TEXT NOT NULL,
        generation INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'leased'
      );
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        claimSeq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO meta(key, value) VALUES('gen', 0);
    `);
  }

  /** Demo/test 辅助：入队一个待抢占会话（真实实现里由扫描循环提交）。 */
  submit(id: string, ownerId: string, attempt = 1): void {
    const claimSeq = (this.db.prepare('SELECT COUNT(*) AS n FROM pending').get() as { n: number }).n + 1;
    this.db.prepare('INSERT OR REPLACE INTO pending(id, ownerId, attempt, claimSeq) VALUES(?,?,?,?)')
      .run(id, ownerId, attempt, claimSeq);
  }

  async claimNext(workerId: string): Promise<ClaimedSession | null> {
    const next = this.db.prepare('SELECT * FROM pending ORDER BY claimSeq ASC LIMIT 1').get() as
      | { id: string; ownerId: string; attempt: number; claimSeq: number }
      | undefined;
    if (!next) return null;
    this.gen = (this.db.prepare("SELECT value FROM meta WHERE key='gen'").get() as { value: number }).value + 1;
    this.db.prepare("UPDATE meta SET value=? WHERE key='gen'").run(this.gen);
    const expiresAt = Date.now() + this.ttlMs;
    this.db.prepare('INSERT OR REPLACE INTO sessions(id, ownerId, attempt, claimSeq, workerId, generation, expiresAt, status) VALUES(?,?,?,?,?,?,?,?)')
      .run(next.id, next.ownerId, next.attempt, next.claimSeq, workerId, this.gen, expiresAt, 'leased');
    this.db.prepare('DELETE FROM pending WHERE id=?').run(next.id);
    return {
      id: next.id,
      ownerId: next.ownerId,
      attempt: next.attempt,
      claimSeq: next.claimSeq,
      lease: { workerId, generation: this.gen, expiresAt },
    };
  }

  async heartbeat(id: string, workerId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT workerId FROM sessions WHERE id=? AND status=?')
      .get(id, 'leased') as { workerId: string } | undefined;
    if (!row || row.workerId !== workerId) return false;
    this.db.prepare('UPDATE sessions SET expiresAt=? WHERE id=?').run(Date.now() + this.ttlMs, id);
    return true;
  }

  async release(id: string, workerId: string): Promise<void> {
    this.db.prepare("UPDATE sessions SET status='released' WHERE id=? AND workerId=?").run(id, workerId);
  }

  async assertActiveLease(id: string, workerId: string, attempt: number): Promise<void> {
    const row = this.db.prepare('SELECT workerId, attempt FROM sessions WHERE id=? AND status=?')
      .get(id, 'leased') as { workerId: string; attempt: number } | undefined;
    if (!row || row.workerId !== workerId || row.attempt !== attempt) {
      throw new LeaseLostError(id, workerId, attempt);
    }
  }

  /** 关闭数据库句柄（demo 结束时调用，避免文件锁遗留）。 */
  close(): void {
    this.db.close();
  }
}

// ============================================================================
// 2. OrderedDurableChain —— 对应「有序写入链 + 关键写入」
//    OpenMAIC runner.ts: enqueue() 把事件/入口树追加串到一条有序链；
//    关键写入失败即终止循环（writeRequiredSessionEntry）。
// ============================================================================

/**
 * 把审计事件与持久化写入串成**一条有序链**，保证：
 *   - 顺序即因果（事件 seq 单调、入口树前缀一致）；
 *   - 关键写入（critical=true）失败 → 触发失租并中止，不允许"部分成功"。
 */
export class OrderedDurableChain {
  private chain: Promise<void> = Promise.resolve();
  private healthy = true;

  constructor(private readonly onLeaseLost: () => void) {}

  enqueue(write: () => Promise<void>, critical = false): void {
    this.chain = this.chain.then(async () => {
      if (!this.healthy) return; // 关键写入已坏，后续全部跳过
      try {
        if (critical) {
          try {
            await write();
          } catch (err) {
            if (isLeaseLostError(err)) {
              this.onLeaseLost();
              return;
            }
            this.healthy = false;
            this.onLeaseLost();
            throw err;
          }
        } else {
          await write();
        }
      } catch (err) {
        if (!isLeaseLostError(err)) {
          // 非关键写入失败仅记录，不中止
          console.error('[chain] non-critical write failed', err);
        }
      }
    });
  }

  async flush(): Promise<void> {
    await this.chain;
    if (!this.healthy) throw new Error('durable chain became unhealthy');
  }
}

// ============================================================================
// 3. LifecycleTripwire —— 对应「事件序 tripwire（确定性硬闸门）」
//    OpenMAIC runner.ts: 首个 runner 事件必须是 lifecycle，否则 abort 并记
//    TRIPWIRE VIOLATION。这是看门狗思想在事件顺序上的精确落地。
// ============================================================================

/**
 * 首个事件必须是生命周期事件。任何"先发业务事件"都视为确定性违规，
 * 对应框架看门狗"不依赖 AI 判断的硬规则"。
 */
export class LifecycleTripwire {
  private emitted = false;
  private violated = false;

  /** 返回 true 表示该事件被允许继续；false 表示触发 tripwire。 */
  check(type: string): boolean {
    if (this.violated) return false;
    if (!this.emitted) {
      if (!LIFECYCLE_EVENTS.has(type)) {
        this.violated = true;
        console.error(`TRIPWIRE VIOLATION: first event must be lifecycle, got ${type}`);
        return false;
      }
      this.emitted = true;
    }
    return true;
  }

  get isViolated(): boolean {
    return this.violated;
  }
}

// ============================================================================
// 4. OwnerScopedStore —— 对应「不经过一号文书」+ 责任锚定
//    OpenMAIC: ownerId 取自被 claim 的会话，刻意不出现在模型可见参数；
//    所有带 resourceId 的工具经 probeAccess 门控（owned/foreign/missing/tombstoned）。
// ============================================================================

/**
 * owner 作用域存储。模型能调用工具，但**永远拿不到 ownerId 参数**——
 * owner 身份由运行器从持久会话注入，工具层只能声明 resourceId 并请求裁决。
 */
export class OwnerScopedStore<TRow> {
  constructor(
    private readonly ownerId: string,
    private readonly backend: {
      probe(ownerId: string, resourceId: string): Promise<AccessVerdict>;
      read(ownerId: string, resourceId: string): Promise<TRow | null>;
      write(ownerId: string, resourceId: string, row: TRow): Promise<void>;
    },
  ) {}

  /** 模型可见接口：只接受 resourceId，owner 由闭包注入，无法伪造。 */
  async read(resourceId: string): Promise<TRow | null> {
    const v = await this.backend.probe(this.ownerId, resourceId);
    if (v.kind !== 'owned') return null; // foreign/missing/tombstoned 一律拒绝
    return this.backend.read(this.ownerId, resourceId);
  }

  async write(resourceId: string, row: TRow): Promise<void> {
    const v = await this.backend.probe(this.ownerId, resourceId);
    if (v.kind !== 'owned') {
      throw new Error(`owner-scoped write refused: ${v.kind} (resource=${resourceId})`);
    }
    await this.backend.write(this.ownerId, resourceId, row);
  }
}

// ============================================================================
// 5. AppendOnlyAuditLog —— 对应 E3 固化外抛（append-only + 可选哈希链）
//    spec/02-architecture.md E3: 证据生成即写入只追加存储，带哈希链，
//    外抛到被观测方不可达的位置。本骨架做 append-only + 哈希链，但
//    固化外抛（独立信任域）属 E5，需另行实现。
//
//    v2.2.0 起哈希为真实 SHA-256（Node 内置 crypto，零外部依赖）——
//    原「占位哈希（链长+前缀）等长篡改可漏检」的缺口（G2）已闭合；
//    demo [12d] 原自曝用例改为验证「SHA-256 下等长篡改必被检出」。
// ============================================================================

import { createHash } from 'node:crypto';

/** 对载荷计算 SHA-256（hex）。生产可替换为更强的哈希或 HMAC，接口不变。 */
export function sha256(payload: string): string {
  return createHash('sha256').update(payload, 'utf-8').digest('hex');
}

export class AppendOnlyAuditLog {
  private seq = 0;
  private prevHash = '';
  private readonly events: Array<AuditEvent & { seq: number; hash: string }> = [];

  /** 追加一条事件；返回其 seq 与哈希。写入失败返回 null（视为失租信号）。 */
  append(type: string, data: unknown): { seq: number; hash: string } | null {
    try {
      this.seq += 1;
      const ts = Date.now();
      const payload = JSON.stringify({ seq: this.seq, type, data, ts, prev: this.prevHash });
      // SHA-256 哈希链：每条事件绑定前一条的哈希，等长篡改/删改必被 verifyChain 检出。
      const hash = sha256(payload);
      this.prevHash = hash;
      this.events.push({ type, data, ts, seq: this.seq, hash });
      return { seq: this.seq, hash };
    } catch {
      return null; // 不可写即视为租约/存储失效
    }
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** 完整性校验：任何中间条目被删改都会导致后续哈希不匹配（呼应 E4 交叉验证的廉价版）。 */
  verifyChain(): boolean {
    let prev = '';
    for (const e of this.events) {
      const payload = JSON.stringify({ seq: e.seq, type: e.type, data: e.data, ts: e.ts, prev });
      if (e.hash !== sha256(payload)) {
        return false;
      }
      prev = e.hash;
    }
    return true;
  }
}

// ============================================================================
// 6. CapabilityRegistry —— 对应 L0 准入「能力门控 + fail-loud」
//    OpenMAIC: 工具按部署能力注册，模型永不看到"死工具"；未解析的模型路由
//    直接报错而非猜测厂商。这里抽象为"后端在才注册 + 白名单允许"。
// ============================================================================

export interface Tool {
  name: string;
  run: (args: unknown) => Promise<unknown>;
}

/**
 * 能力门控工具集：当且仅当后端可用时才注册工具，且运行时再叠加白名单。
 * fail-loud：请求未注册/未授权工具直接抛错，而非静默忽略。
 */
export class CapabilityRegistry {
  private readonly tools = new Map<string, Tool>();
  constructor(private readonly allowlist: Set<string>) {}

  /** 仅当 hasBackend 为真才注册——模型永远看不到它用不了的工具。 */
  registerIf(tool: Tool, hasBackend: boolean): void {
    if (hasBackend) this.tools.set(tool.name, tool);
  }

  async call(name: string, args: unknown): Promise<unknown> {
    if (!this.tools.has(name)) {
      throw new Error(`tool "${name}" not registered (backend unavailable or misconfigured)`);
    }
    if (!this.allowlist.has(name)) {
      throw new Error(`tool "${name}" not in allowlist (fail-loud, not fail-silent)`);
    }
    return this.tools.get(name)!.run(args);
  }
}

// ============================================================================
// 7. RuntimeOverseer —— 组合以上组件，对应 L2 运行时监察的"最小循环"
//    忠实但裁剪地镜像 OpenMAIC runSession：claim → 心跳 → 加载历史 →
//    续跑 → 执行 → 发 lifecycle → finish。看门狗（tripwire/lease/health）
//    全程确定性介入。
// ============================================================================

export interface OverseerDeps {
  authority: LeaseAuthority;
  heartbeatIntervalMs: number;
  maxAttempts: number;
  /** 观测钩子：每次 emit 事件时回调（demo/审计用，不影响监察逻辑）。 */
  onEvent?: (type: string, data: unknown) => void;
}

export class RuntimeOverseer {
  constructor(private readonly deps: OverseerDeps) {}

  async run(meta: ClaimedSession, execute: (ctx: RunContext) => Promise<void>): Promise<void> {
    const workerId = meta.lease.workerId; // 运行器身份 = 抢占该会话的 worker
    const abort = new AbortController();
    let leaseLost = false;
    const markLeaseLost = () => {
      leaseLost = true;
      abort.abort();
    };

    const chain = new OrderedDurableChain(markLeaseLost);
    const tripwire = new LifecycleTripwire();
    const audit = new AppendOnlyAuditLog();

    const emit = (type: string, data: unknown) => {
      if (!tripwire.check(type)) {
        abort.abort();
        return;
      }
      const seq = audit.append(type, data);
      if (seq === null) markLeaseLost();
      this.deps.onEvent?.(type, data);
    };

    const heartbeat = setInterval(() => {
      this.deps.authority.heartbeat(meta.id, workerId)
        .then((held) => { if (!held && !leaseLost) markLeaseLost(); })
        .catch(() => { if (!leaseLost) markLeaseLost(); }); // 心跳故障（如 PG 宕机）视为失租，避免僵尸会话
    }, this.deps.heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      // 超过尝试上限 → verdict-only 失败（对应 OpenMAIC isOverAttemptCap）
      if (meta.attempt > this.deps.maxAttempts) {
        emit('session_end', { status: 'failed', reason: 'over-attempt-cap' });
        await chain.flush();
        return;
      }

      // 发生命周期起始帧（tripwire 要求它是第一个事件）
      emit('session_start', { workerId, ownerId: meta.ownerId });

      const ctx: RunContext = { ownerId: meta.ownerId, attempt: meta.attempt, abort };
      await execute(ctx);

      if (leaseLost) {
        emit('session_interrupted', { reason: 'lease lost' });
      } else {
        emit('session_end', { status: 'succeeded' });
      }
      await chain.flush();
    } catch (err) {
      if (isLeaseLostError(err)) markLeaseLost();
      if (!leaseLost) {
        emit('session_end', { status: 'failed', error: String(err) });
      }
      await chain.flush().catch(() => {});
    } finally {
      clearInterval(heartbeat);
      await this.deps.authority.release(meta.id, workerId).catch(() => {});
    }
  }
}

export interface RunContext {
  ownerId: string;
  attempt: number;
  abort: AbortController;
}

// ============================================================================
// 8. EvalGuard —— 对应 L2 随机烈度抽查 + 证据纠错回灌
//    OpenMAIC eval/orchestration: A/B prompt 变体 + 采样 + 确定性裁决（非
//    LLM-as-judge）+ 错误样本排除（API 失败不算 END）+ 阈值退出码门禁。
//    此处给出最小确定性回归守卫（以"导演是否过早 END"为例）。
// ============================================================================

export interface EvalSample {
  decision: 'END' | string;
  error?: string;
}

/**
 * 确定性回归守卫：对比 pre/post 两变体的 END 率。
 * - 错误样本被排除，避免基础设施故障伪装成模型行为判决（关键纪律）。
 * - 返回 { pass, delta }；delta = preEndRate - postEndRate，越大说明守卫越灵敏。
 */
export function regressionGuard(
  pre: EvalSample[],
  post: EvalSample[],
  opts: { endThreshold: number; deltaThreshold: number },
): { pass: boolean; preEndRate: number; postEndRate: number; delta: number } {
  const rate = (samples: EvalSample[]) => {
    const usable = samples.filter((s) => !s.error);
    if (usable.length === 0) return 0;
    return usable.filter((s) => s.decision === 'END').length / usable.length;
  };
  const preEndRate = rate(pre);
  const postEndRate = rate(post);
  const delta = preEndRate - postEndRate;
  const pass = postEndRate <= opts.endThreshold && delta >= opts.deltaThreshold;
  return { pass, preEndRate, postEndRate, delta };
}

// ============================================================================
// 9. EntryGuard / ExitGuard —— E1 入口检查 / E5 出口检查的最小可运行示例
//    spec/02-architecture.md E1：证据采集应在内核侧进行，不经用户态路径。
//    spec/02-architecture.md E5：采集模块自身须在独立信任域、须签名。
//
//    ⚠️ 本组件是对 E1/E5 的**语义演示**，不是真正的内核侧采集或独立信任域。
//    真正的 E1 需要 eBPF/LSM 探针（见 PRODUCTION-GAPS.md G3）；
//    真正的 E5 需要独立硬件信任域 + 远程证明（见 PRODUCTION-GAPS.md G4）。
//    本组件的角色是把"E1/E5 拦截什么、用什么规则、拦截后留下什么证据"
//    变成可读、可测试的代码——让读者看到"确定性强制力"长什么样。
// ============================================================================

/** 工具调用请求——EntryGuard 的输入。 */
export interface ToolCallRequest {
  tool: string;
  args: unknown;
  /** 调用者身份（由运行器注入，模型不可伪造——呼应 OwnerScopedStore 的设计）。 */
  callerId: string;
}

/** 工具调用结果——ExitGuard 的输入。 */
export interface ToolCallResult {
  ok: boolean;
  /** 工具返回的数据（成功时）或错误消息（失败时）。 */
  output: unknown;
  /** 工具调用的资源消耗（ExitGuard 检查是否超预算）。 */
  resources?: { tokens?: number; memoryMb?: number; durationMs?: number };
}

/** 入口检查裁决。 */
export type EntryVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; /** 拦截类别，用于审计与统计 */ category: EntryDenyCategory };

export type EntryDenyCategory =
  | 'tool-not-allowed'     // 工具不在白名单
  | 'arg-policy-violation' // 参数违反策略（如禁止的路径、禁止的操作）
  | 'rate-limit'           // 速率超限
  | 'budget-exhausted';    // 预算耗尽

/**
 * E1 入口检查守卫——在工具调用**执行之前**做确定性裁决。
 *
 * 与 CapabilityRegistry 的区别：
 *   - CapabilityRegistry 回答"这个工具存不存在、模型能不能看到它"（注册态）。
 *   - EntryGuard 回答"这次具体的调用，要不要放行"（运行态）。
 *
 * 裁决全部是确定性硬规则——不依赖任何 AI 判断（呼应 spec/09 看门狗原则）。
 * 拦截时记一条审计事件，把"为什么拦、拦了谁、依据哪条规则"全留痕。
 */
export class EntryGuard {
  constructor(
    /** 允许的工具白名单。 */
    private readonly allowedTools: ReadonlySet<string>,
    /** 参数策略：返回 false 表示该参数值违反策略。 */
    private readonly argPolicies: Array<{
      name: string;
      tools: ReadonlySet<string>;
      check: (args: unknown) => boolean;
      reason: (args: unknown) => string;
    }>,
    /** 审计日志：每次拦截记一条。 */
    private readonly audit: { append: (type: string, data: unknown) => unknown },
  ) {}

  check(req: ToolCallRequest): EntryVerdict {
    // 规则 1：工具必须在白名单
    if (!this.allowedTools.has(req.tool)) {
      this.audit.append('entry_deny', {
        tool: req.tool,
        callerId: req.callerId,
        category: 'tool-not-allowed',
        reason: `tool "${req.tool}" is not in the allowed set`,
      });
      return {
        kind: 'deny',
        category: 'tool-not-allowed',
        reason: `tool "${req.tool}" is not in the allowed set`,
      };
    }

    // 规则 2：逐条参数策略
    for (const policy of this.argPolicies) {
      if (policy.tools.has(req.tool) && !policy.check(req.args)) {
        this.audit.append('entry_deny', {
          tool: req.tool,
          callerId: req.callerId,
          category: 'arg-policy-violation',
          policy: policy.name,
          reason: policy.reason(req.args),
        });
        return {
          kind: 'deny',
          category: 'arg-policy-violation',
          reason: `[${policy.name}] ${policy.reason(req.args)}`,
        };
      }
    }

    return { kind: 'allow' };
  }
}

/** 出口检查裁决。 */
export type ExitVerdict =
  | { kind: 'accept' }
  | { kind: 'reject'; reason: string; category: ExitRejectCategory };

export type ExitRejectCategory =
  | 'output-policy-violation'  // 输出违反策略（如泄露了禁止字段）
  | 'resource-over-budget'     // 资源消耗超预算
  | 'integrity-check-failed';  // 完整性校验失败（如签名不匹配——E5 的核心）

/**
 * E5 出口检查守卫——在工具调用**返回之后**做确定性裁决。
 *
 * 与 EntryGuard 的对称性：
 *   - EntryGuard 在执行前拦截"不该发生"的调用；
 *   - ExitGuard 在执行后拦截"不该被采纳"的结果（如超预算、输出违规、完整性失败）。
 *
 * ⚠️ 真正的 E5 完整性校验需要独立信任域的签名比对（见 PRODUCTION-GAPS.md G4）。
 * 此处的 `integrityCheck` 只是一个占位钩子——演示语义，不提供真正的密码学保证。
 */
export class ExitGuard {
  constructor(
    /** 资源预算上限。 */
    private readonly budget: { maxTokens?: number; maxMemoryMb?: number; maxDurationMs?: number },
    /** 输出策略：返回 false 表示输出违反策略。 */
    private readonly outputPolicies: Array<{
      name: string;
      tools: ReadonlySet<string>;
      check: (result: ToolCallResult) => boolean;
      reason: (result: ToolCallResult) => string;
    }>,
    /**
     * 完整性校验钩子——返回 false 表示完整性校验失败（E5 核心）。
     * 占位实现：默认返回 true（不做校验）。
     * 生产实现：应比对独立信任域的签名/承诺。
     */
    private readonly integrityCheck: (req: ToolCallRequest, result: ToolCallResult) => boolean = () => true,
    /** 审计日志：每次拒绝记一条。 */
    private readonly audit: { append: (type: string, data: unknown) => unknown },
  ) {}

  check(req: ToolCallRequest, result: ToolCallResult): ExitVerdict {
    // 规则 1：资源预算
    if (result.resources) {
      if (this.budget.maxTokens !== undefined && result.resources.tokens !== undefined) {
        if (result.resources.tokens > this.budget.maxTokens) {
          this.audit.append('exit_reject', {
            tool: req.tool,
            callerId: req.callerId,
            category: 'resource-over-budget',
            metric: 'tokens',
            actual: result.resources.tokens,
            budget: this.budget.maxTokens,
          });
          return {
            kind: 'reject',
            category: 'resource-over-budget',
            reason: `tokens ${result.resources.tokens} > budget ${this.budget.maxTokens}`,
          };
        }
      }
      if (this.budget.maxDurationMs !== undefined && result.resources.durationMs !== undefined) {
        if (result.resources.durationMs > this.budget.maxDurationMs) {
          this.audit.append('exit_reject', {
            tool: req.tool,
            callerId: req.callerId,
            category: 'resource-over-budget',
            metric: 'duration',
            actual: result.resources.durationMs,
            budget: this.budget.maxDurationMs,
          });
          return {
            kind: 'reject',
            category: 'resource-over-budget',
            reason: `duration ${result.resources.durationMs}ms > budget ${this.budget.maxDurationMs}ms`,
          };
        }
      }
    }

    // 规则 2：输出策略
    for (const policy of this.outputPolicies) {
      if (policy.tools.has(req.tool) && !policy.check(result)) {
        this.audit.append('exit_reject', {
          tool: req.tool,
          callerId: req.callerId,
          category: 'output-policy-violation',
          policy: policy.name,
          reason: policy.reason(result),
        });
        return {
          kind: 'reject',
          category: 'output-policy-violation',
          reason: `[${policy.name}] ${policy.reason(result)}`,
        };
      }
    }

    // 规则 3：完整性校验（E5 核心，占位）
    if (!this.integrityCheck(req, result)) {
      this.audit.append('exit_reject', {
        tool: req.tool,
        callerId: req.callerId,
        category: 'integrity-check-failed',
        reason: 'integrity check failed (signature/commitment mismatch)',
      });
      return {
        kind: 'reject',
        category: 'integrity-check-failed',
        reason: 'integrity check failed (signature/commitment mismatch)',
      };
    }

    return { kind: 'accept' };
  }
}

/**
 * 受守卫的工具调用——把 EntryGuard + 工具执行 + ExitGuard 串成一条管道。
 *
 * 这就是把"观测"升级为"观测 + 一次性的强制力展示"的最小形态：
 *   - EntryGuard 拦截 → 工具根本不执行（强制力）；
 *   - ExitGuard 拒绝 → 结果被丢弃、审计留痕（强制力）；
 *   - 只有 EntryGuard 放行 **且** ExitGuard 接受，结果才会被返回给调用方。
 *
 * 这是 demo [17] 组要证明的语义。
 */
export async function guardedToolCall(
  entry: EntryGuard,
  exit: ExitGuard,
  req: ToolCallRequest,
  execute: (req: ToolCallRequest) => Promise<ToolCallResult>,
): Promise<{ verdict: 'allowed' | 'denied-entry' | 'rejected-exit'; result?: ToolCallResult; denyReason?: string }> {
  const ev = entry.check(req);
  if (ev.kind === 'deny') {
    return { verdict: 'denied-entry', denyReason: ev.reason };
  }
  const result = await execute(req);
  const xv = exit.check(req, result);
  if (xv.kind === 'reject') {
    return { verdict: 'rejected-exit', denyReason: xv.reason };
  }
  return { verdict: 'allowed', result };
}

// ============================================================================
// 导出汇总
// ============================================================================
export const RuntimeOversight = {
  LeaseLostError,
  isLeaseLostError,
  InMemoryLeaseAuthority,
  SqliteLeaseAuthority,
  OrderedDurableChain,
  LifecycleTripwire,
  OwnerScopedStore,
  AppendOnlyAuditLog,
  sha256,
  CapabilityRegistry,
  RuntimeOverseer,
  regressionGuard,
  EntryGuard,
  ExitGuard,
  guardedToolCall,
};
