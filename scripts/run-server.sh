#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f ".cmr-config" ]; then
  set -a
  . "./.cmr-config"
  set +a
fi

export PORT="${PORT:-8088}"
export VNC_HOST="${VNC_HOST:-127.0.0.1}"
export VNC_PORT="${VNC_PORT:-5900}"

exec node server/index.js "$@"
