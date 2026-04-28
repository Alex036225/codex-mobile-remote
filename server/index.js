import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { CodexAppServerClient, flattenThreadMessages } from "./codex-app-server.js";
import { CodexDesktopCdp } from "./codex-desktop-cdp.js";
import { findCodexLaunchTarget } from "./codex-paths.js";
import { readSessionBackedThread } from "./codex-session-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const codexScript = path.join(rootDir, "scripts", "codex-app.applescript");
const ocrScript = path.join(rootDir, "scripts", "ocr.swift");
const ocrBoxesScript = path.join(rootDir, "scripts", "ocr-boxes.swift");
const clickScript = path.join(rootDir, "scripts", "click.swift");
const tokenFile = path.join(rootDir, ".remote-token");

const port = Number(process.env.PORT || 8088);
const vncHost = process.env.VNC_HOST || "127.0.0.1";
const vncPort = Number(process.env.VNC_PORT || 5900);
const forceVncPasswordAuth = process.env.FORCE_VNC_PASSWORD_AUTH !== "0";
const cookieName = "cmr_session";
const sessions = new Map();
const codexAppServer = new CodexAppServerClient();
const codexDesktopCdp = new CodexDesktopCdp();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false }));

const accessToken = getAccessToken();

app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path.endsWith(".css") || req.path.endsWith(".js")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use("/styles", express.static(path.join(publicDir, "styles")));

if (process.argv.includes("--check")) {
  const status = await collectStatus();
  console.log(JSON.stringify({ port, vncHost, vncPort, status }, null, 2));
  process.exit(status.vncReachable ? 0 : 1);
}

app.get("/login", (req, res) => {
  if (isAuthDisabled() || getSession(req)) return res.redirect("/");
  res.sendFile(path.join(publicDir, "login.html"));
});

app.post("/api/login", (req, res) => {
  if (isAuthDisabled()) return res.json({ ok: true, authDisabled: true });

  const submitted = String(req.body?.token || "");
  if (!safeEqual(submitted, accessToken)) {
    return res.status(401).json({ ok: false, error: "访问口令不正确" });
  }

  const sid = crypto.randomBytes(32).toString("base64url");
  sessions.set(sid, { createdAt: Date.now(), lastSeenAt: Date.now() });
  res.setHeader("Set-Cookie", serializeCookie(cookieName, sid, req.secure));
  res.json({ ok: true });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const sid = parseCookies(req.headers.cookie || "")[cookieName];
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  res.json({ ok: true });
});

app.get("/api/status", requireAuth, async (_req, res) => {
  res.json(await collectStatus());
});

app.get("/api/app-server/status", requireAuth, async (_req, res) => {
  const backend = await getThreadBackend();
  res.json(await backend.status());
});

app.get("/api/app-server/events", requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const backend = await getThreadBackend();
  const desktopBridge = backend === codexDesktopCdp;
  send("ready", { ok: true, at: Date.now(), transport: desktopBridge ? "desktop-internal-bridge" : "bridge-websocket" });
  const unsubscribe = desktopBridge ? () => {} : codexAppServer.subscribe((event) => send("codex", event));
  const heartbeat = setInterval(() => send("ping", { at: Date.now() }), 25000);

  if (!desktopBridge) {
    codexAppServer.ensureConnection().catch((error) => {
      send("error", { error: error.message || String(error) });
    });
  }

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get("/api/app-server/threads", requireAuth, async (req, res) => {
  const result = await handleAppServer(res, async () => {
    const backend = await getThreadBackend();
    return backend.listThreads({
      limit: clampNumber(req.query.limit, 1, 100, 50),
      searchTerm: req.query.search ? String(req.query.search) : null
    });
  });
  if (result) res.json(result);
});

app.get("/api/app-server/threads/:threadId", requireAuth, async (req, res) => {
  const result = await handleAppServer(res, async () => {
    const backend = await getThreadBackend();
    const { thread } = await backend.readThread(req.params.threadId, true);
    const backendMessages = flattenThreadMessages(thread);
    const sessionThread = await readSessionBackedThread(req.params.threadId).catch(() => null);
    const sessionMessages = sessionThread?.messages || [];
    return {
      thread: enrichThreadFromSession(thread, sessionThread?.thread),
      messages: chooseThreadMessages(backendMessages, sessionMessages)
    };
  });
  if (result) res.json(result);
});

app.post("/api/app-server/threads", requireAuth, async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const cwd = String(req.body?.cwd || "").trim();
  const result = await handleAppServer(res, async () => {
    const backend = await getThreadBackend();
    return backend.createThread({ cwd, message });
  });
  if (result) res.json(result);
});

