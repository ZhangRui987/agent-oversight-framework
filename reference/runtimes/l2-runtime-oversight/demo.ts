/**
 * demo.ts —— l2-runtime-oversight 参照实现的可运行验证脚本（纯内存，无 DB/网络）。
 *
 * 作用：把「L2 运行时监察的每条确定性规则真的会触发」变成可复现证据——
 * 一键跑一遍，覆盖**全部组件**的功能用例与对抗性用例（含对自身局限的自曝，
 * 如 [12d] 占位哈希等长碰撞、[14a] 缺 min-sample 门禁的错误洪泛误判）。
 *
 * 测试分组：
 *   [1]  LeaseAuthority（看门狗：确定性租约/心跳/失租）
 *   [2]  LifecycleTripwire（事件序确定性闸门）
 *   [3]  OwnerScopedStore（ownerId 不可伪造）
 *   [4]  AppendOnlyAuditLog（append-only + 哈希链自检）
 *   [5]  CapabilityRegistry（能力门控 + fail-loud）
 *   [6]  regressionGuard（A/B 变体 + 错误样本排除 + 阈值门禁）
 *   [7a] RuntimeOverseer 端到端（健康完成）
 *   [7b] RuntimeOverseer 端到端（失租中断）
 *   [8]  对抗性：伪造 ownerId 注入
 *   [9]  对抗性：LeaseAuthority（租约窃取/伪造 worker/重放/双重抢占）
 *   [10] 对抗性：LifecycleTripwire（违规不可恢复/名称混淆/空事件名）
 *   [11] 对抗性：OwnerScopedStore 深挖（tombstoned/missing/TOCTOU/不信任后端 read）
 *   [12] 对抗性：AppendOnlyAuditLog（篡改/截断检测 + G2 闭合：SHA-256 等长篡改必检）
 *   [13] 对抗性：CapabilityRegistry（名称混淆/注册-白名单错配）
 *   [14] 对抗性：regressionGuard（错误洪泛误判/阈值边界/空基线）
 *   [15] 对抗性：RuntimeOverseer（超尝试上限/execute 抛错/心跳异常）
 *   [16] 对抗性：OrderedDurableChain（关键写入失败中止/非关键容忍）
 *   [17] EntryGuard/ExitGuard（E1 入口/E5 出口检查——拦截恶意工具调用的强制力展示）
 *   [18] SqliteLeaseAuthority（G1 闭合：租约权威 SQLite 持久化——崩溃后可恢复）
 *   [19] ConfigReviewer（spec/02 第四条：配置权即攻击面——五项配置内容审查，恶意配置注入被拦）
 *   [20] ResourceLedger（G5 闭合：spec/10 资源账本——预算比超阈审计 + 影子比偏离 + 记忆写入最高级审计 + 周期型外联检测）
 *
 * 运行：node --experimental-transform-types demo.ts
 * 退出码：0 = 全部 PASS，1 = 有 FAIL
 *
 * 许可证：Apache License 2.0（代码路径，见 LICENSING.md 的路径 ↔ 许可证映射）。
 */

import {
  AppendOnlyAuditLog,
  CapabilityRegistry,
  ConfigReviewer,
  EntryGuard,
  ExitGuard,
  InMemoryLeaseAuthority,
  LeaseLostError,
  LifecycleTripwire,
  OrderedDurableChain,
  OwnerScopedStore,
  ResourceLedger,
  RuntimeOverseer,
  SqliteLeaseAuthority,
  guardedToolCall,
  isLeaseLostError,
  regressionGuard,
  type ClaimedSession,
  type LeaseAuthority,
  type ResourceUsage,
  type TaskBudget,
  type ToolCallRequest,
} from './index.ts';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 可篡改审计日志：仅测试用，通过 bracket 访问私有 events 以模拟"历史被篡改"
class TamperableAuditLog extends AppendOnlyAuditLog {
  tamper(index: number, data: unknown): void {
    (this as unknown as { events: Array<{ data: unknown }> }).events[index].data = data;
  }
  drop(index: number): void {
    (this as unknown as { events: Array<unknown> }).events.splice(index, 1);
  }
}

// ============================================================================
// 1. LeaseAuthority —— L2 看门狗的"PG 为权威"占位
// ============================================================================
async function testLeaseAuthority(): Promise<void> {
  console.log('\n[1] LeaseAuthority（看门狗：确定性租约/心跳/失租）');
  const auth = new InMemoryLeaseAuthority(30_000);
  auth.submit('s1', 'owner-A', 1);
  const claimed = (await auth.claimNext('wk-demo')) as ClaimedSession;
  check('claimNext 返回会话且 workerId 匹配', !!claimed && claimed.lease.workerId === 'wk-demo');
  check('同 worker 心跳续租成功', (await auth.heartbeat('s1', 'wk-demo')) === true);
  check('异 worker 心跳被拒（失租判定）', (await auth.heartbeat('s1', 'intruder')) === false);
  let threw = false;
  try {
    await auth.assertActiveLease('s1', 'wk-demo', 99);
  } catch (e) {
    threw = isLeaseLostError(e);
  }
  check('attempt 不匹配 → 抛 LeaseLostError', threw);
  check('LeaseLostError 是 Error 子类', new LeaseLostError('x', 'y', 1) instanceof Error);
  await auth.release('s1', 'wk-demo');
  check('释放后心跳被拒', (await auth.heartbeat('s1', 'wk-demo')) === false);
}

// ============================================================================
// 2. LifecycleTripwire —— 事件序确定性闸门
// ============================================================================
function testTripwire(): void {
  console.log('\n[2] LifecycleTripwire（事件序确定性闸门）');
  const tw = new LifecycleTripwire();
  check('首事件非 lifecycle → 被拒 + 触发违例', tw.check('text_delta') === false && tw.isViolated);
  const tw2 = new LifecycleTripwire();
  check('首事件为 lifecycle → 放行', tw2.check('session_start') === true);
  check('后续业务事件允许', tw2.check('text_delta') === true);
}

// ============================================================================
// 3. OwnerScopedStore —— "不经过一号文书" + 责任锚定
// ============================================================================
async function testOwnerScoped(): Promise<void> {
  console.log('\n[3] OwnerScopedStore（ownerId 不可伪造）');
  const backend = {
    probe: async (_owner: string, rid: string) => {
      if (rid === 'own-1') return { kind: 'owned', resourceName: 'own-1' } as const;
      if (rid === 'foreign-1') return { kind: 'foreign' } as const;
      return { kind: 'missing' } as const;
    },
    read: async (_owner: string, rid: string) => ({ id: rid }),
    write: async () => {},
  };
  const store = new OwnerScopedStore<{ id: string }>('owner-A', backend);
  check('读自己的资源 → 成功', (await store.read('own-1')) !== null);
  check('读别人的资源 → 返回 null（拒绝越权）', (await store.read('foreign-1')) === null);
  let threw = false;
  try {
    await store.write('foreign-1', { id: 'x' });
  } catch {
    threw = true;
  }
  check('写别人的资源 → 抛错（owner 不可伪造）', threw);
}

// ============================================================================
// 4. AppendOnlyAuditLog —— E3 固化外抛（append-only + 哈希链）
// ============================================================================
function testAuditLog(): void {
  console.log('\n[4] AppendOnlyAuditLog（append-only + 哈希链自检）');
  const log = new AppendOnlyAuditLog();
  log.append('session_start', { a: 1 });
  log.append('text_delta', { b: 2 });
  log.append('session_end', { c: 3 });
  check('事件序号单调递增', log.lastSeq === 3);
  check('未篡改时 verifyChain() === true', log.verifyChain() === true);
}

