#!/usr/bin/env bash
# scripts/update.sh — One-command update script for production VPS
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

echo "========================================================"
echo "   UPDATING YT-LIVE-MANAGER WITH PLAYWRIGHT AUTOMATION "
echo "========================================================"

# 1. Pull latest git code
echo "[1/5] Pulling latest code from git..."
git pull origin main

# 2. Install npm dependencies
echo "[2/5] Installing npm dependencies..."
npm install

# 3. Ensure real Google Chrome is installed (required to avoid Google "This browser or app may not be secure" error)
echo "[3/5] Checking Google Chrome installation..."
if ! command -v google-chrome &>/dev/null && ! command -v google-chrome-stable &>/dev/null; then
  echo "Installing official Google Chrome stable on Linux VPS..."
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb
  sudo apt-get update -y && sudo apt-get install -y /tmp/chrome.deb && rm -f /tmp/chrome.deb
else
  echo "Real Google Chrome binary is already installed ($(command -v google-chrome || command -v google-chrome-stable))."
fi

# 4. Install display tools for one-time login if missing
echo "[4/5] Checking display tools (xvfb, x11vnc)..."
if ! command -v Xvfb &>/dev/null || ! command -v x11vnc &>/dev/null; then
  echo "Installing xvfb and x11vnc for one-time login bootstrap..."
  sudo apt-get update -y && sudo apt-get install -y xvfb x11vnc
fi

# 5. Reload and restart systemd service
echo "[5/5] Reloading and restarting yt-live-manager systemd service..."
sudo systemctl daemon-reload
sudo systemctl restart yt-live-manager

echo "========================================================"
echo "   UPDATE COMPLETE!                                     "
echo "========================================================"
echo ""
echo "If this is your first time setting up the Playwright profile,"
echo "run the one-time authentication bootstrap:"
echo "  npm run youtube:login"
echo ""
echo "To monitor live logs:"
echo "  sudo journalctl -u yt-live-manager -f --output=cat"
echo "========================================================"
