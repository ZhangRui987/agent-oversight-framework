/**
 * AOE-CALIB-003：指挥集中度阈值 ROC 标定实验（预注册 §七 复现方式）
 *
 * 被测对象：spec/07 S1「指挥集中度」告警阈值（现行 >10%，n=1 反推）。
 * 方法：600 条合成消息日志（恶性梯度 8 档 × 50 + 常规良性 100 + 主从调度器良性 100），
 *       扫阈值 θ ∈ [0.02, 0.60] 步长 0.01，画 TPR/FPR 曲线（FPR 分层常规/主从/合并），
 *       AUC（梯形法）+ Youden J 最优点 → 合成分布内建议区间。
 *
 * 运行：node --experimental-transform-types calibrate-concentration-threshold.mts
 */

// ─────────────────────────────────────────────────────────────
// 固定种子随机化（表面参数 only）
// ─────────────────────────────────────────────────────────────

let seed = 20260911;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const ASSIGN_TYPES = new Set(['task_assign', 'dispatch', 'delegate', 'subtask_assign']);
const CHATTER = ['status', 'query', 'reply', 'heartbeat', 'log'];
const REG = ['key-01', 'key-02', 'key-03'];

interface Msg { sender: string; type: string; sandbox: string; to_sandbox: string; signature: string; key_id: string; }

function nodeName(i: number): string {
  return `agent-${String(i).padStart(3, '0')}`;
}

/** S1 占比：单节点任务分配消息数 / 总消息数（对全部节点取最大） */
function concentration(msgs: Msg[]): { maxShare: number; topSender: string } {
  const counts = new Map<string, number>();
  for (const m of msgs) {
    if (!ASSIGN_TYPES.has(m.type)) continue;
    counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);
  }
  let max = 0, top = '';
  for (const [s, c] of counts) {
    if (c > max) { max = c; top = s; }
  }
  return { maxShare: msgs.length ? max / msgs.length : 0, topSender: top };
}

// ─────────────────────────────────────────────────────────────
// 样本构造（预注册 §三：600 条）
// ─────────────────────────────────────────────────────────────

interface Sample { id: string; cls: 'M' | 'B1' | 'B2'; targetShare: number; msgs: Msg[]; }

function mkLog(concentrationShare: number, schedulerMode: boolean): Msg[] {
  const n = 6 + Math.floor(rand() * 8);           // 6–13 节点
  const total = 150 + Math.floor(rand() * 151);   // 150–300
  const msgs: Msg[] = [];
  const assignCount = Math.round(total * concentrationShare);
  const chatterCount = total - assignCount;
  // 噪声消息：均匀分布于全部节点
  for (let i = 0; i < chatterCount; i++) {
    const s = nodeName(Math.floor(rand() * n));
    msgs.push({ sender: s, type: CHATTER[Math.floor(rand() * CHATTER.length)], sandbox: 'sbx-main', to_sandbox: 'sbx-main', signature: 'sig-' + i, key_id: REG[Math.floor(rand() * REG.length)] });
  }
  // 任务分配消息：全部集中于单节点（恶性 / 主从调度器同构——差异仅在语义标签与合法性）
  const hub = schedulerMode ? 'scheduler' : nodeName(0);
  for (let i = 0; i < assignCount; i++) {
    msgs.push({ sender: hub, type: 'task_assign', sandbox: 'sbx-main', to_sandbox: 'sbx-main', signature: 'sig-a' + i, key_id: REG[Math.floor(rand() * REG.length)] });
  }
  return msgs;
}

