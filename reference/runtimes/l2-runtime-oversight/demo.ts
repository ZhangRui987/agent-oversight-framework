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
 *   [12] 对抗性：AppendOnlyAuditLog（篡改/截断检测 + 占位哈希碰撞边界）
 *   [13] 对抗性：CapabilityRegistry（名称混淆/注册-白名单错配）
 *   [14] 对抗性：regressionGuard（错误洪泛误判/阈值边界/空基线）
 *   [15] 对抗性：RuntimeOverseer（超尝试上限/execute 抛错/心跳异常）
 *   [16] 对抗性：OrderedDurableChain（关键写入失败中止/非关键容忍）
 *
 * 运行：node --experimental-transform-types demo.ts
 * 退出码：0 = 全部 PASS，1 = 有 FAIL
 *
 * 许可证：Apache License 2.0（代码路径，见 LICENSING.md 的路径 ↔ 许可证映射）。
 */

import {
  AppendOnlyAuditLog,
  CapabilityRegistry,
  InMemoryLeaseAuthority,
  LeaseLostError,
  LifecycleTripwire,
  OrderedDurableChain,
  OwnerScopedStore,
  RuntimeOverseer,
  isLeaseLostError,
  regressionGuard,
  type ClaimedSession,
  type LeaseAuthority,
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

  // 12d. 诚实边界：占位哈希仅含"长度"，等长不同内容可能碰撞 → 验证其非真实完整性保证
  const t4 = new TamperableAuditLog();
  t4.append('session_start', { a: 1 }); // 数据 {"a":1} 长 6
  t4.tamper(0, { b: 2 }); // 数据 {"b":2} 等长 6，但内容不同
  // 注：本骨架哈希是占位实现（不含内容哈希），仅示意；生产须换 SHA-256
  check('诚实边界：占位哈希对等长篡改可能漏检（须 SHA-256 才安全）', t4.verifyChain() === true);
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

  console.log(`\n=== 结果：${failures === 0 ? 'ALL PASS ✅' : `${failures} FAIL ❌`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
