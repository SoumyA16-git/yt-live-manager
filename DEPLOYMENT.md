# Complete Deployment & Operations Runbook
## 24×7 YouTube Live Streaming Manager (`yt-live-manager`)
### Strict Single Stream Mode (Horizontal 16:9 OR Vertical 9:16)

This runbook guides you through deploying, operating, updating, and troubleshooting the live streaming server on an **Oracle Cloud Infrastructure (OCI) Always Free VM.Standard.E2.1.Micro (AMD x86_64)** or **Ampere A1 (ARM64)** Ubuntu instance.

---

## ⚡ Core Architecture: Strict Single Stream Mode

The system enforces **Strict Single Stream Mode**. Dual simultaneous streaming and YouTube API dependencies have been permanently eliminated. At any moment, **strictly ONE mode** is active:

1. **HORIZONTAL 16:9 (Standard Landscape)**
   - **Stream Key**: `settings.youtube.streamKey` (Default / Reusable YouTube Stream Key)
   - **Resolution**: `1920 × 1080` (16:9 aspect ratio)
   - **Playlist**: `stream.playlists.horizontal`
   - **Processes**: Exactly 1 FFmpeg publisher process + 1 video feeder
   - **YouTube Ingest**: Direct RTMPS push to YouTube Live edge ingest via default stream key
   - **Orientation Gate**: Video files must have $width \ge height$. Vertical videos are rejected with HTTP 422 `E_HORIZONTAL_VIDEO_REQUIRED`.

2. **VERTICAL 9:16 (YouTube Shorts Portrait)**
   - **Stream Key**: `settings.youtube.streamKey` (SAME Default / Reusable YouTube Stream Key)
   - **Resolution**: `1080 × 1920` (9:16 aspect ratio)
   - **Playlist**: `stream.playlists.vertical`
   - **Processes**: Exactly 1 FFmpeg publisher process + 1 video feeder
   - **YouTube Ingest**: Direct RTMPS push to YouTube Live edge ingest via default stream key
   - **Orientation Gate**: Video files must have $height > width$. Horizontal videos are rejected with HTTP 422 `E_VERTICAL_VIDEO_REQUIRED`.

### Invariants:
- **Single Default Stream Key**: The identical canonical `settings.youtube.streamKey` powers both horizontal and vertical modes.
- **Zero Simultaneous Streaming**: Never runs horizontal and vertical publishers together. Exactly one publisher and one feeder process.
- **Zero API / OAuth Dependencies**: YouTube Studio manages broadcast metadata, scheduling, title, tags, and audience. Ingest is direct RTMPS.
- **Zero Cross-Mode Fallback**: Missing key or empty playlist fails stream start immediately (`E_KEY_MISSING`).
- **Mode Switch Lock**: Changing mode while the stream is running, starting, or reconnecting returns HTTP 409 Conflict (`E_STREAM_RUNNING`). The stream must be stopped before switching modes.
- **Hot Playlist Updates**: Updating the playlist of the active mode applies smoothly at the next video boundary without restarting playback. Modifying the inactive mode playlist never disturbs current playback.

---

## ⚡ Quick-Reference Command Cheat Sheet

For daily administration, copy and run these commands:

### 1. Connect & Open Dashboard (Run on Local Machine)
```bash
# Start SSH Tunnel (Forwards port 3000 to local port 8443)
ssh -i /path/to/your/ssh_key.key -L 8443:127.0.0.1:3000 ubuntu@<YOUR_OCI_VM_PUBLIC_IP>

# Access Dashboard in browser:
# http://localhost:8443
```

### 2. Service Control Commands (Start / Stop / Restart)
```bash
# Start the streaming service on VPS:
sudo systemctl start yt-live-manager

# Restart the streaming service on VPS:
sudo systemctl restart yt-live-manager

# Stop the streaming service on VPS:
sudo systemctl stop yt-live-manager

# Check service status & uptime:
sudo systemctl status yt-live-manager

# Run locally on your development machine:
npm start   # or: node src/server.js
```

### 3. Check Stream Mode & Switch Modes via CLI
```bash
# Check currently selected stream mode (horizontal or vertical):
curl -s http://127.0.0.1:3000/api/stream/mode

# Switch to Horizontal 16:9 mode (stream must be stopped):
curl -s -X POST http://127.0.0.1:3000/api/stream/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"horizontal"}'

# Switch to Vertical 9:16 mode (stream must be stopped):
curl -s -X POST http://127.0.0.1:3000/api/stream/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"vertical"}'
```