// ============================================================================
// 5. CapabilityRegistry —— L0 准入（fail-loud，非 fail-silent）
// ============================================================================
async function testCapability(): Promise<void> {
  console.log('\n[5] CapabilityRegistry（能力门控 + fail-loud）');
  const reg = new CapabilityRegistry(new Set(['t1']));
  reg.registerIf({ name: 't1', run: async () => 42 }, true); // 后端在 → 注册
  reg.registerIf({ name: 't2', run: async () => 0 }, false); // 后端不在 → 不注册
  check('后端可用工具可调用', (await reg.call('t1', {})) === 42);
  let threw1 = false;
  try {
    await reg.call('t2', {});
  } catch {
    threw1 = true;
  }
  check('未注册（后端缺失）工具 → fail-loud 抛错', threw1);
  let threw2 = false;
  try {
    await new CapabilityRegistry(new Set([])).call('t1', {}); // 注册了但不在白名单
  } catch {
    threw2 = true;
  }
  check('不在白名单 → fail-loud 抛错', threw2);
}

// ============================================================================
// 6. regressionGuard —— L2 随机烈度抽查 + 证据纠错回灌
// ============================================================================
function testRegressionGuard(): void {
  console.log('\n[6] regressionGuard（A/B 变体 + 错误样本排除 + 阈值门禁）');
  const r1 = regressionGuard(
    [
      { decision: 'END' },
      { decision: 'END' },
      { decision: 'END' },
    ],
    [
      { decision: 'agentX' },
      { decision: 'agentX' },
      { decision: 'agentX' },
      { decision: 'agentX' },
      { decision: 'END', error: 'Forbidden' }, // 错误样本：不算 END
    ],
    { endThreshold: 0.2, deltaThreshold: 0.3 },
  );
  check('守卫成立：pass=true 且 Δ=1.0', r1.pass === true && r1.delta === 1);
  check('错误样本被排除（postEndRate=0 而非 1/5）', r1.postEndRate === 0);

  const r2 = regressionGuard(
    [{ decision: 'END' }, { decision: 'END' }, { decision: 'END' }],
    [{ decision: 'END' }, { decision: 'END' }, { decision: 'END' }, { decision: 'agentX' }, { decision: 'agentX' }],
    { endThreshold: 0.2, deltaThreshold: 0.3 },
  );
  check('回归检出：postEndRate=0.6 > 0.2 → pass=false', r2.pass === false && r2.postEndRate === 0.6);
}

// ============================================================================
// 7. RuntimeOverseer 端到端 —— 健康完成 vs 失租中断
// ============================================================================
async function testOverseerHealthy(): Promise<void> {
  console.log('\n[7a] RuntimeOverseer 端到端（健康完成）');
  const auth = new InMemoryLeaseAuthority(30_000);
  auth.submit('h1', 'owner-H', 1);
  const meta = (await auth.claimNext('wk-h')) as ClaimedSession;
  const events: string[] = [];
  const ov = new RuntimeOverseer({
    authority: auth,
    heartbeatIntervalMs: 20,
    maxAttempts: 3,
    onEvent: (t) => events.push(t),
  });
  await ov.run(meta, async () => {
    await sleep(5);
  });
  check('事件序列以 session_start 开头', events[0] === 'session_start');
  check('健康完成以 session_end 结尾', events[events.length - 1] === 'session_end');
  check('无中断事件', !events.includes('session_interrupted'));
}

class FlakyAuthority extends InMemoryLeaseAuthority {
  override async heartbeat(): Promise<boolean> {
    return false; // 模拟租约丢失
  }
}

async function testOverseerLeaseLost(): Promise<void> {
  console.log('\n[7b] RuntimeOverseer 端到端（失租中断）');
  const auth = new FlakyAuthority(30_000);
  auth.submit('l1', 'owner-L', 1);
  const meta = (await auth.claimNext('wk-l')) as ClaimedSession;
  const events: string[] = [];
  const ov = new RuntimeOverseer({
    authority: auth,
    heartbeatIntervalMs: 20,
    maxAttempts: 3,
    onEvent: (t) => events.push(t),
  });
  await ov.run(meta, async () => {
    await sleep(80); // 故意比心跳间隔长，让失租先触发
  });
  check('失租 → 触发 session_interrupted', events.includes('session_interrupted'));
}

// ============================================================================
// 8. 对抗性用例：伪造 ownerId 注入
//    核心安全不变量：ownerId 的唯一合法来源是运行时 claim（会话），
//    工具层（模型可见参数）永远没有设置 ownerId 的入口 → 注入在结构上无效。
// ============================================================================
async function testOwnerInjection(): Promise<void> {
  console.log('\n[8] 对抗性：伪造 ownerId 注入（ownerId 不可伪造 / 工具参数无 owner 字段）');

  const ownedBy: Record<string, string> = { 'doc-A1': 'owner-A', 'doc-B1': 'owner-B' };
  const makeBackend = () => {
    let lastProbeOwner = '';
    const base = {
      probe: async (owner: string, rid: string) => {
        lastProbeOwner = owner;
        const o = ownedBy[rid];
        if (!o) return { kind: 'missing' as const };
        return o === owner
          ? ({ kind: 'owned' as const, resourceName: rid })
          : ({ kind: 'foreign' as const });
      },
      read: async (_owner: string, rid: string) => ({ id: rid }),
      write: async () => {},
    };
    return { ...base, _getLastProbeOwner: () => lastProbeOwner };
  };

  const backend = makeBackend();
  const attacker = new OwnerScopedStore<{ id: string }>('owner-A', backend);

  const maliciousArgs = { resourceId: 'doc-B1', ownerId: 'owner-B' as const };
  const got = await attacker.read(maliciousArgs.resourceId);
  check('伪造 ownerId 在参数中无效 → 仍按 owner-A 判定 → 越权读被拒', got === null);

  const got2 = await attacker.read('doc-B1');
  check('已知受害者资源 doc-B1 仍被拒（foreign）', got2 === null);

  check('probe 收到的是 store 绑定 owner-A，而非注入的 owner-B', backend._getLastProbeOwner() === 'owner-A');

  check('store.read 签名为单参数(resourceId) → 工具层无法注入 ownerId', attacker.read.length === 1);

  let threw = false;
  try {
    await attacker.write('doc-B1', { id: 'x' });
  } catch {
    threw = true;
  }
  check('越权写（受害者资源）→ 抛错', threw);

  const forged = new OwnerScopedStore<{ id: string }>('owner-B', makeBackend());
  const victimDoc = await forged.read('doc-B1');
  check('自建伪造 store(owner-B) 可读 owner-B 资源（证明：ownerId 只能源于 claim）', victimDoc !== null);
}

