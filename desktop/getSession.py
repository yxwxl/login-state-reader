"""
浏览器登录态桥接 SDK。

这个模块负责在桌面端启动一个临时 WebSocket 服务，等待浏览器插件连接，
然后向插件发送一次读取请求，最后返回 Cookie、Cookie Header 或
Playwright storage_state。

使用前请确保：
1. 已安装依赖：pip install -r requirements.txt
2. 已在 Chrome/Edge 中加载 extension/ 插件目录
3. 修改插件代码后，已在扩展管理页重新加载插件
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Literal, NamedTuple

import websockets


HOST = "127.0.0.1"
PORT = 17891
DEFAULT_TIMEOUT_MS = 12000
DEFAULT_SERVER_TIMEOUT = 60
DEFAULT_BROWSER_LAUNCH_DELAY = 3

SessionMode = Literal["cookies", "header", "playwright", "all"]
CloseTabPolicy = Literal["never", "created", "always"]


class BrowserLaunchResult(NamedTuple):
    """记录本次是否由脚本启动了浏览器。"""

    process: subprocess.Popen[Any] | None
    launched_by_us: bool


class SessionBridgeError(RuntimeError):
    """插件桥接层无法返回有效结果时抛出。"""


async def _send_request(ws: Any, request: dict[str, Any], timeout: float) -> dict[str, Any]:
    """向插件发送请求，并等待同 id 的响应。"""

    await ws.send(json.dumps(request, ensure_ascii=False))

    while True:
        raw_message = await asyncio.wait_for(ws.recv(), timeout=timeout)
        message = json.loads(raw_message)

        # 插件连接成功后会先发送 extension_ready，这不是业务响应。
        if message.get("type") == "extension_ready":
            continue

        if message.get("id") == request["id"]:
            return message


async def _request_session_async(
    url: str,
    mode: SessionMode,
    *,
    activate: bool,
    timeout_ms: int,
    server_timeout: float,
    close_tab_after: CloseTabPolicy | bool,
    auto_launch_browser: bool,
    browser_launch_delay: float,
    browser_path: str | None,
    close_browser_if_launched: bool,
    reuse_existing_tab: bool,
    host: str,
    port: int,
) -> dict[str, Any]:
    if mode not in {"cookies", "header", "playwright", "all"}:
        raise ValueError("mode must be one of: cookies, header, playwright, all")

    if not url.startswith(("http://", "https://")):
        raise ValueError("url must start with http:// or https://")

    done = asyncio.Event()
    result: dict[str, Any] | None = None
    error: BaseException | None = None
    launched_browser: BrowserLaunchResult | None = None

    request = {
        "id": f"session-{uuid.uuid4().hex}",
        "action": "get_login_state",
        "url": url,
        "mode": mode,
        "activate": activate,
        "timeoutMs": timeout_ms,
        "closeTabAfter": close_tab_after,
        "reuseExistingTab": reuse_existing_tab,
    }

    async def handle_client(ws: Any, _path: str | None = None) -> None:
        nonlocal result, error
        try:
            response = await _send_request(ws, request, timeout=server_timeout)
            if not response.get("ok"):
                raise SessionBridgeError(response.get("error") or "Extension returned an error.")
            result = response.get("payload") or {}
        except BaseException as exc:  # noqa: BLE001 - 保留桥接失败上下文。
            error = exc
        finally:
            done.set()

    async def launch_browser_if_needed() -> None:
        nonlocal launched_browser
        if not auto_launch_browser:
            return
        await asyncio.sleep(browser_launch_delay)
        if done.is_set():
            return
        launched_browser = _launch_browser(browser_path)

    server = await websockets.serve(handle_client, host, port)
    launch_task = asyncio.create_task(launch_browser_if_needed())

    try:
        await asyncio.wait_for(done.wait(), timeout=server_timeout)
    except asyncio.TimeoutError as exc:
        raise TimeoutError(
            "等待浏览器插件连接超时。请确认浏览器已加载 extension/ 插件目录，"
            "并在修改插件后重新加载扩展。"
        ) from exc
    finally:
        launch_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await launch_task

        server.close()
        with contextlib.suppress(Exception):
            await server.wait_closed()

        if close_browser_if_launched and launched_browser and launched_browser.launched_by_us:
            _close_launched_browser(launched_browser.process)

    if error:
        raise error
    if result is None:
        raise SessionBridgeError("插件没有返回登录态 payload。")

    return result


def _launch_browser(browser_path: str | None = None) -> BrowserLaunchResult:
    """
    自动启动 Chrome/Edge。

    这里故意不传目标 URL，避免启动浏览器时打开一次页面、插件收到请求后
    又打开一次页面。目标页面统一由插件打开。
    """

    executable = browser_path or _find_browser_executable()
    if not executable:
        raise SessionBridgeError("找不到 Chrome 或 Edge 可执行文件。")

    process = subprocess.Popen(
        [executable],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    return BrowserLaunchResult(process=process, launched_by_us=True)


def _close_launched_browser(process: subprocess.Popen[Any] | None) -> None:
    """尝试关闭本次脚本启动的浏览器进程。"""

    if process is None or process.poll() is not None:
        return

    with contextlib.suppress(Exception):
        process.terminate()
        process.wait(timeout=5)

    if process.poll() is None:
        with contextlib.suppress(Exception):
            process.kill()


def _find_browser_executable() -> str | None:
    """按 Windows 常见安装位置查找 Chrome/Edge。"""

    candidates = [
        shutil.which("chrome"),
        shutil.which("chrome.exe"),
        shutil.which("msedge"),
        shutil.which("msedge.exe"),
        str(Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe"),
        str(Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"),
        str(Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft/Edge/Application/msedge.exe"),
        str(Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft/Edge/Application/msedge.exe"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Edge/Application/msedge.exe"),
    ]

    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def get_session(
    url: str,
    mode: SessionMode = "playwright",
    *,
    activate: bool = True,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    server_timeout: float = DEFAULT_SERVER_TIMEOUT,
    close_tab_after: CloseTabPolicy | bool = "created",
    auto_launch_browser: bool = True,
    browser_launch_delay: float = DEFAULT_BROWSER_LAUNCH_DELAY,
    browser_path: str | None = None,
    close_browser_if_launched: bool = True,
    reuse_existing_tab: bool = False,
    host: str = HOST,
    port: int = PORT,
) -> Any:
    """
    通过浏览器插件获取目标页面登录态。

    Args:
        url: 目标 URL，例如 B站、腾讯视频、小红书网页地址。
        mode: 返回类型，支持 cookies、header、playwright、all。
        activate: 是否聚焦目标标签页。
        timeout_ms: 插件等待页面加载的最长时间，单位毫秒。
        server_timeout: 桌面端等待插件连接和响应的最长时间，单位秒。
        close_tab_after: 读取完成后的关页策略，默认关闭插件新建的目标页。
        auto_launch_browser: 如果浏览器未打开，是否自动启动 Chrome/Edge。
        browser_launch_delay: 等待插件主动连接多久后再启动浏览器。
        browser_path: 手动指定 Chrome/Edge 路径。
        close_browser_if_launched: 如果本次启动了浏览器，结束后是否尝试关闭。
        reuse_existing_tab: 是否复用已存在的同 URL 标签页。
        host: WebSocket 监听地址。
        port: WebSocket 监听端口。
    """

    print(f"等待浏览器插件连接 ws://{host}:{port} ...")
    payload = asyncio.run(
        _request_session_async(
            url,
            mode,
            activate=activate,
            timeout_ms=timeout_ms,
            server_timeout=server_timeout,
            close_tab_after=close_tab_after,
            auto_launch_browser=auto_launch_browser,
            browser_launch_delay=browser_launch_delay,
            browser_path=browser_path,
            close_browser_if_launched=close_browser_if_launched,
            reuse_existing_tab=reuse_existing_tab,
            host=host,
            port=port,
        )
    )

    if mode == "cookies":
        return payload.get("cookies", [])
    if mode == "header":
        return payload.get("header", "")
    if mode == "playwright":
        return payload.get("playwright", {"cookies": [], "origins": []})
    return payload


def get_cookie_json(url: str, **kwargs: Any) -> list[dict[str, Any]]:
    """获取目标 URL 对应的 Cookie JSON。"""

    return get_session(url, "cookies", **kwargs)


def get_cookie_header(url: str, **kwargs: Any) -> str:
    """获取目标 URL 对应的 Cookie Header 字符串。"""

    return get_session(url, "header", **kwargs)


def get_playwright_storage_state(url: str, **kwargs: Any) -> dict[str, Any]:
    """获取 Playwright 可直接使用的 storage_state 字典。"""

    return get_session(url, "playwright", **kwargs)
