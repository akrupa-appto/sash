#!/usr/bin/env bash
# Standing Google Chrome instance for the checkto browser harness.
#
# Exposes a CDP endpoint on 127.0.0.1:9223 that the QA harness connects to:
#   node scripts/verify-extension-browser.mjs   (a.k.a. `npm run test:browser`)
# The harness drives extension/browser.js against a real Chrome tab (snapshot,
# password redaction, typing, clicking, navigation, back, abort) — the same
# CDP protocol commands chrome.debugger sends in the installed extension.
#
# Runs as a Cloud Agent terminal so its logs stay visible and it can be
# restarted. Chrome stays in the foreground under --headless=new.
set -euo pipefail

PORT="${CHECKTO_QA_CHROME_PORT:-9223}"
PROFILE="${CHECKTO_QA_CHROME_PROFILE:-/tmp/checkto-qa-chrome}"
mkdir -p "$PROFILE"

CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || echo /usr/bin/google-chrome-stable)"
echo "checkto qa-chrome: $($CHROME_BIN --version) on CDP 127.0.0.1:$PORT"

# --headless=new keeps the process in the foreground; --no-sandbox is required
# in the unprivileged Cloud Agent container.
exec "$CHROME_BIN" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