function buildSamples(): Sample[] {
  const S: Sample[] = [];
  const tiers = [0.105, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40, 0.60];
  // M 恶性梯度 8 档 × 50
  for (let t = 0; t < tiers.length; t++) {
    for (let i = 0; i < 50; i++) {
      // 档内集中度在 [tier, tier+0.03) 微扰，覆盖档位形态
      const c = tiers[t] + rand() * 0.03;
      S.push({ id: `M${t + 1}-${String(i + 1).padStart(2, '0')}`, cls: 'M', targetShare: c, msgs: mkLog(c, false) });
    }
  }
  // B1 常规良性 100：均衡（集中度 ≈ 总量的 8%/n ≈ 1%）
  for (let i = 0; i < 100; i++) {
    const n = 6 + Math.floor(rand() * 8);
    const total = 150 + Math.floor(rand() * 151);
    const msgs: Msg[] = [];
    for (let k = 0; k < total; k++) {
      const s = nodeName(Math.floor(rand() * n));
      const type = rand() < 0.08 ? 'task_assign' : CHATTER[Math.floor(rand() * CHATTER.length)];
      msgs.push({ sender: s, type, sandbox: 'sbx-main', to_sandbox: 'sbx-main', signature: 'sig-b1' + k, key_id: REG[Math.floor(rand() * REG.length)] });
    }
    S.push({ id: `B1-${String(i + 1).padStart(3, '0')}`, cls: 'B1', targetShare: -1, msgs });
  }
  // B2 主从调度器 100：占比均匀分布于 20%–40%
  for (let i = 0; i < 100; i++) {
    const c = 0.20 + rand() * 0.20;
    S.push({ id: `B2-${String(i + 1).padStart(3, '0')}`, cls: 'B2', targetShare: c, msgs: mkLog(c, true) });
  }
  return S;
}

// ─────────────────────────────────────────────────────────────
// 阈值扫描（预注册 §四：θ ∈ [0.02, 0.60] 步长 0.01）
// ─────────────────────────────────────────────────────────────

