#!/usr/bin/env bash
# update.sh — Safe update with backup, health verification, and automatic rollback.
# PRD §21.3

set -euo pipefail

INSTALL_DIR="/opt/yt-live-manager"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_ARCHIVE="${INSTALL_DIR}/backups/update-${TIMESTAMP}.tar.gz"
ROLLBACK_DIR="/tmp/ytlm-rollback-${TIMESTAMP}"
UPDATE_FINISHED=false
SERVICE_WAS_ACTIVE=false
SERVICE_UNIT="/etc/systemd/system/yt-live-manager.service"

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
  echo "Update failed; restoring the previous application state..."
  systemctl stop yt-live-manager || true
  pkill -9 -f ffmpeg || true

  if [[ -d "${ROLLBACK_DIR}/src" ]]; then cp -a "${ROLLBACK_DIR}/src/." "${INSTALL_DIR}/src/" || true; fi
  if [[ -d "${ROLLBACK_DIR}/public" ]]; then cp -a "${ROLLBACK_DIR}/public/." "${INSTALL_DIR}/public/" || true; fi
  if [[ -d "${ROLLBACK_DIR}/scripts" ]]; then cp -a "${ROLLBACK_DIR}/scripts/." "${INSTALL_DIR}/scripts/" || true; fi
  if [[ -d "${ROLLBACK_DIR}/systemd" ]]; then cp -a "${ROLLBACK_DIR}/systemd/." "${INSTALL_DIR}/systemd/" || true; fi
  if [[ -d "${ROLLBACK_DIR}/nginx" ]]; then cp -a "${ROLLBACK_DIR}/nginx/." "${INSTALL_DIR}/nginx/" || true; fi
  if [[ -f "${ROLLBACK_DIR}/package.json" ]]; then cp -f "${ROLLBACK_DIR}/package.json" "${INSTALL_DIR}/package.json" || true; fi
  if [[ -f "${ROLLBACK_DIR}/package-lock.json" ]]; then cp -f "${ROLLBACK_DIR}/package-lock.json" "${INSTALL_DIR}/package-lock.json" || true; fi
  if [[ -f "${ROLLBACK_DIR}/yt-live-manager.service" ]]; then cp -f "${ROLLBACK_DIR}/yt-live-manager.service" "${SERVICE_UNIT}" || true; fi

  # Restore only user-owned settings and the video metadata index. Stream state
  # is deliberately excluded so a stale resume bookmark cannot auto-start a stream.
  if [[ -f "${BACKUP_ARCHIVE}" ]]; then
    local members
    members="$(tar -tzf "${BACKUP_ARCHIVE}" 2>/dev/null || true)"
    if grep -qx 'config/settings.json' <<<"${members}"; then
      tar -xzf "${BACKUP_ARCHIVE}" -C "${INSTALL_DIR}" config/settings.json || true
    fi
    if grep -qx 'data/videos.json' <<<"${members}"; then
      tar -xzf "${BACKUP_ARCHIVE}" -C "${INSTALL_DIR}" data/videos.json || true
    fi
  fi

  systemctl daemon-reload || true
  if [[ "${SERVICE_WAS_ACTIVE}" == "true" ]]; then
    systemctl start yt-live-manager || true
  fi
  rm -rf "${ROLLBACK_DIR}"
  echo "Previous application code and pre-update settings/video metadata have been restored."
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

# 2. Backup config and data
echo "--> Creating pre-update backup of config and data..."
mkdir -p "${INSTALL_DIR}/backups"
shopt -s nullglob
BACKUP_MEMBERS=(config data)
for state_backup in "${INSTALL_DIR}"/backups/settings.*.json "${INSTALL_DIR}"/backups/videos.*.json; do
  BACKUP_MEMBERS+=("backups/$(basename "${state_backup}")")
