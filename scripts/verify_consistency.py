# -*- coding: utf-8 -*-
"""发布一致性校验（推送前 / pre-commit 用）。

校验项：
  1. 全仓库无 [TABLE START/END] 伪标记
  2. 所有 Markdown 表格（≥2 行的 | 块）表头后都有分隔行
  3. 证据分级数量一致：REFERENCES 表格实测 A/B/C/D 条数 == 各处声明（54 总 / 44 B）
  4. 事故数字口径一致（1,200 留言板 / 700 参与攻击）
  5. ANTITRUST 章节号（第十二章，非第十三章）
  6. STYLE 术语口径（允许 P0 优先级、禁 P0-x 审阅编号）
  7. spec/ 无 14-references.md（唯一真相源 = 根 REFERENCES.md）
  8. 引用红线：禁止引用的数字（如 GAIE 的「84–97%」）不得出现在正文

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

# ── 2. 表格分隔行 ────────────────────────────
SEP_RE = re.compile(r"^\s*\|?[\s:\-|]+\|?\s*$")
bad_tables = []
for fp in md_files():
    lines = read(fp).splitlines()
    i = 0
    while i < len(lines):
        if lines[i].lstrip().startswith("|") and "|" in lines[i]:
            # 块开始：连续 | 行
            j = i
            while j + 1 < len(lines) and lines[j + 1].lstrip().startswith("|"):
                j += 1
            n_rows = j - i + 1
            if n_rows >= 2 and not SEP_RE.match(lines[i + 1]):
                bad_tables.append(f"{os.path.relpath(fp, ROOT)} L{i+1}: 表头后缺分隔行")
            i = j + 1
        else:
            i += 1
check("所有表格表头后都有 |---| 分隔行", not bad_tables, "; ".join(bad_tables[:5]))

# ── 3. 证据分级数量 ──────────────────────────
refs = read(os.path.join(ROOT, "REFERENCES.md"))
# 数表格行：A | B | C（ C（ D（
a = len(re.findall(r"^A \|", refs, re.M))
b = len(re.findall(r"^B \|", refs, re.M))
c = len(re.findall(r"^C（", refs, re.M))
d = len(re.findall(r"^D（", refs, re.M))
check("REFERENCES 实测 A:1", a == 1, f"实测 A={a}")
check("REFERENCES 实测 B:44", b == 44, f"实测 B={b}")
check("REFERENCES 实测 C:8", c == 8, f"实测 C={c}")
check("REFERENCES 实测 D:1", d == 1, f"实测 D={d}")
total = a + b + c + d
check("REFERENCES 合计 54 条", total == 54, f"实测合计={total}")

readme = read(os.path.join(ROOT, "README.md"))
chg = read(os.path.join(ROOT, "CHANGELOG.md"))
check("README 声明「54 条来源，其中 B 级 44 条」",
      "54 条来源，其中 B 级 44 条" in readme)
check("README 分布「A:1 / B:44 / C:8 / D:1」（含 A 级来源标注）",
      "A:1" in readme and "B:44 / C:8 / D:1" in readme)
check("CHANGELOG 声明「54 条参考文献（其中 B 级 44 条）」",
      "54 条参考文献（其中 B 级 44 条）" in chg)
check("REFERENCES 注脚「44 条 B 级、8 条 C 级、1 条 D 级（合计 54 条来源）」",
      "44 条 B 级、8 条 C 级、1 条 D 级（合计 54 条来源）" in refs)

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

# ── 汇总 ─────────────────────────────────────
print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过（共 {len(FAILS)} 项 FAIL）：")
    for f in FAILS:
        print(f"   - {f}")
    sys.exit(1)
print("✅ 全部校验通过 — 可提交")
