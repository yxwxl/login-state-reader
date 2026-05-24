const BRIDGE_URL = "ws://127.0.0.1:17891";
const SHARED_TOKEN = "";
const RECONNECT_DELAY_MS = 3000;
const BRIDGE_ALARM_NAME = "session_bridge_reconnect";
const BRIDGE_ALARM_PERIOD_MINUTES = 0.5;

let bridgeSocket = null;
let connectTimer = null;
let isConnecting = false;

function ensureBridgeAlarm() {
  chrome.alarms.create(BRIDGE_ALARM_NAME, {
    delayInMinutes: 0.05,
    periodInMinutes: BRIDGE_ALARM_PERIOD_MINUTES
  });
}

function scheduleConnect(delay = RECONNECT_DELAY_MS) {
  if (connectTimer) {
    return;
  }
  connectTimer = setTimeout(() => {
    connectTimer = null;
    connectBridge();
  }, delay);
}

function connectBridge() {
  if (isConnecting) {
    return;
  }
  if (bridgeSocket && bridgeSocket.readyState <= WebSocket.OPEN) {
    return;
  }

  try {
    isConnecting = true;
    bridgeSocket = new WebSocket(BRIDGE_URL);
  } catch {
    isConnecting = false;
    scheduleConnect(RECONNECT_DELAY_MS);
    return;
  }

  bridgeSocket.addEventListener("open", () => {
    isConnecting = false;
    sendBridgeEvent("extension_ready", {
      version: chrome.runtime.getManifest().version,
      supportedActions: ["ping", "open_tab", "get_login_state"]
    });
  });

  bridgeSocket.addEventListener("message", (event) => {
    handleBridgeMessage(event.data);
  });

  bridgeSocket.addEventListener("close", () => {
    isConnecting = false;
    bridgeSocket = null;
    scheduleConnect(RECONNECT_DELAY_MS);
  });

  bridgeSocket.addEventListener("error", () => {
    isConnecting = false;
    try {
      bridgeSocket.close();
    } catch {
      bridgeSocket = null;
      scheduleConnect(RECONNECT_DELAY_MS);
    }
  });
}

function sendBridgeMessage(payload) {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    return false;
  }
  bridgeSocket.send(JSON.stringify(payload));
  return true;
}

function sendBridgeEvent(type, payload = {}) {
  return sendBridgeMessage({
    type,
    payload,
    sentAt: new Date().toISOString()
  });
}

function reply(request, ok, payload = {}, error = "") {
  sendBridgeMessage({
    id: request?.id ?? null,
    type: "response",
    action: request?.action ?? request?.type ?? "",
    ok,
    payload,
    error,
    sentAt: new Date().toISOString()
  });
}

async function handleBridgeMessage(rawMessage) {
  let request;
  try {
    request = JSON.parse(rawMessage);
  } catch {
    reply({ id: null, action: "unknown" }, false, {}, "Invalid JSON message.");
    return;
  }

  if (SHARED_TOKEN && request.token !== SHARED_TOKEN) {
    reply(request, false, {}, "Invalid token.");
    return;
  }

  try {
    const action = request.action || request.type;
    if (action === "ping") {
      reply(request, true, { pong: true });
      return;
    }
    if (action === "open_tab") {
      const target = await openOrFindTab(request.url, Boolean(request.activate), request.reuseExistingTab !== false);
      reply(request, true, { tabId: target.tab.id, url: target.tab.url, created: target.created });
      return;
    }
    if (action === "get_login_state") {
      const result = await getLoginState(request);
      reply(request, true, result);
      return;
    }
    reply(request, false, {}, `Unsupported action: ${action}`);
  } catch (error) {
    reply(request, false, {}, error.message || "Bridge command failed.");
  }
}

async function openOrFindTab(url, activate = true, reuseExistingTab = true) {
  if (!url) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) {
      throw new Error("No active tab found.");
    }
    return { tab: activeTab, created: false };
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http and https URLs are supported.");
  }

  if (reuseExistingTab) {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) => tab.url === url);
    if (existing?.id) {
      if (activate) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId) {
          await chrome.windows.update(existing.windowId, { focused: true });
        }
      }
      return { tab: existing, created: false };
    }
  }

  const tab = await chrome.tabs.create({ url, active: activate });
  return { tab, created: true };
}

async function waitForTabReady(tabId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && /^https?:\/\//i.test(tab.url || "")) {
      return tab;
    }
    await delay(300);
  }
  return chrome.tabs.get(tabId);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLoginState(request) {
  const mode = request.mode || "all";
  const closeTabAfter = request.closeTabAfter || "never";
  const target = await openOrFindTab(
    request.url || "",
    request.activate !== false,
    request.reuseExistingTab !== false
  );
  let tabIdToClose = target.tab?.id;

  try {
    const readyTab = await waitForTabReady(target.tab.id, Number(request.timeoutMs) || 12000);
    tabIdToClose = readyTab.id || tabIdToClose;

    if (!readyTab.url || !/^https?:\/\//i.test(readyTab.url)) {
      throw new Error("Target tab is not an http or https page.");
    }

    const cookies = await getCookiesForPage(readyTab.url);
    const frames = await getStorageFrames(readyTab.id);
    const playwright = buildPlaywrightStorageState(cookies, frames);
    const header = toCookieHeader(cookies);

    const payload = {
      tabId: readyTab.id,
      url: readyTab.url,
      title: readyTab.title || "",
      tabCreatedByExtension: target.created,
      cookieCount: cookies.length,
      localStorageCount: countLocalStorageItems(frames),
      originCount: playwright.origins.length
    };

    if (mode === "cookies" || mode === "all") {
      payload.cookies = cookies;
    }
    if (mode === "header" || mode === "all") {
      payload.header = header;
    }
    if (mode === "playwright" || mode === "all") {
      payload.playwright = playwright;
    }

    return payload;
  } finally {
    if (shouldCloseTab(closeTabAfter, target.created) && tabIdToClose) {
      await closeTabWithRetry(tabIdToClose);
    }
  }
}

async function closeTabWithRetry(tabId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await chrome.tabs.remove(tabId);
      return true;
    } catch {
      await delay(250);
    }
  }
  return false;
}

function shouldCloseTab(closeTabAfter, created) {
  if (closeTabAfter === true || closeTabAfter === "always") {
    return true;
  }
  if (closeTabAfter === "created") {
    return created;
  }
  return false;
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
  } catch {
    return [];
  }
}

function countLocalStorageItems(frames) {
  return frames.reduce((total, frame) => total + (frame.localStorage?.length || 0), 0);
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

function buildPlaywrightOrigins(frames) {
  const origins = new Map();

  for (const frame of frames) {
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

function buildPlaywrightStorageState(cookies, frames) {
  return {
    cookies: cookies.map(toPlaywrightCookie),
    origins: buildPlaywrightOrigins(frames)
  };
}

chrome.runtime.onInstalled.addListener(() => scheduleConnect(300));
chrome.runtime.onStartup.addListener(() => scheduleConnect(300));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_ALARM_NAME) {
    connectBridge();
  }
});

ensureBridgeAlarm();
scheduleConnect(300);