app.post("/api/app-server/threads/:threadId/send", requireAuth, async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ ok: false, error: "empty_message" });

  const result = await handleAppServer(res, async () => {
    const backend = await getThreadBackend();
    const sendResult = await backend.sendTurn(req.params.threadId, message);
    const uiSync = backend === codexDesktopCdp
      ? await syncDesktopThreadViewById(req.params.threadId, message)
      : null;
    return { sendResult, uiSync };
  });
  if (result) res.json({ ok: true, result: result.sendResult, uiSync: result.uiSync });
});

app.get("/api/config", requireAuth, (_req, res) => {
  res.json({
    wsPath: "/vnc",
    vncHost,
    vncPort,
    computerName: os.hostname(),
    defaultUsername: os.userInfo().username
  });
});

app.post("/api/focus-codex", requireAuth, (_req, res) => {
  const target = findCodexLaunchTarget();
  const openArgs = target.endsWith(".app") || target.startsWith("/") ? [target] : ["-a", target];
  execFile("/usr/bin/open", openArgs, (openError) => {
    if (openError) return res.status(500).json({ ok: false, error: openError.message });
    execFile("/usr/bin/osascript", ["-e", 'tell application "Codex" to activate'], (activateError) => {
      if (activateError) return res.json({ ok: true, warning: activateError.message });
      res.json({ ok: true });
    });
  });
});

app.get("/api/codex/status", requireAuth, async (_req, res) => {
  const result = await runCodexAutomation("status");
  res.status(result.ok ? 200 : 424).json(result);
});

app.post("/api/codex/send", requireAuth, async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const threadName = String(req.body?.threadName || "").trim();
  if (!message) return res.status(400).json({ ok: false, error: "empty_message" });

  if (await ensureDesktopBridgeReady()) {
    try {
      if (threadName) {
        const target = await findThreadByName(threadName);
        if (!target) {
          return res.status(404).json({ ok: false, error: "desktop_thread_not_found", detail: `没有找到线程：${threadName}` });
        }
        const result = await codexDesktopCdp.sendTurn(target.id, message);
        const uiSync = await syncDesktopThreadViewById(target.id, message, target.name || threadName);
        return res.json({ ok: true, transport: "desktop-internal-bridge", threadId: target.id, result, uiSync });
      }
    } catch (error) {
      return res.status(424).json({ ok: false, error: "desktop_bridge_send_failed", detail: error.message || String(error) });
    }
  }

  try {
    const result = await codexDesktopCdp.sendMessage({ message, threadName });
    console.log(`CDP send ok: thread=${threadName || "(current)"} chars=${message.length}`);
    return res.json(result);
  } catch (error) {
    const cdpError = error.message || String(error);
    if (process.env.CODEX_DESKTOP_SEND_FALLBACK === "1") {
      console.warn(`CDP send failed; falling back to Accessibility: ${cdpError}`);
    } else {
      return res.status(424).json({ ok: false, error: "desktop_cdp_send_failed", detail: cdpError });
    }
  }

  if (threadName) {
    const opened = await openCodexThreadByName(threadName);
    if (!opened.ok) return res.status(424).json(opened);
  }

  const result = await runCodexAutomation("send", message);
  res.status(result.ok ? 200 : 424).json(result);
});

app.post("/api/codex/open-thread", requireAuth, async (req, res) => {
  const threadName = String(req.body?.threadName || "").trim();
  if (!threadName) return res.status(400).json({ ok: false, error: "empty_thread_name" });

  const result = await openCodexThreadByName(threadName);
  res.status(result.ok ? 200 : 424).json(result);
});

app.get("/api/desktop-cdp/status", requireAuth, async (_req, res) => {
  res.json(await codexDesktopCdp.status());
});

app.post("/api/desktop-cdp/start", requireAuth, async (_req, res) => {
  try {
    res.json(await codexDesktopCdp.launch());
  } catch (error) {
    res.status(424).json({ ok: false, error: "desktop_cdp_start_failed", detail: error.message || String(error) });
  }
});

app.post("/api/desktop-cdp/open-thread", requireAuth, async (req, res) => {
  const threadName = String(req.body?.threadName || "").trim();
  if (!threadName) return res.status(400).json({ ok: false, error: "empty_thread_name" });

  try {
    res.json(await codexDesktopCdp.openThread(threadName));
  } catch (error) {
    res.status(424).json({ ok: false, error: "desktop_cdp_open_thread_failed", detail: error.message || String(error) });
  }
});

