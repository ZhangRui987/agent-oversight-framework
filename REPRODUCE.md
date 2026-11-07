# 复现指南（REPRODUCE）

> **目标**：让一个从没听过本仓库的人，在**三条命令、半分钟**之内，亲眼看到这套检查**真的会失败**——而不只是读到「我们有 54 项校验」。
>
> 全部命令**零安装、零密钥、零联网**。**不需要** `.workbuddy/`、`.env`、`node_modules`、`.venv`，也不需要先读 13 章 spec。

本文所有数字与输出均为 2026-11-06 在**裸克隆**（`git clone` 后未做任何配置）里实测所得，不是整理出来的「典型输出」。

---

## 0. 前置条件

| 依赖 | 最低版本 | 本文实测 | CI 固定 |
|---|---|---|---|
| Node.js | **≥ 22** | v22.22.2 | 22 / 24 |
| Python | **≥ 3.8** | 3.13.12 | 3.12 |

- 「零安装」指的是**不装任何 npm / pip 包**，仓库纯标准库 + Node 内置模块；**不等于有 Python 就够**——复现包与审计面板由 Node 执行。
- 缺 Node 时门禁会出现 7 项 FAIL，报错形如 `FileNotFoundError: [WinError 2]`，**不会提示缺什么**。先跑 `node --version` 确认 ≥ v22。
- 平台：Windows 11 + Git Bash（本文实测环境）与 linux CI（ubuntu-latest）均可；macOS 未实测。

---

## 1. 实测表

| # | 命令 | 判定依据（怎么算对） | 退出码 | 耗时 |
|---|---|---|---|---|
| 1 | `python scripts/verify_consistency.py` | 末行 `✅ 全部校验通过 — 可提交`，且 `[PASS]` 行数 = 54 | 0 | 16–25 s |
| 2 | `node --experimental-transform-types reference/runtimes/l2-runtime-oversight/replicate-t0.mts --strict` | 末行 `通过 9 / 警告 0 / 失败 0`（CI 口径：WARN 也算失败） | 0 | 6–11 s |
| 3 | `node --experimental-transform-types tools/audit-panel/scenario/export-events.mts` | 七场景导出，写出 9 条事件 + 1 条 meta | 0 | 1–2 s |
| 4 | `node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --tamper-demo` | `落盘链 PASS` + `链校验 已检出` + 末行 `演示结论 检出成功`（0 = 演示符合预期，不是"未检出"；未检出时退出 1） | 0 | 1–2 s |
| 5 | `node --experimental-transform-types tools/audit-panel/rules/replay.mts` | `重放一致性 9/9 ✓` + 处置台账 `PASS（3 条）` | 0 | 1–2 s |
| 6 | `node --experimental-transform-types tools/audit-panel/server/server.mts` | 启动横幅打印「当场验证 链 PASS · 重放 9/9 · V2 复核 PASS」 | — | <1 s |

**耗时为区间而不是点值**：同一台机器冷/热缓存差异明显（门禁实测过低至 16 s，也高至 25 s）。CI 上更快。用耗时做验收会误判，请用退出码与判定依据。

克隆体积约 19 MB（无 `node_modules` / `.venv`）。

---

## 2. 三条命令：先看这个仓库怎么管自己

### 2.1 门禁 54 项

```bash
python scripts/verify_consistency.py
```

预期末行：

```
✅ 全部校验通过 — 可提交
```

核对通过数（53 是硬数字，不是大约）：

```bash
python scripts/verify_consistency.py | grep -c "^  \[PASS\]"
# 54
```

这件事的分量在别处：这 54 项对账的是 **13 章 spec 的双语结构、214 条证据的分级计数、未解问题登记册、9 条事件哈希链、3 条处置台账、外锚摘要串的发布记录**。它同时挂在 pre-commit 上——红了就提交不了。

### 2.2 链验证：改一个字就检得出

```bash
node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --tamper-demo
```

实测输出（路径随机器变化）：

```
审计面板事件文件 · 独立验证
──────────────────────────────────────────────────────────
  文件          D:\...\tools\audit-panel\data\events.jsonl
  框架版本      v2.72.7（= `cat VERSION`，随版本变）
  schema        aof-audit-panel/1
  事件条数      9
  依据口径      scenario（每条事件须有 source_scenario）
  落盘链        PASS

  全部检查通过：meta 一致 · seq 连续 · 链可重算 · 每条事件有规则与条款依据

  篡改演示（仅内存，不写盘）：
    目标行        seq 4 · resource-over-budget（文件里的真实事件，非构造行）
    改动          detail 末尾追加"（已篡改）"
    链校验        已检出（重算值与原 chain_hash 不符）
    若落盘        验链判 FAIL，退出码 1
    原 hash       e03d12f753bf2c8a…
    重算 hash     4bcb81d7d2c2e2f1…

    演示结论      检出成功（预期结果）。本命令退出码 0 = 验链通过 且 演示符合预期，不是"未检出"。
```

