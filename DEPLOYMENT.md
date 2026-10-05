# Complete Deployment & Operations Runbook
## 24×7 YouTube Live Streaming Manager (`yt-live-manager`)
### Strict Single Stream Mode (Horizontal 16:9 OR Vertical 9:16)

This runbook guides you through deploying, operating, updating, and troubleshooting the live streaming server on an **Oracle Cloud Infrastructure (OCI) Always Free VM.Standard.E2.1.Micro (AMD x86_64)** or **Ampere A1 (ARM64)** Ubuntu instance.

---

## ⚡ Core Architecture: Strict Single Stream Mode

The system enforces **Strict Single Stream Mode**. Dual simultaneous streaming has been permanently eliminated. At any moment, **strictly ONE mode** is active:

1. **HORIZONTAL 16:9 (Standard Landscape)**
   - **Stream Key**: `settings.youtube.horizontalStreamKey`
   - **Resolution**: `1920 × 1080` (16:9 aspect ratio)
   - **Playlist**: `stream.playlists.horizontal`
   - **Processes**: Exactly 1 FFmpeg publisher process + 1 video feeder
   - **YouTube Broadcast**: Resolved and bound strictly to the Horizontal LiveStream
   - **Orientation Gate**: Video files must have $width \ge height$. Vertical videos are rejected with HTTP 422 `E_HORIZONTAL_VIDEO_REQUIRED`.

2. **VERTICAL 9:16 (YouTube Shorts Portrait)**
   - **Stream Key**: `settings.youtube.streamKey`
   - **Resolution**: `1080 × 1920` (9:16 aspect ratio)
   - **Playlist**: `stream.playlists.vertical`
   - **Processes**: Exactly 1 FFmpeg publisher process + 1 video feeder
   - **YouTube Broadcast**: Resolved and bound strictly to the Vertical LiveStream
   - **Orientation Gate**: Video files must have $height > width$. Horizontal videos are rejected with HTTP 422 `E_VERTICAL_VIDEO_REQUIRED`.

### Invariants:
- **Zero Simultaneous Streaming**: Never runs horizontal and vertical publishers together. Secondary PID is permanently `null`.
- **Zero Cross-Mode Fallback**: Missing key or empty playlist fails stream start immediately.
- **Mode Switch Lock**: Changing mode while the stream is running returns HTTP 409 Conflict (`E_STREAM_RUNNING`). The stream must be stopped before switching modes.
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

# Check YouTube Live broadcast lifecycle:
curl -s http://127.0.0.1:3000/api/internal/cli-status | jq .youtubeLive
```

### 6. One-Time YouTube OAuth Setup (Autonomous Lifecycle)
```bash
# Run one-time OAuth 2.0 bootstrap on VPS (or locally):
node scripts/oauth-setup.js

# Or pass Client ID and Secret directly:
node scripts/oauth-setup.js --client-id="<CLIENT_ID>" --client-secret="<CLIENT_SECRET>"

# Append generated YOUTUBE_CLIENT_ID, SECRET, and REFRESH_TOKEN to:
sudo nano /etc/yt-live-manager/env

# Restart service to activate autonomous lifecycle control:
sudo systemctl restart yt-live-manager
```

### 7. Update Application Code (Run on VPS)
```bash
# Pull latest code and run safe update with automated backup & health check:
cd ~/yt-live-manager && git pull origin main && sudo bash update.sh
```

### 8. Reclaim ~250 MB+ RAM (Run on VPS)
```bash
# Trim heavy idle background daemons (snapd, journald buffers, caches):
sudo bash /opt/yt-live-manager/scripts/optimize-vps.sh
```

### 9. View Live Logs (Run on VPS)
```bash
# View live stream logs (stream keys & OAuth tokens automatically redacted):
sudo journalctl -u yt-live-manager -f
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

## Phase 5: Autonomous YouTube Broadcast Lifecycle & One-Time OAuth Setup

The streaming manager features an **autonomous, server-side YouTube Live Data API v3 lifecycle manager**. It allows 24×7 streaming to run **headlessly / unattended with Google Chrome and YouTube Studio completely CLOSED**.

---

### 5.1 Architecture: Transport vs. Broadcast Lifecycle

Streaming to YouTube involves two distinct layers:

1. **RTMPS Ingest Transport (FFmpeg)**:
   - Connects to Google's edge ingest server (`rtmps://a.rtmps.youtube.com:443/live2/<streamKey>`).
   - TCP packets and ACK bytes confirm physical data delivery to Google.
   - Ingest uses the stream key corresponding to the selected mode (`horizontalStreamKey` for 16:9, `streamKey` for 9:16).

2. **Broadcast Lifecycle Management (YouTube Data API v3)**:
   - **Stream Resolution:** Resolves the `liveStream` resource matching the active mode's stream key (`cdn.ingestionInfo.streamName === streamKey`).
   - **Ingest Health Polling:** Verifies `liveStream.status.streamStatus === 'active'` before attempting any transition.
   - **Broadcast Binding:** Resolves the `liveBroadcast` bound to the active stream, prioritizing `live` > `testing` > `ready`.
   - **Auto-Start Handling:**
     - If `enableAutoStart === true`: Awaits YouTube's automated ingest-to-live transition (up to 30s).
     - If `enableAutoStart === false` (or auto-start stalls): Explicitly transitions broadcast to `live`.
   - **Auto-Recycle Rollover:** Once a broadcast ends and transitions to `complete`, YouTube permanently locks it. On the next session cycle, the manager automatically instantiates a fresh broadcast via `createAndBindBroadcast()`, binds it to the mode's reusable stream, and transitions it to `live`.

