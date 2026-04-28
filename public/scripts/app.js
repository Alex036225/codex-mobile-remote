import RFB from "/vendor/novnc/core/rfb.js";

const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const menuBtn = document.querySelector("#menuBtn");
const closeThreadsBtn = document.querySelector("#closeThreadsBtn");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const threadList = document.querySelector("#threadList");
const threadSearch = document.querySelector("#threadSearch");
const threadTitle = document.querySelector("#threadTitle");
const threadMeta = document.querySelector("#threadMeta");
const messageList = document.querySelector("#messageList");
const composerForm = document.querySelector("#composerForm");
const messageInput = document.querySelector("#messageInput");
const newThreadBtn = document.querySelector("#newThreadBtn");
const refreshThreadsBtn = document.querySelector("#refreshThreadsBtn");
const readThreadBtn = document.querySelector("#readThreadBtn");
const fallbackToggleBtn = document.querySelector("#fallbackToggleBtn");
const fallbackPanel = document.querySelector("#fallbackPanel");
const focusCodexBtn = document.querySelector("#focusCodexBtn");

const screen = document.querySelector("#screen");
const emptyState = document.querySelector("#emptyState");
const emptyHint = document.querySelector("#emptyHint");
const connectBtn = document.querySelector("#connectBtn");
const emptyConnectBtn = document.querySelector("#emptyConnectBtn");
const disconnectBtn = document.querySelector("#disconnectBtn");
const refreshBtn = document.querySelector("#refreshBtn");
const sendTextBtn = document.querySelector("#sendTextBtn");
const textToSend = document.querySelector("#textToSend");
const usernameInput = document.querySelector("#vncUsername");
const passwordInput = document.querySelector("#vncPassword");
const macLoginPasswordInput = document.querySelector("#macLoginPassword");
const unlockMacBtn = document.querySelector("#unlockMacBtn");
const statusDetails = document.querySelector("#statusDetails");
const secureCryptoAvailable = Boolean(window.crypto?.subtle);

let rfb = null;
let configCache = null;
let selectedThreadId = null;
let selectedThread = null;
let threads = [];
let refreshTimer = null;
let realtimePoll = null;
let eventSource = null;
let liveReload = null;
let threadRequestSeq = 0;
let lastError = "";
let appServerStatusLabel = "App Server 已连接";
let followActiveThread = true;
let sendToDesktopUi = false;

menuBtn.addEventListener("click", openThreadDrawer);
closeThreadsBtn.addEventListener("click", closeThreadDrawer);
drawerBackdrop.addEventListener("click", closeThreadDrawer);
newThreadBtn.addEventListener("click", createNewThread);
refreshThreadsBtn.addEventListener("click", loadThreads);
readThreadBtn.addEventListener("click", () => selectedThreadId && loadThread(selectedThreadId));
threadSearch.addEventListener("input", debounce(loadThreads, 250));
composerForm.addEventListener("submit", sendMessage);
messageInput.addEventListener("input", resizeComposer);
messageList.addEventListener("scroll", () => {
  followActiveThread = isNearBottom(messageList);
});
fallbackToggleBtn.addEventListener("click", () => {
  fallbackPanel.hidden = !fallbackPanel.hidden;
  fallbackToggleBtn.textContent = fallbackPanel.hidden ? "远程屏幕" : "收起远程屏幕";
});
focusCodexBtn.addEventListener("click", focusCodex);

connectBtn.addEventListener("click", connect);
emptyConnectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
refreshBtn.addEventListener("click", refreshStatus);
sendTextBtn.addEventListener("click", sendText);
unlockMacBtn.addEventListener("click", unlockMac);

document.querySelectorAll("[data-key]").forEach((button) => {
  button.addEventListener("click", () => sendKey(button.dataset.key));
});

document.querySelectorAll("[data-combo]").forEach((button) => {
  button.addEventListener("click", () => sendCombo(button.dataset.combo));
});

window.addEventListener("error", (event) => {
  setStatus("offline", `浏览器错误：${event.message}`);
});

window.addEventListener("unhandledrejection", (event) => {
  setStatus("offline", `请求失败：${event.reason?.message || event.reason || "未知错误"}`);
});

await boot();

async function boot() {
  setStatus("connecting", "连接 App Server");
  await Promise.all([refreshStatus(), loadThreads()]);
  connectEventStream();
  startRealtimePoll();
  setStatus("online", appServerStatusLabel);
}

