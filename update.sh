#!/usr/bin/env bash
# update.sh — Safe update with backup, health verification, and automatic rollback.
# PRD §21.3

set -euo pipefail

INSTALL_DIR="/opt/yt-live-manager"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_ARCHIVE="${INSTALL_DIR}/backups/update-${TIMESTAMP}.tar.gz"
ROLLBACK_DIR="/tmp/ytlm-rollback-${TIMESTAMP}"

echo "=========================================================="
echo "Updating 24×7 YouTube Vertical Live Streaming Manager"
echo "Timestamp: ${TIMESTAMP}"
echo "=========================================================="

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

# 1. Graceful Stop
echo "--> Stopping systemd service..."
systemctl stop yt-live-manager || true

# 2. Backup config and data
echo "--> Creating pre-update backup of config and data..."
mkdir -p "${INSTALL_DIR}/backups"
tar -czf "${BACKUP_ARCHIVE}" -C "${INSTALL_DIR}" config data
chmod 0600 "${BACKUP_ARCHIVE}"
chown ytlive:ytlive "${BACKUP_ARCHIVE}"

# Create full code snapshot for rollback
mkdir -p "${ROLLBACK_DIR}"
cp -r "${INSTALL_DIR}/src" "${ROLLBACK_DIR}/"
cp -r "${INSTALL_DIR}/public" "${ROLLBACK_DIR}/"
cp "${INSTALL_DIR}/package.json" "${ROLLBACK_DIR}/"
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  cp "${INSTALL_DIR}/package-lock.json" "${ROLLBACK_DIR}/"
fi

rollback() {
  echo ""
  echo "🚨 VERIFICATION FAILED! Initiating automatic rollback..."
  systemctl stop yt-live-manager || true
  cp -r "${ROLLBACK_DIR}/src" "${INSTALL_DIR}/"
  cp -r "${ROLLBACK_DIR}/public" "${INSTALL_DIR}/"
  cp "${ROLLBACK_DIR}/package.json" "${INSTALL_DIR}/"
  if [[ -f "${ROLLBACK_DIR}/package-lock.json" ]]; then
    cp "${ROLLBACK_DIR}/package-lock.json" "${INSTALL_DIR}/"
  fi
  systemctl start yt-live-manager
  rm -rf "${ROLLBACK_DIR}"
  echo "Rollback restored previous version. Review logs via: journalctl -u yt-live-manager -n 50"
  exit 1
}

# 3. Copy New Code (Preserving config, data, videos, logs, backups)
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "--> Updating application files..."
cp -ru "${CURRENT_DIR}/src" "${INSTALL_DIR}/"
cp -ru "${CURRENT_DIR}/public" "${INSTALL_DIR}/"
cp -ru "${CURRENT_DIR}/scripts" "${INSTALL_DIR}/"
cp -ru "${CURRENT_DIR}/systemd" "${INSTALL_DIR}/"
cp -ru "${CURRENT_DIR}/nginx" "${INSTALL_DIR}/"
cp -u "${CURRENT_DIR}/package.json" "${INSTALL_DIR}/"
if [[ -f "${CURRENT_DIR}/package-lock.json" ]]; then
  cp -u "${CURRENT_DIR}/package-lock.json" "${INSTALL_DIR}/"
fi
if [[ -f "${CURRENT_DIR}/systemd/yt-live-manager.service" ]]; then
  cp "${CURRENT_DIR}/systemd/yt-live-manager.service" "/etc/systemd/system/yt-live-manager.service"
  systemctl daemon-reload
fi

# 4. Dependency Update
echo "--> Updating npm dependencies..."
cd "${INSTALL_DIR}"
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# 5. Schema Migration Check
echo "--> Checking schema migrations..."
node scripts/migrate.js --dry-run
node scripts/migrate.js

# 6. Start Service
echo "--> Starting service..."
systemctl start yt-live-manager

# 7. Verification: Wait up to 30s for healthy response (PRD §21.3)
echo "--> Verifying health check within 30 seconds..."
HEALTHY=false
for i in {1..30}; do
  if systemctl is-active --quiet yt-live-manager; then
    HEALTH_RESP=$(curl -s http://127.0.0.1:3000/api/health 2>/dev/null || echo "")
    if echo "${HEALTH_RESP}" | grep -q '"status":"ok"'; then
      HEALTHY=true
      break
    fi
  fi
  sleep 1
done

if [[ "${HEALTHY}" != "true" ]]; then
  rollback
fi

# Clean up rollback directory on success
rm -rf "${ROLLBACK_DIR}"

echo ""
echo "=========================================================="
echo "✅ Update successfully applied and verified healthy!"
echo "Backup archive stored at: ${BACKUP_ARCHIVE}"
echo "=========================================================="