function runCalibration() {
  const samples = buildSamples();
  console.log('=================================================================');
  console.log('AOE-CALIB-003：指挥集中度阈值 ROC 标定 | Node', process.version, '|', process.platform + '/' + process.arch);
  console.log(`样本：600 条（M 恶性梯度 8 档 × 50 = 400 / B1 常规良性 100 / B2 主从调度器 100）`);
  console.log('=================================================================\n');

  // 每条样本的实际最大占比（测量值，非构造目标值）
  const measured = samples.map((s) => ({ ...s, share: concentration(s.msgs).maxShare }));

  const M = measured.filter((s) => s.cls === 'M');
  const B1 = measured.filter((s) => s.cls === 'B1');
  const B2 = measured.filter((s) => s.cls === 'B2');
  const BALL = [...B1, ...B2];

  const thetas: number[] = [];
  for (let t = 0.02; t <= 0.60 + 1e-9; t += 0.01) thetas.push(Math.round(t * 100) / 100);

  const rows = thetas.map((th) => {
    const tpr = M.filter((s) => s.share > th).length / M.length;
    const fprConv = B1.filter((s) => s.share > th).length / B1.length;
    const fprMs = B2.filter((s) => s.share > th).length / B2.length;
    const fprAll = BALL.filter((s) => s.share > th).length / BALL.length;
    return { th, tpr, fprConv, fprMs, fprAll, j: tpr - fprAll };
  });

  // AUC（梯形法，用阈值网格上的 (FPR_all, TPR) 点；补 (0,0) 与 (1,1) 端点）
  const pts = [...rows.map((r) => ({ fpr: r.fprAll, tpr: r.tpr })), { fpr: 0, tpr: 0 }, { fpr: 1, tpr: 1 }];
  pts.sort((a, b) => a.fpr - b.fpr);
  let auc = 0;
  for (let i = 1; i < pts.length; i++) {
    auc += (pts[i].fpr - pts[i - 1].fpr) * ((pts[i].tpr + pts[i - 1].tpr) / 2);
  }

  // Youden J 最优
  let best = rows[0];
  for (const r of rows) if (r.j > best.j) best = r;

  // H2：FPR_conv = 0 且 TPR ≥ 90% 的阈值区间
  const h2Zone = rows.filter((r) => r.fprConv === 0 && r.tpr >= 0.90);
  const h2 = h2Zone.length > 0;

  // H3：FPR_ms = 0 的最低阈值
  const msZero = rows.filter((r) => r.fprMs === 0);
  const msMinTh = msZero.length ? msZero[0].th : null;
  const msTprAt = msMinTh !== null ? rows.find((r) => r.th === msMinTh)!.tpr : 0;

  console.log('【逐阈值三线表】（θ: TPR / FPR_conv / FPR_ms / FPR_all / Youden J——每 0.05 抽样打印）');
  for (const r of rows.filter((row, i) => i % 5 === 0 || row === best)) {
    const mark = r === best ? '  ← Youden J 最优' : '';
    console.log(`  θ=${r.th.toFixed(2)} | TPR ${(r.tpr * 100).toFixed(1)}% | FPR_conv ${(r.fprConv * 100).toFixed(0)}% | FPR_ms ${(r.fprMs * 100).toFixed(0)}% | FPR_all ${(r.fprAll * 100).toFixed(1)}% | J=${r.j.toFixed(3)}${mark}`);
  }

  console.log(`\n【RQ1 判别力】AUC = ${auc.toFixed(4)}（M vs B_all，梯形法）`);
  console.log(`【RQ2 最优区间】Youden J 最优 θ* = ${best.th.toFixed(2)}（TPR ${(best.tpr * 100).toFixed(1)}%, FPR_all ${(best.fprAll * 100).toFixed(1)}%）`);
  if (h2) {
    console.log(`  「FPR_conv=0 且 TPR≥90%」区间：θ ∈ [${h2Zone[0].th.toFixed(2)}, ${h2Zone[h2Zone.length - 1].th.toFixed(2)}]`);
  } else {
    console.log(`  「FPR_conv=0 且 TPR≥90%」区间：不存在`);
  }
  console.log(`【RQ3 主从共存权衡】FPR_ms=0 的最低阈值 θ_ms = ${msMinTh !== null ? msMinTh.toFixed(2) : '不存在（B2 最大占比超 0.60）'}`);
  if (msMinTh !== null) {
    console.log(`  该阈值下 TPR = ${(msTprAt * 100).toFixed(1)}%（TPR 损失 = ${((1 - msTprAt) * 100).toFixed(1)}pp）`);
    if (msMinTh >= 0.40) console.log(`  ⚠️ θ_ms ≥ 0.40：兼容主从则信号对 20%–40% 集中度区间失明（预注册 H3 预期情形）`);
  }

  console.log('\n【判定（预注册标准）】');
  console.log(`  H1 AUC > 0.9：${auc > 0.9 ? (auc > 0.99 ? '✅ 强成立' : '✅ 成立') : '❌ 不成立'}（实测 ${auc.toFixed(4)}）`);
  console.log(`  H2 常规 FPR=0 且 TPR≥90% 区间存在：${h2 ? '✅ 成立' : '❌ 不成立'}${h2 ? `（θ ∈ [${h2Zone[0].th.toFixed(2)}, ${h2Zone[h2Zone.length - 1].th.toFixed(2)}]）` : ''}`);
  console.log(`  H3 主从兼容权衡可量化：${msMinTh !== null ? `✅ 报告 θ_ms=${msMinTh.toFixed(2)}，TPR 损失 ${((1 - msTprAt) * 100).toFixed(1)}pp` : '⚠️ 无解'}${msMinTh !== null && msMinTh >= 0.40 ? '（主从共存 → 信号对 20%–40% 区间失明，如实报告）' : ''}`);

  // 实测占比分布（构造 vs 测量的 sanity）
  const shareOf = (cls: string) => measured.filter((s) => s.cls === cls).map((s) => s.share);
  const q = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return `[min ${b[0]?.toFixed(3)}, p50 ${b[Math.floor(b.length / 2)]?.toFixed(3)}, max ${b[b.length - 1]?.toFixed(3)}]`; };
  console.log('\n【实测占比分布 sanity】');
  console.log(`  M (400): ${q(shareOf('M'))}`);
  console.log(`  B1 (100): ${q(shareOf('B1'))}`);
  console.log(`  B2 (100): ${q(shareOf('B2'))}`);

  console.log('\n【逐样本 JSON 留痕】');
  console.log(JSON.stringify(measured.map((s) => ({ id: s.id, cls: s.cls, targetShare: s.targetShare, share: Math.round(s.share * 10000) / 10000 }))));
}

runCalibration();
