#!/usr/bin/env bash
# install.sh — Idempotent installer for 24×7 YouTube Vertical Live Streaming Manager
# Target: Ubuntu Server (ARM64/aarch64 on OCI Ampere A1)
# PRD §21.2

set -euo pipefail

INSTALL_DIR="/opt/yt-live-manager"
CONFIG_DIR="/etc/yt-live-manager"
ENV_FILE="${CONFIG_DIR}/env"
APP_USER="ytlive"
PORT=3000
NODE_MAJOR=22
WITH_NGINX=false
DOMAIN=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --with-nginx)
      WITH_NGINX=true
      shift
      ;;
    --no-nginx)
      WITH_NGINX=false
      shift
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --node-major)
      NODE_MAJOR="$2"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1"
      exit 1
      ;;
  esac
done

echo "=========================================================="
echo "Installing 24×7 YouTube Vertical Live Streaming Manager"
echo "Target directory: ${INSTALL_DIR}"
echo "Port: ${PORT}"
echo "=========================================================="

# Check root privileges
if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

# 1. Architecture Check (PRD §21.2)
ARCH=$(uname -m)
if [[ "${ARCH}" != "aarch64" ]]; then
  echo "⚠️ Warning: Detected architecture is ${ARCH}, but target is ARM64 (aarch64)."
  echo "Continuing anyway for development/testing..."
fi

# 2. System Packages & NodeSource
echo "--> Updating packages and installing dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg ffmpeg

# Install Node.js LTS if missing or older than 18.15
NEED_NODE=true
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJ=$(echo "${NODE_VER}" | cut -d. -f1)
  if [[ "${NODE_MAJ}" -ge 18 ]]; then
    NEED_NODE=false
    echo "Found Node.js v${NODE_VER} (>= 18.15.0)."
  fi
fi

if [[ "${NEED_NODE}" == "true" ]]; then
  echo "--> Installing Node.js ${NODE_MAJOR}.x from NodeSource..."
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi

# 3. Verify FFmpeg Encoders
echo "--> Verifying FFmpeg encoders (libx264, aac)..."
ENCODERS=$(ffmpeg -encoders 2>/dev/null)
if ! echo "${ENCODERS}" | grep -q "libx264"; then
  echo "Error: FFmpeg does not have libx264 encoder support."
  exit 1
fi
if ! echo "${ENCODERS}" | grep -q "aac"; then
  echo "Error: FFmpeg does not have aac encoder support."
  exit 1
fi

# 4. Create Dedicated User
if ! id "${APP_USER}" >/dev/null 2>&1; then
  echo "--> Creating system user ${APP_USER}..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "${APP_USER}"
fi

# 5. Create Directory Tree
echo "--> Setting up directory structure in ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"/{config,data,videos,videos/.incoming,logs,backups,src,public,scripts,systemd}
mkdir -p "${CONFIG_DIR}"

# 6. Copy Code Files
echo "--> Copying application files..."
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -ru "${CURRENT_DIR}/package.json" "${INSTALL_DIR}/"
cp -ru "${CURRENT_DIR}/src" "${INSTALL_DIR}/"
cp -ru "${CURRENT_DIR}/public" "${INSTALL_DIR}/"
cp -ru "${CURRENT_DIR}/scripts" "${INSTALL_DIR}/"
cp -ru "${CURRENT_DIR}/systemd" "${INSTALL_DIR}/"

if [[ -f "${CURRENT_DIR}/config/settings.example.json" ]]; then
  cp -u "${CURRENT_DIR}/config/settings.example.json" "${INSTALL_DIR}/config/"
fi

# 7. Initialize settings.json ONLY IF ABSENT (PRD §21.2)
if [[ ! -f "${INSTALL_DIR}/config/settings.json" ]]; then
  echo "--> Initializing settings.json from factory example..."
  cp "${INSTALL_DIR}/config/settings.example.json" "${INSTALL_DIR}/config/settings.json"
fi

# 8. Dependencies
echo "--> Installing production npm dependencies..."
cd "${INSTALL_DIR}"
npm ci --omit=dev

# 9. Admin Credentials & Environment File
if [[ ! -f "${ENV_FILE}" ]]; then
  echo ""
  echo "=========================================================="
  echo "Initial Admin Account Setup"
  echo "=========================================================="
  read -r -p "Enter admin username [admin]: " INPUT_USER
  ADMIN_USERNAME="${INPUT_USER:-admin}"

  while true; do
    read -r -s -p "Enter admin password: " P1
    echo ""
    read -r -s -p "Confirm admin password: " P2
    echo ""
    if [[ "${P1}" == "${P2}" && -n "${P1}" ]]; then
      break
    fi
    echo "Passwords do not match or empty. Please try again."
  done

  # Generate scrypt hash using Node script
  ADMIN_PASSWORD_HASH=$(node "${INSTALL_DIR}/scripts/hash-password.js" "${P1}" | grep "ADMIN_PASSWORD_HASH=" | cut -d= -f2-)
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

  cat <<EOF > "${ENV_FILE}"
# /etc/yt-live-manager/env — Runtime secrets (mode 0640 root:ytlive)
PORT=${PORT}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}
SESSION_SECRET=${SESSION_SECRET}
EOF
fi

chmod 0640 "${ENV_FILE}"
chown root:"${APP_USER}" "${ENV_FILE}"

# Set permissions
chmod 0700 "${INSTALL_DIR}"/config "${INSTALL_DIR}"/data "${INSTALL_DIR}"/videos "${INSTALL_DIR}"/logs "${INSTALL_DIR}"/backups
chmod 0600 "${INSTALL_DIR}"/config/settings.json 2>/dev/null || true
chown -R "${APP_USER}:${APP_USER}" "${INSTALL_DIR}"

# 10. Install systemd unit
echo "--> Installing systemd service..."
cp "${INSTALL_DIR}/systemd/yt-live-manager.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable yt-live-manager
systemctl restart yt-live-manager

echo ""
echo "=========================================================="
echo "✅ Installation Complete!"
echo "=========================================================="
echo "Service status:"
systemctl --no-pager status yt-live-manager || true
echo ""
echo "Access Instructions:"
echo "1. Connect securely via SSH tunnel from your local computer:"
echo "   ssh -L 8443:127.0.0.1:${PORT} ubuntu@<YOUR_OCI_VM_IP>"
echo ""
echo "2. Open your browser at:"
echo "   http://localhost:8443"
echo ""
echo "Useful Commands:"
echo "  sudo systemctl status yt-live-manager"
echo "  sudo systemctl restart yt-live-manager"
echo "  sudo journalctl -u yt-live-manager -f"
echo "=========================================================="
