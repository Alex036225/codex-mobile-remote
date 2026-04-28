import { spawn } from "node:child_process";
import WebSocket from "ws";
import { findCodexLaunchTarget } from "./codex-paths.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export class CodexDesktopCdp {
  constructor({ baseUrl = process.env.CODEX_DESKTOP_CDP_URL || DEFAULT_CDP_URL } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.activeTurns = new Map();
    this.bridgeProbe = { at: 0, ok: false };
    this.lastError = null;
  }

  async status() {
    try {
      const page = await this.getPageTarget();
      const client = await this.connect(page);
      try {
        const result = await client.evaluate(`(() => ({
          title: document.title,
          url: location.href,
          hasComposer: Boolean(document.querySelector('.ProseMirror, [contenteditable="true"], textarea')),
          visibleText: document.body.innerText.slice(0, 500),
          codexWindowType: window.codexWindowType || null,
          hasElectronBridge: Boolean(window.electronBridge),
          hasMcpBridge: Boolean(window.electronBridge?.sendMessageFromView)
        }))()`);
        const appServerBridgeReady = result.hasMcpBridge ? await this.probeAppServerBridge(client) : false;
        return {
          ok: true,
          ready: true,
          baseUrl: this.baseUrl,
          title: result.title,
          url: result.url,
          hasComposer: result.hasComposer,
          codexWindowType: result.codexWindowType,
          hasElectronBridge: result.hasElectronBridge,
          hasMcpBridge: result.hasMcpBridge,
          appServerBridgeReady,
          lastError: this.lastError
        };
      } finally {
        client.close();
      }
    } catch (error) {
      this.setLastError(error.message || String(error));
      return {
        ok: true,
        ready: false,
        baseUrl: this.baseUrl,
        lastError: this.lastError
      };
    }
  }

  async appServerBridgeReady() {
    const now = Date.now();
    if (now - this.bridgeProbe.at < 1500) return this.bridgeProbe.ok;
    try {
      const page = await this.getPageTarget();
      const client = await this.connect(page);
      try {
        const ok = await this.probeAppServerBridge(client);
        this.bridgeProbe = { at: Date.now(), ok };
        return ok;
      } finally {
        client.close();
      }
    } catch (error) {
      this.setLastError(error.message || String(error));
      this.bridgeProbe = { at: Date.now(), ok: false };
      return false;
    }
  }

  async launch() {
    const target = findCodexLaunchTarget();
    const args = target.endsWith(".app") || target.startsWith("/")
      ? ["-n", target, "--args", "--remote-debugging-port=9222"]
      : ["-na", target, "--args", "--remote-debugging-port=9222"];
    spawn("/usr/bin/open", args, {
      detached: true,
      stdio: "ignore"
    }).unref();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.ready) return status;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw new Error("Codex Desktop CDP did not become ready on port 9222");
  }

  async listThreads(params = {}) {
    return this.request("thread/list", {
      limit: 50,
      sortKey: "updated_at",
      archived: false,
      ...params
    });
  }

  async readThread(threadId, includeTurns = true) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  async createThread({ cwd, message }) {
    const started = await this.request("thread/start", {
      cwd: cwd || null,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    const threadId = started.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    if (message?.trim()) await this.sendTurn(threadId, message);
    return started;
  }

  async sendTurn(threadId, message) {
    if (!threadId) throw new Error("missing_thread_id");
    if (!message?.trim()) throw new Error("empty_message");

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

    const result = await this.request("turn/start", { threadId, input });
    if (result.turn?.id) this.activeTurns.set(threadId, result.turn.id);
    return result;
  }

  async openThreadInMainWindow(threadId) {
    if (!threadId?.trim()) throw new Error("missing_thread_id");

    const page = await this.getPageTarget();
    const client = await this.connect(page);
    try {
      await client.send("Page.bringToFront");
      const result = await client.evaluate(`(async () => {
        await window.electronBridge.sendMessageFromView({
          type: 'open-in-main-window',
          path: '/local/${threadId}'
        });
        return { ok: true, href: location.href };
      })()`);
      if (!result?.ok) throw new Error(result?.detail || "failed to open local thread route");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return result;
    } finally {
      client.close();
    }
  }

  async syncThreadView(threadId, threadName, expectedSnippet = "") {
    if (!threadName?.trim()) return { ok: false, detail: "missing_thread_name" };

    const page = await this.getPageTarget();
    const client = await this.connect(page);
    try {
      await client.send("Page.bringToFront");
      const result = await client.evaluate(syncThreadViewScript(threadId, threadName, expectedSnippet), 25000);
      if (!result?.ok) throw new Error(result?.detail || "thread view sync failed");
      return result;
    } finally {
      client.close();
    }
  }

  async resumeThread(threadId) {
    const response = await this.request("thread/resume", {
      threadId,
      persistExtendedHistory: true
    });
    const status = response.thread?.status;
    if (status?.type === "running" && status.turnId) {
      this.activeTurns.set(threadId, status.turnId);
    } else {
      this.activeTurns.delete(threadId);
    }
    return response;
  }

  async request(method, params, timeoutMs = 30000) {
    const page = await this.getPageTarget();
    const client = await this.connect(page);
    try {
      const result = await this.requestWithClient(client, method, params, timeoutMs);
      this.bridgeProbe = { at: Date.now(), ok: true };
      return result;
    } catch (error) {
      this.bridgeProbe = { at: Date.now(), ok: false };
      this.setLastError(error.message || String(error));
      throw error;
    } finally {
      client.close();
    }
  }

  async sendMessage({ message, threadName = "" }) {
    if (!message?.trim()) throw new Error("empty_message");

    const page = await this.getPageTarget();
    const client = await this.connect(page);
    try {
      await client.send("Page.bringToFront");
      if (threadName?.trim()) await this.openThreadWithClient(client, threadName);
      await this.focusComposer(client);
      await this.clearComposer(client);
      await client.send("Input.insertText", { text: message });
      await new Promise((resolve) => setTimeout(resolve, 120));

      const clicked = await client.evaluate(sendButtonClickScript());
      if (!clicked?.ok) {
        await client.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
        await client.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
      }

      return { ok: true, transport: "desktop-cdp", sendButton: clicked };
    } catch (error) {
      this.setLastError(error.message || String(error));
      throw error;
    } finally {
      client.close();
    }
  }

  async openThread(threadName) {
    const page = await this.getPageTarget();
    const client = await this.connect(page);
    try {
      await client.send("Page.bringToFront");
      return await this.openThreadWithClient(client, threadName);
    } finally {
      client.close();
    }
  }

  async openThreadWithClient(client, threadName) {
    const result = await client.evaluate(openThreadScript(threadName));
    if (!result?.ok) throw new Error(result?.detail || `Desktop thread not visible: ${threadName}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return result;
  }

  async focusComposer(client) {
    const result = await client.evaluate(`(() => {
      const candidates = [
        ...document.querySelectorAll('.ProseMirror[contenteditable="true"], .ProseMirror, [contenteditable="true"], textarea')
      ].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 40 && rect.height > 10;
      });
      const editor = candidates[candidates.length - 1];
      if (!editor) return { ok: false, detail: 'composer not found' };
      editor.scrollIntoView({ block: 'center' });
      editor.focus();
      return { ok: true, tag: editor.tagName, className: String(editor.className), text: editor.innerText || editor.value || '' };
    })()`);
    if (!result?.ok) throw new Error(result?.detail || "composer not found");
    return result;
  }

  async clearComposer(client) {
    const modifier = process.platform === "darwin" ? 4 : 2;
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Meta",
      code: "MetaLeft",
      modifiers: modifier,
      windowsVirtualKeyCode: 91,
      nativeVirtualKeyCode: 55
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: modifier,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 0
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: modifier,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 0
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Meta",
      code: "MetaLeft",
      modifiers: 0,
      windowsVirtualKeyCode: 91,
      nativeVirtualKeyCode: 55
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 51
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 51
    });
  }

  async getPageTarget() {
    const response = await fetch(`${this.baseUrl}/json/list`);
    if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
    const targets = await response.json();
    const page = targets.find((target) => target.type === "page" && /^app:\/\/-\//.test(target.url))
      || targets.find((target) => target.type === "page" && /Codex/i.test(target.title || ""));
    if (!page?.webSocketDebuggerUrl) throw new Error("Codex Desktop page target not found");
    return page;
  }

  async connect(target) {
    return CdpConnection.connect(target.webSocketDebuggerUrl);
  }

  async requestWithClient(client, method, params, timeoutMs = 30000) {
    return client.evaluate(mcpRequestScript(method, params, timeoutMs));
  }

  async probeAppServerBridge(client) {
    try {
      await this.requestWithClient(client, "account/read", { refreshToken: false }, 4000);
      return true;
    } catch (error) {
      this.setLastError(error.message || String(error));
      return false;
    }
  }

  setLastError(value) {
    if (!value) return;
    this.lastError = String(value).replace(/\s+/g, " ").slice(0, 500);
  }
}

class CdpConnection {
  static async connect(url) {
    const ws = new WebSocket(url);
    const connection = new CdpConnection(ws);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return connection;
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("close", () => this.rejectAll(new Error("CDP socket closed")));
    ws.on("error", (error) => this.rejectAll(error));
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async evaluate(expression, timeoutMs = 10000) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs);
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return response.result?.result?.value;
  }

  handleMessage(data) {
    const message = JSON.parse(String(data));
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.ws.close();
  }
}

function openThreadScript(threadName) {
  return `(() => {
    const target = ${JSON.stringify(normalize(threadName))};
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, '');
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left < 360;
    };
    const candidates = [...document.querySelectorAll('button, [role="button"], a')]
      .filter(visible)
      .map((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        const clickTarget = el.closest('button, [role="button"], a') || el;
        const rect = clickTarget.getBoundingClientRect();
        return { el: clickTarget, text, rect };
      })
      .filter((entry) => {
        const text = normalize(entry.text);
        const firstLine = normalize(entry.text.split('\\n')[0]);
        return entry.text
          && entry.rect.left < 320
          && entry.rect.top > 160
          && entry.rect.height >= 20
          && entry.rect.height <= 70
          && entry.rect.width >= 80
          && entry.rect.width <= 330
          && (firstLine === target || text.includes(target));
      });
    const match = candidates.find((entry) => normalize(entry.text.split('\\n')[0]) === target) || candidates[0];
    if (!match) {
      const visibleThreads = [...document.querySelectorAll('button, [role="button"], a')]
        .filter(visible)
        .map((el) => (el.innerText || el.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 40);
      return { ok: false, detail: 'thread not found in Desktop sidebar', visibleThreads };
    }
    match.el.scrollIntoView({ block: 'center' });
    match.el.click();
    return {
      ok: true,
      text: match.text.slice(0, 120),
      rect: { left: match.rect.left, top: match.rect.top, width: match.rect.width, height: match.rect.height }
    };
  })()`;
}

function sendButtonClickScript() {
  return `(() => {
    const buttons = [...document.querySelectorAll('button')].filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !button.disabled;
    });
    const explicit = buttons.find((button) => /发送|send/i.test(button.getAttribute('aria-label') || button.innerText || ''));
    const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"], .ProseMirror, [contenteditable="true"], textarea')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 40 && rect.height > 10;
      })
      .pop();
    const editorRect = editor?.getBoundingClientRect();
    const composerButton = editorRect && buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const label = button.getAttribute('aria-label') || button.innerText || '';
        return rect.top >= editorRect.top
          && rect.top <= editorRect.bottom + 80
          && rect.left > editorRect.left + editorRect.width * 0.65
          && rect.left <= editorRect.right + 80
          && !/听写|dictation|添加|attach/i.test(label);
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
    const iconButton = buttons.find((button) => String(button.className).includes('size-token-button-composer') && !/听写|dictation/i.test(button.getAttribute('aria-label') || ''));
    const button = explicit || composerButton || iconButton;
    if (!button) return { ok: false, detail: 'send button not found' };
    button.click();
    const rect = button.getBoundingClientRect();
    return { ok: true, aria: button.getAttribute('aria-label') || '', text: button.innerText || '', rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
  })()`;
}

function mcpRequestScript(method, params, timeoutMs) {
  const encodedMethod = JSON.stringify(String(method));
  const encodedParams = params === undefined ? "undefined" : JSON.stringify(params);
  const encodedTimeout = JSON.stringify(Math.max(1000, timeoutMs));

  return `(async () => {
    if (window.codexWindowType !== 'electron') {
      throw new Error('Not running inside Codex Desktop electron window');
    }

    const bridge = window.electronBridge;
    if (!bridge?.sendMessageFromView) {
      throw new Error('electronBridge.sendMessageFromView unavailable');
    }

    const hostId = 'local';
    const requestId = 'cmr-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const request = { id: requestId, method: ${encodedMethod} };
    const params = ${encodedParams};
    if (params !== undefined) request.params = params;

    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        fn(value);
      };

      const onMessage = (event) => {
        const payload = event.data;
        if (!payload || payload.type !== 'mcp-response' || payload.hostId !== hostId) return;
        const message = payload.message || {};
        if (message.id !== requestId) return;
        if (message.error) {
          finish(reject, new Error(message.error.message || JSON.stringify(message.error)));
          return;
        }
        finish(resolve, message.result);
      };

      const timer = setTimeout(() => {
        finish(reject, new Error('mcp-request timed out'));
      }, ${encodedTimeout});

      window.addEventListener('message', onMessage);
      try {
        bridge.sendMessageFromView({ type: 'mcp-request', hostId, request });
      } catch (error) {
        finish(reject, error);
      }
    });
  })()`;
}

function syncThreadViewScript(threadId, threadName, expectedSnippet) {
  return `(async () => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, '');
    const threadId = ${JSON.stringify(String(threadId || ""))};
    const target = ${JSON.stringify(normalize(threadName))};
    const expectedSnippet = ${JSON.stringify(String(expectedSnippet || "").slice(0, 160))};
    const expectedNormalized = normalize(expectedSnippet);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const clickUpdateModalCancel = () => {
      const buttons = [...document.querySelectorAll('button,[role="button"],a')];
      const cancel = buttons.find((node) => {
        const text = (node.innerText || node.textContent || '').trim();
        const rect = node.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && text === '取消'
          && rect.left > 350
          && rect.top > 200;
      });
      if (!cancel) return null;
      cancel.click();
      return '取消';
    };

    const clickThread = () => {
      const buttons = [...document.querySelectorAll('button,[role="button"],a')];
      const entry = buttons.find((node) => {
        const text = (node.innerText || node.textContent || '').trim();
        const rect = node.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && rect.left < 320
          && (normalize(text) === target || normalize(text).startsWith(target));
      });
      if (!entry) return null;
      entry.click();
      return (entry.innerText || entry.textContent || '').trim();
    };

    const dismissedUpdateModal = clickUpdateModalCancel();
    if (dismissedUpdateModal) await sleep(400);

    const clickedThread = clickThread();
    if (!clickedThread) return { ok: false, detail: 'thread button not found in sidebar' };
    await sleep(900);

    const dismissedUpdateModalAfterThread = clickUpdateModalCancel();
    if (dismissedUpdateModalAfterThread) await sleep(400);
    await sleep(700);

    const locateConversationStore = () => {
      const root = window.__codexRoot?._internalRoot;
      if (!root?.current) return null;
      const seen = new Set();
      let found = null;
      const walk = (fiber, depth = 0) => {
        if (found || !fiber || seen.has(fiber) || depth > 140) return;
        seen.add(fiber);
        let state = fiber.memoizedState;
        let guard = 0;
        while (state && guard < 60) {
          const memoized = state.memoizedState;
          if (
            memoized
            && typeof memoized === 'object'
            && memoized.requestClient
            && memoized.conversations instanceof Map
            && memoized.conversationCallbacks instanceof Map
          ) {
            found = memoized;
            return;
          }
          state = state.next;
          guard += 1;
        }
        if (fiber.child) walk(fiber.child, depth + 1);
        if (fiber.sibling) walk(fiber.sibling, depth);
      };
      walk(root.current);
      return found;
    };

    const reconcileConversationStore = async () => {
      if (!threadId) return { ok: false, detail: 'missing_thread_id' };
      const store = locateConversationStore();
      if (!store) return { ok: false, detail: 'conversation_store_not_found' };
      const current = store.conversations.get(threadId);
      if (!current) return { ok: false, detail: 'conversation_not_in_store' };

      const response = await store.requestClient.sendRequest('thread/read', { threadId, includeTurns: true });
      const thread = response?.thread;
      if (!thread?.turns?.length) return { ok: false, detail: 'thread_read_empty' };

      const normalizeTurn = (turn) => ({
        params: {
          threadId,
          input: (turn.items || [])
            .filter((item) => item.type === 'userMessage')
            .flatMap((item) => (item.content || []).map((part) => ({
              type: part.type || 'text',
              text: part.text || '',
              text_elements: part.text_elements || []
            }))),
          model: current.latestModel || null,
          cwd: current.cwd || null
        },
        turnId: turn.id,
        turnStartedAtMs: turn.startedAt ? turn.startedAt * 1000 : null,
        finalAssistantStartedAtMs: turn.completedAt ? turn.completedAt * 1000 : null,
        status: turn.status || 'completed',
        error: turn.error || null,
        diff: null,
        items: turn.items || [],
        firstTurnWorkItemStartedAtMs: null
      });

      const existingIds = new Set((current.turns || []).map((turn) => turn.turnId));
      const missingTurns = (thread.turns || []).filter((turn) => !existingIds.has(turn.id)).map(normalizeTurn);
      const nextConversation = missingTurns.length
        ? {
            ...current,
            turns: [...current.turns, ...missingTurns],
            updatedAt: thread.updatedAt ? thread.updatedAt * 1000 : current.updatedAt,
            hasUnreadTurn: true,
            threadRuntimeStatus: thread.status || current.threadRuntimeStatus
          }
        : current;

      if (missingTurns.length) {
        store.conversations.set(threadId, nextConversation);
      }

      const turnCount = nextConversation.turns?.length || current.turns?.length || 0;
      const lastTurnId = nextConversation.turns?.at(-1)?.turnId || current.turns?.at(-1)?.turnId || null;
      const updatedAtMs = nextConversation.updatedAt || (thread.updatedAt ? thread.updatedAt * 1000 : null);
      const existingAny = store.lastAnySnapshotById.get(threadId) || { id: threadId };
      const existingMeta = store.lastMetaSnapshotById.get(threadId) || { id: threadId };
      const snapshotPatch = {
        turnsLength: turnCount,
        lastTurnId,
        updatedAtMs,
        hasUnreadTurn: true
      };
      store.lastAnySnapshotById.set(threadId, { ...existingAny, ...snapshotPatch });
      store.lastMetaSnapshotById.set(threadId, { ...existingMeta, ...snapshotPatch });

      if (typeof store.lastAnyOrderKey?.set === 'function') {
        store.lastAnyOrderKey.set(threadId, updatedAtMs || Date.now());
      }
      if (typeof store.lastMetaOrderKey?.set === 'function') {
        store.lastMetaOrderKey.set(threadId, updatedAtMs || Date.now());
      }

      for (const cb of store.anyConversationCallbacks || []) {
        try { cb(); } catch {}
        try { cb(threadId); } catch {}
      }
      for (const cb of store.anyConversationMetaCallbacks || []) {
        try { cb(); } catch {}
        try { cb(threadId); } catch {}
      }
      for (const cb of store.conversationCallbacks.get(threadId) || []) {
        try { cb(); } catch {}
        try { cb(nextConversation); } catch {}
      }

      return {
        ok: true,
        turnCount,
        lastTurnId,
        missingTurns: missingTurns.length
      };
    };

    const reconciled = await reconcileConversationStore();
    await sleep(500);

    const scroller = [...document.querySelectorAll('main *')].find((node) => {
      const className = String(node.className || '');
      return className.includes('overflow-y-auto') && className.includes('flex-col-reverse');
    });

    const findLatestMarker = () => {
      const markers = [...document.querySelectorAll('[data-content-search-turn-key], [data-content-search-unit-key]')];
      if (!markers.length) return null;
      if (!expectedNormalized) return markers.at(-1) || null;

      const matching = markers.filter((node) => normalize(node.innerText || node.textContent || '').includes(expectedNormalized));
      return matching.at(-1) || markers.at(-1) || null;
    };

    let latestMarker = null;
    let hasExpectedSnippet = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      latestMarker = findLatestMarker();
      if (latestMarker) {
        const markerText = latestMarker.innerText || latestMarker.textContent || '';
        hasExpectedSnippet = expectedNormalized ? normalize(markerText).includes(expectedNormalized) : false;
      }
      if (!expectedNormalized || hasExpectedSnippet) break;
      await sleep(500);
    }

    if (latestMarker) {
      latestMarker.scrollIntoView({ block: 'end', inline: 'nearest' });
      await sleep(250);
    }

    if (scroller) {
      const latestUnit = [...document.querySelectorAll('[data-content-search-unit-key]')].at(-1);
      latestUnit?.scrollIntoView({ block: 'end', inline: 'nearest' });
      await sleep(250);
    }

    const body = document.body.innerText || '';
    const visibleMain = [...document.querySelectorAll('main *')]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const text = (node.innerText || node.textContent || '').trim();
        return { rect, text };
      })
      .filter((entry) => entry.rect.left > 300 && entry.rect.top >= 40 && entry.rect.top < window.innerHeight && entry.rect.width > 0 && entry.rect.height > 0 && entry.text)
      .map((entry) => entry.text)
      .join('\\n')
      .slice(0, 2000);
    return {
      ok: true,
      clickedThread,
      clickedRefresh: null,
      dismissedUpdateModal: dismissedUpdateModal || dismissedUpdateModalAfterThread || null,
      hasExpectedSnippet: expectedSnippet ? body.includes(expectedSnippet) || hasExpectedSnippet : null,
      href: location.href,
      bodyPreview: body.slice(0, 3000),
      visibleMainPreview: visibleMain,
      reconciled,
      latestMarkerText: latestMarker ? (latestMarker.innerText || latestMarker.textContent || '').slice(0, 500) : '',
      latestMarkerKey: latestMarker?.getAttribute('data-content-search-unit-key') || latestMarker?.getAttribute('data-content-search-turn-key') || null,
      scroller: scroller ? {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight
      } : null
    };
  })()`;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}
