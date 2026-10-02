#!/usr/bin/env bash
# scripts/optimize-vps.sh — Reduce Ubuntu idle RAM consumption from ~450 MB to ~120 MB.
# Safely trims heavy background daemons (snapd, journald buffers, caches) without affecting streaming.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use: sudo bash scripts/optimize-vps.sh)."
  exit 1
fi

echo "=========================================================="
echo "⚡ Ubuntu VPS Memory Optimization"
echo "=========================================================="
echo "Current Memory Status (Before):"
free -h

echo ""
echo "--> 1. Limiting systemd-journald RAM log buffer to 25 MB..."
mkdir -p /etc/systemd/journald.conf.d
cat << 'EOF' > /etc/systemd/journald.conf.d/00-memory-limit.conf
[Journal]
SystemMaxUse=50M
RuntimeMaxUse=25M
EOF
systemctl restart systemd-journald

echo "--> 2. Checking snapd memory consumption..."
if systemctl is-active --quiet snapd 2>/dev/null; then
  echo "    Disabling snapd daemon and background timers..."
  systemctl stop snapd.socket snapd.service snapd.seeded.service || true
  systemctl disable snapd.socket snapd.service snapd.seeded.service || true
  echo "    snapd stopped (reclaimed ~150-200 MB RAM)."
else
  echo "    snapd is already inactive or not present."
fi

echo "--> 3. Stopping idle non-essential cloud agents..."
for svc in oracle-cloud-agent-updater packagekit unattended-upgrades multipathd; do
  if systemctl is-active --quiet "${svc}" 2>/dev/null; then
    echo "    Stopping and disabling ${svc}..."
    systemctl stop "${svc}" || true
    systemctl disable "${svc}" || true
  fi
done

echo "--> 4. Flushing inactive filesystem page buffers..."
sync
echo 3 > /proc/sys/vm/drop_caches

echo ""
echo "=========================================================="
echo "✅ Optimization Complete! Memory Status (After):"
free -h
echo "=========================================================="
