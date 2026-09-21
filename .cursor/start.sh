#!/usr/bin/env bash
# Per-boot service bring-up for sash. Idempotent, and returns once services
# are ready (nothing here stays in the foreground).
#
#   1. qa-chrome  — headless Google Chrome with a CDP endpoint on 127.0.0.1:9223,
#                   the target the browser harness (`npm run test:browser`) drives.
#   2. dev server — src/server.ts, but only when a planner key is present, since
#                   without OPENROUTER_API_KEY it has nothing to serve.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# Node 24 on PATH (the server runs .ts directly; the base image's infra node is v22).
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
NODE24_BIN="$(ls -d "$NVM_DIR"/versions/node/v24*/bin 2>/dev/null | tail -1 || true)"
[ -n "$NODE24_BIN" ] && export PATH="$NODE24_BIN:$PATH"

QA_PORT="${SASH_QA_CHROME_PORT:-9223}"

# --- 1. qa-chrome harness ----------------------------------------------------
if curl -s -o /dev/null "http://127.0.0.1:$QA_PORT/json/version"; then
  echo "qa-chrome: already listening on $QA_PORT"
else
  echo "qa-chrome: launching headless Chrome on CDP $QA_PORT"
  nohup bash "$here/qa-chrome.sh" >/tmp/qa-chrome.log 2>&1 &
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:$QA_PORT/json/version"; then break; fi
    sleep 1
  done
  if curl -s -o /dev/null "http://127.0.0.1:$QA_PORT/json/version"; then
    echo "qa-chrome: ready on $QA_PORT"
  else
    echo "qa-chrome: FAILED to become ready; see /tmp/qa-chrome.log" >&2
    tail -20 /tmp/qa-chrome.log >&2 || true
  fi
fi

# --- 2. dev server (opt-in on secrets) ---------------------------------------
# Needs OPENROUTER_API_KEY (planner/provider) and, for live browser sessions,
# ANCHOR_API_KEY. With no planner key the server is inert, so skip it.
PORT="${PORT:-8791}"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
    echo "sash server: already listening on $PORT"
  else
    echo "sash server: starting on $PORT"
    ( cd "$here/.." && nohup npm start >/tmp/sash-server.log 2>&1 & )
    for _ in $(seq 1 30); do
      if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health"; then break; fi
      sleep 1
    done
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
      echo "sash server: health OK on $PORT"
      [ -z "${ANCHOR_API_KEY:-}" ] && echo "sash server: note — set ANCHOR_API_KEY to enable live browser sessions"
    else
      echo "sash server: not healthy yet; see /tmp/sash-server.log" >&2
    fi
  fi
else
  echo "sash server: skipped (set OPENROUTER_API_KEY, plus ANCHOR_API_KEY for browser sessions, to enable)"
fi

echo "sash start complete"
