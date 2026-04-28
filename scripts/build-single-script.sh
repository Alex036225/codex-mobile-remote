#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
OUT_FILE="$DIST_DIR/codex-mobile-remote.sh"
TMP_DIR="$(mktemp -d)"
PAYLOAD="$TMP_DIR/codex-mobile-remote.tar.gz"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"
mkdir -p "$DIST_DIR"

tar \
  --exclude=".git" \
  --exclude="node_modules" \
  --exclude="dist" \
  --exclude=".remote-token" \
  --exclude=".vnc-password" \
  --exclude=".cmr-config" \
  --exclude=".DS_Store" \
  -czf "$PAYLOAD" .

cat > "$OUT_FILE" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

title="Codex Mobile Remote"

say() {
  printf '\033[1;36m[%s]\033[0m %s\n' "$title" "$1"
}

warn() {
  printf '\033[1;33m[提醒]\033[0m %s\n' "$1"
}

fail() {
  printf '\033[1;31m[错误]\033[0m %s\n' "$1" >&2
  exit 1
}

prompt() {
  local message="$1"
  local default_value="${2:-}"
  local answer=""
  if [ -n "$default_value" ]; then
    printf "%s [%s]: " "$message" "$default_value" >&2
  else
    printf "%s: " "$message" >&2
  fi
  read -r answer
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi
  printf "%s" "$answer"
}

random_token() {
  node --input-type=module -e 'import crypto from "node:crypto"; console.log(crypto.randomBytes(18).toString("base64url"))'
}

mac_ip() {
  local ip=""
  if command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
    if [ -z "$ip" ]; then
      ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
    fi
  fi
  printf "%s" "$ip"
}

extract_payload() {
  local target_dir="$1"
  local marker="__CODEX_MOBILE_REMOTE_PAYLOAD__"
  local line=""
  line="$(awk "/^$marker\$/ { print NR + 1; exit 0; }" "$0")"
  if [ -z "$line" ]; then
    fail "没有找到内嵌项目数据，脚本可能不完整。"
  fi
  mkdir -p "$target_dir"
  tail -n +"$line" "$0" | base64 --decode | tar -xzf - -C "$target_dir"
}

if [ "$(uname -s)" != "Darwin" ]; then
  fail "这个一键脚本目前只支持 macOS。"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "没有检测到 Node.js / npm。请先安装 Node.js 20 或更高版本：https://nodejs.org/"
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 20 ]; then
  fail "当前 Node.js 版本是 $(node -v)，需要 Node.js 20 或更高版本。"
fi

say "这个脚本会把完整项目释放到本机，并启动手机网页服务。"
echo

default_dir="$HOME/Applications/Codex Mobile Remote"
install_dir="$(prompt "安装目录" "$default_dir")"
echo
port="$(prompt "手机网页端口" "8088")"
echo

if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  fail "端口必须是 1 到 65535 之间的数字。"
fi

token="$(prompt "手机登录口令，留空则自动生成" "")"
echo
if [ -z "$token" ]; then
  token="$(random_token)"
fi

codex_app="$(prompt "Codex.app 路径，默认会自动寻找" "/Applications/Codex.app")"
echo

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

say "释放项目到：$install_dir"
extract_payload "$install_dir"
cd "$install_dir"

printf '%s\n' "$token" > .remote-token
chmod 600 .remote-token

cat > .cmr-config <<EOF
PORT=$port
VNC_HOST=127.0.0.1
VNC_PORT=5900
CODEX_DESKTOP_APP=$(shell_quote "$codex_app")
EOF
chmod 600 .cmr-config

say "安装依赖"
npm install

say "修正脚本权限"
chmod +x install.sh scripts/*.sh
if [ -f "Codex Mobile Remote.app/Contents/MacOS/codex-mobile-remote" ]; then
  chmod +x "Codex Mobile Remote.app/Contents/MacOS/codex-mobile-remote"
fi

say "启动后台服务"
./scripts/start-background.sh

ip="$(mac_ip)"
if [ -n "$ip" ]; then
  phone_url="http://$ip:$port"
else
  phone_url="http://<你的Mac局域网IP>:$port"
fi

echo
say "完成"
echo
echo "手机访问地址："
echo "  $phone_url"
echo
echo "手机登录口令："
echo "  $token"
echo
echo "本机页面："
echo "  http://localhost:$port"
echo
echo "安装目录："
echo "  $install_dir"
echo
echo "停止服务："
echo "  \"$install_dir/scripts/stop.sh\""
echo

if command -v open >/dev/null 2>&1; then
  open "http://localhost:$port" >/dev/null 2>&1 || true
fi

exit 0
__CODEX_MOBILE_REMOTE_PAYLOAD__
SCRIPT

base64 < "$PAYLOAD" >> "$OUT_FILE"
printf '\n' >> "$OUT_FILE"
chmod +x "$OUT_FILE"

echo "Built $OUT_FILE"
