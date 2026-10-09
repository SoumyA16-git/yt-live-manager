#!/bin/bash
# test-studio-worker.sh
# Runs studio-worker.mjs standalone — only title update, NO stream start.
# Run on VPS: bash ~/yt-live-manager/scripts/test-studio-worker.sh

set -euo pipefail

# App root where node_modules lives (the installed service location)
APP_ROOT="/opt/yt-live-manager"
WORKER="$APP_ROOT/scripts/studio-worker.mjs"

# Export NODE_PATH so node can find puppeteer-core from the installed app
export NODE_PATH="$APP_ROOT/node_modules"

# Load settings from config
SETTINGS="$APP_ROOT/config/settings.json"
if [ -f "$SETTINGS" ]; then
  STUDIO_URL=$(python3 -c "import json,sys; d=json.load(open('$SETTINGS')); s=d.get('studioAutomation',{}); print(s.get('url', d.get('youtube',{}).get('studioUrl','https://studio.youtube.com/video/uJyJyeNDoMM/livestreaming')))" 2>/dev/null || echo "https://studio.youtube.com/video/uJyJyeNDoMM/livestreaming")
  STUDIO_BASE_TITLE=$(python3 -c "import json,sys; d=json.load(open('$SETTINGS')); s=d.get('studioAutomation',{}); print(s.get('baseTitle', d.get('youtube',{}).get('title','')))" 2>/dev/null || echo "")
  STUDIO_TIMEZONE=$(python3 -c "import json,sys; d=json.load(open('$SETTINGS')); s=d.get('studioAutomation',{}); print(s.get('timezone', d.get('scheduler',{}).get('timezone','Asia/Kolkata')))" 2>/dev/null || echo "Asia/Kolkata")
else
  STUDIO_URL="https://studio.youtube.com/video/uJyJyeNDoMM/livestreaming"
  STUDIO_BASE_TITLE=""
  STUDIO_TIMEZONE="Asia/Kolkata"
fi

echo "============================================================"
echo "  STUDIO WORKER TEST — Title update only, no stream start"
echo "============================================================"
echo "  URL:        $STUDIO_URL"
echo "  Base Title: ${STUDIO_BASE_TITLE:-'(read from Studio)'}"
echo "  Timezone:   $STUDIO_TIMEZONE"
echo "  Worker:     $WORKER"
echo "  Mode:       TITLE ONLY — FFmpeg and Go Live are disabled"
echo "============================================================"
echo ""

DESIRED_STATE=$(python3 -c "import json; s=json.load(open('$APP_ROOT/data/stream-state.json')); print(s.get('desiredState',''))" 2>/dev/null || echo "")
if [[ "$DESIRED_STATE" != "stopped" ]]; then
  echo "❌ Refusing simulation: desired stream state is '$DESIRED_STATE', expected 'stopped'."
  exit 1
fi
if pgrep -x ffmpeg >/dev/null 2>&1; then
  echo "❌ Refusing simulation: an FFmpeg process is already running."
  exit 1
fi

export DISPLAY=:10
export STUDIO_URL
export STUDIO_BASE_TITLE
export STUDIO_TIMEZONE
export STUDIO_PREVIEW_WAIT_SEC=3
export STUDIO_TIMEOUT_MS=120000
export STUDIO_TITLE_ONLY_TEST=1
export CHROME_BIN=/usr/bin/google-chrome
export CHROME_USER_DATA_DIR=/home/ubuntu/.config/google-chrome
export CHROME_ACTIVE_DATA_DIR=/home/ubuntu/.config/google-chrome-studio

# Run worker in an explicit title-only mode. It exits after persisted-title
# read-back, before emitting ready_to_stream or waiting for an RTMPS ack.
TEST_LOG=$(mktemp)
trap 'rm -f "$TEST_LOG"' EXIT
set +e
node "$WORKER" 2>&1 | tee "$TEST_LOG" | while IFS= read -r line; do
  echo "$line"

  # Parse STUDIO_WORKER JSON logs for pretty output
  if echo "$line" | grep -q '\[STUDIO_WORKER\]'; then
    STEP=$(echo "$line" | python3 -c "
import sys,json
try:
  l = sys.stdin.read()
  idx = l.find('{')
  if idx >= 0:
    d = json.loads(l[idx:])
    step = d.get('step','')
    msg  = d.get('message','')
    extra = {k:v for k,v in d.items() if k not in ('time','step','message')}
    extra_str = ' | ' + str(extra) if extra else ''
    print(f'  [{step}] {msg}{extra_str}')
except:
  pass
" 2>/dev/null || true)
    [ -n "$STEP" ] && echo -e "\033[36m$STEP\033[0m"
  fi

  # Detect final outcome
  if echo "$line" | grep -q '"step":"verify_ok"'; then
    echo ""
    echo -e "\033[32m✅ TITLE VERIFIED — Title was saved and confirmed on reload!\033[0m"
  fi
  if echo "$line" | grep -q '"step":"finished"'; then
    echo ""
    if echo "$line" | grep -q '"success":true'; then
      echo -e "\033[32m✅ WORKER FINISHED SUCCESSFULLY\033[0m"
    else
      echo -e "\033[31m❌ WORKER FINISHED WITH ERROR\033[0m"
    fi
  fi
  if echo "$line" | grep -q '"step":"fatal_error"'; then
    echo ""
    echo -e "\033[31m❌ FATAL ERROR — see above for details\033[0m"
  fi
  if echo "$line" | grep -q '"step":"verify_retry_ok"'; then
    echo ""
    echo -e "\033[33m⚠️  Title verified after retry\033[0m"
  fi
  if echo "$line" | grep -q '"step":"title_only_test_passed"'; then
    echo ""
    echo -e "\033[32m✅ TITLE-ONLY SIMULATION PASSED — no stream was started\033[0m"
  fi
done
PIPE_STATUS=("${PIPESTATUS[@]}")
set -e

if [[ "${PIPE_STATUS[0]}" -ne 0 ]]; then
  echo "❌ Studio worker exited with status ${PIPE_STATUS[0]}"
  exit "${PIPE_STATUS[0]}"
fi
if ! grep -q '"step":"title_only_test_passed"' "$TEST_LOG"; then
  echo "❌ Studio worker exited without the title-only verification marker."
  exit 1
fi
if pgrep -x ffmpeg >/dev/null 2>&1; then
  echo "❌ Safety check failed: an FFmpeg process appeared during the title-only simulation."
  exit 1
fi
DESIRED_STATE=$(python3 -c "import json; s=json.load(open('$APP_ROOT/data/stream-state.json')); print(s.get('desiredState',''))" 2>/dev/null || echo "")
if [[ "$DESIRED_STATE" != "stopped" ]]; then
  echo "❌ Safety check failed: desired stream state changed to '$DESIRED_STATE'."
  exit 1
fi

echo ""
echo "============================================================"
echo "  Title-only simulation complete; stream remains stopped."
echo "============================================================"
