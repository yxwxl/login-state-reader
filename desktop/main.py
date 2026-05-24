#!/usr/bin/env python3
"""
桌面端调用示例。

默认只保留一个可直接运行的简单示例。其他常用平台示例已写在注释中，
需要时取消注释即可。

运行：
    pip install -r requirements.txt
    python -B desktop/main.py
"""

from __future__ import annotations

import json

from getSession import get_cookie_header, get_cookie_json, get_playwright_storage_state, get_session


def main() -> None:
    # 简单例子：获取 B站 Cookie JSON。
    # 如果浏览器没打开，脚本会自动启动浏览器；插件读取完成后会关闭本次新建的标签页。
    cookies = get_cookie_json("https://www.bilibili.com/")
    print(json.dumps(cookies, ensure_ascii=False, indent=2))

    # 示例 1：获取 B站 Cookie Header，适合直接放到 requests 请求头中。
    # header = get_cookie_header("https://www.bilibili.com/")
    # print(header)

    # 示例 2：获取腾讯视频 Playwright 登录态。
    # 可用于 browser.new_context(storage_state=state)。
    # state = get_playwright_storage_state("https://v.qq.com/")
    # print(json.dumps(state, ensure_ascii=False, indent=2))

    # 示例 3：获取小红书登录态。
    # 小红书这类平台更依赖真实浏览器环境，建议先在浏览器中确认已登录。
    # state = get_playwright_storage_state("https://www.xiaohongshu.com/")
    # print(json.dumps(state, ensure_ascii=False, indent=2))

    # 示例 4：一次性获取全部内容，包括 cookies、header、playwright。
    # payload = get_session("https://v.qq.com/", "all")
    # print(json.dumps(payload, ensure_ascii=False, indent=2))

    # 示例 5：如果你不希望读取后关闭插件新建的目标标签页，可以这样写。
    # payload = get_session("https://www.bilibili.com/", "all", close_tab_after="never")
    # print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