`依据口径` 一行是 v2.72.7 新增：验链要求每条事件有来源字段，而 V1（`events.jsonl`）用的是
`source_scenario`、V2（`realagent-events.jsonl`）用的是 `session_id`。默认口径为 `scenario`；
验 V2 文件必须显式指定：

```bash
node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --source=session --file=tools/audit-panel/data/realagent-events.jsonl
```

不传 `--source` 去验 V2 文件会**判 FAIL 并指名缺 `source_scenario`**——口径不对是失败，不是静默通过。

> **别把这一条当作「检查会红」的证据**：演示在内存里做、不写盘，所以**退出码仍是 0**。它证明的是「篡改能被检出」，不是「检查会失败」。
>
> **退出码 0 的准确含义是「验链通过 且 演示符合预期」**。反方向才是异常：若演示**没能**检出（链无防护力），本命令自 v2.72.5 起**退出 1**，而不是只打一个感叹号却正常退出。要看真的红，走 §3。

### 2.3 重放：日志说什么不算，重跑裁决一遍才算

```bash
node --experimental-transform-types tools/audit-panel/rules/replay.mts
```

实测关键行：

```
  判定条目        9（ledger 场景按信号组比对）
  ...
  重放一致性      9/9  ✓
  处置台账        PASS（3 条） · ...\tools\disposition\data\disposition.jsonl
  处置三态        已闭合 2 · 观察中 0 · 未处置 1（合计 3）
  孤儿信号        1 条（未处置；含「已转人工未闭合」）
```

它做的是：拿同一套规则**重新裁决**每一行日志，再与日志自述的裁决比对。`MATCH` 才算过——日志自己写「我拦截了」不作数。

---

## 3. 把检查真的弄红一次（本指南最关键的一步）

三条命令，只改**临时副本**，不动仓库里的任何文件。

```bash
# ① 复制一份事件文件，并在 seq 4 的 detail 里插入四个字
python - <<'PY'
import io, os
src = "tools/audit-panel/data/events.jsonl"
dst = os.path.join(os.environ.get("TEMP") or "/tmp", "tampered.jsonl")
out, hit = [], 0
for ln in io.open(src, encoding="utf-8").read().splitlines():
    if '"seq":4' in ln and hit == 0:
        ln = ln.replace('"detail":"', '"detail":"（已篡改）', 1)
        hit += 1
    out.append(ln)
io.open(dst, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print("hits =", hit, "->", dst)
PY

# ② 用链验证器验这份副本
node --experimental-transform-types tools/audit-panel/scenario/verify-chain.mts --file="$TEMP/tampered.jsonl"

# ③ 看退出码
echo "exit=$?"
```

实测输出：

```
审计面板事件文件 · 独立验证
──────────────────────────────────────────────────────────
  文件          C:\Users\...\AppData\Local\Temp\tampered.jsonl
  框架版本      v2.72.7（= `cat VERSION`，随版本变）
  schema        aof-audit-panel/1
  事件条数      9
  依据口径      scenario（每条事件须有 source_scenario）
  落盘链        FAIL

  失败项：
    [seq 4] chain_hash 重算不匹配（该行内容已被修改）：
      落盘 e03d12f753bf2c8a7a7482894c266d55e313a47b8ed2d2b23749ea9d42b3dc37
      重算 4bcb81d7d2c2e2f1906c727dd5961be6de5817981242e87dc7a87b085e7a4cc3
exit=1
```

> `框架版本` 行等于 `cat VERSION`，随版本变化；而**这一对哈希不随版本变**——meta 是第 1 行，不参与事件链计算。所以上面两个值在任何版本上都成立，可以直接用来核对你自己的输出。

这一刻发生了什么：**同一个文件，只在一个字段里插了四个字，9 条事件里第 4 条立刻被指名，退出码从 0 变 1**。行数没变、meta 没变、结构没变——链校验只认内容。

这就是「检查有判别力」与「检查恒 PASS」的分界。一个永远打印 `PASS` 的检查，价值为零；一个能指出 `[seq 4]` 的检查，才配写进 README。

---

## 4. 五条已知卡点（如实登记）

以下是大规模实测中真实踩到的坑。**五条均已修复**：前四条在 v2.72.2（改的是文档与提示），第五条在 v2.72.4（改的是判定与 CI 约束）。

