#!/usr/bin/env bash
set -euo pipefail

session="codex-mobile-remote"
pid_file="/tmp/codex-mobile-remote.pid"
stopped=0

if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$session" 2>/dev/null; then
  tmux kill-session -t "$session"
  echo "Stopped tmux session: $session"
  stopped=1
fi

if [ -f "$pid_file" ]; then
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "Stopped background process: $pid"
    stopped=1
  fi
  rm -f "$pid_file"
fi

if [ "$stopped" -eq 0 ]; then
  echo "Not running: $session"
fi

if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -tiTCP:18795 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    echo "Stopped codex app-server on 127.0.0.1:18795"
  fi
fi
