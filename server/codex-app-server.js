import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import WebSocket from "ws";
import { findCodexBinary } from "./codex-paths.js";

const DEFAULT_URL = "ws://127.0.0.1:18795";
const DEFAULT_CONTROL_SOCKET = path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");

export class CodexAppServerClient {
  constructor({
    url = process.env.CODEX_APP_SERVER_URL || DEFAULT_URL,
    model = process.env.CODEX_MOBILE_MODEL || null,
    binary = process.env.CODEX_APP_SERVER_BIN || getDefaultCodexBinary()
  } = {}) {
    this.url = url;
    this.model = model;
    this.binary = binary;
    this.controlSocketPath = process.env.CODEX_APP_SERVER_CONTROL_SOCK || DEFAULT_CONTROL_SOCKET;
    this.preferDesktopControlSocket = process.env.CODEX_DESKTOP_CONTROL_SOCKET !== "0";
    this.requireDesktopControlSocket = process.env.CODEX_REQUIRE_DESKTOP_CONTROL_SOCKET === "1";
    this.transport = null;
    this.ws = null;
    this.proxy = null;
    this.proxyLines = null;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.initializing = null;
    this.starting = null;
    this.events = [];
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.activeTurns = new Map();
    this.lastError = null;
  }

  async status() {
    const controlSocketPresent = this.controlSocketPresent();
    const ready = this.transport === "desktop-control-socket" ? Boolean(this.initialized && this.proxy) : await this.readyz();
    return {
      ok: true,
      url: this.url,
      transport: this.transport || (controlSocketPresent ? "desktop-control-socket-available" : "bridge-websocket"),
      controlSocketPath: this.controlSocketPath,
      controlSocketPresent,
      preferDesktopControlSocket: this.preferDesktopControlSocket,
      requireDesktopControlSocket: this.requireDesktopControlSocket,
      ready,
      socket: this.socketState(),
      initialized: this.initialized,
      spawnedByBridge: Boolean(this.child),
      model: this.model || "config-default",
      binary: this.binary,
      lastError: this.lastError,
      recentEvents: this.events.slice(-20)
    };
  }

  async listThreads(params = {}) {
    await this.ensureConnection();
    return this.request("thread/list", {
      limit: 50,
      sortKey: "updated_at",
      archived: false,
      ...params
    });
  }

  async readThread(threadId, includeTurns = true) {
    await this.ensureConnection();
    return this.request("thread/read", { threadId, includeTurns });
  }