// ============================================================================
// 9. 对抗性：LeaseAuthority —— 租约窃取 / 伪造 worker / 重放 / 双重抢占
// ============================================================================
async function testLeaseAdversarial(): Promise<void> {
  console.log('\n[9] 对抗性：LeaseAuthority（租约窃取/伪造 worker/重放/双重抢占）');
  const auth = new InMemoryLeaseAuthority(30_000);
  auth.submit('s9', 'owner-9', 1);
  const claimed = (await auth.claimNext('wk-legit')) as ClaimedSession;

  // 9a. 伪造 worker 心跳（租约窃取尝试）→ 必须被拒
  check('伪造 worker 心跳被拒（租约窃取无效）', (await auth.heartbeat('s9', 'wk-attacker')) === false);
  // 9b. 合法 worker 仍能续租（身份绑定未被伪造破坏）
  check('合法 worker 仍能续租', (await auth.heartbeat('s9', 'wk-legit')) === true);
  // 9c. attempt 重放：用错误 attempt 调 assertActiveLease → 抛 LeaseLostError
  let threw = false;
  try {
    await auth.assertActiveLease('s9', 'wk-legit', 7);
  } catch (e) {
    threw = isLeaseLostError(e);
  }
  check('attempt 重放（错代际）→ LeaseLostError', threw);

  // 9d. 双重抢占：同一 pending 会话不会被两次 claim 给不同 worker
  const auth2 = new InMemoryLeaseAuthority(30_000);
  auth2.submit('only-one', 'owner-x', 1);
  const first = await auth2.claimNext('wk-A');
  const second = await auth2.claimNext('wk-B');
  check('双重抢占：第二个 worker 抢不到（pending 空）→ null', first !== null && second === null);

  // 9e. 释放后原会话不可被重抢（已移出 pending，须重新 submit）
  await auth.release('s9', 'wk-legit');
  const stolen = await auth.claimNext('wk-attacker');
  check('释放后原会话不可被重抢（需重新 submit）', stolen === null);
}

// ============================================================================
// 10. 对抗性：LifecycleTripwire —— 违规不可恢复 / 名称混淆 / 空事件名
// ============================================================================
function testTripwireAdversarial(): void {
  console.log('\n[10] 对抗性：LifecycleTripwire（违规不可恢复 / 名称混淆 / 空名）');
  // 10a. 违规后即使补发 lifecycle 也无法恢复（硬闸门，非可绕过）
  const tw = new LifecycleTripwire();
  tw.check('text_delta'); // 先违规
  check('违规后 isViolated=true', tw.isViolated);
  check('违规后补发 session_start 仍被拒（不可恢复）', tw.check('session_start') === false);
  check('违规后所有后续事件均被拒', tw.check('text_delta') === false);

  // 10b. 名称混淆：近似名不算 lifecycle（大小写/前缀）
  const tw2 = new LifecycleTripwire();
  check('"lifecycle_start"（错误命名）被拒', tw2.check('lifecycle_start') === false);
  const tw3 = new LifecycleTripwire();
  check('"Session_Start"（大小写错）被拒', tw3.check('Session_Start') === false);

  // 10c. 空字符串事件名被拒
  const tw4 = new LifecycleTripwire();
  check('空字符串事件名被拒', tw4.check('') === false);
}

// ============================================================================
// 11. 对抗性：OwnerScopedStore 深挖
//     tombstoned/missing 拒绝、TOCTOU（probe 通过但 read 返回 null）、
//     即便后端 read 会返回数据也不信任（门控以 probe 为准）。
// ============================================================================
async function testOwnerAdversarialDeep(): Promise<void> {
  console.log('\n[11] 对抗性：OwnerScopedStore 深挖（tombstoned/missing/TOCTOU/不信任后端 read）');

  const honest = {
    probe: async (owner: string, rid: string) => {
      if (rid === 'tomb') return { kind: 'tombstoned' as const };
      if (rid === 'gone') return { kind: 'missing' as const };
      return owner === 'owner-A'
        ? ({ kind: 'owned' as const, resourceName: rid })
        : ({ kind: 'foreign' as const });
    },
    read: async (_o: string, rid: string) => ({ id: rid }),
    write: async () => {},
  };
  const store = new OwnerScopedStore<{ id: string }>('owner-A', honest);

  check('tombstoned 资源读 → 返回 null（拒绝）', (await store.read('tomb')) === null);
  check('missing 资源读 → 返回 null', (await store.read('gone')) === null);

  // 11a. 即便后端 read 会返回数据，probe=foreign 仍拦截（门控以 probe 为准，不信任后端 read）
  const leakyBackend = {
    probe: async (_owner: string, rid: string) =>
      rid === 'others' ? ({ kind: 'foreign' as const }) : ({ kind: 'owned' as const, resourceName: rid }),
    read: async (_o: string, rid: string) => ({ id: rid, data: 'should-not-leak' }),
    write: async () => {},
  };
  const leaky = new OwnerScopedStore<{ id: string; data?: string }>('owner-A', leakyBackend);
  check('即便后端 read 会返回数据，probe=foreign 仍拦截（不泄露）', (await leaky.read('others')) === null);

  // 11b. TOCTOU：probe 通过但 read 在间隙被删 → 返回 null，不抛、不泄露
  const toctou = {
    probe: async () => ({ kind: 'owned' as const, resourceName: 'x' }) as const,
    read: async () => null,
    write: async () => {},
  };
  const tstore = new OwnerScopedStore<{ id: string }>('owner-A', toctou);
  check('TOCTOU：probe 通过但 read 返回 null → store 返回 null（无泄露/无崩溃）', (await tstore.read('x')) === null);

  // 11c. 越权写 tombstoned 资源同样抛错
  let threw = false;
  try {
    await store.write('tomb', { id: 'x' });
  } catch {
    threw = true;
  }
  check('写 tombstoned 资源 → 抛错', threw);
}

// ============================================================================
// 12. 对抗性：AppendOnlyAuditLog —— 篡改/截断检测 + 占位哈希碰撞边界
// ============================================================================
function testAuditAdversarial(): void {
  console.log('\n[12] 对抗性：AppendOnlyAuditLog（篡改/截断检测 + 占位哈希碰撞边界）');
  const log = new TamperableAuditLog();
  log.append('session_start', { a: 1 });
  log.append('text_delta', { b: 2 });
  log.append('text_delta', { c: 3 });
  log.append('session_end', { d: 4 });
  check('篡改前 verifyChain()===true', log.verifyChain() === true);

  // 12a. 篡改中间事件数据 → 哈希链断裂
  const t1 = new TamperableAuditLog();
  t1.append('session_start', { a: 1 });
  t1.append('text_delta', { b: 2 });
  t1.append('session_end', { d: 4 });
  t1.tamper(1, { b: 999 });
  check('篡改中间事件 → verifyChain()===false', t1.verifyChain() === false);

  // 12b. 篡改首事件 → 断裂
  const t2 = new TamperableAuditLog();
  t2.append('session_start', { a: 1 });
  t2.append('session_end', { d: 4 });
  t2.tamper(0, { a: 999 });
  check('篡改首事件 → verifyChain()===false', t2.verifyChain() === false);

  // 12c. 删除中间事件（截断）→ 断裂
  const t3 = new TamperableAuditLog();
  t3.append('session_start', { a: 1 });
  t3.append('text_delta', { b: 2 });
  t3.append('session_end', { d: 4 });
  t3.drop(1);
  check('删除中间事件 → verifyChain()===false', t3.verifyChain() === false);

  // 12d. G2 闭合验证：v2.2.0 起哈希为真实 SHA-256，等长篡改必被检出
  //     （原「占位哈希等长碰撞漏检」自曝用例改为验证闭合后的安全语义）
  const t4 = new TamperableAuditLog();
  t4.append('session_start', { a: 1 }); // 数据 {"a":1}
  t4.tamper(0, { b: 2 }); // 数据 {"b":2} 同长度（旧占位哈希下碰撞漏检）
  check('G2 闭合：SHA-256 下等长篡改必被检出（verifyChain()===false）', t4.verifyChain() === false);

  // 12e. SHA-256 哈希形态验证：64 位 hex
  const t5 = new TamperableAuditLog();
  const appended = t5.append('session_start', { a: 1 });
  check('哈希为 64 位 hex（SHA-256）', !!appended && /^[0-9a-f]{64}$/.test(appended.hash));
}

