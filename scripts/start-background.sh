#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

session="codex-mobile-remote"
pid_file="/tmp/codex-mobile-remote.pid"

if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$session" 2>/dev/null; then
  echo "Already running in tmux session: $session"
  exit 0
fi

if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "Already running with pid: $(cat "$pid_file")"
  exit 0
fi

if command -v tmux >/dev/null 2>&1; then
  tmux new-session -d -s "$session" "cd '$PWD' && ./scripts/run-server.sh 2>&1 | tee /tmp/codex-mobile-remote.log"
  echo "Started tmux session: $session"
  exit 0
fi

nohup ./scripts/run-server.sh >/tmp/codex-mobile-remote.log 2>&1 &
echo "$!" > "$pid_file"
echo "Started background process: $(cat "$pid_file")"