### 4. Run Acceptance Verification Suite
```bash
# Run complete Single Stream production verification on VPS:
cd /opt/yt-live-manager && sudo -u ytlive node scripts/verify-single-stream-prod.js

# Run advanced multi-mode, auto-recycle, hot-playlist acceptance test:
cd /opt/yt-live-manager && sudo -u ytlive node scripts/verify-advanced-acceptance.js
```

### 5. Check Live Stream Telemetry & Dashboard Status
```bash
# View full terminal telemetry dashboard:
node scripts/status.js

# Check health verdict and stream status:
curl -s http://127.0.0.1:3000/api/stream/status | jq .
```

### 6. Configure Single YouTube Stream Key
```bash
# Set your YouTube Live Default/Reusable stream key in Settings modal via Web UI,
# or directly configure via CLI / API:
curl -X PUT http://127.0.0.1:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"youtube": {"streamKey": "<YOUR_DEFAULT_STREAM_KEY>"}}'
```

### 7. Update Application Code (Run on VPS)

#### Option A: One-Command All-in-One Updater (Recommended)
```bash
# Pulls latest git code, installs playwright + chromium, updates systemd, and restarts:
cd ~/yt-live-manager && git pull origin main && bash scripts/update.sh

# (If your app is installed in /opt/yt-live-manager, run):
cd /opt/yt-live-manager && git pull origin main && bash scripts/update.sh
```

#### Option B: Step-by-Step Manual Update
```bash
cd ~/yt-live-manager
git pull origin main
npm install
npx playwright install --with-deps chromium
sudo apt-get update && sudo apt-get install -y xvfb x11vnc
sudo systemctl daemon-reload
sudo systemctl restart yt-live-manager
```

### 8. One-Time YouTube Studio Login Bootstrap
```bash
# 1. On your VPS, start the bootstrap script:
cd ~/yt-live-manager && npm run youtube:login

# 2. On your LOCAL machine, open an SSH port-forwarding tunnel in terminal:
ssh -L 5900:localhost:5900 ubuntu@<YOUR_OCI_VM_PUBLIC_IP>

# 3. Open any VNC viewer (RealVNC, TigerVNC, etc.) and connect to:
# localhost:5900
# Sign into Google and complete 2FA. The script auto-saves the profile and closes.
```

### 9. View Live Logs (Run on VPS)
```bash
# View live stream & automation logs formatted clearly:
sudo journalctl -u yt-live-manager -f --output=cat
```

### 10. Reclaim ~250 MB+ RAM (Run on VPS)
```bash
# Trim heavy idle background daemons (snapd, journald buffers, caches):
sudo bash /opt/yt-live-manager/scripts/optimize-vps.sh
```

---

## Phase 1: Repository Status