done
shopt -u nullglob
tar -czf "${BACKUP_ARCHIVE}" -C "${INSTALL_DIR}" "${BACKUP_MEMBERS[@]}"
chmod 0600 "${BACKUP_ARCHIVE}"
chown ubuntu:ubuntu "${BACKUP_ARCHIVE}" 2>/dev/null || chown ytlive:ytlive "${BACKUP_ARCHIVE}" 2>/dev/null || true

# Create full code snapshot for rollback
mkdir -p "${ROLLBACK_DIR}"
cp -r "${INSTALL_DIR}/src" "${ROLLBACK_DIR}/"
cp -r "${INSTALL_DIR}/public" "${ROLLBACK_DIR}/"
for dir in scripts systemd nginx; do
  if [[ -d "${INSTALL_DIR}/${dir}" ]]; then cp -r "${INSTALL_DIR}/${dir}" "${ROLLBACK_DIR}/"; fi
done
cp "${INSTALL_DIR}/package.json" "${ROLLBACK_DIR}/"
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  cp "${INSTALL_DIR}/package-lock.json" "${ROLLBACK_DIR}/"
fi
if [[ -f "${SERVICE_UNIT}" ]]; then cp "${SERVICE_UNIT}" "${ROLLBACK_DIR}/yt-live-manager.service"; fi

# 3. Copy New Code (Preserving config, data, videos, logs, backups)
echo "--> Updating application files..."
for dir in src public scripts systemd nginx; do
  if [[ -d "${CURRENT_DIR}/${dir}" ]]; then
    mkdir -p "${INSTALL_DIR}/${dir}"
    cp -a "${CURRENT_DIR}/${dir}/." "${INSTALL_DIR}/${dir}/"
  fi
done
cp -f "${CURRENT_DIR}/package.json" "${INSTALL_DIR}/package.json"
if [[ -f "${CURRENT_DIR}/package-lock.json" ]]; then
  cp -f "${CURRENT_DIR}/package-lock.json" "${INSTALL_DIR}/package-lock.json"
fi
if [[ -f "${CURRENT_DIR}/systemd/yt-live-manager.service" ]]; then
  cp "${CURRENT_DIR}/systemd/yt-live-manager.service" "${SERVICE_UNIT}"
  systemctl daemon-reload
fi

# 4. Update yt-dlp binary (YouTube URL direct download feature)
echo "--> Updating yt-dlp (non-blocking, 60s timeout)..."
YTDLP_BIN="/usr/local/bin/yt-dlp"
YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
if curl -fsSL --connect-timeout 10 --max-time 60 --retry 1 "${YTDLP_URL}" -o "${YTDLP_BIN}" 2>/dev/null; then
  chmod a+rx "${YTDLP_BIN}"
  echo "    yt-dlp updated: $(${YTDLP_BIN} --version 2>/dev/null || echo 'ok')"
else
  echo "    WARNING: yt-dlp download failed or timed out. Skipping (YouTube URL import may not work)."
  echo "    To install manually: sudo curl -fsSL ${YTDLP_URL} -o ${YTDLP_BIN} && sudo chmod a+rx ${YTDLP_BIN}"
fi

# 5. Dependency Update
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

# Clear any stale resume bookmark only after the exact pre-update archive exists
# and the migration has had a chance to recover a valid stream-state backup.
if [[ -f "${INSTALL_DIR}/data/stream-state.json" ]]; then
  echo "--> Clearing stale resume bookmark after backup and migration..."
  node --input-type=module -e '
    import { readJSON, writeJSON } from "./src/lib/atomic-json.js";
    const file = process.argv[1];
    const { data } = await readJSON(file, [], null);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      data.resumeBookmark = null;
      await writeJSON(file, data, { mode: 0o600 });
    }
  ' "${INSTALL_DIR}/data/stream-state.json"
fi

echo "--> Reconciling settings and video titles with the pre-update backup..."
node scripts/restore-update-state.js "${BACKUP_ARCHIVE}"

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
echo "Backup archive stored at: ${BACKUP_ARCHIVE}"
echo "=========================================================="
