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
 * 诚实边界（呼应 spec/13 的诚实传统，生产前必须补齐，逐项见同目录 README）：
 *   - 租约权威为内存占位（InMemoryLeaseAuthority）；生产应换 PostgreSQL 或独立信任域存储。
 *   - 审计链是 append-only + 哈希链，但哈希为占位实现（等长篡改可漏检，见 demo [12d]）；
 *     未做 E1 内核侧采集（spec/02）/ E5 独立信任域固化，对抗性多 Agent 场景（P3）下
 *     不能单独用作信任根。
 *   - 无资源账本（预算比/影子比/记忆写入审计，spec/10）、无三号公证机（spec/09 要求
 *     独立硬件信任域 + 三号甲/乙拆分）、无信用分与信用回避（spec/04）、无群治理（spec/07）。
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
// ============================================================================

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
      // 占位哈希：生产应换为 SHA-256；此处仅示意"每条指向前一条"。
      const hash = `h${this.seq}:${this.prevHash.slice(0, 6)}:${payload.length}`;
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

  /** 完整性校验：可检测出中间条目被删改（呼应 E4 交叉验证的廉价版）。 */
  verifyChain(): boolean {
    let prev = '';
    for (const e of this.events) {
      if (e.hash !== `h${e.seq}:${prev.slice(0, 6)}:${JSON.stringify({
        seq: e.seq,
        type: e.type,
        data: e.data,
        ts: e.ts,
        prev,
      }).length}`) {
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
// 导出汇总
// ============================================================================
export const RuntimeOversight = {
  LeaseLostError,
  isLeaseLostError,
  InMemoryLeaseAuthority,
  OrderedDurableChain,
  LifecycleTripwire,
  OwnerScopedStore,
  AppendOnlyAuditLog,
  CapabilityRegistry,
  RuntimeOverseer,
  regressionGuard,
};