| # | 卡点 | 现状 | 规避 / 说明 |
|---|---|---|---|
| 1 | `replicate-t0` 退出码 0 曾被 README 读作「9/9 通过」，实测是「通过 4 / 警告 5 / 失败 0」 | v2.72.2 订正文字；v2.72.4 修掉根因 | 那 5 条 WARN 一条数值差异都没有：全部是基准被 `core.autocrlf` 检出成 CRLF（另 3 条是基准首行写死平台串）。现 Windows 与 linux 均为 `通过 9 / 警告 0 / 失败 0` |
| 2 | 文档从未写 Node / Python 版本；缺 Node 时报 `FileNotFoundError` traceback | v2.72.2 已在快速开始补「环境前置」 | 见本文 §0 |
| 3 | `export-events.mts` 重写已入库的 `events.jsonl`；Windows 下 `git status` 显示 M 而 `git diff` 为空 | v2.72.2 已在命令旁注明 | 是换行符差异，`git checkout -- tools/audit-panel/data/events.jsonl` 还原，勿提交 |
| 4 | 门禁原不在「快速开始」里，陌生人最先跑的是 6 秒的复现包 | v2.72.2 已列为快速体验第 4 步 | 见本文 §2.1 |
| 5 | **WARN 数量不受任何检查约束**：CI 只断言 exit 0 | v2.72.4 已修：CI 改跑 `--strict`，WARN 即红 | 断言形式是「WARN 也判失败」而不是「WARN 必须为 0」——前者能容纳未来真实的环境噪声，后者会把噪声变成红灯，最终训练人关掉告警 |

另有一处归因失真（v2.72.2 已改为不越界断言，v2.72.4 定位到真实原因）：当时 WARN 文案写「疑似平台 / Node 版本差异」，实测用的是与基准相同的 Node 22.22.2，真实主因是**行尾 CRLF** 与**基准头行写死的平台串**——两者都不是浮点精度问题。现在这两类已被消除，`env-diff` 只对「版本/平台串等价替换」与「1e-9 相对差内的数值末位」放行，并在明细里给出「首处 L{n}」，不必再靠猜。

---

## 5. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 门禁 7 项 FAIL，异常里是 `FileNotFoundError: [WinError 2]` | 缺 Node 或不在 PATH | 装 Node ≥ 22，`node --version` 确认 |
| `git status` 显示 `events.jsonl` 被改，`git diff` 却是空的 | Windows `core.autocrlf=true` 的换行符差异 | `git checkout -- tools/audit-panel/data/events.jsonl` |
| `--tamper-demo` 退出码 0，以为检查没生效 | 演示只在内存里做，不写盘；0 的含义是「验链通过 且 演示符合预期」 | 正常。要红请看 §3。反向才该警惕：演示**没能**检出时命令退出 1（v2.72.5 起） |
| `[seq 13] SKIP：沙箱现场不存在（CI 干净 clone）` | V2 realagent 产物依赖的沙箱现场未入库 | 预期行为。白名单 / 数值 / 链复核不受影响 |
| `EADDRINUSE` | 7727 端口被占 | `--port=7811` 换端口 |
| Git Bash 里路径带反斜杠报错 | Windows 路径 | 用正斜杠，或整体加引号 |
| Python 3.7 及以下 | 版本过低 | 升到 ≥ 3.8（CI 用 3.12） |

---

## 6. 本指南不覆盖什么

- **tier-1 API 档**：`AOE-ABSTAIN-001/002`、`AOE-CALIB-004` 等需要模型 API 密钥，逐条条件与成本上限见 [`spec/13-boundaries.md`](spec/13-boundaries.md)。
- **V2 realagent 会话不可重跑**：那是 LLM-in-the-loop 产物，仓库只提供**静态复核**（链可重算、被拒工具 ∈ 全声明且 ∉ 白名单、预算数值成立）。页面与产物均标注「不可复现 · 自测行为记录」。
- **CALIB-007 的结论不因本指南而升级**：`APPLICABILITY-AOE-CALIB-007-R1.md` 的三条适用边界与「已验证可部署不成立」的表述不因此改变。复现这里的**机制**，不等于复现那批**实验**。
- **macOS**：未实测。

---

## 7. 结果怎么报

- 复现**成功**：走 Issue 模板 [`independent-replication`](https://github.com/ZhangRui987/agent-oversight-framework/issues/new?template=independent-replication.yml)。
- 复现**失败**（包括本文哪一句与你的输出不符）：同样是数据，请附**完整命令 + 完整输出 + 版本三件套**（`node --version`、`python --version`、`cat VERSION`）。只有结论没输出的报告无法定位。
- 过程性疑问：到 [Discussions「复现答疑」](https://github.com/ZhangRui987/agent-oversight-framework/discussions/categories/q-a)。

---

**返回**：[`README.md`](README.md) ｜ 可复现性边界：[`spec/13-boundaries.md`](spec/13-boundaries.md) ｜ 证据分级：[`spec/11-traceability.md`](spec/11-traceability.md)