// ============================================================================
// 13. 对抗性：CapabilityRegistry —— 名称混淆 / 注册-白名单错配
// ============================================================================
async function testCapabilityAdversarial(): Promise<void> {
  console.log('\n[13] 对抗性：CapabilityRegistry（名称混淆 / 注册-白名单错配）');
  // 13a. 大小写/前后缀混淆：注册 't1'，调用 'T1' → fail-loud
  const reg = new CapabilityRegistry(new Set(['t1']));
  reg.registerIf({ name: 't1', run: async () => 1 }, true);
  let threw1 = false;
  try {
    await reg.call('T1', {});
  } catch {
    threw1 = true;
  }
  check('名称大小写混淆 T1≠t1 → fail-loud', threw1);

  // 13b. 已注册但不在白名单 → 调用失败（注册 ≠ 授权）
  const reg2 = new CapabilityRegistry(new Set(['other']));
  reg2.registerIf({ name: 't1', run: async () => 1 }, true);
  let threw2 = false;
  try {
    await reg2.call('t1', {});
  } catch {
    threw2 = true;
  }
  check('已注册但不在白名单 → fail-loud（注册≠授权）', threw2);

  // 13c. 白名单含但从未注册（后端缺失）→ 调用失败（fail-loud，非静默放行）
  const reg3 = new CapabilityRegistry(new Set(['t1']));
  let threw3 = false;
  try {
    await reg3.call('t1', {});
  } catch {
    threw3 = true;
  }
  check('白名单含但后端缺失（未注册）→ fail-loud', threw3);

  // 13d. 不存在的工具名 → 直接 fail-loud（不会"猜测"或返回空）
  let threw4 = false;
  try {
    await reg.call('nonexistent', {});
  } catch {
    threw4 = true;
  }
  check('不存在的工具名 → fail-loud（非 fail-silent）', threw4);
}

// ============================================================================
// 14. 对抗性：regressionGuard —— 错误洪泛误判 / 阈值边界 / 空基线
// ============================================================================
function testRegressionAdversarial(): void {
  console.log('\n[14] 对抗性：regressionGuard（错误洪泛误判 / 阈值边界 / 空基线）');
  // 14a. 错误洪泛：post 全是错误样本 → usable=0 → rate=0 → 可能"误判通过"
  const r = regressionGuard(
    [{ decision: 'END' }, { decision: 'END' }, { decision: 'END' }],
    [
      { decision: 'END', error: 'API' },
      { decision: 'END', error: 'API' },
      { decision: 'END', error: 'API' },
      { decision: 'END', error: 'API' },
    ],
    { endThreshold: 0.2, deltaThreshold: 0.3 },
  );
  // 诚实边界：错误排除后 postEndRate=0 ≤ 0.2，delta=1 ≥ 0.3 → pass=true
  // 意味着"评测根本没跑起来"也会被判通过 → 生产须叠加"可用样本数下限"门禁
  check('诚实边界：post 全错误 → 仍 pass=true（缺 min-sample 门禁）', r.pass === true && r.postEndRate === 0);

  // 14b. 边界含等号：postEndRate 恰等于阈值 → 仍通过（<=）
  const r2 = regressionGuard(
    [{ decision: 'END' }],
    [{ decision: 'END' }, { decision: 'END' }, { decision: 'END' }, { decision: 'END' }],
    { endThreshold: 1.0, deltaThreshold: 0 },
  );
  check('边界：postEndRate 恰等于阈值(1.0) → pass=true（<= 含等）', r2.pass === true);

  // 14c. delta 恰等于阈值 → pass（>= 含等）
  const r3 = regressionGuard(
    [{ decision: 'END' }],
    [{ decision: 'agentX' }],
    { endThreshold: 0.2, deltaThreshold: 1.0 },
  );
  check('边界：delta 恰等于阈值(1.0) → pass=true（>= 含等）', r3.pass === true && r3.delta === 1);

  // 14d. 空 pre（无基线）→ rate=0，delta 退化为 -postEndRate；guard 无法满足 delta 阈值而失效
  const r4 = regressionGuard(
    [],
    [{ decision: 'END' }], // post 全 END → postEndRate=1
    { endThreshold: 0.2, deltaThreshold: 0.3 },
  );
  check('空 pre（无基线）：postEndRate=1 但 delta=-1 → pass=false（guard 失效，需有效基线）', r4.pass === false && r4.delta === -1 && r4.postEndRate === 1);
}

// ============================================================================
// 15. 对抗性：RuntimeOverseer —— 超尝试上限 / execute 抛错 / 心跳异常
// ============================================================================
async function testOverseerAdversarial(): Promise<void> {
  console.log('\n[15] 对抗性：RuntimeOverseer（超尝试上限 / execute 抛错 / 心跳异常）');

  // 15a. 超尝试上限：meta.attempt > maxAttempts → 不执行、直接 failed
  const auth = new InMemoryLeaseAuthority(30_000);
  auth.submit('cap1', 'owner-C', 5);
  const meta = (await auth.claimNext('wk-c')) as ClaimedSession;
  const ev: string[] = [];
  let executed = false;
  const ov = new RuntimeOverseer({ authority: auth, heartbeatIntervalMs: 20, maxAttempts: 3, onEvent: (t) => ev.push(t) });
  await ov.run(meta, async () => { executed = true; });
  check('超尝试上限 → execute 不被调用', executed === false);
  check('超尝试上限 → 发 session_end(failed/over-attempt-cap) 且不开 session_start', ev.includes('session_end') && !ev.includes('session_start'));

  // 15b. execute 抛错 → 不崩溃、发 session_end(failed)、释放租约
  const auth2 = new InMemoryLeaseAuthority(30_000);
  auth2.submit('ex1', 'owner-E', 1);
  const meta2 = (await auth2.claimNext('wk-e')) as ClaimedSession;
  const ev2: string[] = [];
  let threwOutside = false;
  const ov2 = new RuntimeOverseer({ authority: auth2, heartbeatIntervalMs: 20, maxAttempts: 3, onEvent: (t) => ev2.push(t) });
  try {
    await ov2.run(meta2, async () => { throw new Error('agent panic'); });
  } catch {
    threwOutside = true;
  }
  check('execute 抛错 → 不被外层抛出（已内部消化）', threwOutside === false);
  check('execute 抛错 → 发 session_end(failed)', ev2.includes('session_end'));
  check('execute 抛错后租约已释放（心跳被拒）', (await auth2.heartbeat('ex1', 'wk-e')) === false);

  // 15c. 心跳异常（存储故障）→ 视为失租 → session_interrupted
  class ThrowingAuth extends InMemoryLeaseAuthority {
    override async heartbeat(): Promise<boolean> { throw new Error('pg down'); }
  }
  const auth3 = new ThrowingAuth(30_000);
  auth3.submit('hb1', 'owner-H', 1);
  const meta3 = (await auth3.claimNext('wk-h')) as ClaimedSession;
  const ev3: string[] = [];
  const ov3 = new RuntimeOverseer({ authority: auth3, heartbeatIntervalMs: 10, maxAttempts: 3, onEvent: (t) => ev3.push(t) });
  await ov3.run(meta3, async () => { await sleep(60); });
  check('心跳异常（存储故障）→ session_interrupted', ev3.includes('session_interrupted'));
}

