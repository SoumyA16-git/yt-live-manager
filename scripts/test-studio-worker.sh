#!/bin/bash
# test-studio-worker.sh
# Runs studio-worker.mjs standalone — only title update, NO stream start.
# Run on VPS: bash /opt/yt-live-manager/scripts/test-studio-worker.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER="$SCRIPT_DIR/studio-worker.mjs"

# Load settings from config
SETTINGS="/opt/yt-live-manager/config/settings.json"
if [ -f "$SETTINGS" ]; then
  STUDIO_URL=$(python3 -c "import json,sys; d=json.load(open('$SETTINGS')); s=d.get('studioAutomation',{}); print(s.get('url', d.get('youtube',{}).get('studioUrl','https://studio.youtube.com/video/xHUulPKBtJs/livestreaming')))" 2>/dev/null || echo "https://studio.youtube.com/video/xHUulPKBtJs/livestreaming")
  STUDIO_BASE_TITLE=$(python3 -c "import json,sys; d=json.load(open('$SETTINGS')); s=d.get('studioAutomation',{}); print(s.get('baseTitle', d.get('youtube',{}).get('title','')))" 2>/dev/null || echo "")
  STUDIO_TIMEZONE=$(python3 -c "import json,sys; d=json.load(open('$SETTINGS')); s=d.get('studioAutomation',{}); print(s.get('timezone', d.get('scheduler',{}).get('timezone','Asia/Kolkata')))" 2>/dev/null || echo "Asia/Kolkata")
else
  STUDIO_URL="https://studio.youtube.com/video/xHUulPKBtJs/livestreaming"
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
echo "============================================================"
echo ""

export DISPLAY=:10
export STUDIO_URL
export STUDIO_BASE_TITLE
export STUDIO_TIMEZONE
export STUDIO_PREVIEW_WAIT_SEC=3
export STUDIO_TIMEOUT_MS=120000
export CHROME_BIN=/usr/bin/google-chrome
export CHROME_USER_DATA_DIR=/home/ubuntu/.config/google-chrome
export CHROME_ACTIVE_DATA_DIR=/home/ubuntu/.config/google-chrome-studio

# Run worker and capture output, intercept ready_to_stream (don't actually start stream)
node "$WORKER" 2>&1 | while IFS= read -r line; do
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
done

echo ""
echo "============================================================"
echo "  Test complete."
echo "============================================================"
