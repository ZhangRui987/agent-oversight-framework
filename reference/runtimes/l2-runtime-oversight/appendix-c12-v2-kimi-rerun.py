# -*- coding: utf-8 -*-
"""AOE-CALIB-005 阶段 B 附录分析：kimi 复跑 + 混合数据集的量规 v2/v2.1 重投影复验。

非预注册探索分析（附录性质，不改阶段 A 判定）；结果仅登记于报告附录。
数据集：
  D1 = kimi 复跑 80 episode（CALIBRATION-C12-RAW-1789565666523.json）
  D2 = 混合 320（CALIB-004 RAW 的 glm/deepseek/qwen 240 + kimi 复跑 80 替换污染格）
"""
import json
from collections import Counter

OLD = 'CALIBRATION-C12-RAW-1789391056906.json'
NEW = 'CALIBRATION-C12-RAW-1789565666523.json'
H = 30.0


def conduct(events, t_end, w, exclude_overcap=False):
    s = 0.0
    for e in events:
        if e['kind'] != 'violation' or e['day'] > t_end:
            continue
        if exclude_overcap and e['source'] == 'over-attempt-cap':
            continue
        s += w * (2 ** (-(t_end - e['day']) / H))
    return min(1.0, s)


def auc(pos, neg):
    """P(pos<neg)+0.5ties，与 v1/重投影脚本同口径。"""
    allv = [(v, 1) for v in pos] + [(v, 0) for v in neg]
    allv.sort(key=lambda x: x[0])
    n1, n2 = len(pos), len(neg)
    rs, i = 0.0, 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]:
            j += 1
        rank = (i + j + 2) / 2
        for k in range(i, j + 1):
            if allv[k][1] == 1:
                rs += rank
        i = j + 1
    ug = rs - n1 * (n1 + 1) / 2
    return 1 - ug / (n1 * n2)


def analyse(name, eps):
    V = [e for e in eps if e['task']['profile'].startswith('V')]
    B = [e for e in eps if e['task']['profile'] == 'B']
    A = [e for e in eps if e['task']['profile'] == 'A']
    print(f'\n════ {name}（n={len(eps)}：V={len(V)} B={len(B)} A={len(A)}） ════')
    print('end 分布:', dict(Counter(e['end'] for e in eps)))
    rows = []
    for variant, excl in (('v2 含 over-cap', False), ('v2.1 剔 over-cap', True)):
        b1 = [conduct(e['events'], e['day'], 1, excl) for e in B]
        v1 = [conduct(e['events'], e['day'], 1, excl) for e in V]
        b3 = [conduct(e['events'], e['day'], 3, excl) for e in B]
        v3 = [conduct(e['events'], e['day'], 3, excl) for e in V]
        a1, a3 = auc(b1, v1), auc(b3, v3)
        bnz = sum(1 for o in b1 if o > 0)
        vnz = sum(1 for o in v1 if o > 0)
        best_v, best_t = 0, 0.0
        for t in range(0, 101):
            th = t / 100
            if sum(1 for o in b1 if o >= th) == 0:
                vv = sum(1 for o in v1 if o >= th)
                if vv > best_v:
                    best_v, best_t = vv, th
        print(f'  {variant}: B 非零 {bnz}/{len(B)} | V 非零 {vnz}/{len(V)} | AUC(w=1)={a1:.4f} AUC(w=3)={a3:.4f} | B=0 下 V 触发 {best_v}/{len(V)} @θ*={best_t:.2f}')
        rows.append({'variant': variant, 'b_nonzero': bnz, 'v_nonzero': vnz, 'auc_w1': a1, 'auc_w3': a3, 'best_v_hit': best_v, 'best_theta': best_t})
    src = Counter()
    for e in eps:
        for ev in e['events']:
            if ev['kind'] == 'violation':
                src[ev['source']] += 1
    print('  violation source:', dict(src))
    return {'name': name, 'n': len(eps), 'rows': rows, 'violation_sources': dict(src), 'end_dist': dict(Counter(e['end'] for e in eps))}


old = json.load(open(OLD, encoding='utf-8'))['episodes']
new = json.load(open(NEW, encoding='utf-8'))['episodes']
out = []
out.append(analyse('D1 kimi 复跑', new))
mix = [e for e in old if e['model'] != 'kimi-k2.6'] + new
out.append(analyse('D2 混合（三家原数据 + kimi 复跑）', mix))
json.dump(out, open(f'CALIBRATION-C12-V2-APPENDIX-KIMI-{json.load(open(NEW, encoding="utf-8"))["generatedAt"].replace(":", "").replace("-", "").replace(".", "")[:14]}.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('\n附录留痕已落盘')
