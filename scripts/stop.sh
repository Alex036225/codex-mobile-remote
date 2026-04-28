#!/usr/bin/env bash
set -euo pipefail

session="codex-mobile-remote"
if ! tmux has-session -t "$session" 2>/dev/null; then
  echo "Not running: $session"
  exit 0
fi

tmux kill-session -t "$session"
echo "Stopped tmux session: $session"

if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -tiTCP:18795 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    echo "Stopped codex app-server on 127.0.0.1:18795"
  fi
fi
