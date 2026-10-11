#!/usr/bin/env bash
# update.sh — Code-only update with health verification and automatic rollback.
# PRD §21.3

set -euo pipefail

INSTALL_DIR="/opt/yt-live-manager"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
ROLLBACK_DIR="/tmp/ytlm-rollback-${TIMESTAMP}"
UPDATE_FINISHED=false
SERVICE_WAS_ACTIVE=false

echo "=========================================================="
echo "Updating 24×7 YouTube Vertical Live Streaming Manager"
echo "Timestamp: ${TIMESTAMP}"
echo "=========================================================="

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

SOURCE_REAL="$(realpath -m "${CURRENT_DIR}")"
INSTALL_REAL="$(realpath -m "${INSTALL_DIR}")"
if [[ "${SOURCE_REAL}" == "${INSTALL_REAL}" ]]; then
  echo "Error: update.sh was started from the live install directory (${INSTALL_DIR})."
  echo "Pull the source checkout first, then run: cd ~/yt-live-manager && sudo bash ./update.sh"
  exit 1
fi
if ! git -C "${CURRENT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: ${CURRENT_DIR} is not a Git checkout; refusing to deploy an unknown source tree."
  exit 1
fi
echo "Source checkout: ${CURRENT_DIR}"
echo "Live install:    ${INSTALL_DIR}"

if systemctl is-active --quiet yt-live-manager; then
  SERVICE_WAS_ACTIVE=true
fi

rollback() {
  local exit_code=${1:-1}
  trap - ERR INT TERM
  if [[ "${UPDATE_FINISHED}" == "true" ]]; then
    exit "${exit_code}"
  fi

  echo ""
  echo "Update failed; restoring the previous application code..."
  systemctl stop yt-live-manager || true
  pkill -9 -f ffmpeg || true

  if [[ -d "${ROLLBACK_DIR}/src" ]]; then cp -a "${ROLLBACK_DIR}/src/." "${INSTALL_DIR}/src/" || true; fi
  if [[ -d "${ROLLBACK_DIR}/public" ]]; then cp -a "${ROLLBACK_DIR}/public/." "${INSTALL_DIR}/public/" || true; fi
  if [[ -d "${ROLLBACK_DIR}/scripts" ]]; then cp -a "${ROLLBACK_DIR}/scripts/." "${INSTALL_DIR}/scripts/" || true; fi
  if [[ -f "${ROLLBACK_DIR}/package.json" ]]; then cp -f "${ROLLBACK_DIR}/package.json" "${INSTALL_DIR}/package.json" || true; fi
  if [[ -f "${ROLLBACK_DIR}/package-lock.json" ]]; then cp -f "${ROLLBACK_DIR}/package-lock.json" "${INSTALL_DIR}/package-lock.json" || true; fi

  if [[ "${SERVICE_WAS_ACTIVE}" == "true" ]]; then
    systemctl start yt-live-manager || true
  fi
  rm -rf "${ROLLBACK_DIR}"
  echo "Previous application code has been restored; no configuration or runtime-data restore was performed."
  exit "${exit_code}"
}

on_error() {
  local exit_code=$?
  echo "Update command failed at line ${BASH_LINENO[0]} (exit ${exit_code})."
  rollback "${exit_code}"
}
trap on_error ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

# 1. Graceful Stop
echo "--> Stopping systemd service..."
systemctl stop yt-live-manager || true
pkill -9 -f ffmpeg || true

# 2. Snapshot application code for rollback. Never snapshot/restore user data.
mkdir -p "${ROLLBACK_DIR}"
cp -r "${INSTALL_DIR}/src" "${ROLLBACK_DIR}/"
cp -r "${INSTALL_DIR}/public" "${ROLLBACK_DIR}/"
if [[ -d "${INSTALL_DIR}/scripts" ]]; then cp -r "${INSTALL_DIR}/scripts" "${ROLLBACK_DIR}/"; fi
cp "${INSTALL_DIR}/package.json" "${ROLLBACK_DIR}/"
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  cp "${INSTALL_DIR}/package-lock.json" "${ROLLBACK_DIR}/"
fi

# 3. Copy application code only. Do not copy or migrate configuration/data,
#    systemd/nginx files, videos, logs, or backups.
echo "--> Updating application files..."
for dir in src public scripts; do
  if [[ -d "${CURRENT_DIR}/${dir}" ]]; then
    mkdir -p "${INSTALL_DIR}/${dir}"
    cp -a "${CURRENT_DIR}/${dir}/." "${INSTALL_DIR}/${dir}/"
  fi
done
cp -f "${CURRENT_DIR}/package.json" "${INSTALL_DIR}/package.json"
if [[ -f "${CURRENT_DIR}/package-lock.json" ]]; then
  cp -f "${CURRENT_DIR}/package-lock.json" "${INSTALL_DIR}/package-lock.json"
fi
# 4. Install the exact application dependency versions from the lockfile.
echo "--> Updating npm dependencies..."
cd "${INSTALL_DIR}"
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# 5. Start Service
echo "--> Starting service..."
systemctl start yt-live-manager

# 6. Verification: Wait up to 30s for healthy response (PRD §21.3)
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
  journalctl -u yt-live-manager -n 25 --no-pager || true
  rollback
fi

# Clean up rollback directory on success
rm -rf "${ROLLBACK_DIR}"
UPDATE_FINISHED=true
trap - ERR INT TERM

echo ""
echo "=========================================================="
echo "✅ Update successfully applied and verified healthy!"
echo "The updater did not copy, migrate, or restore configuration/data."
echo "Normal service shutdown/start may persist runtime stream state."
echo "=========================================================="
