# -*- coding: utf-8 -*-
"""发布一致性校验（推送前 / pre-commit 用）。

校验项：
  1. 全仓库无 [TABLE START/END] 伪标记
  2. 所有 Markdown 表格（≥2 行的 | 块）表头后都有分隔行；且每行列数与分隔行一致
     —— 两种表头风格都覆盖：带首竖线（| 表头 | ... |）与不带首竖线（表头 | ...）
        （后者曾长期未被校验，导致 11-traceability 出现「6 列 vs 表头 5 列」而漏检）
  3. 证据分级数量一致：REFERENCES 表格实测 A/B/C/D 条数 == 各处声明（55 总 / 45 B）
  4. 事故数字口径一致（1,200 留言板 / 700 参与攻击）
  5. ANTITRUST 章节号（第十二章，非第十三章）
  6. STYLE 术语口径（允许 P0 优先级、禁 P0-x 审阅编号）
  7. spec/ 无 14-references.md（唯一真相源 = 根 REFERENCES.md）
  8. 引用红线：禁止引用的数字（如 GAIE 的「84–97%」）不得出现在正文
  9. 未解问题条数一致：13-boundaries 实测条数 == README / README.en 各处声明

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
check("REFERENCES 实测 B:45", b == 45, f"实测 B={b}")
check("REFERENCES 实测 C:8", c == 8, f"实测 C={c}")
check("REFERENCES 实测 D:1", d == 1, f"实测 D={d}")
total = a + b + c + d
check("REFERENCES 合计 55 条", total == 55, f"实测合计={total}")

readme = read(os.path.join(ROOT, "README.md"))
chg = read(os.path.join(ROOT, "CHANGELOG.md"))
check("README 声明「55 条来源，其中 B 级 45 条」",
      "55 条来源，其中 B 级 45 条" in readme)
check("README 分布「A:1 / B:45 / C:8 / D:1」（含 A 级来源标注）",
      "A:1" in readme and "B:45 / C:8 / D:1" in readme)
check("CHANGELOG 声明「54 条参考文献（其中 B 级 44 条）」",
      "54 条参考文献（其中 B 级 44 条）" in chg)
check("REFERENCES 注脚「45 条 B 级、8 条 C 级、1 条 D 级（合计 55 条来源）」",
      "45 条 B 级、8 条 C 级、1 条 D 级（合计 55 条来源）" in refs)

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

# ── 汇总 ─────────────────────────────────────
print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过（共 {len(FAILS)} 项 FAIL）：")
    for f in FAILS:
        print(f"   - {f}")
    sys.exit(1)
print("✅ 全部校验通过 — 可提交")