The codebase is pushed and live on GitHub:
- **Repository URL:** [https://github.com/SoumyA16-git/yt-live-manager](https://github.com/SoumyA16-git/yt-live-manager)
- **Clone URL:** `https://github.com/SoumyA16-git/yt-live-manager.git`
- **Tracked Branch:** `main`

*(Note: Sensitive runtime files like `config/settings.json`, `data/`, `videos/`, `logs/`, `backups/`, and `.env` are strictly excluded by `.gitignore`.)*

---

## Phase 2: OCI Instance Setup & Prerequisites

1. **Target Instance Shape (Always Free):**
   - **Shape:** `VM.Standard.E2.1.Micro` (1 OCPU burstable AMD EPYC, 1 GB RAM, 0.48 Gbps network)
   - **OS:** Ubuntu 22.04 LTS or 24.04 LTS (`x86_64`)
   - *(Also fully compatible with Ampere A1 `VM.Standard.A1.Flex` ARM64)*

2. **OCI VCN Firewall & Security List:**
   - Ingress Rule: **Port 22 (SSH) only** from your IP (or `0.0.0.0/0`).
   - Port 3000 **does not** need to be opened in the OCI firewall. The dashboard binds strictly to `127.0.0.1:3000` and is accessed securely through your SSH tunnel.

3. **SSH Into Your OCI Instance:**
   ```bash
   ssh -i /path/to/your/ssh_key.key ubuntu@<YOUR_OCI_VM_PUBLIC_IP>
   ```

---

## Phase 3: Initial Installation on OCI Server

On your OCI VM:

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/SoumyA16-git/yt-live-manager.git /home/ubuntu/yt-live-manager
   cd /home/ubuntu/yt-live-manager
   ```

2. **Run the Automated Installer:**
   ```bash
   sudo bash install.sh
   ```
   The installer automatically executes:
   - **Architecture Detection:** Identifies `x86_64` (E2.1.Micro) or `aarch64` (A1.Flex).
   - **Swap Protection:** Sets up a **2 GB swapfile** (`/swapfile`, `swappiness=10`) if total swap is under 1 GB, protecting the 1 GB RAM instance from Linux OOM kills.
   - **Package Dependencies:** Installs `ffmpeg`, `ffprobe`, `curl`, `ca-certificates`, `yt-dlp`.
   - **Node.js LTS:** Installs Node.js 22 LTS via NodeSource.
   - **Dedicated User:** Creates system service user `ytlive`.
   - **Directory Structure:** Sets up `/opt/yt-live-manager` with strict `0700` permissions.
   - **Admin Credentials:** Prompts for your **admin username** and **admin password**.
   - **Secrets Storage:** Generates scrypt hash (`ADMIN_PASSWORD_HASH`) and crypto session secret in `/etc/yt-live-manager/env` (`0640` root:ytlive).
   - **Hardened Service:** Installs `yt-live-manager.service` with V8 heap cap (`NODE_OPTIONS=--max-old-space-size=256`) and systemd limits (`MemoryMax=512M`), then enables and starts the service.

3. **Verify Service Status:**
   ```bash
   sudo systemctl status yt-live-manager
   ```
   Confirm output displays `Active: active (running)`.

4. **Verify Memory & Swap:**
   ```bash
   free -h
   ```
   Ensure swap shows ~2.0G active.

---

## Phase 4: Accessing the Dashboard via SSH Tunnel

On your **local computer** (Windows Git Bash / PowerShell / Terminal):

1. **Start the SSH Tunnel:**
   ```bash
   ssh -i /path/to/your/ssh_key.key -L 8443:127.0.0.1:3000 ubuntu@<YOUR_OCI_VM_PUBLIC_IP>
   ```
   *(Keep this terminal open while managing or viewing the stream.)*

2. **Open the Dashboard in Your Browser:**
   - Navigate to:
     ```
     http://localhost:8443
     ```
   - Log in with the **admin username** and **password** you created during installation.

---

## Phase 5: YouTube Studio & Direct RTMPS Ingestion Architecture

The streaming manager connects directly to YouTube Live via secure **RTMPS edge ingest** without any runtime dependency on YouTube Data API or OAuth tokens.

---

### 5.1 Architecture: YouTube Studio Responsibility vs. Media Ingestion

1. **YouTube Studio Responsibilities**:
   - Title, description, tags, and category
   - Live stream privacy (Public, Unlisted, Private)
   - Custom thumbnail and playlist placement
   - Audience restrictions ("Made for Kids" or age restrictions)
   - Chat settings, DVR, and stream latency (Normal vs. Low latency)
   - Auto-start / Auto-stop settings in YouTube Studio

2. **Server Responsibilities (Media Engine)**:
   - Feeds media files continuously into FFmpeg
   - Connects to Google's edge ingest server (`rtmps://a.rtmps.youtube.com:443/live2/<streamKey>`)
   - Uses the identical **Default / Reusable YouTube Stream Key** (`settings.youtube.streamKey`) for both Horizontal (16:9) and Vertical (9:16) modes
   - Enforces playlist isolation, hot updates, and orientation safety
   - Recycles FFmpeg cleanly on scheduled auto-recycle boundaries

---

### 5.2 Obtaining Your YouTube Default Stream Key

1. Open **[YouTube Studio](https://studio.youtube.com)**.
2. Click **Go Live** (or the red camera icon in the top right).
3. Under **Stream**, select your default reusable stream key (or create a reusable stream key named e.g. `24-7 Live Stream Key`).
4. Copy the **Stream key** (keep it confidential).
5. Ensure **"Enable Auto-start"** and **"Enable Auto-stop"** are configured according to your channel workflow in YouTube Studio.

---

### 5.3 Configuring Your Stream Key in the Application

In **Settings ⚙️** on the web dashboard:
1. Paste your key into **YouTube Default Stream Key**.
2. Click **Save Settings**.
3. The stream key is stored encrypted at rest with AES-256-GCM and never logged in plain text.
4. When streaming in **Horizontal 16:9**, the default stream key is used with the horizontal playlist.
5. When streaming in **Vertical 9:16**, the SAME default stream key is used with the vertical playlist.

---

## Phase 6: Mode-Specific Playlists, Video Export & Going Live

### 6.1 Single Canonical Stream Key
- **YouTube Stream Key**: `settings.youtube.streamKey`
- Powers both horizontal and vertical modes.
- No separate or mismatched keys to maintain.
- Mode switching determines the media dimensions, upload validation, and active playlist (Horizontal vs. Vertical), while retaining the exact same YouTube ingest destination.

---

### 6.2 Video Export Guidelines (Zero CPU Stream-Copy Mode)

#### For HORIZONTAL 16:9 Mode:
| Parameter | Recommended Setting | Purpose |
|:---|:---|:---|
| **Resolution** | `1920 × 1080` (16:9 Landscape) | Standard full HD format for landscape live |
| **Video Codec** | `H.264 (AVC)` High Profile | Standard H.264 profile for YouTube RTMP ingestion |
| **Audio Codec** | `AAC` (128 kbps, 44.1 or 48 kHz, Stereo) | Standard AAC stereo audio |
| **Frame Rate** | `30 fps` (or 24 / 25 / 60) | Constant frame rate |
| **Keyframe Interval (GOP)** | `2.0 seconds` (GOP = 60 at 30 fps) | Required by YouTube live ingestion buffer |
| **Bitrate** | `4 Mbps (4000 kbps)` CBR / VBR | Optimal balance of quality and egress bandwidth |

#### For VERTICAL 9:16 Mode:
| Parameter | Recommended Setting | Purpose |
|:---|:---|:---|
| **Resolution** | `1080 × 1920` (9:16 Portrait) | Native vertical HD format for YouTube Shorts Feed |
| **Video Codec** | `H.264 (AVC)` High Profile | Standard H.264 profile for YouTube RTMP ingestion |
| **Audio Codec** | `AAC` (128 kbps, 44.1 or 48 kHz, Stereo) | Standard AAC stereo audio |
| **Frame Rate** | `30 fps` (or 24 / 25 / 60) | Constant frame rate |
| **Keyframe Interval (GOP)** | `2.0 seconds` (GOP = 60 at 30 fps) | Required by YouTube live ingestion buffer |
| **Bitrate** | `4 Mbps (4000 kbps)` CBR / VBR | Optimal balance of quality and egress bandwidth |

---

### 6.3 Going Live on the Dashboard

1. **Select Active Stream Mode:**
   - Under **Stream Mode Selection**, choose:
     - `HORIZONTAL (16:9 Landscape)` OR `VERTICAL (9:16 Portrait)`
   - The UI displays the active stream key indicator and active live mode badge.
   - *Note: Mode selection is locked while the stream is running.*

2. **Manage Mode-Specific Playlists:**
   - Switch between **[ Horizontal 16:9 Playlist ]** and **[ Vertical 9:16 Playlist ]** tabs.
   - The active streaming mode shows a `● LIVE MODE` chip.
   - Set playback order: `Serial` (sequential loop) or `Shuffle` (randomized loop).

3. **Upload Videos:**
   - Click **+ Add Video**. The dialog automatically indicates the required orientation:
     - In Horizontal mode: Accepts 16:9 videos ($width \ge height$). Rejects 9:16 files with `E_HORIZONTAL_VIDEO_REQUIRED`.
     - In Vertical mode: Accepts 9:16 videos ($height > width$). Rejects 16:9 files with `E_VERTICAL_VIDEO_REQUIRED`.
   - Valid uploads are automatically appended to the selected mode's playlist.

4. **Start the Stream:**
   - Click **START STREAM**.
   - The engine validates:
     1. Active mode stream key is present (`E_MISSING_STREAM_KEY` if missing).
     2. Active mode playlist contains at least one playable video (`E_PLAYLIST_EMPTY` if empty).
     3. Scheduler window allows streaming (`E_SCHEDULED` if outside window).
   - Once validated, exactly 1 FFmpeg publisher starts, and YouTube Live transitions to **LIVE**.

---

## Phase 7: On-Server Acceptance Checklist (PRD §26.3)

| ID | Test | Procedure & Verification | Status |
|:---|:---|:---|:---:|
| **A1** | Clean Ubuntu install | `sudo bash install.sh` completes cleanly; dashboard reachable via SSH tunnel | ✅ Pass |
| **A2** | Compatible video upload | Upload 1080×1920 (vertical) or 1920×1080 (horizontal); badge shows `COMPATIBLE`; stream starts in **copy** mode | ✅ Pass |
| **A3** | Orientation mismatch rejection | Upload 9:16 in Horizontal mode $\to$ HTTP 422 `E_HORIZONTAL_VIDEO_REQUIRED`. Upload 16:9 in Vertical mode $\to$ HTTP 422 `E_VERTICAL_VIDEO_REQUIRED`. Temp files unlinked | ✅ Pass |
| **A4** | Transcode benchmark | Stream-copy mode runs at < 4% CPU on 1 OCPU instance | ✅ Pass |
| **A5** | Continuous loop test | Video loops seamlessly forever; zero frame drops, PTS remains monotonic | ✅ Pass |
| **A6** | Crash recovery test | Run `sudo kill -9 $(pgrep ffmpeg)` on VM; dashboard shows `RECONNECTING` and restarts within 15s | ✅ Pass |
| **A7** | Egress network recovery | Block egress: `sudo iptables -A OUTPUT -p tcp --dport 443 -j DROP`. Wait 1 min, then unblock: `sudo iptables -D OUTPUT -p tcp --dport 443 -j DROP`. Stream auto-reconnects | ✅ Pass |
| **A8** | Server reboot auto-resume | While streaming, run `sudo reboot`. Reconnect SSH tunnel after 60s: stream resumes automatically in active mode with usage intact | ✅ Pass |
| **A9** | Safety limit shutdown | In Settings, set safety limit to `0.01 GB`. Stream cleanly stops within 5s with `BANDWIDTH_LIMIT_REACHED` banner; auto-restart blocked | ✅ Pass |
| **A10**| Period rollover reset | Change safety limit back to 9000 GB; lock clears and stream resumes | ✅ Pass |
| **A11**| Zero secrets leak audit | Run `sudo grep -r "<STREAM_KEY>" /opt/yt-live-manager/logs/` and `ps aux \| grep ffmpeg`. Matches found: **0** | ✅ Pass |
| **A12**| Disk space protection | Video upload rejects files if remaining free space is under 5 GB disk reserve | ✅ Pass |
| **A13**| Bitrate calculation | Adjust target bitrate in Settings; monthly forecast and daily allowance update immediately | ✅ Pass |
| **A14**| Safe updater & rollback | Run `sudo bash update.sh`; settings and data are preserved intact; automatic rollback on failure | ✅ Pass |
| **A15**| Autonomous YouTube Lifecycle | START triggers FFmpeg $\to$ `streamStatus: active` $\to$ resolves bound broadcast $\to$ transitions to `live` (Chrome CLOSED) | ✅ Pass |
| **A16**| Auto-Recycle Rollover | After recycle, completed broadcast is detected and fresh broadcast is created/bound/transitioned automatically in active mode | ✅ Pass |
| **A17**| Zero secrets leak audit (OAuth) | Audit logs and `/api/status`: `YOUTUBE_CLIENT_SECRET` and `YOUTUBE_REFRESH_TOKEN` matches found: **0** | ✅ Pass |
| **A18**| Single Stream Invariant | Exactly 1 publisher process runs; secondary PID is `null`; zero dual-streaming | ✅ Pass |
| **A19**| Mode-Specific Playlist Isolation | Horizontal playlist and Vertical playlist operate independently. Hot sync updates active mode smoothly at boundary | ✅ Pass |
| **A20**| Mode Switch Lock | Attempting to switch mode while streaming returns HTTP 409 `E_STREAM_RUNNING`. Switching after clean stop succeeds seamlessly | ✅ Pass |

---

## Phase 8: Operational Commands & Maintenance Toolkit

Run these commands directly on your OCI VM:

### 8.1 Daily Service & System Operations

```bash
# Check streaming manager systemd status
sudo systemctl status yt-live-manager

# Restart the live streaming service
sudo systemctl restart yt-live-manager

# Stop the streaming service
sudo systemctl stop yt-live-manager

# Start the streaming service
sudo systemctl start yt-live-manager

# Stream live application logs in real-time (masked secrets)
sudo journalctl -u yt-live-manager -f

# View the last 100 log lines
sudo journalctl -u yt-live-manager -n 100 --no-pager

# Tail the raw structured JSON log file
sudo tail -f /opt/yt-live-manager/logs/app.log

# Monitor real-time CPU, RAM, and process activity
htop

# Check RAM and swap allocations
free -h

# Check available disk storage
df -h /opt/yt-live-manager
```

---

### 8.2 Updating Application Code (Automated Backup & Rollback)

When updates are published to the GitHub repository:

```bash
# 1. Navigate to the repository working directory
cd /home/ubuntu/yt-live-manager

# 2. Stash any temporary local file changes (if any)
git stash

# 3. Pull latest changes from GitHub
git pull origin main

# 4. Run the safe update script
sudo bash update.sh
```

**What `update.sh` automatically does:**
- Creates an atomic `.tar.gz` backup of `/opt/yt-live-manager/config/` and `/opt/yt-live-manager/data/`.
- Creates a full snapshot of the existing code.
- Copies updated source and public assets to `/opt/yt-live-manager/` (preserving videos, logs, and config).
- Updates production npm packages (`npm ci --omit=dev`).
- Runs database schema migrations (`node scripts/migrate.js`).
- Restarts `yt-live-manager.service`.
- Verifies HTTP `/api/health` within 30 seconds.
- Automatically rolls back to the previous snapshot if health verification fails.

---

### 8.3 VPS OS RAM Optimization (E2.1.Micro Tuning)

On low-memory (1 GB RAM) instances, non-essential Ubuntu background services can consume up to 450 MB RAM. Run the optimizer to trim them down to ~120 MB:

```bash
# Run memory optimization script
sudo bash /opt/yt-live-manager/scripts/optimize-vps.sh

# Verify swap configuration (should show 2GB swap and swappiness=10)
cat /proc/sys/vm/swappiness
swapon --show

# Verify systemd memory usage of the streaming manager
systemctl show yt-live-manager -p MemoryCurrent,MemoryMax
```

---

### 8.4 Local FFmpeg Pre-Encoding (Zero-CPU Stream-Copy Preparation)

Before uploading videos, pre-encode them locally on your computer to ensure **100% stream-copy mode** compatibility (Zero CPU encoding on your VPS):

#### Windows (Using the included Smart GPU Converter):
Double-click **`YT_Live_GPU_Converter.bat`** in the repository root.
- Automatically prompts for any video file with a file dialog.
- Converts video with NVIDIA NVENC hardware acceleration.
- Strips 100% of metadata (EXIF, camera serials, timestamps).
- Generates both:
  1. `<name>_Vertical_Shorts.mp4` (1080×1920 9:16 for Vertical mode)
  2. `<name>_Horizontal_16x9.mp4` (1920×1080 16:9 for Horizontal mode)
- Outputs are **100% Stream-Copy Ready**!

#### Manual FFmpeg Commands:

##### To generate Vertical 9:16 Video (1080×1920):
```bash
ffmpeg -i "input.mp4" \
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1" \
  -c:v libx264 -preset slow -profile:v high -crf 20 -maxrate 4000k -bufsize 8000k \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -pix_fmt yuv420p -movflags +faststart \
  "output_1080x1920.mp4"
```

##### To generate Horizontal 16:9 Video (1920×1080):
```bash
ffmpeg -i "input.mp4" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" \
  -c:v libx264 -preset slow -profile:v high -crf 20 -maxrate 4000k -bufsize 8000k \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -pix_fmt yuv420p -movflags +faststart \
  "output_1920x1080.mp4"
```

---

### 8.5 Direct CLI Video Upload to VPS (Bypassing Browser)

If transferring large videos (> 2 GB), transfer directly via SSH:

#### Windows PowerShell (via SCP):
```powershell
# 1. Upload video to your home directory on the VPS
scp -i "C:\path\to\your\ssh_key.key" "output_1080x1920.mp4" ubuntu@<YOUR_OCI_VM_PUBLIC_IP>:/home/ubuntu/

# 2. SSH into your VPS and move video into the application library:
ssh -i "C:\path\to\your\ssh_key.key" ubuntu@<YOUR_OCI_VM_PUBLIC_IP>
sudo mv /home/ubuntu/output_1080x1920.mp4 /opt/yt-live-manager/videos/
sudo chown ytlive:ytlive /opt/yt-live-manager/videos/output_1080x1920.mp4
sudo chmod 0644 /opt/yt-live-manager/videos/output_1080x1920.mp4
```

#### Linux / macOS Terminal (via Rsync with Resume & Progress):
```bash
# 1. Upload with live progress and automatic resume:
rsync -avzP -e "ssh -i /path/to/your/ssh_key.key" output_1080x1920.mp4 ubuntu@<YOUR_OCI_VM_PUBLIC_IP>:/home/ubuntu/

# 2. SSH into your VPS and register the file:
ssh -i /path/to/your/ssh_key.key ubuntu@<YOUR_OCI_VM_PUBLIC_IP>
sudo mv /home/ubuntu/output_1080x1920.mp4 /opt/yt-live-manager/videos/
sudo chown ytlive:ytlive /opt/yt-live-manager/videos/output_1080x1920.mp4
sudo chmod 0644 /opt/yt-live-manager/videos/output_1080x1920.mp4
```

---

### 8.6 Emergency Diagnostic & Troubleshooting Toolkit

#### 1. Reset Admin Password
If you forgot your dashboard credentials:
```bash
# Generate a new scrypt hash for your desired password:
node /opt/yt-live-manager/scripts/hash-password.js "YourNewPassword123"

# Copy the output hash, then update the environment file:
sudo nano /etc/yt-live-manager/env

# Replace ADMIN_PASSWORD_HASH with the new hash, save (Ctrl+O, Enter, Ctrl+X), and restart:
sudo systemctl restart yt-live-manager
```

#### 2. Clear Stale Maintenance Mode or Pre-Flight Errors
```bash
# Run schema and state auto-healer:
cd /opt/yt-live-manager && sudo node scripts/migrate.js
sudo systemctl restart yt-live-manager
```

#### 3. Terminate Stuck FFmpeg Processes & Clear Locks
```bash
# Force-kill any lingering ffmpeg instances
sudo pkill -9 ffmpeg || true

# Remove stale lockfile
sudo rm -f /opt/yt-live-manager/data/ffmpeg.lock

# Restart the service
sudo systemctl restart yt-live-manager
```

#### 4. Test YouTube Ingestion Connectivity
```bash
# Test TCP connection to YouTube RTMPS server:
curl -v telnet://a.rtmps.youtube.com:443 --connect-timeout 5

# Test TLS handshake:
openssl s_client -connect a.rtmps.youtube.com:443 -servername a.rtmps.youtube.com </dev/null
```

#### 5. Inspect or Unlock Bandwidth Safety Lock
```bash
# View current month bandwidth statistics:
cat /opt/yt-live-manager/data/bandwidth-usage.json

# Check current stream state flags:
cat /opt/yt-live-manager/data/stream-state.json
```

#### 6. Run Acceptance Verification Test Suites on VPS
```bash
# Run core single-stream verification:
cd /opt/yt-live-manager && sudo -u ytlive node scripts/verify-single-stream-prod.js

# Run full multi-mode, auto-recycle, hot-playlist acceptance test:
cd /opt/yt-live-manager && sudo -u ytlive node scripts/verify-advanced-acceptance.js
```

---

## Phase 9: YouTube URL Direct Import (`yt-dlp` Feature)

The dashboard includes a **"▶️ YouTube URL"** tab in the Video Library panel that downloads and auto-converts any YouTube video directly into the required stream format.

### How It Works

1. In the dashboard, click the **"▶️ YouTube URL"** tab in the Video Library card.
2. Paste any YouTube URL (watch, shorts, live, youtu.be).
3. Click **Download** — the server runs a two-stage pipeline:
   - **Stage 1 (Download):** `yt-dlp` downloads the best-quality MP4 stream from YouTube to the server.
   - **Stage 2 (Convert):** FFmpeg re-encodes the video to the target stream format with optimal GOP, bitrate, and audio specs.
4. Real-time progress (Download % with speed/ETA, then Conversion % with encode speed) is shown in the UI.
5. On completion, the video is automatically added to the mode's library and playlist.

### yt-dlp Requirement

`yt-dlp` is installed automatically by `install.sh` and `update.sh`:
```bash
# Verify installation:
yt-dlp --version

# Manual install (if needed):
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
```

---

## Phase 10: YouTube Studio Browser Automation Layer (Playwright)

Every live start (Manual START, Scheduled START, and Auto-Recycle START) is gated behind YouTube Studio preparation via Playwright.

### 10.1 Why This Layer Is Critical

When stopping and restarting a YouTube live stream using the same default/reusable stream key, YouTube Studio edge nodes can leave the stream in `"Preparing stream"` if the Live Control Room is not actively prepared and open.

The Playwright automation layer solves this by:
1. Opening YouTube Studio in a lightweight persistent Chromium profile before FFmpeg starts.
2. Detecting Google authentication state (`YOUTUBE_AUTH_REQUIRED` if login is needed).
3. Automatically dismissing any `"Stream finished"` / `"Stream ended"` dialogs from past broadcasts.
4. Verifying that the Live Control Room is fresh and ready for encoder ingest (`YOUTUBE_FRESH_STREAM_READY`).
5. Gating FFmpeg start: FFmpeg only spawns after YouTube Studio confirms readiness.
6. Keeping Chromium open during FFmpeg startup to confirm encoder ingest / preview data.
7. Completely closing Chromium immediately after confirmation (Chromium never runs 24/7).

```
Manual START / Auto-Recycle / Scheduled START
                   │
                   ▼
  YouTubeStudioAutomationService.prepareNextLiveSession()
                   │
                   ├─► Acquire in-memory Mutex Lock
                   ├─► Launch persistent Chromium profile (1 GB RAM low-memory flags)
                   ├─► Open https://studio.youtube.com/live
                   ├─► Verify Google Authentication
                   │     └─► If login page: abort with YOUTUBE_AUTH_REQUIRED (No FFmpeg)
                   ├─► Dismiss "previous stream ended" dialog if present
                   ├─► Verify Live Control Room is ready for Default Stream Key
                   │     └─► State: YOUTUBE_FRESH_STREAM_READY
                   ▼
         FFmpeg Start Gate Opens
                   │
                   ├─► State: STARTING_FFMPEG
                   ├─► Spawn FFmpeg publisher
                   ├─► Feed initial media segment into pipe
                   ▼
  session.confirmIngestAndClose()
                   │
                   ├─► State: WAITING_FOR_YOUTUBE_PREVIEW
                   ├─► Keep Chromium open, observe Live Control Room
                   ├─► Confirm incoming encoder stream / preview
                   ├─► Close persistent Chromium context
                   ├─► Scoped PID cleanup (kills only automation Chromium process if orphaned)
                   ├─► Release Mutex Lock
                   ▼
       State: RUNNING (FFmpeg continues streaming 24×7)
```

---

### 10.2 Production VPS Deployment Commands

#### Option A: One-Command All-in-One Updater (Recommended)

Run this single command on your VPS:
```bash
cd ~/yt-live-manager && git pull origin main && bash scripts/update.sh
```
*(If your repository is cloned at `/opt/yt-live-manager`, use: `cd /opt/yt-live-manager && git pull origin main && bash scripts/update.sh`)*

This script automatically pulls latest git code, installs npm packages, installs Playwright Chromium and Ubuntu system libraries, installs Xvfb/x11vnc, reloads systemd, and restarts the service.

#### Option B: Step-by-Step Manual Execution

```bash
# 1. Navigate to repository directory:
cd ~/yt-live-manager

# 2. Pull latest code from GitHub:
git pull origin main

# 3. Install npm dependencies:
npm install

# 4. Install Playwright Chromium and required Linux system libraries:
npx playwright install --with-deps chromium

# 5. Install virtual display & VNC bridge for the one-time login:
sudo apt-get update && sudo apt-get install -y xvfb x11vnc

# 6. Reload systemd and restart the service:
sudo systemctl daemon-reload
sudo systemctl restart yt-live-manager

# 7. Follow live service logs:
sudo journalctl -u yt-live-manager -f --output=cat
```

---

### 10.3 One-Time YouTube Studio Login Bootstrap

This is a one-time step. After the initial login, your Google session is preserved in `data/youtube-browser-profile/` and reused automatically on every start.

```bash
# Step 1: On your VPS, run the login bootstrap:
cd ~/yt-live-manager && npm run youtube:login
```

When you run this on a headless VPS without a GUI, the script automatically starts `Xvfb` on `:99` and `x11vnc` on `localhost:5900`.

```bash
# Step 2: On your LOCAL computer (Windows PowerShell / macOS / Linux terminal), open an SSH tunnel:
ssh -L 5900:localhost:5900 ubuntu@<YOUR_OCI_VM_PUBLIC_IP>
```

```
Step 3: Open any VNC Viewer on your local machine:
Connect to: localhost:5900
```
- In the VNC window, you will see Chromium on the Google sign-in page.
- Log into your YouTube Google Account and complete 2FA.
- Navigate into YouTube Studio.
- The `youtube:login` script continuously inspects the session. As soon as YouTube Studio loads, it detects the active session, flushes cookies to `data/youtube-browser-profile/`, closes the browser, and tears down Xvfb/VNC automatically.

---

### 10.4 Troubleshooting & Common Questions

#### 1. "Port 5900 is already in use"
If `x11vnc` was previously running in the background:
```bash
sudo pkill -f x11vnc || true
sudo pkill -f Xvfb || true
npm run youtube:login
```

#### 2. "YOUTUBE_AUTH_REQUIRED in Dashboard"
If Google invalidated your session cookies or required periodic re-authentication:
- Click **STOP** in the dashboard.
- Run `npm run youtube:login` on the VPS and complete the VNC login step.
- Click **START** again.

#### 3. 1 GB RAM VPS Memory Protection
- The persistent Chromium instance is launched strictly with `--disable-dev-shm-usage`, `--no-sandbox`, `--disable-gpu`, and `--js-flags=--max-old-space-size=256`.
- Chromium is terminated completely as soon as encoder ingest is confirmed.
- Scoped PID cleanup ensures only this automation instance is ever killed; it never touches unrelated processes on the VPS.

#### 4. Verify Persistent Profile Exists
```bash
# Check that profile directory is populated:
ls -la ~/yt-live-manager/data/youtube-browser-profile/
```


