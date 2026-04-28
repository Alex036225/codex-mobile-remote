#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

session="codex-mobile-remote"
if tmux has-session -t "$session" 2>/dev/null; then
  echo "Already running in tmux session: $session"
  exit 0
fi

tmux new-session -d -s "$session" "cd '$PWD' && node server/index.js 2>&1 | tee /tmp/codex-mobile-remote.log"
echo "Started tmux session: $session"
