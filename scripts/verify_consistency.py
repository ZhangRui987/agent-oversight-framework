# -*- coding: utf-8 -*-
"""发布一致性校验（推送前 / pre-commit 用）。

校验项（共 30 项，按运行顺序）：
  1. 全仓库无 [TABLE START/END] 伪标记
  2. 所有 Markdown 表格表头后都有 |---| 分隔行
  3. 表格每行列数与分隔行一致
     —— 两种表头风格都覆盖：带首竖线（| 表头 | ... |）与不带首竖线（表头 | ...）
        （后者曾长期未被校验，导致 11-traceability 出现「6 列 vs 表头 5 列」而漏检）
  4. REFERENCES 实测 A:1
  5. REFERENCES 实测 B:56
  6. REFERENCES 实测 C:9
  7. REFERENCES 实测 D:1
  8. REFERENCES 合计 67 条
  9. README 声明「67 条来源，其中 B 级 56 条」
 10. README 分布「A:1 / B:56 / C:9 / D:1」（含 A 级来源标注）
 11. CHANGELOG 声明「54 条参考文献（其中 B 级 44 条）」
 12. REFERENCES 注脚「56 条 B 级、9 条 C 级、1 条 D 级（合计 67 条来源）」
 13. README 双语全文「证据总数」一致（所有出现的总数 == 67）
 14. README 双语全文「B 级数」一致（所有出现的 B 级数 == 56）
 15. README 事故数字（1,200 留言板）
 16. README 事故数字（700 参与攻击）
 17. REFERENCES 一手材料（1,200 留言板 / 700 攻击）
 18. ANTITRUST 指第十二章
 19. STYLE 禁 P0-x 审阅编号
 20. STYLE 允许 P0 优先级标记
 21. spec/ 无 14-references.md（唯一真相源 = 根 REFERENCES.md）
 22. 引用红线：正文无禁止引用的数字（GAIE 84–97%）
 23. 13-boundaries 实测未解问题条数 = 28
 24. README 声明「28 条未解问题」
 25. README.en 声明「28 open problems」
 26. REFERENCES 无悬空引用：条目的登记键须在 spec/ 正文出现；
     若确系有意登记而未回灌，须在落点列显式标注【登记备用】
     —— 备用清单逐条打印公示，无法静默堆积
 27. 反向悬空：spec/ 正文引用的每个 arXiv 号，均须在 REFERENCES 有条目登记
     —— 与第 26 项对称，双向都查才闭合
 28. 无 arXiv 号的条目均已在文献列声明【键: XXX】
     —— 让第 26 项的覆盖从「有号条目」扩展到全部条目
 29. 引用键全局唯一（不同条目不得共用同一键）
 30. 引用键非通用词（不在黑名单且长度 ≥ 4）

用法：
  python scripts/verify_consistency.py [仓库根目录，默认脚本所在目录的上级]

退出码 0 = 全部通过；非 0 = 存在未通过项（pre-commit 将拦截提交）。
"""
import os
import re
import sys

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
GRADE_RE = re.compile(r"^(A|B|C|D)(（[^）]*）)?\s*\|", re.M)
grades = GRADE_RE.findall(refs)
a = sum(1 for g, _ in grades if g == "A")
b = sum(1 for g, _ in grades if g == "B")
c = sum(1 for g, _ in grades if g == "C")
d = sum(1 for g, _ in grades if g == "D")
check("REFERENCES 实测 A:1", a == 1, f"实测 A={a}")
check("REFERENCES 实测 B:56", b == 56, f"实测 B={b}")
check("REFERENCES 实测 C:9", c == 9, f"实测 C={c}")
check("REFERENCES 实测 D:1", d == 1, f"实测 D={d}")
total = a + b + c + d
check("REFERENCES 合计 67 条", total == 67, f"实测合计={total}")

readme = read(os.path.join(ROOT, "README.md"))
chg = read(os.path.join(ROOT, "CHANGELOG.md"))
check("README 声明「67 条来源，其中 B 级 56 条」",
      "67 条来源，其中 B 级 56 条" in readme)
check("README 分布「A:1 / B:56 / C:9 / D:1」（含 A 级来源标注）",
      "A:1" in readme and "B:56 / C:9 / D:1" in readme)
check("CHANGELOG 声明「54 条参考文献（其中 B 级 44 条）」",
      "54 条参考文献（其中 B 级 44 条）" in chg)
check("REFERENCES 注脚「56 条 B 级、9 条 C 级、1 条 D 级（合计 67 条来源）」",
      "56 条 B 级、9 条 C 级、1 条 D 级（合计 67 条来源）" in refs)

# ── 3b. README 全文证据计数一致性 ─────────────
# 教训：v2.1.0 之前门禁只锁了 README 顶部声明与 REFERENCES 注脚两个固定字符串，
# 仓库结构表（README.md L139）漏写旧值「55 条分级证据」、英文版「可核查文献」段
# 写成「46 are grade B」都没被覆盖——同文件内部自相矛盾却照常提交。
# 本项扫描 README 双语全文出现的「N 条…证据 / N sources / N graded… / grade B」，
# 所有出现的总数与 B 级数都必须与门禁实测一致。
readme_en = read(os.path.join(ROOT, "README.en.md"))

# 总数声明：中文「N 条…分级证据」「N 条来源」、英文「N sources」「N graded evidence sources」
TOTAL_RE_ZH = re.compile(r"(\d{2})\s*条(?:[^\n]{0,6})?(?:分级)?证据")
TOTAL_RE_ZH2 = re.compile(r"(\d{2})\s*条来源")
TOTAL_RE_EN = re.compile(r"(\d{2})\s+(?:sources|graded(?:\s+evidence)?(?:\s+sources)?)", re.I)

# B 级数声明：中文「B 级 N 条」「其中 B 级 N 条」、英文「N are grade B」「grade-B: N」「B:N」
B_RE_ZH = re.compile(r"B\s*级\s*(\d{2})\s*条")
B_RE_EN1 = re.compile(r"(\d{2})\s+are\s+grade\s+B", re.I)
B_RE_EN2 = re.compile(r"B\s*[:：]\s*(\d{2})")
B_RE_ZH_DIST = re.compile(r"B\s*[:：]\s*(\d{2})")

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

# ── 汇总 ─────────────────────────────────────
print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过（共 {len(FAILS)} 项 FAIL）：")
    for f in FAILS:
        print(f"   - {f}")
    sys.exit(1)
print("✅ 全部校验通过 — 可提交")