async function loadThreads() {
  const params = new URLSearchParams({ limit: "60" });
  const search = threadSearch.value.trim();
  if (search) params.set("search", search);

  const response = await fetchJson(`/api/app-server/threads?${params.toString()}`, { allowFailure: true });
  if (!response?.data) {
    renderThreadError(response?.detail || "无法读取 Codex 线程");
    return;
  }

  threads = response.data;
  renderThreads();
  if (!selectedThreadId && threads[0]) await loadThread(threads[0].id);
}

async function loadThread(threadId, options = {}) {
  const silent = Boolean(options.silent);
  const requestSeq = ++threadRequestSeq;
  const shouldStickToBottom = Boolean(options.forceBottom) || followActiveThread || isNearBottom(messageList);
  selectedThreadId = threadId;
  renderThreads();
  if (!silent) setStatus("connecting", "读取线程");

  const response = await fetchJson(`/api/app-server/threads/${encodeURIComponent(threadId)}`, { allowFailure: true });
  if (requestSeq !== threadRequestSeq) return;
  if (!response?.thread) {
    renderMessageError(response?.detail || "无法读取这个线程");
    setStatus("offline", "读取失败");
    return;
  }

  selectedThread = response.thread;
  threadTitle.textContent = selectedThread.name || selectedThread.preview || "未命名线程";
  threadMeta.textContent = `${selectedThread.cwd || "Codex"} · ${formatStatus(selectedThread.status)}`;
  const messages = response.messages || [];
  renderMessages(messages, shouldStickToBottom);
  followActiveThread = shouldStickToBottom && hasInProgressMessage(messages);
  if (!silent) setStatus("online", appServerStatusLabel);
  startRealtimePoll();
}

async function sendMessage(event) {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;

  if (!selectedThreadId) {
    await createNewThread(message);
    return;
  }

  messageInput.value = "";
  resizeComposer();
  appendMessage({ role: "user", text: message, pending: true });
  appendMessage({ role: "system", text: "已发送，等待 Codex 输出...", pending: true });
  followActiveThread = true;
  setComposerDisabled(true);

  const response = sendToDesktopUi
    ? await sendMessageToDesktopUi(message)
    : await sendMessageToAppServer(message);

  setComposerDisabled(false);
  if (!response?.ok) {
    appendMessage({ role: "system", text: `发送失败：${response?.detail || response?.error || "未知错误"}` });
    return;
  }

  if (sendToDesktopUi) {
    appendMessage({
      role: "system",
      text: "已通过 Desktop CDP 发送到电脑端 Codex。手机会继续显示桥接线程；电脑端会在真实 Desktop UI 中执行。"
    });
  }

  scheduleThreadRefresh(900, true);
  scheduleThreadRefresh(2500, true);
  scheduleThreadRefresh(6000, true);
}

