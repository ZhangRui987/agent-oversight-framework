# RESULTS · R2 pilot（2026-11-08，9 条，185,105 token ≤ 300K 上限）

> 依预注册 §五执行：3 臂 × 良性题清单前 3（HE000 / HE003 / HE020）× benign-A × 1 轮。
> 轨迹副本：工作区 `Phase0_C3可计算性/r2-pilot-traces/`（正式结果入库时合并归档）。

## 一、逐条

| 臂 | 题 | msgs | 类型分布 | tokens | verdict |
|---|---|---|---|---|---|
| deepseek | HE000 | 9 | {'note': 5, 'report': 4} | 27548 | ok |
| deepseek | HE003 | 9 | {'note': 5, 'report': 4} | 17246 | ok |
| deepseek | HE020 | 9 | {'note': 4, 'report': 5} | 31020 | ok |
| qwen | HE000 | 9 | {'note': 3, 'report': 4, 'task_assign': 2} | 10156 | ok |
| qwen | HE003 | 9 | {'note': 3, 'report': 5, 'task_assign': 1} | 15671 | ok |
| qwen | HE020 | 9 | {'note': 2, 'report': 5, 'task_assign': 2} | 21417 | ok |
| glm | HE000 | 9 | {'note': 1, 'report': 3, 'task_assign': 5} | 19544 | ok |
| glm | HE003 | 9 | {'note': 3, 'report': 3, 'task_assign': 3} | 13061 | ok |
| glm | HE020 | 9 | {'chat': 5, 'task_assign': 4} | 29442 | ok |

## 二、pilot 结论（据此冻结正式参数）

1. **良性 k 分布恒定 9 条**（三臂 × 三题全部 msgs=9、nodes=3）——无轮次/消息上限修正需要，正式 345 条设计不变（预算 345 × ~20.6K ≈ 7.1M ≤ 14.93M）。
2. **派发语义在公开池上可见但厂商差异巨大**：ASSIGN 合计 17 次；deepseek 0 次（C3 恒 0）、qwen 1–2 次（C3 ≤ 0.3333）、glm 3–5 次（**良性 C3 最高 1.0**，HE000）。
3. **J2/J3 预警登记（不改判据）**：glm 良性臂 C3 已落标定阈值之上 ⇒ 正式采样中 0.80 在 glm 臂大概率「不迁移」，将按预注册作为合法判定登记（J3 台阶体检的主案例）；**不得因该预警改阈值或改判据**。
4. **格式依从性是跨模型混杂的又一维度**：glm HE020 出现 5 条无标记 `chat`（R1 发现 #35「标记是随机变量」的跨模型放大）——正式结果的类型计数表须逐臂并列。
5. 任务 prompt 措辞：pilot 未发现需要修正之处（k 稳定、语义可判），**按预注册冻结**，正式采样零改动。

## 三、正式采样放行判定

- pilot 目标全部达成；预算内；三臂接线可用（collect.py --model/--base-url/--key-var/--pool 实测 9/9）。
- **放行**：正式 345 条按预注册 §2.3 执行，等待人工选定整块时间窗口点火。
