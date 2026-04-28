#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

log() {
  printf '\033[1;36m[Codex Mobile Remote]\033[0m %s\n' "$1"
}

warn() {
  printf '\033[1;33m[Warning]\033[0m %s\n' "$1"
}

fail() {
  printf '\033[1;31m[Error]\033[0m %s\n' "$1" >&2
  exit 1
}

if [ "$(uname -s)" != "Darwin" ]; then
  fail "这个项目目前面向 macOS，原因是它依赖 AppleScript、Swift OCR 和 Codex Desktop 桌面桥接。"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "没有检测到 node，请先安装 Node.js 20 或更高版本。"
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "没有检测到 npm，请先安装 Node.js 20 或更高版本。"
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 20 ]; then
  fail "当前 Node.js 版本过低：$(node -v)。请升级到 Node.js 20 或更高版本。"
fi

if [ ! -d "/Applications/Codex.app" ]; then
  warn "没有在 /Applications 里找到 Codex.app。只要你本机已经装了 Codex Desktop，且能正常启动，也可以继续。"
fi

if ! command -v tmux >/dev/null 2>&1; then
  warn "没有检测到 tmux。前台运行没问题，但 ./scripts/start-background.sh 需要 tmux。"
fi

log "安装 npm 依赖..."
npm install

log "修正脚本执行权限..."
chmod +x "$ROOT_DIR/install.sh" "$ROOT_DIR"/scripts/*.sh

if [ ! -f "$ROOT_DIR/.remote-token" ]; then
  log "生成手机访问口令..."
  node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const tokenFile = path.join(process.cwd(), ".remote-token");
const token = crypto.randomBytes(18).toString("base64url");
fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
NODE
fi

mac_ip=""
if command -v ipconfig >/dev/null 2>&1; then
  mac_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -z "$mac_ip" ]; then
    mac_ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
fi

token_preview="$(cat "$ROOT_DIR/.remote-token")"

log "安装完成。"
echo
echo "下一步建议："
echo "  1. 前台启动：npm start"
echo "  2. 或后台启动：./scripts/start-background.sh"
echo "  3. 手机访问口令：$token_preview"
if [ -n "$mac_ip" ]; then
  echo "  4. 手机访问地址：http://$mac_ip:8088"
else
  echo "  4. 手机访问地址：http://<你的Mac局域网IP>:8088"
fi
echo
echo "可选配置："
echo "  - 如果要用远程屏幕兜底，请在 macOS 打开“屏幕共享”"
echo "  - 如果要在外网访问，推荐使用 Tailscale"