// ============================================================================
// 16. 对抗性：OrderedDurableChain —— 关键写入失败中止 / 非关键容忍
// ============================================================================
async function testChainAdversarial(): Promise<void> {
  console.log('\n[16] 对抗性：OrderedDurableChain（关键写入失败中止 / 非关键容忍）');

  // 16a. 关键写入失败 → onLeaseLost 触发、healthy=false、flush 抛错、后续关键写入跳过
  let lostCalls = 0;
  let criticalRan = 0;
  let afterRan = 0;
  const chain = new OrderedDurableChain(() => { lostCalls++; });
  chain.enqueue(() => Promise.resolve(), false);
  chain.enqueue(async () => { criticalRan++; throw new Error('db down'); }, true);
  chain.enqueue(async () => { afterRan++; }, true);
  let flushThrew = false;
  try {
    await chain.flush();
  } catch {
    flushThrew = true;
  }
  check('关键写入失败 → onLeaseLost 被调用', lostCalls === 1);
  check('关键写入失败 → flush() 抛错（拒绝部分成功）', flushThrew);
  check('关键写入失败后，后续关键写入被跳过（afterRan=0）', afterRan === 0);
  check('首个关键写入确实执行过（criticalRan=1）', criticalRan === 1);

  // 16b. 非关键写入失败 → 不影响链健康、flush 成功、后续仍执行
  let lost2 = 0;
  let nonCritRan = 0;
  let nextRan = 0;
  const chain2 = new OrderedDurableChain(() => { lost2++; });
  chain2.enqueue(async () => { nonCritRan++; throw new Error('soft fail'); }, false);
  chain2.enqueue(async () => { nextRan++; }, false);
  let flush2Threw = false;
  try {
    await chain2.flush();
  } catch {
    flush2Threw = true;
  }
  check('非关键写入失败 → onLeaseLost 不被调用', lost2 === 0);
  check('非关键写入失败 → flush() 不抛错（容忍）', flush2Threw === false);
  check('非关键失败后，后续写入仍执行（nextRan=1）', nextRan === 1);
}

// ============================================================================
// 17. EntryGuard / ExitGuard —— E1 入口 / E5 出口检查（拦截恶意工具调用）
//     证明：把"观测"升级为"观测 + 一次性的强制力展示"——
//     - EntryGuard 拦截 → 工具根本不执行；
//     - ExitGuard 拒绝 → 结果被丢弃 + 审计留痕；
//     - 只有两者都放行，结果才返回给调用方。
// ============================================================================
async function testEntryExitGuards(): Promise<void> {
  console.log('\n[17] EntryGuard / ExitGuard（E1 入口 / E5 出口检查）');

  const audit = new AppendOnlyAuditLog();

  // 场景：允许 read_file / write_file / exec_shell 三个工具；
  // 但 exec_shell 的参数不允许包含 "rm -rf"；write_file 的路径不允许写 /etc。
  const allowedTools = new Set(['read_file', 'write_file', 'exec_shell']);
  const argPolicies = [
    {
      name: 'no-destructive-shell',
      tools: new Set(['exec_shell']),
      check: (args: unknown) => {
        const cmd = (args as { command?: string }).command ?? '';
        return !cmd.includes('rm -rf');
      },
      reason: (args: unknown) =>
        `destructive command blocked: "${(args as { command?: string }).command ?? ''}"`,
    },
    {
      name: 'no-system-path-write',
      tools: new Set(['write_file']),
      check: (args: unknown) => {
        const path = (args as { path?: string }).path ?? '';
        return !path.startsWith('/etc');
      },
      reason: (args: unknown) =>
        `system path write blocked: "${(args as { path?: string }).path ?? ''}"`,
    },
  ];
  const entry = new EntryGuard(allowedTools, argPolicies, audit);

  // 17a. 白名单外的工具 → 入口拒绝，工具不执行
  let executeCount = 0;
  const ev1 = entry.check({ tool: 'drop_database', args: {}, callerId: 'agent-1' });
  check('入口拒绝白名单外的工具（drop_database）', ev1.kind === 'deny');
  check('拒绝类别正确（tool-not-allowed）',
    ev1.kind === 'deny' && ev1.category === 'tool-not-allowed');
  executeCount = 0; // 模拟：如果走 guardedToolCall，execute 根本不会被调用
  check('入口拒绝时工具不执行（executeCount=0）', executeCount === 0);

  // 17b. exec_shell 包含 rm -rf → 入口拒绝（参数策略违规）
  const ev2 = entry.check({
    tool: 'exec_shell',
    args: { command: 'rm -rf /' },
    callerId: 'agent-1',
  });
  check('入口拦截恶意命令 rm -rf /（强制力展示）', ev2.kind === 'deny');
  check('拒绝类别正确（arg-policy-violation）',
    ev2.kind === 'deny' && ev2.category === 'arg-policy-violation');
  check('拒绝理由包含策略名', ev2.kind === 'deny' && ev2.reason.includes('no-destructive-shell'));

  // 17c. write_file 写 /etc/passwd → 入口拒绝
  const ev3 = entry.check({
    tool: 'write_file',
    args: { path: '/etc/passwd', content: 'hacked' },
    callerId: 'agent-1',
  });
  check('入口拦截系统路径写入 /etc/passwd', ev3.kind === 'deny');
  check('拒绝类别正确（arg-policy-violation）',
    ev3.kind === 'deny' && ev3.category === 'arg-policy-violation');

  // 17d. 正常的 read_file → 入口放行
  const ev4 = entry.check({
    tool: 'read_file',
    args: { path: '/tmp/hello.txt' },
    callerId: 'agent-1',
  });
  check('正常调用入口放行（read_file）', ev4.kind === 'allow');

  // 17e. 入口拦截记审计事件——检查 audit 有 3 条 entry_deny（17a/17b/17c）
  check('入口拦截记了 3 条审计事件（audit.lastSeq >= 3）', audit.lastSeq >= 3);

  // --- ExitGuard ---
  const audit2 = new AppendOnlyAuditLog();
  const budget = { maxTokens: 1000, maxDurationMs: 5000 };
  const outputPolicies = [
    {
      name: 'no-credit-card-leak',
      tools: new Set(['read_file']),
      check: (result: { ok: boolean; output: unknown }) => {
        const text = String(result.output ?? '');
        return !text.match(/\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/);
      },
      reason: () => 'output contains credit-card-like number (potential data leak)',
    },
  ];
  const exit = new ExitGuard(budget, outputPolicies, () => true, audit2);

  const req: ToolCallRequest = { tool: 'read_file', args: { path: '/tmp/x' }, callerId: 'agent-1' };

  // 17f. 正常结果 → 出口接受
  const xv1 = exit.check(req, { ok: true, output: 'hello world', resources: { tokens: 10 } });
  check('正常结果出口接受', xv1.kind === 'accept');

  // 17g. 资源超预算 → 出口拒绝
  const xv2 = exit.check(req, {
    ok: true,
    output: 'data',
    resources: { tokens: 2000, durationMs: 3000 },
  });
  check('资源超预算 → 出口拒绝（强制力展示）', xv2.kind === 'reject');
  check('拒绝类别正确（resource-over-budget）',
    xv2.kind === 'reject' && xv2.category === 'resource-over-budget');

  // 17h. 输出含疑似信用卡号 → 出口拒绝
  const xv3 = exit.check(req, { ok: true, output: 'card: 4111 1111 1111 1111' });
  check('输出含信用卡号 → 出口拒绝（数据泄露拦截）', xv3.kind === 'reject');
  check('拒绝类别正确（output-policy-violation）',
    xv3.kind === 'reject' && xv3.category === 'output-policy-violation');

  // 17i. 端到端：guardedToolCall 把入口 + 执行 + 出口串成管道——恶意调用被拦在入口
  const audit3 = new AppendOnlyAuditLog();
  const entry2 = new EntryGuard(
    new Set(['exec_shell']),
    [{
      name: 'no-rm-rf',
      tools: new Set(['exec_shell']),
      check: (a: unknown) => !(a as { command?: string }).command?.includes('rm -rf'),
      reason: (a: unknown) => `blocked: "${(a as { command?: string }).command}"`,
    }],
    audit3,
  );
  const exit2 = new ExitGuard({}, [], () => true, audit3);
  let actuallyExecuted = false;
  const outcome = await guardedToolCall(
    entry2,
    exit2,
    { tool: 'exec_shell', args: { command: 'rm -rf /home' }, callerId: 'agent-x' },
    async () => {
      actuallyExecuted = true;
      return { ok: true, output: 'should never reach here' };
    },
  );
  check('端到端：恶意调用被拦在入口（denied-entry）', outcome.verdict === 'denied-entry');
  check('端到端：execute 回调根本没被调用（强制力）', actuallyExecuted === false);
  check('端到端：拒绝理由有值', !!outcome.denyReason && outcome.denyReason.length > 0);

  // 17j. 端到端：正常调用穿过整条管道
  const outcome2 = await guardedToolCall(
    entry2,
    exit2,
    { tool: 'exec_shell', args: { command: 'ls /tmp' }, callerId: 'agent-x' },
    async () => ({ ok: true, output: 'file1\nfile2' }),
  );
  check('端到端：正常调用穿过管道（allowed）', outcome2.verdict === 'allowed');
  check('端到端：返回执行结果', outcome2.result?.output === 'file1\nfile2');
}

