#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_release_invariant.py —— Release 承诺的机器校验（v2.61.1 新增）

背景教训：v2.52.11 曾承诺「自本版起每版发布时建 GitHub Release」，实际执行一版
即停，v2.52.13–v2.61.0 共 30 个 tag 无 Release——承诺靠纪律维护必然漂移。
外部审查（豆包，2026-11-04）实测指出根因：门禁 46 项覆盖仓内一致性，不覆盖
仓外动作。本脚本把承诺变成可校验不变量：

    最新 minor tag（X.Y.0）必须存在于 GitHub Releases 列表中

⚠️ 设计修正记录（实测教育）：初版用 /releases/latest 做「最新 Release」判定——
错。该端点语义是「最近创建的 Release」而非「最新版本」：补发历史 tag 的 Release
（如 v2.52.27）创建时间晚于现行 minor 的 Release，会让守卫误报。政策真正要的是
成员关系（该 minor 有没有 Release），不是时间序——改为全量 Releases 集合成员判定。

政策：minor 必发 / patch 可选 / v2.61.0 前历史不追 —— 见 CONTRIBUTING「版本管理政策」。
运行：CI 每日定时（release-guard.yml）或手动 `python scripts/check_release_invariant.py`；
     也可在 GitHub Actions 页面手动触发 release-guard workflow。

设计约束：
  - 纯标准库（urllib），零第三方依赖，与全仓零依赖纪律一致；
  - 匿名 API（公共仓库，限额内够用：tags 两页 + releases 两页）；
  - 成员关系判定对补发历史 Release 完全免疫（创建顺序不参与语义）。

测试钩子（仅测试用）：环境变量 GUARD_TEST_MINOR=vX.Y.0 可覆盖期望的 minor tag，
用于对 FAIL 路径做端到端反向测试（不改真实 API 数据）。
"""
import json
import os
import re
import sys
import urllib.request

OWNER, REPO = "ZhangRui987", "agent-oversight-framework"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"


def get_json(url: str):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "release-guard", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def semver(tag: str):
    m = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def _paged(path: str):
    """分页收集（releases/tags 均按 per_page=100 翻页）。"""
    items, page = [], 1
    while True:
        batch = get_json(f"{API}{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
        if not batch:
            break
        items.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return items


def latest_minor_tag():
    tags = _paged("/tags")
    minors = sorted(
        (v for v in (semver(t["name"]) for t in tags) if v and v[2] == 0),
        reverse=True,
    )
    return f"v{minors[0][0]}.{minors[0][1]}.{minors[0][2]}" if minors else None


def release_tags():
    return {r["tag_name"] for r in _paged("/releases")}


def main() -> None:
    latest_minor = latest_minor_tag()
    if latest_minor is None:
        print("不变量空真：仓库无 semver minor tag")
        return

    # 测试钩子：仅用于对 FAIL 路径做端到端反向测试
    injected = os.environ.get("GUARD_TEST_MINOR")
    if injected:
        print(f"[测试钩子] 期望 minor tag 被覆盖为 {injected}")
        expected = injected
    else:
        expected = latest_minor

    releases = release_tags()
    has = expected in releases
    print(f"最新 minor tag   : {expected}")
    print(f"Releases 总数    : {len(releases)}（成员判定，与创建顺序无关）")
    if has:
        print("不变量           : PASS — 最新 minor tag 已有 Release（minor 必发政策满足）")
        return
    print(
        "不变量           : FAIL — 最新 minor tag 无对应 Release\n"
        f"                   修复：按 CONTRIBUTING「Release 节奏」为 {expected} 建 Release\n"
        "                   （工具链：.workbuddy/create_release_v*.py 或 GitHub 页面 Draft new release）"
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