  subscribe(listener) {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async createThread({ cwd, message }) {
    await this.ensureConnection();
    const started = await this.request("thread/start", {
      cwd: cwd || null,
      ...this.modelOverride(),
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    const threadId = started.thread.id;
    if (message?.trim()) await this.sendTurn(threadId, message);
    return started;
  }

  async sendTurn(threadId, message) {
    await this.ensureConnection();
    await this.resumeThread(threadId);
    const activeTurnId = this.activeTurns.get(threadId);
    const input = [{ type: "text", text: message, text_elements: [] }];

    if (activeTurnId) {
      try {
        return await this.request("turn/steer", {
          threadId,
          input,
          expectedTurnId: activeTurnId
        });
      } catch (error) {
        this.activeTurns.delete(threadId);
        if (!/activeTurn|not.*active|precondition|steer/i.test(error.message)) throw error;
      }
    }

    return this.request("turn/start", { threadId, input, ...this.modelOverride() });
  }

  async resumeThread(threadId) {
    const response = await this.request("thread/resume", {
      threadId,
      ...this.modelOverride(),
      persistExtendedHistory: true
    });
    const status = response.thread?.status;
    if (status?.type === "running" && status.turnId) {
      this.activeTurns.set(threadId, status.turnId);
    }
    return response;
  }

  async ensureConnection() {
    if (this.preferDesktopControlSocket && this.controlSocketPresent()) {
      if (this.transport !== "desktop-control-socket") {
        this.resetSocket("switching to Codex Desktop control socket");
        this.stopBridgeServer();
      }
      try {
        return await this.ensureDesktopProxyConnection();
      } catch (error) {
        this.setLastError(`Desktop control socket failed: ${error.message || String(error)}`);
        if (this.requireDesktopControlSocket) throw error;
      }
    }

    if (this.requireDesktopControlSocket) {
      throw new Error(`Codex Desktop control socket not found: ${this.controlSocketPath}`);
    }

    if (this.transport === "desktop-control-socket") this.resetSocket("Codex Desktop control socket disappeared");
    await this.ensureServer();
    return this.ensureWebSocketConnection();
  }

  async ensureWebSocketConnection() {
    if (this.ws?.readyState === WebSocket.OPEN && this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const fail = (error) => {
        this.setLastError(error.message || String(error));
        this.resetSocket(error.message || String(error));
        reject(error);
      };

      ws.once("open", async () => {
        this.ws = ws;
        this.transport = "bridge-websocket";
        ws.on("message", (data) => this.handleMessage(data));
        ws.on("close", () => this.resetSocket("app-server websocket closed"));
        ws.on("error", (error) => {
          this.setLastError(error.message || String(error));
        });

        try {
          await this.request("initialize", {
            clientInfo: {
              name: "codex-mobile-remote",
              title: "Codex Mobile Remote",
              version: "0.1.0"
            },
            capabilities: {
              experimentalApi: true
            }
          });
          this.initialized = true;
          resolve();
        } catch (error) {
          fail(error);
        }
      });

      ws.once("error", fail);
    }).finally(() => {
      this.initializing = null;
    });

    return this.initializing;
  }

  async ensureDesktopProxyConnection() {
    if (this.proxy && this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["app-server", "proxy", "--sock", this.controlSocketPath], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"]
      });

      this.proxy = child;
      this.transport = "desktop-control-socket";
      this.proxyLines = readline.createInterface({ input: child.stdout });
      this.proxyLines.on("line", (line) => this.handleMessage(line));

      const fail = (error) => {
        const message = error.message || String(error);
        this.setLastError(message);
        this.resetSocket(message);
        reject(error);
      };

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) this.setLastError(text);
      });
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (this.proxy === child) {
          this.proxy = null;
          this.proxyLines = null;
          this.resetSocket(`Codex Desktop control proxy exited: ${code ?? signal ?? "unknown"}`);
        }
      });

      this.request("initialize", {
        clientInfo: {
          name: "codex-mobile-remote",
          title: "Codex Mobile Remote",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      }, 8000).then(() => {
        this.initialized = true;
        resolve();
      }, fail);
    }).finally(() => {
      this.initializing = null;
    });

    return this.initializing;
  }

  async ensureServer() {
    if (await this.readyz()) return;
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      const listenArg = this.url;
      const child = spawn(this.binary, ["app-server", "--listen", listenArg], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      });

      this.child = child;
      child.stdout.on("data", () => {});
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text && !/"level":"WARN"/.test(text) && !/^codex app-server/i.test(text)) this.setLastError(text);
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        this.setLastError(`app-server exited: ${code ?? signal ?? "unknown"}`);
        this.resetSocket();
      });

      this.waitForReady(8000).then(resolve, reject);
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  async waitForReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.readyz()) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("codex app-server did not become ready");
  }

  async readyz() {
    try {
      const url = new URL(this.url);
      const response = await fetch(`http://${url.host}/readyz`);
      return response.ok;
    } catch {
      return false;
    }
  }

  request(method, params, timeoutMs = 30000) {
    if (!this.canSend()) {
      return Promise.reject(new Error("app-server transport is not open"));
    }

    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method });
      this.sendPayload(payload, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  sendPayload(payload, callback) {
    const serialized = JSON.stringify(payload);
    if (this.transport === "desktop-control-socket") {
      this.proxy.stdin.write(`${serialized}\n`, callback);
      return;
    }
    this.ws.send(serialized, callback);
  }

  modelOverride() {
    return this.model ? { model: this.model } : {};
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.recordEvent(message);
  }

  recordEvent(event) {
    const entry = { at: Date.now(), method: event.method, params: event.params };
    this.events.push(entry);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    this.emitter.emit("event", entry);

    const threadId = event.params?.threadId;
    if (!threadId) return;
    if (event.method === "turn/started" && event.params?.turn?.id) {
      this.activeTurns.set(threadId, event.params.turn.id);
    }
    if (event.method === "turn/completed" || event.method === "thread/status/changed") {
      const status = event.params?.status;
      if (!status || status.type !== "running") this.activeTurns.delete(threadId);
    }
  }

  resetSocket(reason = "app-server socket closed") {
    this.initialized = false;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    if (this.proxy) {
      const proxy = this.proxy;
      this.proxy = null;
      this.proxyLines?.close();
      this.proxyLines = null;
      proxy.removeAllListeners();
      if (!proxy.killed) proxy.kill("SIGTERM");
    }
    this.transport = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  setLastError(value) {
    if (!value) return;
    this.lastError = String(value)
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 500);
  }

  canSend() {
    if (this.transport === "desktop-control-socket") return Boolean(this.proxy?.stdin?.writable);
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  socketState() {
    if (this.transport === "desktop-control-socket") return this.proxy ? "desktop-proxy-open" : "desktop-proxy-closed";
    return this.ws?.readyState === WebSocket.OPEN ? "websocket-open" : "closed";
  }

  controlSocketPresent() {
    try {
      return fs.statSync(this.controlSocketPath).isSocket();
    } catch {
      return false;
    }
  }

  stopBridgeServer() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.removeAllListeners();
    if (!child.killed) child.kill("SIGTERM");
  }
}