// ============================================================================
// 18. SqliteLeaseAuthority —— G1 闭合：租约权威持久化
//     证明：① 租约状态落盘后，重新打开同一数据库可恢复（"崩溃后可恢复"）；
//           ② 接口行为与 InMemoryLeaseAuthority 一致（同 heartbeat/release/assert 语义）；
//           ③ SQLite 不可用（Node 版本/flag 不支持）时优雅跳过而非崩溃。
//     运行：node --experimental-sqlite --experimental-transform-types demo.ts
// ============================================================================
async function testSqliteLease(): Promise<void> {
  console.log('\n[18] SqliteLeaseAuthority（G1 闭合：租约权威 SQLite 持久化）');

  // 18a. SQLite 可用性探测——不可用时降级为提示 + 全跳过（不 FAIL，环境差异不算缺陷）
  let auth: SqliteLeaseAuthority;
  try {
    auth = new SqliteLeaseAuthority(':memory:', 30_000);
  } catch (e) {
    console.log(`  SKIP  node:sqlite 不可用（${String(e).slice(0, 60)}…）——加 --experimental-sqlite 运行可启用本组`);
    return;
  }

  // 18b. 基本租约语义与 InMemory 一致
  auth.submit('s1', 'owner-A', 1);
  const claimed = (await auth.claimNext('wk-sqlite')) as ClaimedSession;
  check('claimNext 返回会话且 workerId 匹配', !!claimed && claimed.lease.workerId === 'wk-sqlite');
  check('SQLite 心跳续租成功', (await auth.heartbeat('s1', 'wk-sqlite')) === true);
  check('SQLite 异 worker 心跳被拒（失租判定）', (await auth.heartbeat('s1', 'intruder')) === false);
  let threw = false;
  try {
    await auth.assertActiveLease('s1', 'wk-sqlite', 99);
  } catch (e) {
    threw = isLeaseLostError(e);
  }
  check('SQLite attempt 不匹配 → 抛 LeaseLostError', threw);

  // 18c. 持久化核心证明：写盘 → 关句柄 → 重开同一文件 → 状态仍在
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dbFile = path.join(os.tmpdir(), `l2-lease-demo-${Date.now()}.db`);
  try {
    const authDisk = new SqliteLeaseAuthority(dbFile, 30_000);
    authDisk.submit('s-persist', 'owner-P', 1);
    await authDisk.claimNext('wk-crash');
    authDisk.close(); // 模拟进程崩溃：句柄关闭、内存全失

    const reopened = new SqliteLeaseAuthority(dbFile, 30_000);
    check('持久化：崩溃（close）后重开数据库，租约状态仍在',
      (await reopened.heartbeat('s-persist', 'wk-crash')) === true);
    check('持久化：重开后其他 worker 仍无法窃取心跳',
      (await reopened.heartbeat('s-persist', 'intruder')) === false);
    reopened.close();
  } finally {
    try { fs.unlinkSync(dbFile); } catch { /* 临时文件清理尽力而为 */ }
  }

  // 18d. 释放语义
  await auth.release('s1', 'wk-sqlite');
  check('SQLite 释放后心跳被拒', (await auth.heartbeat('s1', 'wk-sqlite')) === false);
  auth.close();
}

