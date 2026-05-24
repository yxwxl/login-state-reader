const pageUrlEl = document.getElementById("pageUrl");
const statusEl = document.getElementById("status");
const cookieListEl = document.getElementById("cookieList");
const refreshBtn = document.getElementById("refreshBtn");
const modeSwitchEl = document.querySelector(".mode-switch");
const modeButtons = [...document.querySelectorAll(".mode-btn")];
const cookiePanelEl = document.getElementById("cookiePanel");
const playwrightPanelEl = document.getElementById("playwrightPanel");
const cookieCountEl = document.getElementById("cookieCount");
const storageCountEl = document.getElementById("storageCount");
const originCountEl = document.getElementById("originCount");
const copyCookieJsonBtn = document.getElementById("copyCookieJsonBtn");
const copyHeaderBtn = document.getElementById("copyHeaderBtn");
const copyPlaywrightBtn = document.getElementById("copyPlaywrightBtn");
const playwrightPreviewEl = document.getElementById("playwrightPreview");

let currentCookies = [];
let currentTabUrl = "";
let currentStorageFrames = [];
let activeMode = "cookies";

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setButtonsEnabled(enabled) {
  copyCookieJsonBtn.disabled = !enabled;
  copyHeaderBtn.disabled = !enabled;
  copyPlaywrightBtn.disabled = !enabled;
}

function formatExpiry(expirationDate) {
  if (!expirationDate) {
    return "Session";
  }
  return new Date(expirationDate * 1000).toLocaleString();
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}

function renderCookies(cookies) {
  cookieListEl.innerHTML = "";

  if (!cookies.length) {
    cookieListEl.innerHTML = '<div class="empty">当前页面没有可读取的 Cookie。</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const cookie of cookies) {
    const item = document.createElement("article");
    item.className = "cookie-item";
    item.innerHTML = `
      <h2 class="cookie-name">${escapeText(cookie.name)}</h2>
      <pre class="cookie-value">${escapeText(cookie.value)}</pre>
      <div class="cookie-meta">
        <span>域名：${escapeText(cookie.domain)}</span>
        <span>路径：${escapeText(cookie.path)}</span>
        <span>Secure：${cookie.secure ? "是" : "否"}</span>
        <span>HttpOnly：${cookie.httpOnly ? "是" : "否"}</span>
        <span>SameSite：${escapeText(cookie.sameSite || "未设置")}</span>
        <span>过期：${escapeText(formatExpiry(cookie.expirationDate))}</span>
      </div>
    `;
    fragment.appendChild(item);
  }

  cookieListEl.appendChild(fragment);
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function getRegistrableCookieDomain(url) {
  const hostname = new URL(url).hostname;
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return hostname;
  }
  return parts.slice(-2).join(".");
}

function uniqueCookies(cookies) {
  const seen = new Map();
  for (const cookie of cookies) {
    const key = [cookie.name, cookie.domain, cookie.path, cookie.storeId || ""].join("\n");
    seen.set(key, cookie);
  }
  return [...seen.values()].sort((a, b) => {
    const byDomain = a.domain.localeCompare(b.domain);
    return byDomain || a.name.localeCompare(b.name);
  });
}

async function getCookiesForPage(url) {
  const byUrl = await chrome.cookies.getAll({ url });
  const domain = getRegistrableCookieDomain(url);
  const byDomain = await chrome.cookies.getAll({ domain });
  return uniqueCookies([...byUrl, ...byDomain]);
}

function readStorageSnapshot() {
  function storageToPairs(storage) {
    const pairs = [];
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      pairs.push({ name, value: storage.getItem(name) });
    }
    pairs.sort((a, b) => a.name.localeCompare(b.name));
    return pairs;
  }

  const snapshot = {
    href: location.href,
    origin: location.origin,
    title: document.title,
    userAgent: navigator.userAgent,
    localStorage: [],
    ok: true,
    error: ""
  };

  try {
    snapshot.localStorage = storageToPairs(localStorage);
  } catch (error) {
    snapshot.ok = false;
    snapshot.error = `localStorage: ${error.message}`;
  }

  return snapshot;
}

