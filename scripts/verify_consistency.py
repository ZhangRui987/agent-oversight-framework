# -*- coding: utf-8 -*-
"""发布一致性校验（推送前 / pre-commit 用）。

校验项（共 53 项 = 53 个 check( 调用，按运行顺序；v2.26.1 起本清单项数与实际调用数一致，由第 39 项自校验）：
  1. 全仓库无 [TABLE START/END] 伪标记
  2. 所有 Markdown 表格表头后都有 |---| 分隔行
  3. 表格每行列数与分隔行一致
     —— 两种表头风格都覆盖：带首竖线（| 表头 | ... |）与不带首竖线（表头 | ...）
        （后者曾长期未被校验，导致 11-traceability 出现「6 列 vs 表头 5 列」而漏检）
  4. 分级声明三方可提取（README 顶部行 / 分布行 / REFERENCES 注脚；任一缺失即 FAIL；v2.52.18 实测派生改造）
  5. REFERENCES 实测 A == 声明（实测派生：权威=机器统计，断言只比「声明 == 实测」）
  6. REFERENCES 实测 B == 注脚 + README 顶部声明（实测派生）
  7. REFERENCES 实测 C == 声明（实测派生）
  8. REFERENCES 实测 D == 声明（实测派生）
  9. REFERENCES 实测 G == 声明（实测派生）
  10. REFERENCES 实测合计 == 注脚声明（实测派生）
  11. README 顶部声明（合计 & B 级）== 实测（实测派生）
  12. README 分布行（A/B/C/D/G）== 实测（实测派生）
  13. CHANGELOG 声明「新增 1 条 G 级」（v2.11.0，历史锚点防回退）
  14. README 双语全文「证据总数」一致（所有出现的总数 == 实测合计，动态）
  15. README 双语全文「B 级数」一致（所有出现的 B 级数 == 实测 B，动态）
      —— v2.52.18 改造说明：4-12 项原为硬编码期望值（每加一条证据须同步改本脚本十余处，
         v2.52.13–17 五轮四险的根因）；改造后新增证据只改 REFERENCES + README + 注脚
         三处声明，本脚本零改动。先例：第 24-26 项未解问题数（v2.51.1 起同模式）。
  16. README 事故数字（1,200 留言板）
  17. README 事故数字（700 参与攻击）
  18. REFERENCES 一手材料（1,200 留言板 / 700 攻击）
  19. ANTITRUST 指第十二章
  20. STYLE 禁 P0-x 审阅编号
  21. STYLE 允许 P0 优先级标记
  22. spec/ 无 14-references.md（唯一真相源 = 根 REFERENCES.md）
  23. 引用红线：正文无禁止引用的数字（GAIE 84–97%）
  24. 13-boundaries 实测未解问题条数 = 登记册总条数（动态；已解决行留痕不删、不扣减——#12/#14/#37 先例，v2.51.1 口径裁决）
  25. README 声明「N 条未解问题」（N 动态跟随第 24 项实测）
  26. README.en 声明「N open problems」（N 动态跟随第 24 项实测）
  27. REFERENCES 无悬空引用：条目的登记键须在 spec/ 正文出现；
     若确系有意登记而未回灌，须在落点列显式标注【登记备用】
     —— 备用清单逐条打印公示，无法静默堆积
  28. 反向悬空：spec/ 正文引用的每个 arXiv 号，均须在 REFERENCES 有条目登记
     —— 与第 27 项对称，双向都查才闭合
  29. 无 arXiv 号的条目均已在文献列声明【键: XXX】
     —— 让第 27 项的覆盖从「有号条目」扩展到全部条目
  30. 引用键全局唯一（不同条目不得共用同一键）
  31. 引用键非通用词（不在黑名单且长度 ≥ 4）
  32. G 类引用键前缀合法（cn- / us- / eu- / uk- / ca- / au- / jp- / kr- / sg- / int- / iso- / owasp-）
  33. G 类条目须声明【键: XXX】且键含管辖前缀（G 类无 arXiv 号，强制声明键以防漏检）
  34. VERIFICATION-LOG 覆盖全部条目（不分等级；REFERENCES 键/arXiv 号 ⊆ LOG 首列，包含匹配）
      —— v2.44.0 起从「仅 G 键」扩展为全量覆盖，堵死非 G 类欠账复发路径
  35. VERIFICATION-LOG 无幽灵行（LOG 首列均可归因到 REFERENCES 条目）
     —— ⚠️ 历史注记：旧清单曾把 34/35 合写为一个编号项，导致「门禁项数」声明
        长期比实际 check 调用数少 1（v2.12.1–v2.26.0 声明 35/36、实际 36/37）；
        v2.26.1 起清单按实际调用数逐条编号，并由第 39 项防复发
  36. README 法域枚举与计数和 REFERENCES G 键前缀一致（九法域，防法域计数漂移）
  37. spec/11 机制溯源表 CAE 三段齐全（每行含 主张/论证/证据；v2.23.0 新增）
  38. 版本元数据同步（VERSION / CITATION.cff / README 双语 badge；v2.26.1 新增）
  39. 门禁项数声明一致（README 双语 / CONTRIBUTING / ci.yml / 本清单 == 实际调用数；v2.26.1 新增）
  40. demo 断言声明与实际输出一致（ci.yml 三处声明 + 子 README 一处 == demo 运行时计数；v2.44.1 新增）
      —— 教训来源：外部审查（2026-09-16）实测发现 ci.yml 写「23 组 154 项」、子 README 停在
         「20 组、136 项（截至 v2.13.0）」，而实际运行为 24 组 153 项——三处声明无一正确，
         且错误自 v2.38.0 起伴随每轮 CI 全绿存活 7 个版本。结构性根源：门禁只校验「文档之间
         一致」，不校验「声明 vs 实际运行」。本项把声明钉死到 demo 实际输出：运行 demo，
         解析其末行动态计数（组数/断言数由运行时计数器生成，非手写）逐处比对。
         原则：任何可验证数字，要么生成、要么校验，不写第三种。
  41. CORRECTION-LOG 结构合法且无超期未结纠错（14 天纠错周期机制化；v2.44.2 新增）
      —— 教训来源：外部审查（2026-09-16）A2 指出「14 天纠错周期、拒绝不静默关闭」
         仅是 README 承诺，无登记载体、无机制保证，属「承诺≠机制」。本项把承诺数值化：
         CORRECTION-LOG.md 每行登记 受理日期/截止日期/状态，门禁校验
         截止-受理 == 14 天、状态合法、拒绝必附理由、待处理超期 FAIL（按当日日期）。
  42. PRODUCTION-GAPS 当前状态行与正文表格一致（闭合/未闭合双向比对；v2.52.10 新增）
      —— 教训来源：外部 AI 评估（2026-10-07）实测发现头部 v2.2.0 状态声明「其余 6 项
         （G3–G8）未闭合」与正文表格 G7（v2.36.0 事件流侧）/ G8（v2.38.0 告警侧）已
         「✅ 演示级闭合」漂移存活多个版本。与第 40 项教训同构：门禁只校验「文档之间
         一致」，不校验「同一文件头尾一致」。本项把头部显式「当前状态」行钉死到正文
         表格实测 ✅/❌ 集合：任一侧变化未同步即 FAIL。
  43. spec/ 双语结构对齐（X.md ↔ X.en.md 标题层级序列一致；v2.52.11 新增）
  44. spec/11 行数声明 == 双语实测（v2.52.25 新增）
      —— 教训来源：2026-11-03 内部审计实测发现 spec/11 双语行数声明「现为 55 行」自
         v2.28.0 起漂移（主表实际 93 行，低估 38 行），伴随门禁全绿存活约 30 个版本。
         结构性根源与第 40/42 项同构：声明靠手工续写、无守卫。本项把声明钉死到实测：
         门禁机器统计主表数据行（CAE 三标记 + 竖线分隔），与双语声明数字逐一比对。
  45. spec/13 未解登记册完整性（行数==编号连续==README 双语声明三方互证；v2.52.26 新增）
      —— 教训来源：2026-11-03 内部审计中「#41/#42/#43 疑似缺失」经排查为格式假警报，但暴露
         结构性盲区：spec/13 登记册与 README「43 条未解问题」声明之间无机器互证，登记册
         加行/删行而声明不动将静默漂移（与第 40/42/44 项同构：声明靠手工续写、无守卫）。
  46. 面板入库产物 meta.framework.version 与 VERSION 一致（v2.60.0 新增）
      —— 教训来源：tools/audit-panel/data/*.jsonl 的 meta 自描述框架版本，两次因「版本联动
         sed 在产物重生成之后执行」而滞后（v2.55.1 首次、v2.59.0 前再次），靠人工检查偶然
         抓到。与第 40/42/44/45 项同构：声明/产物靠手工同步、无守卫。本项把入库产物
         （events.jsonl 与 realagent-events.jsonl）首行的 framework.version 钉死到 VERSION：
         版本联动后产物未重生成即 FAIL。
         本项机器统计双语登记册数据行与首列编号序列：行数双语相等、编号连续 1..N 无跳号
         无重复，且 N 与 README 双语全部「N 条未解问题 / N open problems」声明逐一比对。
         原则同前：任何可验证数字，要么生成、要么校验，不写第三种。
      —— 实测（2026-10-14）：5/13 对存在标题数量或层级序列漂移——双语同步此前
         仅靠人工纪律，门禁对英文版检查面远窄于中文（同「声明 vs 实际」盲区族）。
         机制：逐对提取 ^#+ 标题层级序列比对；已实测漂移的 5 对按完整序列指纹
         登记入豁免表（诚实公示而非粉饰），修复一对删一对；未登记的新漂移即 FAIL。
         5 对已于 v2.52.12 全部清偿（豁免表清零），双语一致性自此全量门禁守护。
  47. 处置台账链可重算 + 篡改检出（处置通道阶段 1 新增）
      —— 教训来源：处置通道阶段 1（spec/13 #44 的工具侧补口）DoD 写「第三方可独立重算」，
         若只提供 JS 验证器，等于只证明「同一实现能验自己」。本项把四件事钉死：
         ① Node 生成 20 行样本 → Python 参照实现验链 PASS（键序/分隔符/非 ASCII 任一漂移即失败）；
         ② 改任意一行内容 → Python 与 Node 必须 FAIL（链有防护力）；
         ③ 打乱一行键序 → 两端必须 FAIL（键序冻结不是文档口号）；
         ④ 入库台账 tools/disposition/data/disposition.jsonl 可被 Python 独立验链。
         与第 40/44/46 项同构：任何可验证声明，要么生成、要么校验，不写第三种。
  48. spec/10 处置条款 == tools/disposition 实现（v2.67.0 新增）
      —— 教训来源：spec/13 #44 的「下一步」自 v2.61.0 起就写明三件事（事件类型 /
         义务条款 / 完整性信号），但此前无人校验文档与实现是否对得上。条款化若没有
         机器校验，只是文字：文档写四个动作、实现多一个，读者无法察觉。
         本项解析 spec/10 中英双语的三处条款表（10-D1 字段 / 10-D2 动作 / 10-D3 三态），
         与 ledger.mts 的 FIELD_ORDER / ACTIONS / stateOf 逐项比对，并校验中英时限一致；
         内置三条反向测试（改动作名 / 改字段名 / 改时限），任一未被检出即 FAIL。
  49. 义务注册表 ↔ spec/10 条款 ↔ LedgerSignalKind 三方一致（v2.68.0 新增）
      —— 教训来源：第 48 项校验了**动作枚举**，却漏了**类别枚举**。v2.67.0 的 10-D4
         表格写了 memory-write-unauthorized / shadow-ratio-deviation / periodic-touch-hit
         三个实现中不存在的名字，而实现是 memory-write-audited / shadow-deviation /
         periodic-egress——四个类别错了三个，且没有任何机器读过它们（ERRATA-L2-SPEC D-S1）。
         本项校验：注册表类别集合 == index.ts 的 LedgerSignalKind == 中英 10-D4 表格；
         逐级时限等于 PRIORITY_SLA_HOURS（24/72/168）；10-D8 状态与实现相符；
         10-D5 聚合行为的 9 条边界断言（空集 null / 超时 1 / 闭合不计 / 倒挂标脏 /
         未声明不入分母 / now 必传）。内含 8 条反向测试，每条**断言指定检查项命中**
         ——避免被别的检查顺带拦住而误判判别力（D-5 同类陷阱）。
  50. 处置通道集成层：处置与信号同链（v2.69.0 新增）
      —— 教训来源：阶段 1/2a/2b-1 的台账是**独立链**，信号在框架链、处置在台账链，
         「删掉处置记录」不破坏信号链，反之亦然。第 47 项验的是台账自己那条链，
         验不出「处置与被处置对象是否同链」——链各自的完整性不等于它们的关系成立。
         本项：① Node 侧 19 项自检 + 6 条反测（同链写入 / 篡改检出 / 删除中间检出 /
         键序漂移 / disp_seq 跳号 / 未登记类别拒写且不污染链 / 自审自批拒写 /
         链拒写不静默 / 迁移四种原因 / 注入 ts 才可复现 / 尾部截断不可自证须外锚）；
         ② 同链**投影**出的台账交给 **Python** verify_chain.py 复核——跨语言这一层是本项
         存在的理由：JS 内部自洽不等于第三方可复算；③ 投影只落临时目录，用完即删
         （派生数据入库即产生第二真相源）。
  51. 处置链外锚：尾部截断与同条数换史（v2.70.0 新增）
      —— 教训来源：第 50 项的 B19 是一条**诚实的边界声明**，不是解决方案——它只证明
         「尾部截断链自证检不出」。边界写出来之后，若不补上唯一能检出的手段（外锚），
         则所有「链完整」的结论都停在「未被截断」这个未验证的假设上。
         本项：① Node 侧 14 项自检 + 6 条反测，覆盖五种判定（match / grew / truncated /
         forked / undecidable）——其中 grew 必须单列：把「锚后正常新增」报成篡改会产生
         大量误报，而误报会让人关掉告警，比没有告警更差；undecidable 用于「只给摘要、
         拿不到前缀证据」时如实说不知道，而不是猜；② 拒收类断言：锚日志键序漂移、
         中间行被改、同链 count 回退一律拒收（否则「截断后补一条更小的锚」即可自圆其说）；
         ③ **仓库实锚**：`tools/disposition/data/anchor.jsonl` 对两条真实产物
         （面板 V1 事件流 / 处置台账）的锚必须与产物一致，且产物先由各自的验证器验过
         ——锚只说条数与末哈希，链内自洽不由锚回答。
         ⚠️ 本项不主张「防篡改」：锚与链在同一可写域时，能改链者通常也能改锚。
         真正的信任根是把 `aof-anchor/v1:…` 摘要串发布到域外（Release 说明 /
         第三方保管），那一步是运行程序，代码无法自证。
  52. 外锚摘要串的**发布**：漏贴 / 贴旧串 / 重锚后没重新发布（v2.71.0 新增）
      —— 教训来源：第 51 项把「发布摘要串」写成文档里的一句话，于是它仍然只靠人。
         而漏贴这一串的后果是**静默的**：锚日志是对的、链也是对的，只是域外见证不存在，
         于是「锚尾被整体删掉」重新变成不可检出。与「30 个 tag 无 Release」同病：
         承诺靠纪律维护必然漂移。
         本项跑 `scripts/check_anchor_publish.py --selftest`（离线，不联网）：
         ① 基线 P1 覆盖（当前锚必须有发布记录且串逐字相等）/ P2 可溯（记录必须指回
         真实锚行——防「先写一条已发布记录再声称已发布」）/ P3 仓内声明（CHANGELOG
         当前版本小节逐字含当前串，且**不得残留旧串**）；② 8 条反向测试，每条断言
         **指定项**命中（S4/S5 只命中 P3，S6 只 P4，S7 只 P5，S8 只 P4——构造若写错
         会显示 PASS，等于没检查）；③ 锚格式不重实现：本项消费 `check-anchor.mts
         --emit-digests` 的 JSON，Python 侧只做字符串比对。
         ⚠️ P4/P5（Release 正文必须含该串 / 正文里的串必须已登记）需联网，不进门禁——
         放在 `release-guard` 每日跑，避免 CI 因网络抖动变红而被人习惯性忽略。
  53. 发版脚本把预检当**必经代码路径**（v2.72.0 新增）
      —— 教训来源：第 52 项把「发布」变成可校验，但校验仍是**发版前要记得跑的一步**。
         在那之前，发版靠工作区里 `create_release_v*.py` 这类一次性脚本：每版复制一份、
         改三处，预检写在文档里。两个失效模式都真实发生过：复制旧模板漏改字段（tag 对、
         正文是上一版），以及预检跑了但看的不是将要发的那份正文。
         本项：① `scripts/create_release.py --selftest`（离线 7 条）证明预检**挡在创建
         之前**——预检失败时 creator 一次都没被调用，dry-run 预检通过也不创建；
         ② 结构断言：脚本必须消费 `check_anchor_publish.py` 与 `git ls-remote`，且
         **不得出现 `--force`**（能跳过检查就等于没有检查）；
         ③ 发版脚本唯一化：仓库内只有这一份实现，不再每版复制。

用法：
  python scripts/verify_consistency.py [仓库根目录，默认脚本所在目录的上级]

退出码 0 = 全部通过；非 0 = 存在未通过项（pre-commit 将拦截提交）。
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if len(sys.argv) > 1:
    ROOT = os.path.abspath(sys.argv[1])

FAILS = []


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {name}" + (f"  — {detail}" if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def md_files():
    out = []
    for dirpath, _, files in os.walk(ROOT):
        if ".git" in dirpath:
            continue
        for fn in files:
            if fn.endswith(".md"):
                out.append(os.path.join(dirpath, fn))
    return sorted(out)


def read(fp):
    with open(fp, encoding="utf-8") as f:
        return f.read()


# ── 1. 伪标记 ────────────────────────────────
pseudo = []
for fp in md_files():
    c = read(fp)
    if "[TABLE START]" in c or "[TABLE END]" in c:
        pseudo.append(os.path.relpath(fp, ROOT))
check("无 [TABLE START/END] 伪标记", not pseudo, "; ".join(pseudo))

# ── 2. 表格分隔行 + 列数一致 ─────────────────
SEP_RE = re.compile(r"^\s*\|?[\s:\-|]+\|?\s*$")
CELL_SPLIT_RE = re.compile(r"(?<!\\)\|")  # 忽略被转义的 \|


def _looks_row(line):
    """是否像一行表格行。

    覆盖两种风格：
      A. 表头 / 数据行都不带首尾竖线，只有分隔行带（02-architecture、REFERENCES 等）
      B. 全部行都带首尾竖线（13-boundaries 等）
    """
    s = line.strip()
    if not s or "|" not in s:
        return False
    return s.startswith("|") or " | " in s


def _ncols(line):
    """该行的单元格数（按分隔行的口径：不计首尾空串）。"""
    s = line.strip()
    n = len(CELL_SPLIT_RE.split(s))
    return n - 2 if s.startswith("|") else n


bad_tables = []
bad_cols = []
for fp in md_files():
    lines = read(fp).splitlines()
    i = 0
    while i < len(lines):
        if _looks_row(lines[i]):
            j = i
            while j + 1 < len(lines) and _looks_row(lines[j + 1]):
                j += 1
            rel = os.path.relpath(fp, ROOT)
            if (j - i + 1) >= 2:
                if not SEP_RE.match(lines[i + 1]):
                    bad_tables.append(f"{rel} L{i+1}: 表头后缺分隔行")
                else:
                    ncol = _ncols(lines[i + 1])
                    for k in range(i, j + 1):
                        if k == i + 1:
                            continue
                        c = _ncols(lines[k])
                        if c != ncol:
                            bad_cols.append(
                                f"{rel} L{k+1}: 列数 {c} != 分隔行 {ncol}"
                            )
            i = j + 1
        else:
            i += 1
check("所有表格表头后都有 |---| 分隔行", not bad_tables, "; ".join(bad_tables[:5]))
check(
    "表格每行列数与分隔行一致",
    not bad_cols,
    "; ".join(bad_cols[:5]),
)

# ── 3. 证据分级数量 ──────────────────────────
refs = read(os.path.join(ROOT, "REFERENCES.md"))
# 数表格行：等级格允许带括号说明（如 C（域迁移缺口）/ B（可核查预印本；…））。
# 旧实现用 ^A \| / ^B \| / ^C（ / ^D（ 四个不一致的正则，导致「带括号的 B 级行」被漏计。
# G 类（治理 / 政策 / 执法一手实证）2026-09-04 新增，与 A/B/C/D 同等并列。
GRADE_RE = re.compile(r"^(A|B|C|D|G)(（[^）]*）)?\s*\|", re.M)
grades = GRADE_RE.findall(refs)
a = sum(1 for g, _ in grades if g == "A")
b = sum(1 for g, _ in grades if g == "B")
c = sum(1 for g, _ in grades if g == "C")
d = sum(1 for g, _ in grades if g == "D")
g_count = sum(1 for g_, _ in grades if g_ == "G")
# ── v2.52.18 实测派生改造（M1；先例=第 24-26 项未解数，v2.51.1 起同模式）──
# 权威 = 上方对 REFERENCES.md 的机器统计；声明 = README 顶部行 / 分布行 / 注脚文本提取。
# 断言只做「声明 == 实测」。新增证据时改 REFERENCES + README + 注脚三处声明，本脚本零改动。
# 防同错：三方声明各自独立与实测比对，任一方写错即 FAIL；统计为机器数行，无声明依赖。
readme = read(os.path.join(ROOT, "README.md"))
chg = read(os.path.join(ROOT, "CHANGELOG.md"))
_m_top = re.search(r"(\d{2,3})\s*条来源，其中 B 级 (\d{2,3})\s*条", readme)
_m_dist = re.search(
    r"A:(\d{1,3})(?:（[^）]*）)?\s*/\s*B:(\d{2,3})\s*/\s*C:(\d{1,3})\s*/\s*D:(\d{1,3})(?:\s*/\s*G:(\d{1,3}))?",
    readme)
_m_note = re.search(
    r"(\d{1,3})\s*条 A 级、(\d{2,3})\s*条 B 级、(\d{1,3})\s*条 C 级、(\d{1,3})\s*条 D 级、(\d{1,3})\s*条 G 级（合计 (\d{2,3})\s*条来源）",
    refs)
check("分级声明三方可提取（README 顶部 / 分布行 / 注脚；任一缺失即 FAIL）",
      _m_top is not None and _m_dist is not None and _m_note is not None,
      f"顶部={_m_top is not None} 分布={_m_dist is not None} 注脚={_m_note is not None}")
check(f"REFERENCES 实测 A == 声明（{_m_note.group(1) if _m_note else '?'}）",
      _m_note is not None and a == int(_m_note.group(1)), f"实测 A={a}")
check(f"REFERENCES 实测 B == 声明（{_m_note.group(2) if _m_note else '?'}）",
      _m_note is not None and _m_top is not None
      and b == int(_m_note.group(2)) and b == int(_m_top.group(2)), f"实测 B={b}")
check(f"REFERENCES 实测 C == 声明（{_m_note.group(3) if _m_note else '?'}）",
      _m_note is not None and c == int(_m_note.group(3)), f"实测 C={c}")
check(f"REFERENCES 实测 D == 声明（{_m_note.group(4) if _m_note else '?'}）",
      _m_note is not None and d == int(_m_note.group(4)), f"实测 D={d}")
check(f"REFERENCES 实测 G == 声明（{_m_note.group(5) if _m_note else '?'}）",
      _m_note is not None and g_count == int(_m_note.group(5)), f"实测 G={g_count}")
total = a + b + c + d + g_count
check(f"REFERENCES 合计 == 声明（{_m_note.group(6) if _m_note else '?'} 条）",
      _m_note is not None and total == int(_m_note.group(6)), f"实测合计={total}")
check(f"README 顶部声明 == 实测（合计={total} / B={b}）",
      _m_top is not None and int(_m_top.group(1)) == total and int(_m_top.group(2)) == b,
      f"顶部声明 total={_m_top.group(1) if _m_top else '?'} B={_m_top.group(2) if _m_top else '?'}")
check(f"README 分布行 == 实测（A={a} / B={b} / C={c} / D={d}"
      + (f" / G={g_count}）" if _m_dist and _m_dist.group(5) else "）"),
      _m_dist is not None and [int(x) for x in _m_dist.group(1, 2, 3, 4)] == [a, b, c, d]
      and (_m_dist.group(5) is None or int(_m_dist.group(5)) == g_count),
      f"分布声明={_m_dist.groups() if _m_dist else '?'}")
# CHANGELOG 取最近版本声明——门禁只校验字符串存在，数值一致性由第 14-15 项覆盖
# v2.11.0 条目含「新增 1 条 G 级」字样
check("CHANGELOG 声明「新增 1 条 G 级」（v2.11.0）",
      "新增 1 条 G 级" in chg)

# ── 3b. README 全文证据计数一致性 ─────────────
# 教训：v2.1.0 之前门禁只锁了 README 顶部声明与 REFERENCES 注脚两个固定字符串，
# 仓库结构表（README.md L139）漏写旧值「55 条分级证据」、英文版「可核查文献」段
# 写成「46 are grade B」都没被覆盖——同文件内部自相矛盾却照常提交。
# 本项扫描 README 双语全文出现的「N 条…证据 / N sources / N graded… / grade B」，
# 所有出现的总数与 B 级数都必须与门禁实测一致。
readme_en = read(os.path.join(ROOT, "README.en.md"))

# 总数声明：中文「N 条…分级证据」「N 条来源」、英文「N sources」「N graded evidence sources」
# 支持 2-3 位数字（证据总数已突破 100 条）
TOTAL_RE_ZH = re.compile(r"(\d{2,3})\s*条(?:[^\n]{0,6})?(?:分级)?证据")
TOTAL_RE_ZH2 = re.compile(r"(\d{2,3})\s*条来源")
TOTAL_RE_EN = re.compile(r"(\d{2,3})\s+(?:sources|graded(?:\s+evidence)?(?:\s+sources)?)", re.I)

# B 级数声明：中文「B 级 N 条」「其中 B 级 N 条」、英文「N are grade B」「grade-B: N」「B:N」
B_RE_ZH = re.compile(r"B\s*级\s*(\d{2,3})\s*条")
B_RE_EN1 = re.compile(r"(\d{2,3})\s+are\s+grade\s+B", re.I)
B_RE_EN2 = re.compile(r"B\s*[:：]\s*(\d{2,3})")
B_RE_ZH_DIST = re.compile(r"B\s*[:：]\s*(\d{2,3})")

_bad_total = []
_bad_b = []
for _label, _content in (("README.md", readme), ("README.en.md", readme_en)):
    # 总数：取所有声明集合，须全部 == total
    _tot = set(int(m.group(1)) for m in TOTAL_RE_ZH.finditer(_content))
    _tot |= set(int(m.group(1)) for m in TOTAL_RE_ZH2.finditer(_content))
    _tot |= set(int(m.group(1)) for m in TOTAL_RE_EN.finditer(_content))
    for _n in _tot:
        if _n != total:
            _bad_total.append(f"{_label} 出现总数 {_n} != 实测 {total}")
    # B 级：取所有声明集合，须全部 == b
    _bb = set(int(m.group(1)) for m in B_RE_ZH.finditer(_content))
    _bb |= set(int(m.group(1)) for m in B_RE_EN1.finditer(_content))
    _bb |= set(int(m.group(1)) for m in B_RE_EN2.finditer(_content))
    _bb |= set(int(m.group(1)) for m in B_RE_ZH_DIST.finditer(_content))
    for _n in _bb:
        if _n != b:
            _bad_b.append(f"{_label} 出现 B 级数 {_n} != 实测 {b}")
check(
    f"README 双语全文「证据总数」一致（所有出现的总数 == {total}）",
    not _bad_total,
    "; ".join(_bad_total[:5]),
)
check(
    f"README 双语全文「B 级数」一致（所有出现的 B 级数 == {b}）",
    not _bad_b,
    "; ".join(_bad_b[:5]),
)

# ── 4. 事故数字口径 ──────────────────────────
check("README 事故数字（1,200 留言板）",
      "1,200 个隔离 Agent 自发形成共享留言板" in readme)
check("README 事故数字（700 参与攻击）",
      "700 个参与协同攻击" in readme)
check("REFERENCES 一手材料（1,200 留言板 / 700 攻击）",
      "1,200" in refs and "700" in refs)

# ── 5. ANTITRUST 章节号 ──────────────────────
ant = read(os.path.join(ROOT, "ANTITRUST.md"))
check("ANTITRUST 指第十二章", "第十二章" in ant and "第十三章" not in ant)

# ── 6. STYLE 术语口径 ────────────────────────
style = read(os.path.join(ROOT, "STYLE.md"))
check("STYLE 禁 P0-x 审阅编号", "P0-1/P0-2/P0-3" in style)
check("STYLE 允许 P0 优先级标记",
      "允许使用公开语义的优先级标记" in style)

# ── 7. 单一真相源 ────────────────────────────
dup = os.path.join(ROOT, "spec", "14-references.md")
check("spec/ 无 14-references.md（唯一真相源 = 根 REFERENCES.md）",
      not os.path.exists(dup))

# ── 8. 引用红线 ────────────────────────────
# 已登记为「禁止引用」的数字。当前一条：GAIE（arXiv:2606.22484）的 84–97%
# 系由 18 个自设参数算出的解析估计，论文自陈无实测（见 REFERENCES.md 该条目）。
# REFERENCES.md 自身豁免——那里是禁令的说明文字，不是引用。
FORBIDDEN_NUMBERS = ["84–97%", "84-97%", "84～97%"]
red_line_hits = []
for fp in md_files():
    rel = os.path.relpath(fp, ROOT).replace("\\", "/")
    if rel in ("REFERENCES.md", "REFERENCES.en.md"):
        continue
    content = read(fp)
    for pat in FORBIDDEN_NUMBERS:
        if pat in content:
            red_line_hits.append(f"{rel} 出现禁止引用的数字 {pat}")
check("引用红线：正文无禁止引用的数字（GAIE 84–97%）",
      not red_line_hits, "; ".join(red_line_hits[:5]))

# ── 9. 未解问题条数一致 ──────────────────────
# 教训：v1.2.0 在 13-boundaries 新增 #16 / #17 后，README 中英双语共 7 处
# 仍写「15 条未解问题」，门禁无此检查因而漏网，直到人工复查才发现。
# 取数方式：从文件开头收集第一列为连续自然数（1,2,3...）的表格行，
# 序列一旦中断即停止——避免把后续 harness 披露卡表格的 1..11 误计入。
b13 = read(os.path.join(ROOT, "spec", "13-boundaries.md"))
_seq, _started = [], False
for _line in b13.split("\n"):
    _m = re.match(r"^\|\s*(\d+)\s*\|", _line)
    if _m:
        if int(_m.group(1)) == len(_seq) + 1:
            _seq.append(int(_m.group(1)))
            _started = True
        elif _started:
            break
    elif _started:
        break
# 口径裁决（v2.51.1）：本数 = 未解问题登记册总条数；已解决行留痕不删、不扣减
# （#12 / #14 自 v1.0.0 首版即为已解决留痕行，历史计数 31→37 从未因闭合而 -1）。
# 曾在本轮短暂改为「未解状态行数」并回滚——那是基于「未解 = 未解决状态」的误读，
# 漏查了 #12/#14 先例；登记册口径以本注释钉死，防止后续再按状态数误改。
open_n = len(_seq)
readme_en = read(os.path.join(ROOT, "README.en.md"))
check(f"13-boundaries 实测未解问题条数 = {open_n}",
      open_n >= 15, f"实测 {open_n} 条，少于 15 条疑似解析失败")
check(f"README 声明「{open_n} 条未解问题」",
      f"{open_n} 条未解问题" in readme, f"README.md 未找到「{open_n} 条未解问题」")
check(f"README.en 声明「{open_n} open problems」",
      f"{open_n} open problems" in readme_en,
      f"README.en.md 未找到「{open_n} open problems」")

# ── 10. REFERENCES 无悬空引用 ────────────────
# 教训（已复发两例）：v1.6.0 之前，REFERENCES 登记了 HarnessRisk 的「配置权即攻击面」，
# 落点列写着它支撑哪一章，但 spec/ 正文对该文献零命中 —— 概念只活在 REFERENCES 里，
# 读者会误以为该论断有文献支撑；v1.7.0 的 Janssen 是第二例。这是**隐性过度宣称**，
# 与证据完整性章自己写的「错觉比缺失更危险」是同一类问题。
#
# 登记键：有 arXiv 号者以号为键；无号者须在文献列显式声明【键: XXX】。
# 键须在 spec/ 正文出现；确系有意登记而未回灌者，须在落点列显式标注【登记备用】。
#
# ⚠️ 键不可用自由关键词推断：v1.8.0 摸底时以「EU AI Act」「Hugging Face」等关键词
# 判定命中，两次都是误报——正文里这些串指向的是**别的**文献（Janssen / Nannini），
# 以及把 HF 当作事故当事方提起、而非引用其技术时间线。键必须由人在 REFERENCES 显式声明。
#
# ⚠️ 「显式豁免」不是后门：① 标记是固定词元、可 grep、可计数；② 下方逐条打印备用
# 清单，每次跑门禁都会在输出里公示，无法静默堆积；③ 标记只豁免「正文未引用」这一项，
# 不豁免该条目的等级、限定的准确性。
#
# 覆盖范围：v1.9.0 起，全部条目（含无 arXiv 号者）均须有键，故本项已无盲区。
STANDBY_MARK = "【登记备用】"
_spec_dir = os.path.join(ROOT, "spec")
SPEC_ALL = "\n".join(
    read(os.path.join(_spec_dir, _fn))
    for _fn in sorted(os.listdir(_spec_dir))
    if _fn.endswith(".md")
)
ARX_RE = re.compile(r"arXiv:(\d{4}\.\d{4,5})")
KEY_RE = re.compile(r"【键:\s*([^】]+?)\s*】")

# 统一解析：每条条目 = (键列表, 是否有 arXiv 号, 文献列, 落点列, 显示标签)
_entries = []
for _line in refs.splitlines():
    if not GRADE_RE.match(_line):
        continue
    _parts = _line.split(" | ")
    if len(_parts) < 3:
        continue
    _lit = _parts[1]
    _land = " | ".join(_parts[2:])
    _ids = ARX_RE.findall(_lit)
    _keys = list(_ids) + KEY_RE.findall(_lit)
    _head = _ids[0] if _ids else (_keys[0] if _keys else "(无键)")
    _entries.append((_keys, bool(_ids), _lit, _land, _head + " — " + _lit[:34]))

_dangling = []
_standby = []
for _keys, _has_arx, _lit, _land, _tag in _entries:
    if not _keys or any(k in SPEC_ALL for k in _keys):
        continue
    if STANDBY_MARK in _land:
        _standby.append(_tag)
    else:
        _dangling.append(_tag)
check(
    f"REFERENCES 无悬空引用（键未命中 spec/ 者须在落点列标注{STANDBY_MARK}）",
    not _dangling,
    "; ".join(_dangling[:5]),
)
print(f"       ↳ 显式登记备用（正文未引用，逐条公示）: {len(_standby)} 条")
for _t in _standby:
    print(f"         · {_t}")
print(f"       ↳ 已声明引用键: "
      f"{sum(1 for e in _entries if e[0])} / {len(_entries)} 条")

# ── 11. 反向悬空：spec/ 引用的号必须已登记 ────
# 与第 10 项对称。教训：机制溯源表长期写着 AIprint 的 arXiv:2607.14434v1，
# 而 REFERENCES 的 AIprint 条目漏写该号 —— 只查单向，这个洞一直开着。
# 只有双向都查，REFERENCES 与正文的引用关系才真正闭合。
_ref_ids = set(ARX_RE.findall(refs))
_spec_ids = {}
for _fn in sorted(os.listdir(_spec_dir)):
    if not _fn.endswith(".md"):
        continue
    for _m in ARX_RE.finditer(read(os.path.join(_spec_dir, _fn))):
        _spec_ids.setdefault(_m.group(1), set()).add(_fn)
_unregistered = {k: sorted(v) for k, v in _spec_ids.items() if k not in _ref_ids}
check(
    "spec/ 引用的 arXiv 号均已在 REFERENCES 登记（反向悬空）",
    not _unregistered,
    "; ".join(f"arXiv:{k} → {v[0]}" for k, v in sorted(_unregistered.items())[:5]),
)

# ── 12. 引用键的声明与质量 ───────────────────
# 第 10 项此前只能覆盖有 arXiv 号的条目，16 条无号条目（官方博客 / 技术报告 /
# 期刊论文）是盲区。本项把覆盖补齐：无号条目必须由人显式声明键，随后并入第 10 项
# 的同一规则。
#
# ⚠️ 为什么键不能由脚本推断：见第 10 项注释——「EU AI Act」「Hugging Face」两次
# 关键词判定都是误报。键是**人对引用关系的声明**，脚本只负责校验声明本身的质量。
#
# 三条子规则：
#   (a) 完备 —— 无号条目必须声明键，否则该条目永远进不了第 10 项的比对，盲区复现。
#   (b) 唯一 —— 键撞车则命中无法归因到具体条目，等价于没有键。
#   (c) 非通用 —— 通用词必然在正文大量出现，但这些命中指向**别的**文献，键形同虚设。
#       黑名单收录的是已复现的误报词与同类高危词；最短长度挡住过短的缩写。
KEY_MIN_LEN = 4
GENERIC_KEYS = {
    # 已复现的两次误报（第 10 项注释有完整经过）
    "EU AI Act", "Hugging Face",
    # 同类高危：机构 / 通用概念名，正文里既指文献也指当事方或泛指
    "OpenAI", "Anthropic", "METR / Redwood", "Google", "DeepMind", "Microsoft",
    "sandbox", "Sandbox", "沙箱", "监管", "监管沙盒", "合规",
    "Agent", "agent", "AI", "LLM", "模型", "对齐", "审计", "溯源", "证据",
}

_nokey = []
_key_dup = {}
_key_generic = []
for _keys, _has_arx, _lit, _land, _tag in _entries:
    if _has_arx:
        continue
    if not _keys:
        _nokey.append(_tag)
        continue
    for _k in _keys:
        _key_dup.setdefault(_k, []).append(_tag)
        if _k in GENERIC_KEYS or len(_k) < KEY_MIN_LEN:
            _key_generic.append(f"{_k}（{_tag}）")

check(
    "无 arXiv 号的条目均已在文献列声明【键: XXX】",
    not _nokey,
    "; ".join(_nokey[:5]),
)
_dups = {k: v for k, v in _key_dup.items() if len(v) > 1}
check(
    "引用键全局唯一（不同条目不得共用同一键）",
    not _dups,
    "; ".join(f"{k} → {len(v)} 条" for k, v in list(_dups.items())[:5]),
)
check(
    f"引用键非通用词（不在黑名单且长度 ≥ {KEY_MIN_LEN}）",
    not _key_generic,
    "; ".join(_key_generic[:5]),
)
print(f"       ↳ 无号条目 {sum(1 for e in _entries if not e[1])} 条，"
      f"其中已声明键 "
      f"{sum(1 for e in _entries if not e[1] and e[0])} 条")

# ── 13. G 类引用键的管辖前缀合法性（2026-09-04 新增） ──────
# G 类条目无 arXiv 号，全部依赖显式【键: XXX】声明。为防止自由命名导致引用混乱，
# G 类键必须以管辖前缀开头，门禁逐条校验。
# 教训预防：非 G 类条目此前已出现过随意命名（如 GEN-RWD / Glasswing），但 G 类
# 因涉及多法域且同名事件跨域重复（如「意大利 Garante」既可指欧盟成员国执法、
# 也可引申至 GDPR 框架），前缀化是区分的最低门槛。
G_PREFIXES = {
    "cn-", "us-", "eu-", "uk-", "ca-", "au-", "jp-", "kr-",
    "sg-", "int-", "iso-", "owasp-",
}
_bad_g_prefix = []
_g_entries = []
for _keys, _has_arx, _lit, _land, _tag in _entries:
    # G 类条目：文献列等级标记为「G」（由 GRADE_RE 解析，此处用 _lit 反查不精确，
    # 改用直接扫原文件匹配）
    pass

# 直接从 refs 按 G 级行重新解析，确保只管 G 类
_G_LINE_RE = re.compile(r"^G(?:（[^）]*）)?\s*\|\s*【键:\s*([^】]+?)\s*】", re.M)
_g_keys_in_refs = [m.group(1) for m in _G_LINE_RE.finditer(refs)]
for _k in _g_keys_in_refs:
    _matched = any(_k.startswith(_p) for _p in G_PREFIXES)
    if not _matched:
        _bad_g_prefix.append(_k)
check(
    "G 类引用键前缀合法（cn- / us- / eu- / uk- / ca- / au- / jp- / kr- / sg- / int- / iso- / owasp-）",
    not _bad_g_prefix,
    "; ".join(_bad_g_prefix[:5]),
)

# ── 14. G 类条目必须声明【键: XXX】（与第 12 项 a 子规则互补） ──────
# G 类条目天然无 arXiv 号，本项确保「G 类无键」不会成为盲区。
_G_NOKEY_RE = re.compile(r"^G(?:（[^）]*）)?\s*\|(?!.*【键:)", re.M)
_g_nokey = _G_NOKEY_RE.findall(refs)
check(
    "G 类条目均声明【键: XXX】（G 类无 arXiv 号，强制声明键）",
    not _g_nokey,
    f"{len(_g_nokey)} 条 G 类条目未声明键",
)

# 非 G 类条目键集合（供「VERIFICATION-LOG 无幽灵键」放宽对照用，v2.15.1 引入）
# 非 G 类可能声明【键: XXX】（强制声明键），也可能不声明（走 arXiv 号定位）。
# 此处提取所有非 G 行声明的键，合并入 _ref_all_keys 作幽灵键方向的全集。
_NONG_LINE_RE = re.compile(r"^(?:A|B|C|D)(?:（[^）]*）)?\s*\|\s*【键:\s*([^】]+?)\s*】", re.M)
_ref_non_g_keys = [m.group(1) for m in _NONG_LINE_RE.finditer(refs)]

# ── 15. VERIFICATION-LOG 与 REFERENCES 键集双向一致（防核验公示漂移） ──────
# 教训预防：README「结构性偏置声明」段曾不在门禁覆盖范围，v2.11.0 升级漏改、
# 两轮门禁全 PASS 仍残留（v2.11.2 修正）。核验公示日志若与真相源脱节
# （新增 G 键未登记核验 / 键拼写漂移）会静默腐烂，本项把公示与真相源钉死。
# 演进（v2.15.1）：VERIFICATION-LOG 已从 G-only 扩展到 A/D/C 类补登记，
# 「无幽灵键」方向的对照全集从 REFERENCES G 键放宽为 REFERENCES 全部条目键
# （非 G 键 + G 键合集），覆盖所有已回填类型。
_LOG_PATH = os.path.join(ROOT, "VERIFICATION-LOG.md")
_log_cells = []
if os.path.exists(_LOG_PATH):
    with open(_LOG_PATH, encoding="utf-8") as _f:
        for _ln in _f:
            _m = re.match(r"^\|\s*([^|]+?)\s*\|", _ln)
            if _m:
                _cell = _m.group(1).strip()
                if _cell and not _cell.startswith("-") and "条目键" not in _cell:
                    _log_cells.append(_cell)  # 保留完整首列（含「短名（arXiv:xxxx）」形态），覆盖判定用包含匹配
# 每条条目的匹配 token：arXiv 号加「arXiv:」前缀、键原样
_entry_tokens = []
for _keys, _has_arx, _lit, _land, _tag in _entries:
    _toks = [("arXiv:" + _k) if re.match(r"^\d{4}\.\d{4,5}$", _k) else _k for _k in _keys]
    _entry_tokens.append((_keys, _toks, _tag))
_uncovered = sorted(
    (_keys[0] if _keys else "(无键)") + " — " + _lit[:34]
    for _keys, _toks, _tag in _entry_tokens
    if not any(any(tok in c for tok in _toks) for c in _log_cells)
)
_ghost_in_log = sorted(
    c for c in _log_cells
    if not any(any(tok in c for tok in _toks) for _keys, _toks, _tag in _entry_tokens)
)
check(
    "VERIFICATION-LOG 覆盖全部条目（不分等级；REFERENCES 键/arXiv 号均须在 LOG 出现）",
    not _uncovered,
    f"{len(_uncovered)} 条未登记：{'; '.join(_uncovered[:5])}",
)
check(
    "VERIFICATION-LOG 无幽灵行（LOG 首列须可归因到 REFERENCES 条目）",
    not _ghost_in_log,
    f"{len(_ghost_in_log)} 行无法归因：{'; '.join(_ghost_in_log[:5])}",
)

# ── 16. README 法域枚举与 REFERENCES G 键前缀一致（防法域计数漂移） ──────
# 教训预防：「八法域」自 v2.8.0 初写即漏计 1（当时已列 8 个主权法域），
# v2.10.0 新增 au 时机械 7→8 未重新枚举，三轮门禁全 PASS 仍残留（v2.12.1 修正）。
# 本项把 README 的法域枚举与计数钉死到 REFERENCES G 键前缀这一真相源上：
# 新增主权法域前缀而不同步 README 枚举 / 计数时，本项 FAIL；旧计数残留同样 FAIL。
# 注：int- 前缀为国际组织（OECD/GPAI/G7/IMDRF），非主权法域，README 以「等」概括，
# 不参与逐名枚举校验；iso- / owasp- 为国际标准，仅要求出现于法域行。
_JP_NAME = {"cn": "中", "us": "美", "uk": "英", "ca": "加", "au": "澳",
            "eu": "欧盟", "sg": "新加坡", "kr": "韩国", "jp": "日本"}
_ZH_NUM = {5: "五", 6: "六", 7: "七", 8: "八", 9: "九", 10: "十", 11: "十一", 12: "十二"}
_EN_NUM = {5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve"}
_sovereign = sorted({_k.split("-")[0] for _k in _g_keys_in_refs} - {"int", "iso", "owasp"})
_n_jp = len(_sovereign)
_zh_ct, _en_ct = _ZH_NUM.get(_n_jp), _EN_NUM.get(_n_jp)
with open(os.path.join(ROOT, "README.md"), encoding="utf-8") as _f:
    _readme_zh = _f.read()
with open(os.path.join(ROOT, "README.en.md"), encoding="utf-8") as _f:
    _readme_en = _f.read()
_zh_jp_line = next((_l for _l in _readme_zh.splitlines() if "法域" in _l and "覆盖" in _l), "")
_jp_missing = [_JP_NAME[_p] for _p in _sovereign if _JP_NAME[_p] not in _zh_jp_line]
_jp_probs = []
if _zh_ct is None:
    _jp_probs.append(f"主权法域数 {_n_jp} 超出 _ZH_NUM/_EN_NUM 映射范围，请先扩充映射再同步 README 双语")
else:
    if f"{_zh_ct}法域" not in _zh_jp_line:
        _jp_probs.append(f"README.md 法域行未声明「{_zh_ct}法域」")
    if f"{_zh_ct}个法域" not in _readme_zh:
        _jp_probs.append(f"README.md 未声明「{_zh_ct}个法域」（结构性偏置声明段）")
    if ("L0" + chr(0x2013) + "L4 + E 六个落点") not in _readme_zh:
        _jp_probs.append("README.md 偏置声明未写「L0–L4 + E 六个落点」（中文漏 E，与英文口径不一致）")
    if f"{_en_ct} jurisdictions" not in _readme_en:
        _jp_probs.append(f"README.en.md 未声明「{_en_ct} jurisdictions」")
    for _num, _w in _ZH_NUM.items():
        if _num != _n_jp and (f"{_w}法域" in _readme_zh or f"{_w}个法域" in _readme_zh):
            _jp_probs.append(f"README.md 残留旧计数「{_w}（个）法域」")
        if _num != _n_jp and f"{_w} jurisdictions" in _readme_en:
            _jp_probs.append(f"README.en.md 残留旧计数「{_w} jurisdictions」")
_jp_fail = ([f"法域行缺 {'、'.join(_jp_missing)}"] if _jp_missing else []) + _jp_probs
check(
    "README 法域枚举与计数和 REFERENCES G 键前缀一致（防法域计数漂移）",
    not _jp_fail,
    "; ".join(_jp_fail),
)

# ── 17. spec/11 机制溯源表 CAE 三段齐全（v2.23.0 新增） ──────
# 启发 9 第二步落地后，spec/11 的每行数据行的「教训/来源」字段须同时含
# **主张**、**论证**、**证据**（中文）/ **Claim**、**Argument**、**Evidence**（英文）。
# 跳过：表头行、分隔行、## 结构迁移声明 / Structure migration 声明节内的全部行、
#       ## 标准引注 / Standard citations 节及其后全部行（非表格内容）。
_cae_bad = []
for _fn in ("spec/11-traceability.md", "spec/11-traceability.en.md"):
    _fp = os.path.join(ROOT, _fn)
    if not os.path.isfile(_fp):
        continue
    _is_en = _fn.endswith(".en.md")
    _markers = ("**Claim**", "**Argument**", "**Evidence**") if _is_en else (
        "**主张**", "**论证**", "**证据**")
    _skip_header_zh = "## 结构迁移声明"
    _skip_header_en = "## Structure migration declaration"
    _skip_header2_zh = "## 标准引注"
    _skip_header2_en = "## Standard citations"
    _lines = read(_fp).splitlines()
    _in_skip_zone = False
    _in_skip_zone2 = False
    for _i, _line in enumerate(_lines, 1):
        if _skip_header_zh in _line or _skip_header_en in _line:
            _in_skip_zone = True
            continue
        if _skip_header2_zh in _line or _skip_header2_en in _line:
            _in_skip_zone2 = True
            continue
        if _in_skip_zone2:
            continue
        if _in_skip_zone:
            # 跳到表格表头行（含 "机制" 或 "Mechanism" 且以 "|" 分隔）
            if "|" in _line and ("机制" in _line or "Mechanism" in _line):
                _in_skip_zone = False
                continue
            else:
                continue
        # 只检查表格数据行（含 "|" 且不是分隔行、不是表头）
        _s = _line.strip()
        if not _s or "|" not in _s:
            continue
        if SEP_RE.match(_line):
            continue  # 分隔行
        # 表头行跳过
        if _s.startswith("机制") or _s.startswith("Mechanism"):
            continue
        # 检查三个标记词都在
        _missing = [m for m in _markers if m not in _line]
        if _missing:
            _cae_bad.append(f"{_fn} L{_i}: 缺 {'/'.join(_missing)}")
check(
    "spec/11 机制溯源表 CAE 三段齐全（每行含 主张/论证/证据）",
    not _cae_bad,
    "; ".join(_cae_bad[:5]),
)

# ── 18. 版本元数据同步（v2.26.1 新增，防版本号漂移） ──────────
# 教训来源：v2.17.0–v2.26.0 期间 README 双语 Version badge 停在 2.17.0、
# CITATION.cff 停在 2.19.0，而 VERSION 已到 2.26.0——门禁此前不覆盖版本元数据。
# 校验：VERSION / CITATION.cff（全部 version 字段）/ README 双语 badge 三处一致。
_version = read(os.path.join(ROOT, "VERSION")).strip()
_citation = read(os.path.join(ROOT, "CITATION.cff"))
_cit_versions = re.findall(r'version:\s*"([^"]+)"', _citation)
_v_bad = []
if not _cit_versions:
    _v_bad.append("CITATION.cff 未找到 version 字段")
else:
    _mismatch = [v for v in _cit_versions if v != _version]
    if _mismatch:
        _v_bad.append(f"CITATION.cff version {_mismatch} != VERSION {_version}")
for _rn in ("README.md", "README.en.md"):
    _rm = re.search(r"badge/version-([0-9.]+)-blue", read(os.path.join(ROOT, _rn)))
    _badge_v = _rm.group(1) if _rm else None
    if _badge_v != _version:
        _v_bad.append(f"{_rn} badge version {_badge_v} != VERSION {_version}")
# v2.44.3 起把 README 双语「当前版本」正文行纳入校验——该行曾两轮漏网
# （v2.44.1 / v2.44.2 时停在 v2.44.0；v2.31.0 同一坑已修过一次值但未入门禁）
for _rn, _pat in (("README.md", r"当前版本：v([0-9.]+)"),
                  ("README.en.md", r"Current version: v([0-9.]+)")):
    _rm = re.search(_pat, read(os.path.join(ROOT, _rn)))
    _cur_v = _rm.group(1) if _rm else None
    if _cur_v != _version:
        _v_bad.append(f"{_rn} 当前版本行 {_cur_v} != VERSION {_version}")
check(
    "版本元数据同步（VERSION / CITATION.cff / README 双语 badge）",
    not _v_bad,
    "; ".join(_v_bad),
)

# ── 19. 门禁项数声明一致（v2.26.1 新增，防项数漂移） ──────────
# 教训来源：v2.23.0 门禁 35→36 项时，README 双语 / CONTRIBUTING / ci.yml 共 5 处
# 「35 项」声明漏更新（v2.12.1 的 34→35 曾同步，v2.23.0 却漏）。
# 校验：实际 check( 调用数（读本脚本源码统计行首 check( ）与全部声明处的数字一致。
_self_src = read(os.path.abspath(__file__))
_n_checks = len(re.findall(r"^check\(", _self_src, re.M))
_DECL_SITES = [
    ("README.md", r"(\d+) 项发布一致性校验"),
    ("README.en.md", r"(\d+) release-consistency checks"),
    ("CONTRIBUTING.md", r"verify_consistency\.py`，(\d+) 项："),
    ("CONTRIBUTING.en.md", r"verify_consistency\.py`, (\d+) items:"),
    (".github/workflows/ci.yml", r"发布一致性校验（(\d+) 项）"),
    (".github/workflows/ci.yml", r"(\d+) 项门禁"),
    ("scripts/verify_consistency.py", r"校验项（共 (\d+) 项"),
]
_declared = set()
_missing_sites = []
for _fn, _pat in _DECL_SITES:
    _fp2 = os.path.join(ROOT, _fn)
    if not os.path.isfile(_fp2):
        _missing_sites.append(_fn)
        continue
    for _m2 in re.finditer(_pat, read(_fp2)):
        _declared.add(int(_m2.group(1)))
_decl_bad = []
if _missing_sites:
    _decl_bad.append(f"声明文件缺失: {_missing_sites}")
if not _declared:
    _decl_bad.append("未在任何声明处找到门禁项数")
elif _declared != {_n_checks}:
    _decl_bad.append(f"声明项数 {sorted(_declared)} != 实际 check 数 {_n_checks}")
check(
    "门禁项数声明一致（README 双语 / CONTRIBUTING / ci.yml / 本脚本头注释）",
    not _decl_bad,
    "; ".join(_decl_bad),
)

# ── 20. demo 断言声明 vs 实际输出一致（v2.44.1 新增，防声明性数字漂移） ──────────
# 声明采集四处，按格式分两类：
#   完整二元组（组数, 项数）：ci.yml step 名「(N 组 M 项断言)」、子 README「demo 覆盖 N 组、M 项断言」
#   仅 demo 项数（otel 项数属另一脚本，不在本项真相源内）：
#       ci.yml 头注释「N+M 项断言」（N=demo、M=otel）、job 名「demo N 项 + otel M 项」
# 真相源：demo.ts 运行末行「=== 结果：…（N 组 M 项断言）===」（运行时计数器生成）。
_ci = read(os.path.join(ROOT, ".github", "workflows", "ci.yml"))
_DEMO_REL = os.path.join("reference", "runtimes", "l2-runtime-oversight", "demo.ts")
_decl_ci_header = re.search(r"(\d+)\+(\d+) 项断言", _ci)
_decl_ci_job = re.search(r"demo (\d+) 项 \+ otel (\d+) 项", _ci)
_decl_ci_step = re.search(r"Run demo\.ts \((\d+) 组 (\d+) 项断言\)", _ci)
_sub_readme = read(os.path.join(ROOT, "reference", "runtimes",
                                "l2-runtime-oversight", "README.md"))
_decl_sub_readme = re.search(r"demo 覆盖 (\d+) 组、(\d+) 项断言", _sub_readme)
_demo_bad = []
_actual, _err = None, ""
try:
    _proc = subprocess.run(
        ["node", "--experimental-transform-types", _DEMO_REL],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=ROOT, timeout=300,
    )
    _m = re.search(r"=== 结果：.*?（(\d+) 组 (\d+) 项断言）===", _proc.stdout)
    if _m:
        _actual = (int(_m.group(1)), int(_m.group(2)))
        if _proc.returncode != 0:
            _demo_bad.append(f"demo 实跑存在 FAIL（退出码 {_proc.returncode}）")
    elif _proc.returncode != 0:
        _err = f"demo 实跑非零退出（码 {_proc.returncode}），先修 demo 再谈声明"
    else:
        _err = ("demo 输出未找到「（N 组 M 项断言）」计数行"
                "——demo 末行汇总模板被改动？第 40 项失去真相源")
except FileNotFoundError:
    _err = ("未找到 node——本项需 node ≥ 22 实跑 demo 取证"
            "（CI consistency job 已配置 Setup Node）")
except subprocess.TimeoutExpired:
    _err = "demo 实跑超时（300s）"
if _actual is None:
    _demo_bad.append(_err or "demo 计数解析失败")
else:
    _ag, _an = _actual
    for _label, _m2 in (("ci.yml step 名", _decl_ci_step),
                        ("子 README", _decl_sub_readme)):
        if _m2 is None:
            _demo_bad.append(f"{_label} 未找到 demo 断言声明（声明被删除？）")
        elif (int(_m2.group(1)), int(_m2.group(2))) != (_ag, _an):
            _demo_bad.append(
                f"{_label} 声明 {_m2.group(1)} 组 {_m2.group(2)} 项"
                f" != 实际 {_ag} 组 {_an} 项")
    # 头注释 / job 名：拼接格式，只校验 demo 项数段
    for _label, _m2 in (("ci.yml 头注释", _decl_ci_header),
                        ("ci.yml job 名", _decl_ci_job)):
        if _m2 is None:
            _demo_bad.append(f"{_label} 未找到 demo 断言声明（声明被删除？）")
        elif int(_m2.group(1)) != _an:
            _demo_bad.append(
                f"{_label} 声明 demo {_m2.group(1)} 项 != 实际 {_an} 项")
check(
    "demo 断言声明与实际输出一致（ci.yml 三处 + 子 README == demo 运行时计数）",
    not _demo_bad,
    "; ".join(_demo_bad),
)
if _actual is not None:
    print(f"       ↳ demo 实跑计数：{_actual[0]} 组 {_actual[1]} 项断言"
          f"（运行时计数器生成，非手写）")

# ── 21. CORRECTION-LOG 结构与时效校验（v2.44.2 新增，纠错承诺机制化） ──────────
# README 双语承诺「纠错审核周期不超过 14 天；拒绝不静默关闭」此前无登记载体，
# 属审查 A2 所指「承诺≠机制」。CORRECTION-LOG.md 是该承诺的数值化载体：
# 截止日期 = 受理日期 + 14 天；拒绝必附理由；待处理超期（按当日日期）FAIL。
_COR_LOG = os.path.join(ROOT, "CORRECTION-LOG.md")
_cor_bad = []
if not os.path.isfile(_COR_LOG):
    _cor_bad.append("CORRECTION-LOG.md 不存在（14 天纠错承诺失去登记载体）")
else:
    _cor_src = read(_COR_LOG)
    _cor_rows = []
    for _ln in _cor_src.splitlines():
        if not re.match(r"^\|\s", _ln):
            continue
        _cells = [c.strip() for c in _ln.strip().strip("|").split("|")]
        if len(_cells) != 5:
            continue
        if _cells[0] in ("Issue", "") or set(_cells[0]) <= set("-"):
            continue  # 表头 / 分隔行
        if _cells[0].startswith("（暂无"):
            continue  # 占位行（空表合法）
        _cor_rows.append(_cells)
    for _issue, _accept, _due, _status, _summary in _cor_rows:
        _tag = _issue[:24]
        if not _issue:
            _cor_bad.append("存在 Issue 为空的登记行")
            continue
        if _status not in ("待处理", "已结") and not _status.startswith("已拒绝"):
            _cor_bad.append(f"{_tag}: 状态 {_status!r} 不在枚举（待处理/已结/已拒绝）")
            continue
        try:
            _d1 = datetime.date.fromisoformat(_accept)
            _d2 = datetime.date.fromisoformat(_due)
        except ValueError:
            _cor_bad.append(f"{_tag}: 受理/截止日期格式非法（{_accept} / {_due}，须 ISO 日期）")
            continue
        if (_d2 - _d1).days != 14:
            _cor_bad.append(f"{_tag}: 截止-受理 = {(_d2 - _d1).days} 天 != 14 天")
        if _status == "待处理" and _d2 < datetime.date.today():
            _cor_bad.append(f"{_tag}: 待处理已超期（截止 {_d2} < 今日）——14 天纠错承诺违约")
        if _status.startswith("已拒绝") and len(_summary) < 8:
            _cor_bad.append(f"{_tag}: 已拒绝但拒绝理由缺失（违反「拒绝不静默关闭」）")
    print(f"       ↳ 纠错登记：{len(_cor_rows)} 条（待处理 "
          f"{sum(1 for r in _cor_rows if r[3] == '待处理')} 条）")
check(
    "CORRECTION-LOG 结构合法且无超期未结纠错（14 天纠错周期机制化）",
    not _cor_bad,
    "; ".join(_cor_bad[:5]),
)

# ── 22. PRODUCTION-GAPS 当前状态行 vs 正文表格一致（v2.52.10 新增） ─────────────
# 教训来源：外部 AI 评估（2026-10-07）实测发现 PRODUCTION-GAPS.md 头部 v2.2.0 更新行
# 写「其余 6 项（G3–G8）未闭合」，而正文表格 G7（v2.36.0 事件流侧）/ G8（v2.38.0 告警侧）
# 已「✅ 演示级闭合」——头部声明与正文表格漂移存活多个版本。与第 40 项教训同构：
# 门禁只校验「文档之间一致」，不校验「同一文件头尾一致」。
# 机制：头部须有显式「当前状态」行（闭合/未闭合清单），门禁从正文表格解析实际
# ✅/❌ 集合，双向比对；表格状态变化而状态行未同步即 FAIL。
_pg = read(os.path.join(ROOT, "reference", "runtimes", "l2-runtime-oversight",
                        "PRODUCTION-GAPS.md"))
_pg_state = re.search(
    r"当前状态（v[\d.]+）\*{0,2}：\s*([G\d/ ]+?)演示级闭合[；;]\s*([G\d/ ]+?)未闭合", _pg)
_pg_tbl_closed, _pg_tbl_open = set(), set()
for _m in re.finditer(r"^\| \*\*G(\d+)\*\*.*\|\s*(✅|❌)[^|]*\|\s*$", _pg, re.M):
    (_pg_tbl_closed if _m.group(2) == "✅" else _pg_tbl_open).add(_m.group(1))
_pg_bad = []
if not _pg_state:
    _pg_bad.append("未找到「当前状态（vX.Y.Z）：G…演示级闭合；G…未闭合」状态行")
else:
    _pg_dec_closed = set(re.findall(r"G(\d+)", _pg_state.group(1)))
    _pg_dec_open = set(re.findall(r"G(\d+)", _pg_state.group(2)))
    if _pg_dec_closed != _pg_tbl_closed:
        _pg_bad.append(f"闭合声明 {sorted(_pg_dec_closed)} != 表格实测 {sorted(_pg_tbl_closed)}")
    if _pg_dec_open != _pg_tbl_open:
        _pg_bad.append(f"未闭合声明 {sorted(_pg_dec_open)} != 表格实测 {sorted(_pg_tbl_open)}")
check(
    "PRODUCTION-GAPS 当前状态行与正文表格一致（闭合/未闭合双向比对）",
    not _pg_bad,
    "; ".join(_pg_bad[:3]),
)

# ── 23. spec/ 双语结构对齐（v2.52.11 新增） ─────────────────────────────────
# 实测（2026-10-14）：5/13 对 spec 存在标题数量或层级序列漂移——双语同步此前仅靠
# 人工纪律，门禁对英文版的检查面远窄于中文（同「声明 vs 实际」盲区族）。机制：
# 逐对比对 ^#+ 标题层级序列；已知漂移按完整序列指纹登记豁免表（诚实公示），
# 修复一对删一对；未登记的新漂移即 FAIL。豁免指纹为实测快照：修复后手动删除。
_BILINGUAL_KNOWN_DRIFT = {}  # 已清偿（v2.52.12）：v2.52.11 实测的 5 对结构漂移全部对齐，豁免表清零；机制保留——未来新漂移出现时按完整序列指纹登记于此并自动公示
_spec_dir = os.path.join(ROOT, "spec")
_bl_bad, _bl_exempt = [], []
for _base in sorted(os.listdir(_spec_dir)):
    if not re.match(r"^[0-1][0-9]-.*\.md$", _base) or _base.endswith(".en.md"):
        continue
    _en = os.path.join(_spec_dir, _base[:-3] + ".en.md")
    if not os.path.exists(_en):
        continue
    _hz = re.findall(r"^(#+) ", read(os.path.join(_spec_dir, _base)), re.M)
    _he = re.findall(r"^(#+) ", read(_en), re.M)
    _sz = ",".join(str(len(h)) for h in _hz)
    _se = ",".join(str(len(h)) for h in _he)
    if _sz == _se:
        continue
    if _base in _BILINGUAL_KNOWN_DRIFT and tuple(_BILINGUAL_KNOWN_DRIFT[_base]) == (_sz, _se):
        _bl_exempt.append("%s（zh %d / en %d 标题）" % (_base, len(_hz), len(_he)))
    else:
        _bl_bad.append("%s 中文 %d 标题/序列 vs 英文 %d（未登记的新漂移）"
                       % (_base, len(_hz), len(_he)))
if _bl_exempt:
    print("       ↳ 双语结构：已登记漂移豁免 %d 对（修复一对删一对）: %s"
          % (len(_bl_exempt), "; ".join(_bl_exempt)))
check(
    "spec/ 双语结构对齐（标题层级序列一致；已知漂移按豁免表公示）",
    not _bl_bad,
    "; ".join(_bl_bad[:3]),
)

# ── 44. spec/11 行数声明 == 双语实测（v2.52.25 新增，防声明链漂移） ──────────
# 教训来源：2026-11-03 内部审计实测发现 spec/11 双语行数声明「现为 55 行」自
# v2.28.0 起漂移（主表实际 93 行，低估 38 行），伴随每轮门禁全绿存活约 30 个版本。
# 声明锚点：zh「当前 N 行」/ en「currently has N data rows」（spec/11 L15，双语各一）。
# 实测口径：主表区（至「标准引注 / Standard citations」节前）内含 CAE 三标记与
# 「 | 」分隔的行数——与第 37 项（每行 CAE 三段齐全）互补：37 管行内结构，44 管行数。
def _count_s11_rows(_region, _m1, _m2, _m3):
    _n = 0
    for _ln in _region.splitlines():
        if " | " in _ln and _m1 in _ln and _m2 in _ln and _m3 in _ln:
            _n += 1
    return _n

_s11z = read(os.path.join(ROOT, "spec", "11-traceability.md"))
_s11e = read(os.path.join(ROOT, "spec", "11-traceability.en.md"))
assert "## 标准引注" in _s11z and "## Standard citations" in _s11e, "spec/11 节锚点缺失"
_s11z_n = _count_s11_rows(_s11z.split("## 标准引注")[0], "主张", "论证", "证据")
_s11e_n = _count_s11_rows(_s11e.split("## Standard citations")[0], "Claim", "Argument", "Evidence")
_s11z_decl = re.search(r"当前 (\d+) 行", _s11z)
_s11e_decl = re.search(r"currently has (\d+) data rows", _s11e)
_s11_bad = []
if not _s11z_decl or not _s11e_decl:
    _s11_bad.append("spec/11 行数声明句缺失或格式变更（zh「当前 N 行」/ en「currently has N data rows」）")
else:
    if int(_s11z_decl.group(1)) != _s11z_n:
        _s11_bad.append("zh 声明 %s 行 != 实测 %d 行" % (_s11z_decl.group(1), _s11z_n))
    if int(_s11e_decl.group(1)) != _s11e_n:
        _s11_bad.append("en 声明 %s 行 != 实测 %d 行" % (_s11e_decl.group(1), _s11e_n))
check(
    "spec/11 行数声明 == 双语实测（v2.52.25 新增）",
    not _s11_bad,
    "; ".join(_s11_bad),
)

# ── 45. spec/13 未解登记册完整性（v2.52.26 新增，行数==编号连续==README 声明三方互证） ──────────
# 教训来源：2026-11-03 内部审计「#41~#43 疑似缺失」排查为格式假警报，但暴露 spec/13 登记册
# 与 README「43 条未解问题」声明之间无机器互证。本项与第 44 项同构：机器统计为权威、
# 声明提取比对——登记册加行/删行而 README 声明不动（或反向）即 FAIL。
def _s13_scan(path, next_heading):
    _region = read(path).split(next_heading)[0]
    _rows, _nums = [], []
    for _ln in _region.splitlines():
        _t = _ln.strip()
        if _t.startswith("| ") and " | " in _t and "---" not in _t:
            _m = re.match(r"\| (\d+) \|", _ln)
            if _m:
                _rows.append(_ln)
                _nums.append(int(_m.group(1)))
    return _nums

_s13z_nums = _s13_scan(os.path.join(ROOT, "spec", "13-boundaries.md"), "\n## 自报置信度")
_s13e_nums = _s13_scan(os.path.join(ROOT, "spec", "13-boundaries.en.md"), "\n## Acceptance boundary")
_r13z = read(os.path.join(ROOT, "README.md"))
_r13e = read(os.path.join(ROOT, "README.en.md"))
_s13z_decls = re.findall(r"(\d+) 条未解问题", _r13z)
_s13e_decls = re.findall(r"(\d+) open problems", _r13e)
_s13_bad = []
if not _s13z_nums or not _s13e_nums:
    _s13_bad.append("spec/13 登记册数据行缺失或格式变更（期望「| N | ...」行）")
else:
    if len(_s13z_nums) != len(_s13e_nums):
        _s13_bad.append("双语登记册行数不等 zh=%d en=%d" % (len(_s13z_nums), len(_s13e_nums)))
    for _tag, _nums in (("zh", _s13z_nums), ("en", _s13e_nums)):
        if _nums != list(range(1, len(_nums) + 1)):
            _s13_bad.append("%s 登记册编号不连续或有重复（实测 %s）" % (_tag, _nums[:8]))
    _s13n = len(_s13z_nums)
    for _tag, _decls in (("zh", _s13z_decls), ("en", _s13e_decls)):
        if not _decls:
            _s13_bad.append("README %s 未解问题声明句缺失或格式变更" % _tag)
        else:
            for _d in set(_decls):
                if int(_d) != _s13n:
                    _s13_bad.append("README %s 声明 %s 条 != 登记册实测 %d 条" % (_tag, _d, _s13n))
check(
    "spec/13 未解登记册完整性：行数/编号连续/README 双语声明互证（v2.52.26 新增）",
    not _s13_bad,
    "; ".join(_s13_bad),
)

# ── 46. 面板入库产物 meta.framework.version 与 VERSION 一致（v2.60.0 新增）──
_p46_version = read(os.path.join(ROOT, "VERSION")).strip()
_p46_bad = []
for _p46_name in ("events.jsonl", "realagent-events.jsonl"):
    _p46_path = os.path.join(ROOT, "tools", "audit-panel", "data", _p46_name)
    if not os.path.exists(_p46_path):
        _p46_bad.append("缺少入库产物 %s" % _p46_name)
        continue
    _p46_first = open(_p46_path, encoding="utf-8").readline()
    try:
        _p46_meta = json.loads(_p46_first)
        _p46_fv = (_p46_meta.get("framework") or {}).get("version")
    except Exception:
        _p46_fv = None
    if _p46_fv != _p46_version:
        _p46_bad.append(
            "%s 的 meta.framework.version=%s != VERSION=%s（版本联动后须重生成产物）"
            % (_p46_name, _p46_fv, _p46_version)
        )
check(
    "面板入库产物 meta.framework.version 与 VERSION 一致（v2.60.0 新增）",
    not _p46_bad,
    "; ".join(_p46_bad),
)

# ── 47. 处置台账链可重算 + 篡改检出（处置通道阶段 1 新增）──────────
# 教训来源：处置通道阶段 1 的 DoD 写「第三方可独立重算」，但只提供 JS 验证器等于
# 只证明「同一实现能验自己」。本项把三件事同时钉死：
#   ① Node 生成 20 行样本 → Python 参照实现验链 PASS（序列化规格漂移即失败）
#   ② 篡改任意一行的内容 → Python 必须 FAIL（链有防护力，不是常量比对）
#   ③ 打乱某行键序 → 两端必须 FAIL（键序冻结不是文档口号）
#   ④ 入库台账 tools/disposition/data/disposition.jsonl → Python 验链 PASS
# 与第 40/44/46 项同构：任何可验证声明，要么生成、要么校验，不写第三种。
_p47_dir = os.path.join(ROOT, "tools", "disposition")
_p47_py = os.path.join(_p47_dir, "verify_chain.py")
_p47_js = os.path.join(_p47_dir, "verify-chain.mts")
_p47_gen = os.path.join(_p47_dir, "gen-sample.mts")
_p47_data = os.path.join(_p47_dir, "data", "disposition.jsonl")
_p47_bad = []


def _p47_run(cmd):
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=ROOT, timeout=120,
    )


def _p47_detail(proc):
    for _ln in proc.stdout.splitlines():
        _t = _ln.strip()
        if _t.startswith("[disp") or _t.startswith("失败项"):
            return _t
    _tail = [l.strip() for l in (proc.stdout + "\n" + proc.stderr).splitlines() if l.strip()]
    return _tail[-1][:160] if _tail else "无输出"


_p47_tmp = tempfile.mkdtemp(prefix="aof-disposition-")
try:
    _p47_missing = [n for n, p in (("verify_chain.py", _p47_py), ("verify-chain.mts", _p47_js),
                                   ("gen-sample.mts", _p47_gen)) if not os.path.isfile(p)]
    if _p47_missing:
        _p47_bad.append("处置台账模块缺失：%s" % "、".join(_p47_missing))
    else:
        _p47_sample = os.path.join(_p47_tmp, "sample.jsonl")
        _p47_gen_proc = _p47_run(["node", "--experimental-transform-types", _p47_gen,
                                  "--out=" + _p47_sample, "--force"])
        if _p47_gen_proc.returncode != 0:
            _p47_bad.append("Node 生成 20 行样本失败：%s" % _p47_detail(_p47_gen_proc))
        else:
            # ① 双语言一致
            _p47_py_ok = _p47_run([sys.executable, _p47_py, _p47_sample])
            if _p47_py_ok.returncode != 0:
                _p47_bad.append("Python 验链未通过（序列化规格漂移？）：%s" % _p47_detail(_p47_py_ok))
            _p47_js_ok = _p47_run(["node", "--experimental-transform-types", _p47_js,
                                   "--file=" + _p47_sample])
            if _p47_js_ok.returncode != 0:
                _p47_bad.append("Node 验链未通过：%s" % _p47_detail(_p47_js_ok))

            with open(_p47_sample, encoding="utf-8") as _f:
                _p47_lines = [l for l in _f.read().splitlines() if l.strip()]

            # ② 内容篡改必须检出
            _p47_tampered = os.path.join(_p47_tmp, "tampered.jsonl")
            _p47_row = json.loads(_p47_lines[4])
            _p47_row["rationale"] = _p47_row["rationale"] + "（已篡改）"
            _p47_lines[4] = json.dumps(_p47_row, ensure_ascii=False, separators=(",", ":"))
            with open(_p47_tampered, "w", encoding="utf-8") as _f:
                _f.write("\n".join(_p47_lines) + "\n")
            _p47_tp = _p47_run([sys.executable, _p47_py, _p47_tampered])
            _p47_tj = _p47_run(["node", "--experimental-transform-types", _p47_js,
                                "--file=" + _p47_tampered])
            if _p47_tp.returncode == 0:
                _p47_bad.append("Python 未检出内容篡改（链无防护力）")
            if _p47_tj.returncode == 0:
                _p47_bad.append("Node 未检出内容篡改（链无防护力）")

            # ③ 键序破坏必须检出（值不变，只换键序）
            _p47_reordered = os.path.join(_p47_tmp, "reordered.jsonl")
            _p47_row2 = json.loads(_p47_lines[5]) if len(_p47_lines) > 5 else {}
            if _p47_row2:
                _p47_rev = {k: _p47_row2[k] for k in reversed(list(_p47_row2.keys()))}
                _p47_lines2 = list(_p47_lines)
                _p47_lines2[5] = json.dumps(_p47_rev, ensure_ascii=False, separators=(",", ":"))
                with open(_p47_reordered, "w", encoding="utf-8") as _f:
                    _f.write("\n".join(_p47_lines2) + "\n")
                _p47_rp = _p47_run([sys.executable, _p47_py, _p47_reordered])
                _p47_rj = _p47_run(["node", "--experimental-transform-types", _p47_js,
                                    "--file=" + _p47_reordered])
                if _p47_rp.returncode == 0:
                    _p47_bad.append("Python 未检出键序破坏（键序未真正冻结）")
                if _p47_rj.returncode == 0:
                    _p47_bad.append("Node 未检出键序破坏（键序未真正冻结）")

    # ④ 入库台账可被 Python 独立验链
    if not os.path.isfile(_p47_data):
        _p47_bad.append("入库台账缺失：tools/disposition/data/disposition.jsonl")
    else:
        _p47_committed = _p47_run([sys.executable, _p47_py, _p47_data])
        if _p47_committed.returncode != 0:
            _p47_bad.append("入库台账 Python 验链未通过：%s" % _p47_detail(_p47_committed))
except FileNotFoundError:
    _p47_bad.append("未找到 node——本项需 node ≥ 22 生成样本（CI consistency job 已配置 Setup Node）")
except subprocess.TimeoutExpired:
    _p47_bad.append("处置台账验链超时（120s）")
finally:
    shutil.rmtree(_p47_tmp, ignore_errors=True)

check(
    "处置台账链可重算 + 篡改检出（Node 生成 → Python 验链 → 篡改/乱序必 FAIL；处置通道阶段 1 新增）",
    not _p47_bad,
    "; ".join(_p47_bad),
)

# ── 48. spec/10 处置条款 ↔ tools/disposition 实现一致性（v2.67.0 新增）──────
# 教训来源：spec/13 #44 的「下一步」自 v2.61.0 起就写明三件事（事件类型 / 义务条款 /
# 完整性信号），但无人校验文档与实现是否对得上。条款化若没有机器校验，只是文字——
# 文档写了四个动作、实现多一个或少一个，读者无法察觉。
# 本项做四件事：① 13 字段键序 ② 四动作枚举 ③ 三态派生 ④ 中英条款与时限不漂移；
# 并内置三条反向测试，证明校验本身真的会 FAIL。

def _c48_section_tokens(text, heading):
    """取以 heading 开头的小节内、表格第一列的反引号 token（保序去重）。"""
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith(heading):
            start = i
            break
    if start is None:
        return None
    out = []
    for ln in lines[start + 1:]:
        if ln.startswith("#"):
            break
        if not ln.startswith("|"):
            continue
        cell = ln.split("|")[1]
        for tok in re.findall(r"`([^`]+)`", cell):
            if tok not in out:
                out.append(tok)
    return out


def _c48_impl_order(src, name):
    m = re.search(r"export const " + name + r" = \[(.*?)\] as const;", src, re.S)
    if not m:
        return None
    return re.findall(r"'([^']+)'", m.group(1))


def _c48_impl_states(src):
    m = re.search(r"export function stateOf\(.*?\n\}", src, re.S)
    if not m:
        return None
    return sorted(set(re.findall(r"state: '([a-z_]+)'", m.group(0))))


def _c48_deadlines(text):
    tok = _c48_section_tokens(text, "### 10-D4 ") or _c48_section_tokens(text, "### 10-D4 ")
    if tok is None:
        return None
    body = text[text.index("### 10-D4 "):]
    body = body[:body.find("\n### ", 5)] if "\n### " in body[5:] else body
    return re.findall(r"\b(\d+[hd])\b", body)


def _c48_verify(zh, en, impl):
    bad = []
    pairs = [
        ("字段键序", "### 10-D1 ", _c48_impl_order(impl, "FIELD_ORDER")),
        ("动作枚举", "### 10-D2 ", _c48_impl_order(impl, "ACTIONS")),
        ("三态派生", "### 10-D3 ", _c48_impl_states(impl)),
    ]
    for label, heading, impl_vals in pairs:
        zh_tok = _c48_section_tokens(zh, heading)
        en_tok = _c48_section_tokens(en, heading)
        if not zh_tok:
            bad.append(f"{label}：spec/10 中文 {heading.strip()} 未取到条款 token")
            continue
        if not en_tok:
            bad.append(f"{label}：spec/10 英文 {heading.strip()} 未取到条款 token")
            continue
        if impl_vals is None:
            bad.append(f"{label}：无法从 ledger.mts 解析实现常量")
            continue
        if label == "字段键序":
            if zh_tok != impl_vals:
                bad.append(f"字段键序：spec {zh_tok} != 实现 {impl_vals}")
            if en_tok != impl_vals:
                bad.append(f"字段键序：英文 spec {en_tok} != 实现 {impl_vals}")
        else:
            if sorted(zh_tok) != sorted(impl_vals):
                bad.append(f"{label}：spec {sorted(zh_tok)} != 实现 {sorted(impl_vals)}")
            if sorted(en_tok) != sorted(impl_vals):
                bad.append(f"{label}：英文 spec {sorted(en_tok)} != 实现 {sorted(impl_vals)}")
        if zh_tok != en_tok:
            bad.append(f"{label}：中英条款不一致（{len(zh_tok)} vs {len(en_tok)}）")

    zh_dl, en_dl = _c48_deadlines(zh), _c48_deadlines(en)
    if not zh_dl:
        bad.append("时限：中文 10-D4 未取到时限值")
    elif zh_dl != en_dl:
        bad.append(f"时限：中英不一致（{zh_dl} vs {en_dl}）")
    return bad


_c48_zh = read(os.path.join(ROOT, "spec", "10-resource-ledger.md"))
_c48_en = read(os.path.join(ROOT, "spec", "10-resource-ledger.en.md"))
_c48_impl = read(os.path.join(ROOT, "tools", "disposition", "ledger.mts"))
_c48_bad = _c48_verify(_c48_zh, _c48_en, _c48_impl)

# 反向测试：三处扰动必须各自被检出，否则校验形同虚设
_c48_mut = [
    ("改动作名 escalate→escalate_now",
     _c48_verify(_c48_zh.replace("`escalate`", "`escalate_now`"), _c48_en, _c48_impl)),
    ("改字段名 target_seq→target_seq_v2",
     _c48_verify(_c48_zh.replace("`target_seq`", "`target_seq_v2`"), _c48_en, _c48_impl)),
    ("改英文时限 72h→48h",
     _c48_verify(_c48_zh, _c48_en.replace("72h", "48h"), _c48_impl)),
]
for _c48_label, _c48_ret in _c48_mut:
    if not _c48_ret:
        _c48_bad.append(f"反向测试未检出：{_c48_label}（校验失效）")

check(
    "spec/10 处置条款 == tools/disposition 实现（13 字段键序 / 四动作 / 三态 / 中英时限；含 3 条反向测试）",
    not _c48_bad,
    "; ".join(_c48_bad),
)

# ── 49. 义务注册表 ↔ spec/10 条款 ↔ LedgerSignalKind 三方一致（v2.68.0 新增）
# 教训来源：v2.67.0 的 10-D4 表格写了三个实现中**不存在**的信号类别名
# （memory-write-unauthorized / shadow-ratio-deviation / periodic-touch-hit），
# 而实现用的是 memory-write-audited / shadow-deviation / periodic-egress。
# 第 48 项校验了字段键序与动作枚举，却漏了**类别枚举**——同一类漂移在动作上被挡住、
# 在类别上漏了。条款里的类别名在 v2.68.0 之前从未被任何机器读过（见 ERRATA-L2-SPEC D-S1）。
# 本项直接运行 check-obligations.mts --selftest（内含 8 项校验 + 8 条反向测试），
# 不在 Python 里重写一套解析——仓库既有纪律：两套规格并行必然漂移。

_p49_bad = []
_p49_note = ""
_p49_script = os.path.join(ROOT, "tools", "disposition", "check-obligations.mts")
if not os.path.exists(_p49_script):
    _p49_bad.append("缺少 tools/disposition/check-obligations.mts")
else:
    try:
        _p49_proc = subprocess.run(
            ["node", "--experimental-transform-types", _p49_script, "--selftest"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            cwd=ROOT,
        )
        _p49_out = (_p49_proc.stdout or "") + (_p49_proc.stderr or "")
        if _p49_proc.returncode != 0:
            _p49_lines = [
                ln.strip()
                for ln in _p49_out.splitlines()
                if ln.strip().startswith("[FAIL]")
                or ln.strip().startswith("FAIL ")
                or ln.startswith("[基线]")
            ]
            _p49_bad.append(
                "三方一致性未通过："
                + (" | ".join(_p49_lines[:6]) if _p49_lines else _p49_out[-400:].strip())
            )
        else:
            _p49_sum = [ln.strip() for ln in _p49_out.splitlines() if ln.startswith("selftest PASS=")]
            _p49_note = _p49_sum[-1] if _p49_sum else "校验通过"
    except FileNotFoundError:
        _p49_bad.append(
            "未找到 node——本项需 node ≥ 22 运行 check-obligations.mts（CI consistency job 已配置 Setup Node）"
        )
    except subprocess.TimeoutExpired:
        _p49_bad.append("义务一致性校验超时（180s）")

check(
    "义务注册表 ↔ spec/10 条款 ↔ LedgerSignalKind 三方一致（类别集合 / 逐级时限 / 10-D8 状态 / 聚合行为，含 8 条反向测试）",
    not _p49_bad,
    "; ".join(_p49_bad) if _p49_bad else _p49_note,
)

# ── 第 50 项：处置通道集成层（同链）─────────────────────────────
# 校验对象：tools/disposition/framework-bridge.mts 关于「处置与被处置信号同处一条
# AppendOnlyAuditLog」的全部主张。三件事：
#   1. Node 侧 19 项自检 + 6 条反向测试全过（每条反测断言指定检查项命中）；
#   2. 同链投影出的台账能被 **Python** 参照实现 verify_chain.py 验过
#      —— 跨语言复核是本项存在的理由：JavaScript 内部自洽不等于第三方可复算；
#   3. 投影不落仓（临时目录，用完即删）——投影是派生数据，入库即产生第二真相源。
# 与第 49 项分工：49 管取值域（类别/时限），50 管链结构（同链/篡改/投影/迁移/复现）。

_p50_bad = []
_p50_note = ""
_p50_script = os.path.join(ROOT, "tools", "disposition", "check-bridge.mts")
_p50_tmpdir = None
if not os.path.exists(_p50_script):
    _p50_bad.append("缺少 tools/disposition/check-bridge.mts")
else:
    try:
        _p50_node = ["node", "--experimental-transform-types", _p50_script]
        _p50_st = subprocess.run(
            _p50_node + ["--selftest"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            cwd=ROOT,
        )
        _p50_out = (_p50_st.stdout or "") + (_p50_st.stderr or "")
        if _p50_st.returncode != 0:
            _p50_lines = [
                ln.strip()
                for ln in _p50_out.splitlines()
                if ln.strip().startswith("FAIL") or ln.strip().startswith("[FAIL]")
            ]
            _p50_bad.append(
                "集成层自检未通过："
                + (" | ".join(_p50_lines[:6]) if _p50_lines else _p50_out[-400:].strip())
            )
        else:
            _p50_sum = [
                ln.strip() for ln in _p50_out.splitlines() if ln.startswith("selftest PASS=")
            ]
            _p50_note = _p50_sum[-1] if _p50_sum else "自检通过"

            # 跨语言：投影台账 → Python 参照实现验链
            _p50_tmpdir = tempfile.mkdtemp(prefix="aof-bridge-")
            _p50_ledger = os.path.join(_p50_tmpdir, "projected.jsonl")
            _p50_emit = subprocess.run(
                _p50_node + [f"--emit-ledger={_p50_ledger}"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                cwd=ROOT,
            )
            if _p50_emit.returncode != 0 or not os.path.exists(_p50_ledger):
                _p50_bad.append(
                    "投影台账生成失败：" + ((_p50_emit.stdout or "") + (_p50_emit.stderr or ""))[-300:].strip()
                )
            else:
                _p50_py = subprocess.run(
                    [sys.executable, os.path.join(ROOT, "tools", "disposition", "verify_chain.py"), _p50_ledger],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=120,
                    cwd=ROOT,
                )
                if _p50_py.returncode != 0:
                    _p50_py_out = (_p50_py.stdout or "") + (_p50_py.stderr or "")
                    _p50_bad.append(
                        "同链投影未通过 Python 参照实现："
                        + " | ".join(ln.strip() for ln in _p50_py_out.splitlines() if ln.strip())[:400]
                    )
                else:
                    _p50_note += "；投影经 Python verify_chain.py 复核 PASS"
    except FileNotFoundError:
        _p50_bad.append(
            "未找到 node——本项需 node ≥ 22 运行 check-bridge.mts（CI consistency job 已配置 Setup Node）"
        )
    except subprocess.TimeoutExpired:
        _p50_bad.append("集成层自检超时（180s）")
    finally:
        if _p50_tmpdir is not None:
            shutil.rmtree(_p50_tmpdir, ignore_errors=True)

check(
    "处置通道集成层：处置与信号同链（19 项自检 + 6 条反测）+ 投影经 Python 参照实现复核",
    not _p50_bad,
    "; ".join(_p50_bad) if _p50_bad else _p50_note,
)

# ── 第 51 项：处置链外锚（尾部截断 / 同条数换史）────────────────
# 校验对象：tools/disposition/anchor.mts 与 data/anchor.jsonl。三件事：
#   1. Node 侧 14 项自检 + 6 条反向测试（五种判定 + 三类拒收）；
#   2. 「仓库实锚」与两条真实产物一致，且产物先由**各自的**验证器验过
#      —— 锚只说条数与末哈希，链内自洽不由锚回答（分工写死，避免锚越权背书）；
#   3. 锚日志本身成链（prev_anchor_hash）且同链 count 单调不减。
# 本项存在的理由：第 50 项的 B19 只**声明**了「尾部截断不可自证」这条边界，
# 声明不等于解决。外锚是唯一能检出的手段，缺它则所有「链完整」结论都停在
# 「未被截断」这个未验证的前提上。

_p51_bad = []
_p51_note = ""
_p51_script = os.path.join(ROOT, "tools", "disposition", "check-anchor.mts")
_p51_log = os.path.join(ROOT, "tools", "disposition", "data", "anchor.jsonl")
if not os.path.exists(_p51_script):
    _p51_bad.append("缺少 tools/disposition/check-anchor.mts")
elif not os.path.exists(_p51_log):
    _p51_bad.append(
        "缺少 tools/disposition/data/anchor.jsonl——首次启用执行 "
        "`node --experimental-transform-types tools/disposition/check-anchor.mts --reanchor`"
    )
else:
    try:
        _p51_node = ["node", "--experimental-transform-types", _p51_script]
        for _p51_mode in ("--selftest", "--verify-repo"):
            _p51_st = subprocess.run(
                _p51_node + [_p51_mode],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=180,
                cwd=ROOT,
            )
            _p51_out = (_p51_st.stdout or "") + (_p51_st.stderr or "")
            if _p51_st.returncode != 0:
                _p51_lines = [
                    ln.strip()
                    for ln in _p51_out.splitlines()
                    if ln.strip().startswith("FAIL") or ln.strip().startswith("[FAIL]")
                ]
                _p51_bad.append(
                    f"外锚{_p51_mode} 未通过："
                    + (" | ".join(_p51_lines[:6]) if _p51_lines else _p51_out[-400:].strip())
                )
            else:
                _p51_hits = [
                    ln.strip() for ln in _p51_out.splitlines()
                    if ln.startswith("selftest PASS=") or ln.startswith("[PASS] 锚日志")
                ]
                for _h in _p51_hits:
                    _p51_note += (_p51_note and "；") + _h
        _p51_digest = [
            ln.strip() for ln in (_p51_out or "").splitlines()
            if "aof-anchor/v1:" in ln
        ]
        if _p51_bad == [] and _p51_digest:
            _p51_note += "；域外摘要 " + _p51_digest[-1].replace("锚：", "").strip()[:56] + "…"
    except FileNotFoundError:
        _p51_bad.append("未找到 node——本项需 node ≥ 22 运行 check-anchor.mts")
    except subprocess.TimeoutExpired:
        _p51_bad.append("外锚自检超时（180s）")

check(
    "处置链外锚：尾部截断 / 同条数换史可检出（14 项自检 + 6 条反测）+ 仓库实锚与产物一致",
    not _p51_bad,
    "; ".join(_p51_bad) if _p51_bad else (_p51_note or "通过"),
)

# ── 第 52 项：外锚摘要串的**发布**（漏贴 / 贴旧串 / 重锚后未重新发布）──
# 第 51 项证明「有锚且链与锚一致」，但它管不到「这串有没有真的发出去」。
# 发布是唯一能把「锚尾被整体删掉」变成可检出的动作，而漏做它**不留痕迹**：
# 锚日志是对的、链也是对的，只是域外见证不存在。所以必须单独可校验。

_p52_bad = []
_p52_note = ""
_p52_script = os.path.join(ROOT, "scripts", "check_anchor_publish.py")
_p52_rec = os.path.join(ROOT, "tools", "disposition", "data", "published-anchors.jsonl")
if not os.path.exists(_p52_script):
    _p52_bad.append("缺少 scripts/check_anchor_publish.py")
elif not os.path.exists(_p52_rec):
    _p52_bad.append(
        "缺少 tools/disposition/data/published-anchors.jsonl——用 "
        "`node --experimental-transform-types tools/disposition/check-anchor.mts --publish-lines` "
        "生成待追加行"
    )
else:
    try:
        _p52_st = subprocess.run(
            [sys.executable, _p52_script, "--selftest"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            cwd=ROOT,
        )
        _p52_out = (_p52_st.stdout or "") + (_p52_st.stderr or "")
        if _p52_st.returncode != 0:
            _p52_lines = [
                ln.strip()
                for ln in _p52_out.splitlines()
                if ln.strip().startswith("FAIL") or ln.strip().startswith("[FAIL]")
            ]
            _p52_bad.append(
                "发布校验未通过："
                + (" | ".join(_p52_lines[:6]) if _p52_lines else _p52_out[-400:].strip())
            )
        else:
            _p52_hits = [ln.strip() for ln in _p52_out.splitlines() if ln.startswith("selftest PASS=")]
            _p52_note = "；".join(_p52_hits) or "通过"
    except subprocess.TimeoutExpired:
        _p52_bad.append("发布校验超时（180s）")

check(
    "外锚摘要串的发布：覆盖 / 可溯 / 仓内声明 + 8 条反测（漏贴与贴旧串必须被检出）",
    not _p52_bad,
    "; ".join(_p52_bad) if _p52_bad else _p52_note,
)

# ── 第 53 项：发版脚本把预检当必经代码路径（不是「发版前记得跑」）──
# 第 52 项证明「发布可校验」，但校验仍是发版流程里靠人记得的一步。
# 预检与 POST 若不在同一个函数里，就永远存在「跑的是 A、发的是 B」的缝。

_p53_bad = []
_p53_note = ""
_p53_script = os.path.join(ROOT, "scripts", "create_release.py")
if not os.path.exists(_p53_script):
    _p53_bad.append("缺少 scripts/create_release.py——发版预检回到「靠人先跑」")
else:
    try:
        _p53_src = open(_p53_script, encoding="utf-8").read()
    except OSError as e:
        _p53_src = ""
        _p53_bad.append(f"读不了 scripts/create_release.py：{e}")

    # 结构断言：预检的两项能力必须在（消费已有实现，不重写规则），且不得留跳过开关
    if _p53_src:
        if "check_anchor_publish.py" not in _p53_src:
            _p53_bad.append("脚本未消费 check_anchor_publish.py——预检可能已被摘掉")
        if "ls-remote" not in _p53_src:
            _p53_bad.append(
                "脚本未校验 tag 是否已推 origin——GitHub 会把缺失的 tag 建在默认分支 HEAD 上"
            )
        # 只查「是否被读取」，不查「是否被提到」——脚本注释里本来就写着「没有 --force」，
        # 按字面 grep 会把说明文字当成开关（此处第一版就踩了，断言比注释更早撞车）。
        if '"--force"' in _p53_src or "'--force'" in _p53_src or 'arg("force")' in _p53_src:
            _p53_bad.append("脚本读取了 force 开关：能跳过预检就等于没有预检")

    try:
        _p53_st = subprocess.run(
            [sys.executable, _p53_script, "--selftest"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            cwd=ROOT,
        )
        _p53_out = (_p53_st.stdout or "") + (_p53_st.stderr or "")
        if _p53_st.returncode != 0:
            _p53_lines = [
                ln.strip()
                for ln in _p53_out.splitlines()
                if ln.strip().startswith("[FAIL]") or ln.strip().startswith("FAIL")
            ]
            _p53_bad.append(
                "发版脚本自检未通过："
                + (" | ".join(_p53_lines[:6]) if _p53_lines else _p53_out[-400:].strip())
            )
        else:
            _p53_hits = [ln.strip() for ln in _p53_out.splitlines() if ln.startswith("selftest PASS=")]
            _p53_note = "；".join(_p53_hits) or "通过"
    except subprocess.TimeoutExpired:
        _p53_bad.append("发版脚本自检超时（300s）")

check(
    "发版脚本：预检挡在创建之前（7 条自检）+ 可跳过开关不得存在",
    not _p53_bad,
    "; ".join(_p53_bad) if _p53_bad else _p53_note,
)

# ── 汇总 ─────────────────────────────────────
print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过（共 {len(FAILS)} 项 FAIL）：")
    for f in FAILS:
        print(f"   - {f}")
    sys.exit(1)
print("✅ 全部校验通过 — 可提交")