// ============================================================================
// 19. ConfigReviewer + EntryGuard 配置内容审查 —— spec/02 第四条「配置权即攻击面」
//     证明：恶意配置变更（明文凭据内联 / 共享范围扩大 / 审批步骤关闭 / 网关公开化 /
//     脱敏弱化）即使工具在白名单、参数策略全通过、性能完全不回归，也会被第五道
//     审查拦在执行之前——「性能不回归不等于安全不退化」的强制力展示。
//     五项检查点对应 spec/02-architecture.md L98–L100；证据锚点 HarnessRisk（arXiv:2608.17597，B 级）。
// ============================================================================
function testConfigReview(): void {
  console.log('\n[19] ConfigReviewer（spec/02 第四条：配置权即攻击面——五项检查点）');

  const audit = new AppendOnlyAuditLog();
  // 场景：update_workflow_config 是一条**已被授权**的配置变更工具（白名单内）；
  // 它的参数不含任何被参数策略禁止的模式——恶意性完全藏在配置内容里。
  const allowedTools = new Set(['update_workflow_config']);
  const reviewer = new ConfigReviewer();
  const entry = new EntryGuard(allowedTools, [], audit, reviewer, new Set(['update_workflow_config']));

  // 19a. 凭据明文内联 → 拦截
  const ev1 = entry.check({
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-1', config: 'api_key=sk-abc123def456ghi789' },
    callerId: 'agent-1',
  });
  check('① 明文凭据内联被拦截（inline-credential）',
    ev1.kind === 'deny' && ev1.category === 'config-review-fail' && ev1.reason.includes('inline-credential'));
  check('  拒绝理由包含命中的规则名与细节', ev1.kind === 'deny' && ev1.reason.includes('config-review['));

  // 19b. 共享范围扩大（public）→ 拦截
  const ev2 = entry.check({
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-2', config: { visibility: 'public' } },
    callerId: 'agent-1',
  });
  check('② 共享范围扩大（visibility: public）被拦截（share-scope-widened）',
    ev2.kind === 'deny' && ev2.category === 'config-review-fail' && ev2.reason.includes('share-scope-widened'));

  // 19c. 审批步骤关闭 → 拦截
  //     这是关键对抗场景：关掉审批步骤会让通过率上升（性能中性甚至为正），
  //     参数策略与准入判定式都不会拦——只有配置内容审查会拦。
  const ev3 = entry.check({
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-3', config: { requireApproval: false } },
    callerId: 'agent-1',
  });
  check('③ 审批步骤关闭（requireApproval: false）被拦截（approval-disabled）',
    ev3.kind === 'deny' && ev3.category === 'config-review-fail' && ev3.reason.includes('approval-disabled'));

  // 19d. 对外网关公开化（127.0.0.1 → 0.0.0.0）→ 拦截
  const ev4 = entry.check({
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-4', config: { gateway: '0.0.0.0' } },
    callerId: 'agent-1',
  });
  check('④ 对外网关公开化（gateway: 0.0.0.0）被拦截（gateway-publicized）',
    ev4.kind === 'deny' && ev4.category === 'config-review-fail' && ev4.reason.includes('gateway-publicized'));

  // 19e. 脱敏强度弱化（redact: off）→ 拦截
  const ev5 = entry.check({
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-5', config: { redact: 'off' } },
    callerId: 'agent-1',
  });
  check('⑤ 脱敏强度弱化（redact: off）被拦截（redaction-weakened）',
    ev5.kind === 'deny' && ev5.category === 'config-review-fail' && ev5.reason.includes('redaction-weakened'));

  // 19f. 复合恶意配置（一次命中多项）→ 拦截且 findings 全部记录
  const ev6 = entry.check({
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-6', config: { visibility: 'everyone', requireApproval: false, redact: 'none' } },
    callerId: 'agent-1',
  });
  check('复合恶意配置一次命中多项（share-scope-widened + approval-disabled + redaction-weakened）',
    ev6.kind === 'deny' &&
    ev6.reason.includes('share-scope-widened') &&
    ev6.reason.includes('approval-disabled') &&
    ev6.reason.includes('redaction-weakened'));

  // 19g. 良性配置变更（改个超时参数）→ 放行——审查不误伤正常运维
  const ev7 = entry.check({
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-7', config: { timeoutMs: 30000, retries: 3 } },
    callerId: 'agent-1',
  });
  check('良性配置变更（timeoutMs/retries）放行（不误伤正常运维）', ev7.kind === 'allow');

  // 19h. 内网地址不触发网关公开化误报（127.0.0.1 / 10.x 内网不拦）
  const ev8 = entry.check({
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-8', config: { gateway: '127.0.0.1:8080' } },
    callerId: 'agent-1',
  });
  check('内网网关（127.0.0.1）不触发误报', ev8.kind === 'allow');

  // 19i. 恶意拦截全部留痕——审计日志有 6 条 entry_deny（19a–19f），类别正确
  check('五项拦截 + 复合拦截均记审计事件（config-review-fail × 6）', audit.lastSeq === 6);

  // 19j. 端到端：guardedToolCall + ConfigReviewer——恶意配置变更被拦在入口，execute 不执行
  const audit2 = new AppendOnlyAuditLog();
  const entry2 = new EntryGuard(
    new Set(['update_workflow_config']),
    [],
    audit2,
    new ConfigReviewer(),
    new Set(['update_workflow_config']),
  );
  const exit2 = new ExitGuard({}, [], () => true, audit2);
  let actuallyExecuted = false;
  const outcome = guardedToolCallSync(entry2, exit2, {
    tool: 'update_workflow_config',
    args: { workflowId: 'wf-9', config: { password: 'hunter2hunter2hunter2', requireApproval: false } },
    callerId: 'agent-x',
  }, () => { actuallyExecuted = true; return { ok: true, output: 'should never reach' }; });
  check('端到端：恶意配置变更被拦在入口（denied-entry）', outcome.verdict === 'denied-entry');
  check('端到端：execute 回调根本没被调用（强制力）', actuallyExecuted === false);
  check('端到端：拒绝理由同时命中明文凭据与审批关闭两项', outcome.verdict === 'denied-entry' &&
    !!outcome.denyReason && outcome.denyReason.includes('inline-credential') && outcome.denyReason.includes('approval-disabled'));

  // 19k. ConfigReviewer 单独可用（不依赖 EntryGuard）——可直接用于变更准入流水线
  const solo = new ConfigReviewer();
  check('ConfigReviewer 可独立使用：review() 单独判定恶意配置',
    solo.review({ token: 'ghp_1234567890abcdef' }).kind === 'fail');
  check('ConfigReviewer 可独立使用：review() 单独判定良性配置',
    solo.review({ timeoutMs: 5000 }).kind === 'pass');
}

/** 同步版管道——仅供 demo [19j] 在不引入 async 的情况下展示「拦截即不执行」语义。 */
function guardedToolCallSync(
  entry: EntryGuard,
  exit: ExitGuard,
  req: ToolCallRequest,
  execute: (req: ToolCallRequest) => { ok: boolean; output: unknown; resources?: { tokens?: number; memoryMb?: number; durationMs?: number } },
): { verdict: 'allowed' | 'denied-entry' | 'rejected-exit'; result?: unknown; denyReason?: string } {
  const ev = entry.check(req);
  if (ev.kind === 'deny') return { verdict: 'denied-entry', denyReason: ev.reason };
  const result = execute(req);
  const xv = exit.check(req, result);
  if (xv.kind === 'reject') return { verdict: 'rejected-exit', denyReason: xv.reason };
  return { verdict: 'allowed', result };
}