---

### 5.2 Telemetry States

The dashboard and internal telemetry strictly separate encoder health from YouTube publication:

| State | Status Text | Meaning |
|:---|:---|:---|
| **FFmpeg Running (Unmanaged)** | `FFMPEG RUNNING (RTMPS ACTIVE • API UNCONFIGURED)` | FFmpeg is transmitting to YouTube RTMPS ingest; YouTube API credentials are not set. The server **never claims YouTube LIVE** without verification. |
| **Ingest Active, Preparing** | `FFMPEG HEALTHY (INGEST ACTIVE • BROADCAST: PREPARING)` | Google ingest server has received valid video chunks (`streamStatus: active`); broadcast is awaiting auto-start or transition. |
| **YouTube Broadcast Live (Horizontal)** | `YOUTUBE LIVE (HORIZONTAL 16:9 • BROADCAST LIVE)` | Data API confirms `lifeCycleStatus: live` for the Horizontal stream key. |
| **YouTube Broadcast Live (Vertical)** | `YOUTUBE LIVE (VERTICAL 9:16 • BROADCAST LIVE)` | Data API confirms `lifeCycleStatus: live` for the Vertical Shorts stream key. |

---

### 5.3 One-Time Google Cloud OAuth 2.0 Credentials Setup

YouTube Data API v3 requires OAuth 2.0 user credentials (Service Accounts are **not** supported by YouTube Live Streaming API).

#### Step 1: Create OAuth Client in Google Cloud Console
1. Open the [Google Cloud Console](https://console.cloud.google.com).
2. Create a new project (e.g., `YT-Live-Manager`) or select an existing project.
3. In the left navigation, go to **APIs & Services** → **Library**.
4. Search for **YouTube Data API v3** and click **Enable**.
5. Go to **APIs & Services** → **OAuth consent screen**:
   - Select User Type: **External** and click **Create**.
   - Fill in **App name** (e.g. `YT Live Manager`) and **User support email**.
   - Under **Scopes**, click **Add or Remove Scopes**, select `https://www.googleapis.com/auth/youtube`, and click **Update**.
   - Under **Test users**, click **Add Users** and enter the Google/Gmail address that owns your YouTube channel. Click **Save and Continue**.
6. Go to **APIs & Services** → **Credentials**:
   - Click **Create Credentials** → **OAuth client ID**.
   - Application type: Select **Desktop app** (recommended: works with localhost on any port) *or* **Web application** (Authorized redirect URI: `http://localhost:8085/oauth2callback`).
   - Click **Create**.
   - Copy the generated **Client ID** and **Client Secret**.

---

### 5.4 Run the One-Time OAuth Setup CLI

On your OCI VM (or on your local computer), run the included OAuth setup utility:

```bash
# Interactive mode (prompts for Client ID and Secret):
node scripts/oauth-setup.js

# Or pass them directly via flags:
node scripts/oauth-setup.js --client-id="<YOUR_CLIENT_ID>" --client-secret="<YOUR_CLIENT_SECRET>"
```

#### What Happens:
1. The tool prints a Google authorization link.
2. Open that URL in your browser, sign in with the Google account for your YouTube channel, and click **Allow**.
3. **If running locally or with SSH port forwarding (`ssh -L 8085:localhost:8085 ...`)**:
   The browser redirects to `http://localhost:8085/oauth2callback` and the CLI automatically captures the code.
4. **If running directly on the VPS without port forwarding**:
   Your browser will show a connection error after redirecting to `http://localhost:8085/oauth2callback?code=4/0A...`.
   **Copy the full URL from your browser's address bar and paste it into the CLI prompt.**
5. The CLI exchanges the authorization code for a persistent `refresh_token`, verifies your YouTube channel title, and outputs the exact configuration block.

---

### 5.5 Configure Production Environment & Restart

On your OCI VM, append the three generated variables to `/etc/yt-live-manager/env`:

```bash
sudo nano /etc/yt-live-manager/env
```

Add these three lines at the bottom:
```bash
YOUTUBE_CLIENT_ID="<your-client-id>.apps.googleusercontent.com"
YOUTUBE_CLIENT_SECRET="<your-client-secret>"
YOUTUBE_REFRESH_TOKEN="<your-refresh-token>"
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

Restart the service:
```bash
sudo systemctl restart yt-live-manager
```

Verify that the lifecycle manager is configured:
```bash
curl -s http://127.0.0.1:3000/api/internal/cli-status | jq .youtubeLive
```

Now, clicking **START** in the dashboard or triggering automated scheduling will autonomously connect FFmpeg, verify ingest stream activation, resolve the bound broadcast, and transition your YouTube channel to **LIVE** with no browser or YouTube Studio window required!

---

## Phase 6: Mode-Specific Playlists, Video Export & Going Live

### 6.1 Configuring Both Stream Keys
In **Settings ⚙️** (or directly in `/opt/yt-live-manager/config/settings.json`):
1. **Vertical 9:16 Stream Key (`settings.youtube.streamKey`)**:
   - Set to your YouTube Live key for Shorts/portrait broadcasts.
2. **Horizontal 16:9 Stream Key (`settings.youtube.horizontalStreamKey`)**:
   - Set to your YouTube Live key for standard landscape broadcasts.

Both keys are encrypted at rest with AES-256-GCM and masked in all logs and API responses.

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