async function getStorageFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: readStorageSnapshot
    });
    return results.map((result) => result.result).filter(Boolean);
  } catch (error) {
    setStatus(`Cookie 已读取，但页面存储读取失败：${error.message}`, true);
    return [];
  }
}

async function loadState() {
  setButtonsEnabled(false);
  setStatus("正在读取当前页面登录态...");
  cookieListEl.innerHTML = "";
  playwrightPreviewEl.textContent = "";

  try {
    const tab = await getCurrentTab();
    if (!tab?.url) {
      throw new Error("无法获取当前标签页 URL。");
    }

    if (!/^https?:\/\//i.test(tab.url)) {
      currentCookies = [];
      currentStorageFrames = [];
      currentTabUrl = tab.url;
      pageUrlEl.textContent = tab.url;
      renderAll();
      setStatus("该页面类型不支持读取登录态，请在 http 或 https 页面使用。", true);
      return;
    }

    currentTabUrl = tab.url;
    pageUrlEl.textContent = tab.url;
    const [cookies, storageFrames] = await Promise.all([
      getCookiesForPage(tab.url),
      getStorageFrames(tab.id)
    ]);

    currentCookies = cookies;
    currentStorageFrames = storageFrames;
    renderAll();
    setButtonsEnabled(currentCookies.length > 0 || countLocalStorageItems() > 0);
    setStatus(`读取完成：${currentCookies.length} 个 Cookie，${countLocalStorageItems()} 个 localStorage 项。`);
  } catch (error) {
    currentCookies = [];
    currentStorageFrames = [];
    renderAll();
    setStatus(error.message || "读取登录态失败。", true);
  }
}

function countLocalStorageItems() {
  return currentStorageFrames.reduce((total, frame) => total + (frame.localStorage?.length || 0), 0);
}

function countOrigins() {
  return buildPlaywrightOrigins().length;
}

function renderAll() {
  renderCookies(currentCookies);
  cookieCountEl.textContent = currentCookies.length;
  storageCountEl.textContent = countLocalStorageItems();
  originCountEl.textContent = countOrigins();
  playwrightPreviewEl.textContent = JSON.stringify(buildPlaywrightStorageState(), null, 2);
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(successMessage);
  } catch {
    setStatus("复制失败，请检查浏览器剪贴板权限。", true);
  }
}

function toCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function mapSameSite(sameSite) {
  const normalized = String(sameSite || "").toLowerCase();
  if (normalized === "strict") {
    return "Strict";
  }
  if (normalized === "no_restriction" || normalized === "none") {
    return "None";
  }
  return "Lax";
}

function toPlaywrightCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    expires: cookie.expirationDate || -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: mapSameSite(cookie.sameSite)
  };
}

function buildPlaywrightOrigins() {
  const origins = new Map();

  for (const frame of currentStorageFrames) {
    if (!frame.origin || frame.origin === "null") {
      continue;
    }
    const existing = origins.get(frame.origin) || new Map();
    for (const item of frame.localStorage || []) {
      existing.set(item.name, item.value);
    }
    origins.set(frame.origin, existing);
  }

  return [...origins.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([origin, items]) => ({
      origin,
      localStorage: [...items.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => ({ name, value }))
    }));
}

function buildPlaywrightStorageState() {
  return {
    cookies: currentCookies.map(toPlaywrightCookie),
    origins: buildPlaywrightOrigins()
  };
}

function setMode(mode) {
  activeMode = mode;
  modeSwitchEl.classList.toggle("playwright", mode === "playwright");
  modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  cookiePanelEl.classList.toggle("active", mode === "cookies");
  playwrightPanelEl.classList.toggle("active", mode === "playwright");
}

refreshBtn.addEventListener("click", loadState);

modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

copyCookieJsonBtn.addEventListener("click", () => {
  const payload = {
    url: currentTabUrl,
    cookies: currentCookies
  };
  copyText(JSON.stringify(payload, null, 2), "已复制 Cookie JSON。");
});

copyHeaderBtn.addEventListener("click", () => {
  copyText(toCookieHeader(currentCookies), "已复制 Cookie Header。");
});

copyPlaywrightBtn.addEventListener("click", () => {
  copyText(JSON.stringify(buildPlaywrightStorageState(), null, 2), "已复制 Playwright 登录态。");
});

setMode(activeMode);
loadState();