async function sendMessageToAppServer(message) {
  return fetchJson(`/api/app-server/threads/${encodeURIComponent(selectedThreadId)}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    allowFailure: true
  });
}

async function sendMessageToDesktopUi(message) {
  return fetchJson("/api/codex/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, threadName: selectedThread?.name || selectedThread?.preview || "" }),
    allowFailure: true
  });
}

async function createNewThread(initialMessage = "") {
  const message = typeof initialMessage === "string" ? initialMessage : "";
  const response = await fetchJson("/api/app-server/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    allowFailure: true
  });

  if (!response?.thread) {
    appendMessage({ role: "system", text: `新建失败：${response?.detail || response?.error || "未知错误"}` });
    return;
  }

  selectedThreadId = response.thread.id;
  await loadThreads();
  await loadThread(selectedThreadId, { forceBottom: true });
  closeThreadDrawer();
  if (messageInput.value.trim() === message) messageInput.value = "";
}

function scheduleThreadRefresh(delay, forceBottom = false) {
  window.setTimeout(() => {
    if (selectedThreadId) loadThread(selectedThreadId, { forceBottom });
  }, delay);
  if (!refreshTimer) {
    refreshTimer = window.setInterval(() => {
      if (selectedThreadId) loadThread(selectedThreadId, { silent: true, forceBottom: followActiveThread });
    }, 5000);
    window.setTimeout(() => {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }, 45000);
  }
}

function renderThreads() {
  threadList.textContent = "";
  if (!threads.length) {
    const empty = document.createElement("p");
    empty.className = "muted thread-empty";
    empty.textContent = "没有找到线程。";
    threadList.appendChild(empty);
    return;
  }

  for (const thread of threads) {
    const button = document.createElement("button");
    button.className = "thread-item";
    button.dataset.active = thread.id === selectedThreadId ? "true" : "false";
    button.type = "button";
    button.addEventListener("click", () => {
      loadThread(thread.id);
      closeThreadDrawer();
    });

    const title = document.createElement("strong");
    title.textContent = thread.name || firstLine(thread.preview) || "未命名线程";
    const meta = document.createElement("span");
    meta.textContent = `${formatDate(thread.updatedAt)} · ${thread.cwd || "Codex"}`;
    const preview = document.createElement("span");
    preview.className = "thread-preview";
    preview.textContent = firstLine(thread.preview);

    button.append(title, meta, preview);
    threadList.appendChild(button);
  }
}

function renderMessages(messages, stickToBottom = true) {
  messageList.textContent = "";
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "这个线程还没有可显示的消息。你可以直接在底部输入框继续这条对话。";
    messageList.appendChild(empty);
    return;
  }

  for (const message of messages) appendMessage(message, false);
  if (stickToBottom) messageList.scrollTop = messageList.scrollHeight;
}

function appendMessage(message, scroll = true) {
  const item = document.createElement("article");
  item.className = `message ${message.role || "system"}`;
  if (message.pending) item.dataset.pending = "true";

  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = roleLabel(message.role, message.phase);

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = message.text || "";

  item.append(label, body);
  messageList.appendChild(item);
  if (scroll) messageList.scrollTop = messageList.scrollHeight;
}

function renderThreadError(text) {
  threadList.textContent = "";
  const error = document.createElement("p");
  error.className = "error";
  error.textContent = text;
  threadList.appendChild(error);
}

function renderMessageError(text) {
  messageList.textContent = "";
  appendMessage({ role: "system", text });
}

async function focusCodex() {
  const response = await fetch("/api/focus-codex", { method: "POST" });
  setStatus(response.ok ? "online" : "offline", response.ok ? "已请求聚焦 Codex" : "无法聚焦 Codex");
}

function connectEventStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/app-server/events");
  eventSource.addEventListener("ready", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.transport === "desktop-internal-bridge") {
      setStatus("online", "已连接 Codex Desktop");
      return;
    }
    setStatus("online", "实时连接已建立");
  });
  eventSource.addEventListener("codex", (event) => {
    const payload = JSON.parse(event.data);
    const threadId = payload.params?.threadId || payload.params?.thread?.id;
    if (threadId && selectedThreadId && threadId === selectedThreadId) {
      setStatus("online", "正在实时刷新");
      scheduleLiveReload(300);
    }
    if (payload.method?.startsWith("thread/")) {
      window.setTimeout(loadThreads, 400);
    }
  });
  eventSource.addEventListener("error", () => {
    setStatus("idle", "实时连接重试中");
  });
}

function scheduleLiveReload(delay) {
  window.clearTimeout(liveReload);
  liveReload = window.setTimeout(() => {
    if (selectedThreadId) loadThread(selectedThreadId, { silent: true, forceBottom: followActiveThread });
  }, delay);
}

function startRealtimePoll() {
  if (realtimePoll) return;
  realtimePoll = window.setInterval(() => {
    if (document.hidden || !selectedThreadId) return;
    loadThread(selectedThreadId, { silent: true, forceBottom: followActiveThread });
  }, 2500);
}

function openThreadDrawer() {
  document.body.classList.add("drawer-open");
  drawerBackdrop.hidden = false;
}

function closeThreadDrawer() {
  document.body.classList.remove("drawer-open");
  drawerBackdrop.hidden = true;
}

function resizeComposer() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 150)}px`;
}

async function refreshStatus() {
  const status = await fetchJson("/api/status", { allowFailure: true });
  statusDetails.textContent = JSON.stringify(status || {}, null, 2);

  const desktopBridge = Boolean(status?.desktopCdp?.appServerBridgeReady);
  const desktopSocket = status?.appServer?.transport === "desktop-control-socket";
  sendToDesktopUi = !desktopBridge && !desktopSocket && Boolean(status?.desktopCdp?.ready);
  if (desktopBridge || desktopSocket) appServerStatusLabel = "已连接 Codex Desktop";
  else if (sendToDesktopUi) appServerStatusLabel = "Desktop CDP 模式";
  else if (status?.appServer?.ready) appServerStatusLabel = "桥接 App Server";

  if (sendToDesktopUi || desktopSocket || status?.appServer?.ready) {
    setStatus("online", appServerStatusLabel);
  } else {
    setStatus("connecting", "启动 App Server");
  }

  if (rfb) return;
  if (status?.vncReachable) {
    const appleOnly = status.vncSecurity?.hasAppleRemoteDesktop && !status.vncSecurity?.hasVncPassword;
    if (appleOnly && !secureCryptoAvailable) {
      emptyHint.textContent = "当前 Mac 只开放 Apple 认证；手机 HTTP 页面无法稳定完成认证。";
    } else {
      emptyHint.textContent = "点击连接后会显示当前 Mac 桌面。";
    }
  } else {
    emptyHint.textContent = "请先在 Mac 上开启 Screen Sharing。";
  }
}

async function getConfig() {
  if (!configCache) configCache = await fetchJson("/api/config");
  return configCache;
}

async function connect() {
  disconnect();
  lastError = "";
  const config = await getConfig();
  if (!usernameInput.value && config.defaultUsername) usernameInput.value = config.defaultUsername;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}${config.wsPath}`;

  setStatus("connecting", "连接远程屏幕");
  rfb = new RFB(screen, url, { credentials: getCredentials() });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.viewOnly = false;
  rfb.focusOnClick = true;
  rfb.clipViewport = false;
  rfb.touchButton = 1;

  rfb.addEventListener("connect", () => {
    emptyState.hidden = true;
    setStatus("online", "远程屏幕已连接");
  });

  rfb.addEventListener("disconnect", (event) => {
    emptyState.hidden = false;
    setStatus(event.detail.clean ? "idle" : "offline", event.detail.clean ? "远程屏幕已断开" : lastError || "远程屏幕中断");
  });

  rfb.addEventListener("credentialsrequired", () => {
    if (!usernameInput.value) usernameInput.value = window.prompt("请输入这台 Mac 的用户名", config.defaultUsername || "") || "";
    if (!passwordInput.value) passwordInput.value = window.prompt("请输入这台 Mac 的 VNC 密码") || "";
    rfb.sendCredentials(getCredentials());
  });

  rfb.addEventListener("securityfailure", (event) => {
    lastError = `认证失败：${event.detail.reason || "请检查 VNC 密码"}`;
    setStatus("offline", lastError);
  });

  screen.focus();
}

function disconnect() {
  if (!rfb) return;
  rfb.disconnect();
  rfb = null;
}

function sendText() {
  if (!rfb || !textToSend.value) return;
  rfb.clipboardPasteFrom(textToSend.value);
  sendCombo("MetaLeft+KeyV");
  textToSend.value = "";
}

function unlockMac() {
  if (!rfb || !macLoginPasswordInput.value) return;
  typeAscii(macLoginPasswordInput.value);
  sendKey("Enter");
  macLoginPasswordInput.value = "";
}

function typeAscii(text) {
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0x7f) rfb.sendKey(codePoint, null);
  }
}

function sendKey(code) {
  if (!rfb) return;
  const keysymByCode = {
    Backspace: 0xff08,
    Tab: 0xff09,
    Enter: 0xff0d,
    Escape: 0xff1b
  };
  rfb.sendKey(keysymByCode[code] || 0, code);
}

function sendCombo(combo) {
  if (!rfb) return;
  const parts = combo.split("+");
  const modifiers = parts.slice(0, -1);
  const key = parts.at(-1);
  modifiers.forEach((code) => rfb.sendKey(0, code, true));
  rfb.sendKey(0, key);
  [...modifiers].reverse().forEach((code) => rfb.sendKey(0, code, false));
}

function getCredentials() {
  const credentials = {};
  if (usernameInput.value) credentials.username = usernameInput.value;
  if (passwordInput.value) credentials.password = passwordInput.value;
  return credentials;
}

async function fetchJson(url, options = {}) {
  const { allowFailure, ...fetchOptions } = options;
  const response = await fetch(url, fetchOptions);
  if (response.status === 401) {
    location.href = "/login";
    return null;
  }
  if (!response.ok && !allowFailure) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function setComposerDisabled(disabled) {
  messageInput.disabled = disabled;
  document.querySelector("#sendMessageBtn").disabled = disabled;
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 120;
}

function hasInProgressMessage(messages) {
  return messages.some((message) => message.status === "inProgress");
}

function setStatus(state, text) {
  statusDot.dataset.state = state;
  statusText.textContent = text;
}

function roleLabel(role, phase) {
  if (phase === "plan") return "计划";
  if (role === "user") return "你";
  if (role === "assistant") return "Codex";
  return "系统";
}

function firstLine(text = "") {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function formatStatus(status) {
  if (!status?.type) return "unknown";
  if (status.type === "running") return "运行中";
  if (status.type === "notLoaded") return "未加载";
  return status.type;
}

function formatDate(seconds) {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}