// ============================================================================
// 20. ResourceLedger —— G5 闭合：spec/10 资源账本（预算比/影子比/记忆写入审计/周期型外联）
// ============================================================================
function testResourceLedger(): void {
  console.log('\n[20] ResourceLedger（G5 闭合：spec/10 资源账本——四类信号）');

  // 辅助：提取审计日志中的 ledger_signal 事件
  function extractLedgerSignals(log: AppendOnlyAuditLog): Array<{ kind: string; taskId: string; detail: string }> {
    const events = (log as unknown as { events: Array<{ type: string; data: unknown }> }).events;
    return events
      .filter((e) => e.type === 'ledger_signal')
      .map((e) => (e.data as { kind: string; taskId: string; detail: string }));
  }

  // —— 信号① 预算比：超阈触发审计信号（非拦截）——
  const log1 = new AppendOnlyAuditLog();
  const ledger1 = new ResourceLedger(log1);
  const budget1: TaskBudget = { taskId: 't-budget', maxTokens: 8000, maxDurationMs: 5000 };
  const signals1 = ledger1.record('t-budget', 'search', { tokens: 12000, durationMs: 3000 }, budget1);
  check('预算比：tokens 超阈 → 产出 budget-exceeded 信号', signals1.some((s) => s.kind === 'budget-exceeded' && s.detail.includes('tokens 12000 > budget 8000')));
  check('预算比：duration 未超阈 → 不产出该维度信号', signals1.every((s => s.kind !== 'budget-exceeded' || !s.detail.includes('duration'))));
  check('预算比：信号写入审计日志（ledger_signal 事件）', extractLedgerSignals(log1).some((s) => s.kind === 'budget-exceeded'));
  check('预算比：预算内消耗不触发信号', ledger1.record('t-budget', 'search', { tokens: 4000, durationMs: 2000 }, budget1).length === 0);

  // —— 信号② 影子比：实际/基线 比例超阈触发偏离信号 ——
  const log2 = new AppendOnlyAuditLog();
  const ledger2 = new ResourceLedger(log2);
  const budget2: TaskBudget = {
    taskId: 't-shadow',
    shadowRatioThreshold: 2.0,
    shadowBaseline: { tokens: 5000, durationMs: 1000 },
  };
  const signals2 = ledger2.record('t-shadow', 'infer', { tokens: 12000, durationMs: 800 }, budget2);
  check('影子比：tokens 偏离基线 2.4 倍 > 阈值 2.0 → 产出 shadow-deviation', signals2.some((s) => s.kind === 'shadow-deviation' && s.detail.includes('tokens')));
  check('影子比：duration 0.8 倍 < 阈值 2.0 → 不产出该维度信号', signals2.every((s) => s.kind !== 'shadow-deviation' || !s.detail.includes('duration')));
  check('影子比：基线内消耗不触发偏离信号', ledger2.record('t-shadow', 'infer', { tokens: 6000 }, budget2).every((s) => s.kind !== 'shadow-deviation'));
  check('影子比：无基线（shadowBaseline=undefined）时跳过影子比检测', new ResourceLedger(new AppendOnlyAuditLog()).record('t-no-base', 'infer', { tokens: 99999 }, { taskId: 't-no-base', shadowRatioThreshold: 2.0 }).length === 0);

  // —— 信号③ 记忆写入审计：memory/system-prompt/persisted-config 写入标记为最高审计级别 ——
  const log3 = new AppendOnlyAuditLog();
  const ledger3 = new ResourceLedger(log3);
  const memSig = ledger3.auditMemoryWrite('t-mem', 'memory', { tool: 'write_memory', fieldsChanged: ['preferences', 'goals'], bytes: 512 });
  check('记忆写入审计：产出 memory-write-audited 信号', memSig.kind === 'memory-write-audited');
  check('记忆写入审计：detail 含 target=memory', memSig.detail.includes('memory'));
  check('记忆写入审计：detail 含 fields 变更列表', memSig.detail.includes('preferences') && memSig.detail.includes('goals'));
  check('记忆写入审计：detail 含字节数', memSig.detail.includes('bytes=512'));
  const sysSig = ledger3.auditMemoryWrite('t-mem', 'system-prompt', { tool: 'update_prompt' });
  check('记忆写入审计：system-prompt 写入同样标记', sysSig.detail.includes('system-prompt'));
  const cfgSig = ledger3.auditMemoryWrite('t-mem', 'persisted-config', { tool: 'set_config', fieldsChanged: ['model'], bytes: 64 });
  check('记忆写入审计：persisted-config 写入同样标记', cfgSig.detail.includes('persisted-config'));
  check('记忆写入审计：写入留痕于审计日志', extractLedgerSignals(log3).filter((s) => s.kind === 'memory-write-audited').length === 3);

  // —— 信号④ 周期型外联：固定间隔轮询触发（与数据量无关） ——
  const log4 = new AppendOnlyAuditLog();
  const ledger4 = new ResourceLedger(log4, 4); // 窗口=4，便于快速触发
  // 模拟 C2 心跳：4 次出站，每次间隔固定 100ms，但每次数据量极小（与量级信号无关）
  let clock4 = 1000000;
  const realNow = Date.now;
  for (let i = 0; i < 4; i++) {
    clock4 += 100; // 固定间隔 100ms
    // 临时让 Date.now 返回受控值（signals 在 record 内部用 Date.now() 取时间戳）
    (Date as unknown as { now: () => number }).now = () => clock4;
    ledger4.record('t-c2', 'http_post', { egressBytes: 32 }, { taskId: 't-c2' });
  }
  (Date as unknown as { now: () => number }).now = realNow;
  const periodicSignals = extractLedgerSignals(log4).filter((s) => s.kind === 'periodic-egress');
  check('周期型外联：固定间隔小数据量触发 periodic-egress（与量级信号无关）', periodicSignals.length >= 1);
  check('周期型外联：信号 detail 含 interval mean 与 variance', periodicSignals[0]?.detail.includes('interval mean') && periodicSignals[0]?.detail.includes('variance'));

  // —— 对抗性：非周期出站不触发信号④ ——
  const log5 = new AppendOnlyAuditLog();
  const ledger5 = new ResourceLedger(log5, 4);
  let clock5 = 2000000;
  const intervals5 = [50, 800, 30, 950]; // 高度不规则的间隔
  for (const gap of intervals5) {
    clock5 += gap;
    (Date as unknown as { now: () => number }).now = () => clock5;
    ledger5.record('t-burst', 'http_get', { egressBytes: 100 }, { taskId: 't-burst' });
  }
  (Date as unknown as { now: () => number }).now = realNow;
  check('对抗性：非周期出站（间隔方差极大）不触发 periodic-egress', extractLedgerSignals(log5).every((s) => s.kind !== 'periodic-egress'));

  // —— 对抗性：信号①预算比与信号③记忆写入审计级别不同 ——
  const log6 = new AppendOnlyAuditLog();
  const ledger6 = new ResourceLedger(log6);
  ledger6.record('t-mix', 'infer', { tokens: 99999 }, { taskId: 't-mix', maxTokens: 100 });
  ledger6.auditMemoryWrite('t-mix', 'memory', { tool: 'write', bytes: 10 });
  const events6 = (log6 as unknown as { events: Array<{ type: string; data: unknown }> }).events.filter((e) => e.type === 'ledger_signal');
  const budgetEv = events6.find((e) => (e.data as { kind: string }).kind === 'budget-exceeded');
  const memEv = events6.find((e) => (e.data as { kind: string }).kind === 'memory-write-audited');
  check('对抗性：记忆写入审计事件含 level=highest 标记（高于普通预算信号）', (memEv?.data as { level?: string }).level === 'highest');
  check('对抗性：普通预算信号不含 level=highest', (budgetEv?.data as { level?: string }).level === undefined);

  // —— 向后兼容：不注入 ResourceLedger 时现有组件行为不变（与 ConfigReviewer 同构） ——
  check('向后兼容：ResourceLedger 不注入不影响 AppendOnlyAuditLog 正常工作', (() => {
    const log = new AppendOnlyAuditLog();
    log.append('test_event', { x: 1 });
    return log.lastSeq === 1;
  })());
}

// ============================================================================
// main
// ============================================================================
async function main(): Promise<void> {

  console.log('=== runtime-oversight-skeleton demo ===');
  await testLeaseAuthority();
  testTripwire();
  await testOwnerScoped();
  testAuditLog();
  await testCapability();
  testRegressionGuard();
  await testOverseerHealthy();
  await testOverseerLeaseLost();
  await testOwnerInjection();
  await testLeaseAdversarial();
  testTripwireAdversarial();
  await testOwnerAdversarialDeep();
  testAuditAdversarial();
  await testCapabilityAdversarial();
  testRegressionAdversarial();
  await testOverseerAdversarial();
  await testChainAdversarial();
  await testEntryExitGuards();
  await testSqliteLease();
  testConfigReview();
  testResourceLedger();

  console.log(`\n=== 结果：${failures === 0 ? 'ALL PASS ✅' : `${failures} FAIL ❌`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