app.get("/api/codex/snapshot", requireAuth, async (_req, res) => {
  const result = await runCodexAutomation("snapshot");
  if (!result.ok) return res.status(424).json(result);
  const axText = compactAxText(result.stdout);
  if (axText.length > 120) return res.json({ ok: true, source: "accessibility", text: axText, raw: result.stdout });

  const ocr = await captureCodexOcr();
  if (ocr.ok) return res.json({ ok: true, source: "ocr", text: ocr.text, axText });
  res.json({ ok: true, source: "accessibility", text: axText, raw: result.stdout, ocrError: ocr.error });
});

app.use("/vendor/novnc", requireAuth, express.static(path.join(rootDir, "node_modules", "@novnc", "novnc")));
app.use(requireAuth, express.static(publicDir));

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Codex Mobile Remote listening on http://localhost:${port}`);
  console.log(isAuthDisabled() ? "Access token: disabled" : `Access token: ${accessToken}`);
  console.log(`VNC target: ${vncHost}:${vncPort}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (pathname !== "/vnc") {
    socket.destroy();
    return;
  }

  if (!getSession(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const tcp = net.connect({ host: vncHost, port: vncPort });
  const handshake = createRfbHandshakeFilter(ws);
  tcp.setNoDelay(true);

  tcp.on("data", (chunk) => {
    handshake.handleServerData(chunk);
  });

  tcp.on("error", (error) => {
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `VNC connection failed: ${error.code || error.message}`);
    }
  });

  tcp.on("close", () => {
    if (ws.readyState === ws.OPEN) ws.close(1000);
  });

  ws.on("message", (message) => {
    if (tcp.destroyed) return;
    const chunk = Buffer.isBuffer(message) ? message : Buffer.from(message);
    handshake.handleClientData(chunk);
    tcp.write(chunk);
  });

  ws.on("close", () => tcp.destroy());
  ws.on("error", () => tcp.destroy());
});

function createRfbHandshakeFilter(ws) {
  let state = forceVncPasswordAuth ? "serverProtocol" : "passthrough";
  let serverBuffer = Buffer.alloc(0);
  let sawClientProtocol = false;

  const send = (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  };

  return {
    handleClientData(chunk) {
      if (!sawClientProtocol && chunk.length >= 12 && chunk.subarray(0, 4).toString("ascii") === "RFB ") {
        sawClientProtocol = true;
        if (state === "waitClientProtocol") state = "serverSecurityTypes";
        flush();
      }
    },
    handleServerData(chunk) {
      if (state === "passthrough") {
        send(chunk);
        return;
      }

      serverBuffer = Buffer.concat([serverBuffer, chunk]);
      flush();
    }
  };

  function flush() {
    while (serverBuffer.length > 0) {
      if (state === "serverProtocol") {
        if (serverBuffer.length < 12) return;
        send(serverBuffer.subarray(0, 12));
        serverBuffer = serverBuffer.subarray(12);
        state = sawClientProtocol ? "serverSecurityTypes" : "waitClientProtocol";
        if (state === "waitClientProtocol") return;
      }

      if (state === "waitClientProtocol") return;

      if (state === "serverSecurityTypes") {
        if (serverBuffer.length < 1) return;
        const count = serverBuffer[0];
        if (serverBuffer.length < count + 1) return;

        const packet = serverBuffer.subarray(0, count + 1);
        const rest = serverBuffer.subarray(count + 1);
        const types = [...packet.subarray(1)];
        send(types.includes(2) ? Buffer.from([1, 2]) : packet);
        serverBuffer = rest;
        state = "passthrough";
        continue;
      }

      send(serverBuffer);
      serverBuffer = Buffer.alloc(0);
    }
  }
}

async function collectStatus() {
  const [vncReachable, screenSharing, vncSecurity, appServer, desktopCdp] = await Promise.all([
    canConnect(vncHost, vncPort, 600),
    getScreenSharingState(),
    probeVncSecurity(vncHost, vncPort, 1000),
    codexAppServer.status(),
    codexDesktopCdp.status()
  ]);

  return {
    ok: true,
    appServer,
    desktopCdp,
    vncReachable,
    vncSecurity,
    screenSharing,
    vncHost,
    vncPort,
    port,
    sessions: sessions.size,
    tokenFile
  };
}

async function getThreadBackend() {
  return await ensureDesktopBridgeReady() ? codexDesktopCdp : codexAppServer;
}

async function ensureDesktopBridgeReady() {
  if (await codexDesktopCdp.appServerBridgeReady()) return true;
  try {
    await codexDesktopCdp.launch();
    await delay(1200);
  } catch (error) {
    console.warn(`Desktop bridge launch failed: ${error.message || String(error)}`);
  }
  return await codexDesktopCdp.appServerBridgeReady();
}

async function syncDesktopThreadViewById(threadId, message, preferredName = "") {
  try {
    const { thread } = await codexDesktopCdp.readThread(threadId, false);
    const threadName = String(preferredName || thread?.name || thread?.preview || "").trim();
    if (!threadName) {
      return { ok: false, detail: "missing_thread_name_for_ui_sync", threadId };
    }
    const expectedSnippet = String(message || "").slice(0, 160);
    let uiSync;
    try {
      await codexDesktopCdp.openThreadInMainWindow(threadId);
      uiSync = await codexDesktopCdp.syncThreadView(threadId, threadName, expectedSnippet);
    } catch (error) {
      const detail = error.message || String(error);
      if (!/socket closed|fetch failed|ECONNREFUSED|target list failed|page target/i.test(detail)) {
        throw error;
      }
      await codexDesktopCdp.launch();
      await delay(1200);
      await codexDesktopCdp.openThreadInMainWindow(threadId);
      uiSync = await codexDesktopCdp.syncThreadView(threadId, threadName, expectedSnippet);
    }
    return { ok: true, threadId, threadName, ...uiSync };
  } catch (error) {
    return {
      ok: false,
      threadId,
      detail: error.message || String(error)
    };
  }
}

async function findThreadByName(threadName) {
  const normalizedTarget = normalizeThreadName(threadName);
  if (!normalizedTarget) return null;

  const { data } = await codexDesktopCdp.listThreads({ limit: 100, searchTerm: threadName });
  const threads = data || [];
  return threads.find((thread) => normalizeThreadName(thread.name || "") === normalizedTarget)
    || threads.find((thread) => normalizeThreadName(thread.preview || "").includes(normalizedTarget))
    || null;
}

async function handleAppServer(res, fn) {
  try {
    return await fn();
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "codex_app_server_failed",
      detail: error.message || String(error)
    });
    return null;
  }
}

function chooseThreadMessages(backendMessages, sessionMessages) {
  if (!sessionMessages.length) return backendMessages;
  if (!backendMessages.length) return sessionMessages;

  const backendLast = backendMessages.at(-1)?.text?.trim() || "";
  const sessionLast = sessionMessages.at(-1)?.text?.trim() || "";
  if (sessionMessages.length > backendMessages.length) return sessionMessages;
  if (sessionLast && sessionLast !== backendLast) return sessionMessages;
  return backendMessages;
}

function enrichThreadFromSession(thread, sessionThread) {
  if (!sessionThread) return thread;
  return {
    ...thread,
    name: thread.name || sessionThread.title || thread.preview || "",
    cwd: thread.cwd || sessionThread.cwd || thread.cwd,
    updatedAt: thread.updatedAt || sessionThread.updatedAt || null
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAccessToken() {
  if (process.env.REMOTE_TOKEN !== undefined) return process.env.REMOTE_TOKEN.trim();
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, "utf8").trim();

  const token = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

function isAuthDisabled() {
  return accessToken === "";
}

function runCodexAutomation(command, argument = "") {
  const args = [codexScript, command];
  if (argument) args.push(argument);

  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout: stdout.trim() });

      const combined = `${stderr || ""}\n${error.message || ""}`;
      const needsAccessibility = /辅助访问|assistive|not allowed|不允许|-25211/i.test(combined);
      resolve({
        ok: false,
        code: error.code || null,
        needsAccessibility,
        error: needsAccessibility ? "accessibility_permission_required" : "codex_automation_failed",
        detail: combined.trim()
      });
    });
  });
}

async function openCodexThreadByName(threadName) {
  const activate = await runCodexAutomation("activate");
  if (!activate.ok) return activate;

  const imagePath = path.join(os.tmpdir(), `codex-thread-search-${crypto.randomBytes(8).toString("hex")}.png`);
  try {
    await execFilePromise("/usr/sbin/screencapture", ["-x", imagePath], { timeout: 5000 });
    const { stdout } = await execFilePromise("/usr/bin/swift", [ocrBoxesScript, imagePath], {
      timeout: 20000,
      maxBuffer: 1024 * 1024
    });
    const boxes = JSON.parse(stdout || "[]");
    const visibleText = boxes.map((box) => box.text).join("\n");
    if (!/所有对话/.test(visibleText) || !/新对话/.test(visibleText)) {
      return {
        ok: false,
        error: "desktop_chat_window_not_visible",
        detail: "没有看到 Codex Desktop 的对话侧边栏；请先把 Codex 主对话窗口置前。"
      };
    }

    const target = normalizeThreadName(threadName);
    const match = boxes
      .filter((box) => box.x < 280 && box.y > 120 && box.y < 1000)
      .find((box) => normalizeThreadName(box.text).includes(target));

    if (!match) {
      return {
        ok: false,
        error: "desktop_thread_not_visible",
        detail: `没有在 Codex 左侧边栏看到线程：${threadName}`
      };
    }

    const clickX = Math.max(20, match.x + match.width / 2);
    const clickY = Math.max(20, match.y + match.height / 2);
    await execFilePromise("/usr/bin/swift", [clickScript, String(clickX), String(clickY)], { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { ok: true, clicked: { text: match.text, x: clickX, y: clickY } };
  } catch (error) {
    return {
      ok: false,
      error: "desktop_thread_open_failed",
      detail: error.message || String(error)
    };
  } finally {
    fs.rm(imagePath, { force: true }, () => {});
  }
}

async function captureCodexOcr() {
  const activate = await runCodexAutomation("activate");
  if (!activate.ok) return { ok: false, error: activate.error || "activate_failed" };

  const imagePath = path.join(os.tmpdir(), `codex-mobile-remote-${crypto.randomBytes(8).toString("hex")}.png`);
  try {
    await execFilePromise("/usr/sbin/screencapture", ["-x", imagePath], { timeout: 5000 });
    const { stdout } = await execFilePromise("/usr/bin/swift", [ocrScript, imagePath], {
      timeout: 20000,
      maxBuffer: 1024 * 1024
    });
    return { ok: true, text: stdout.trim() };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  } finally {
    fs.rm(imagePath, { force: true }, () => {});
  }
}

function normalizeThreadName(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function compactAxText(raw) {
  const seen = new Set();
  const lines = [];

  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split("\t").map((part) => part.trim()).filter(Boolean);
    for (const part of parts.slice(1)) {
      const normalized = part.replace(/\s+/g, " ").trim();
      if (!normalized || normalized.length < 2 || seen.has(normalized)) continue;
      seen.add(normalized);
      lines.push(normalized);
    }
  }

  return lines.join("\n");
}

function requireAuth(req, res, next) {
  if (isAuthDisabled()) return next();
  if (getSession(req)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "not_authenticated" });
  }
  res.redirect("/login");
}

function getSession(req) {
  const sid = parseCookies(req.headers.cookie || "")[cookieName];
  if (!sid) return null;

  const session = sessions.get(sid);
  if (!session) return null;

  const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
  if (Date.now() - session.createdAt > maxAgeMs) {
    sessions.delete(sid);
    return null;
  }

  session.lastSeenAt = Date.now();
  return session;
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function serializeCookie(name, value, secure) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=1209600"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function canConnect(host, targetPort, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: targetPort });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function probeVncSecurity(host, targetPort, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: targetPort });
    let step = 0;
    let chunks = [];
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish({ ok: false, error: "timeout" }));
    socket.on("error", (error) => finish({ ok: false, error: error.code || error.message }));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (step === 0 && buffer.length >= 12) {
        const protocol = buffer.subarray(0, 12).toString("ascii").trim();
        chunks = buffer.length > 12 ? [buffer.subarray(12)] : [];
        step = 1;
        socket.write("RFB 003.008\n");
        return;
      }

      if (step === 1 && buffer.length >= 1) {
        const count = buffer[0];
        if (buffer.length < count + 1) return;
        const types = [...buffer.subarray(1, 1 + count)];
        finish({
          ok: true,
          protocol: "RFB 003.889",
          types,
          hasVncPassword: types.includes(2),
          hasAppleRemoteDesktop: types.includes(30)
        });
      }
    });
  });
}

function getScreenSharingState() {
  return new Promise((resolve) => {
    execFile("/bin/launchctl", ["print", "system/com.apple.screensharing"], { timeout: 1000 }, (error, stdout) => {
      if (error) return resolve({ available: false, running: false, raw: "" });
      resolve({
        available: true,
        running: /state = running/.test(stdout),
        raw: stdout.match(/state = .+/)?.[0] || "state = unknown"
      });
    });
  });
}
