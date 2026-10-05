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

# 3. Install Playwright Chromium and system dependencies
echo "[3/5] Installing Playwright Chromium browser and OS libraries..."
npx playwright install --with-deps chromium

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