function getDefaultCodexBinary() {
  return findCodexBinary();
}

export function flattenThreadMessages(thread) {
  const messages = [];
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) {
      const message = flattenThreadItem(turn, item);
      if (message) messages.push(message);
    }
    if (turn.error) {
      messages.push({
        id: `${turn.id}-error`,
        turnId: turn.id,
        type: "turnError",
        role: "system",
        status: turn.status,
        startedAt: turn.startedAt || null,
        completedAt: turn.completedAt || null,
        text: normalizeTurnError(turn.error)
      });
    }
  }
  return messages;
}

function flattenThreadItem(turn, item) {
  const base = {
    id: item.id,
    turnId: turn.id,
    type: item.type,
    status: turn.status,
    startedAt: turn.startedAt || null,
    completedAt: turn.completedAt || null
  };

  if (item.type === "userMessage") {
    return {
      ...base,
      role: "user",
      text: (item.content || []).map(inputToText).filter(Boolean).join("\n\n")
    };
  }

  if (item.type === "agentMessage") {
    return { ...base, role: "assistant", text: item.text || "", phase: item.phase || null };
  }

  if (item.type === "plan") return { ...base, role: "assistant", text: item.text || "", phase: "plan" };

  // Keep the mobile view conversational, like Codex Desktop's main chat.
  // Tool calls, command output, file changes, and reasoning details stay out
  // of the phone transcript unless we add an explicit diagnostics view later.
  return null;
}

function inputToText(input) {
  if (input.type === "text") return input.text;
  if (input.type === "image") return `[image] ${input.url}`;
  if (input.type === "localImage") return `[local image] ${input.path}`;
  if (input.type === "skill") return `[$skill] ${input.name}`;
  if (input.type === "mention") return `[@mention] ${input.name}`;
  return "";
}

function normalizeTurnError(error) {
  const raw = error.message || error.additionalDetails || JSON.stringify(error);
  try {
    const parsed = JSON.parse(raw);
    if (parsed.detail) return `运行失败：${parsed.detail}`;
  } catch {}
  return `运行失败：${raw}`;
}
