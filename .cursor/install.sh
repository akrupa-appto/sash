#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for sash.
# Runs after the repo is checked out. Safe to run repeatedly.
set -euo pipefail

# --- Node 24 -----------------------------------------------------------------
# The server and tests run .ts files directly with Node's type stripping, which
# is only on by default from Node 23.6+. The base image ships Node 22 (and an
# infra `node` early on PATH), so install Node 24 via nvm and make sure it wins.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 24 >/dev/null
nvm alias default 24 >/dev/null
NODE24_BIN="$(dirname "$(nvm which 24)")"
export PATH="$NODE24_BIN:$PATH"

# Make Node 24 the default `node` in the agent's interactive shells too. The
# base image pins an infra `node` (v22) early on PATH; prepending nvm's Node 24
# bin from ~/.bashrc beats it for login and interactive shells.
MARKER="# sash-node24"
if ! grep -q "$MARKER" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<'EOF'

# sash-node24: use Node 24 for direct .ts execution (type stripping)
export NVM_DIR="$HOME/.nvm"
SASH_NODE24_BIN="$(ls -d "$NVM_DIR"/versions/node/v24*/bin 2>/dev/null | tail -1)"
[ -n "$SASH_NODE24_BIN" ] && export PATH="$SASH_NODE24_BIN:$PATH"
EOF
fi

echo "node: $(node --version)  npm: $(npm --version)"

# --- Dependencies ------------------------------------------------------------
npm ci

# --- Browser for the local test harnesses ------------------------------------
# panel/content/extension tests drive a real Chromium via Playwright. Google
# Chrome is already in the base image (used by the CDP QA harness and computer
# use); this adds Playwright's own Chromium build for `chromium.launch()`.
npx --yes playwright install chromium

echo "sash install complete"
