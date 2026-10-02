# Complete Deployment & Operations Runbook
## 24×7 YouTube Vertical Live Streaming Manager (`yt-live-manager`)

This runbook guides you through deploying, operating, updating, and troubleshooting the live streaming server on an **Oracle Cloud Infrastructure (OCI) Always Free VM.Standard.E2.1.Micro (AMD x86_64)** or **Ampere A1 (ARM64)** Ubuntu instance.

---

## ⚡ Quick-Reference Command Cheat Sheet

For quick daily administration, copy and run these commands:

### 1. Connect & Open Dashboard (Run on Local Machine)
```bash
# Start SSH Tunnel (Forwards port 3000 to local port 8443)
ssh -i /path/to/your/ssh_key.key -L 8443:127.0.0.1:3000 ubuntu@<YOUR_OCI_VM_PUBLIC_IP>

# Access Dashboard in browser:
# http://localhost:8443
```

### 2. Update Application Code (Run on VPS)
```bash
# Pull latest code and run safe update with automated backup & health check:
cd ~/yt-live-manager && git pull origin main && sudo bash update.sh
```

### 3. Reclaim ~250 MB+ RAM (Run on VPS)
```bash
# Trim heavy idle background daemons (snapd, journald buffers, caches):
sudo bash /opt/yt-live-manager/scripts/optimize-vps.sh
```

### 4. Service Control & Live Logs (Run on VPS)
```bash
# Check service health and uptime:
sudo systemctl status yt-live-manager

# View live stream logs (stream keys automatically redacted):
sudo journalctl -u yt-live-manager -f

# Restart the live streaming engine:
sudo systemctl restart yt-live-manager
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
   - **Swap Protection:** Automatically sets up a **2 GB swapfile** (`/swapfile`, `swappiness=10`) if total swap is under 1 GB, protecting the 1 GB RAM instance from Linux OOM kills.
   - **Package Dependencies:** Installs `ffmpeg`, `ffprobe`, `curl`, `ca-certificates`.
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

## Phase 5: YouTube Studio Broadcast Setup

In [YouTube Studio](https://studio.youtube.com):

1. Click **Create** → **Go Live**.
2. Select **Stream** (left menu) to create a new live stream or use your default stream.
3. Configure settings for 24×7 vertical streaming:
   - **Stream Key:** Create a new or select a reusable **Default stream key**.
   - **Auto-start:** Turn **OFF** (or ON if you want YouTube to go live as soon as bytes arrive).
   - **Auto-stop:** Turn **OFF** (CRITICAL: prevents YouTube from terminating the broadcast on brief network hiccups or server restarts).
   - **Stream Latency:** Set to **Normal latency** (provides the largest ingestion buffer for maximum 24×7 buffer resilience).
4. Copy your secret **Stream Key** (format: `xxxx-xxxx-xxxx-xxxx-xxxx`).

---

## Phase 6: Video Export & Going Live

### Video Export Guidelines (Zero CPU Stream-Copy Mode)
On your editing software (Premiere / DaVinci / CapCut / Handbrake), export your vertical video with these parameters:

| Parameter | Recommended Setting | Purpose |
|:---|:---|:---|
| **Resolution** | `1080 × 1920` (9:16 Vertical) | Native vertical HD format for Shorts & Live |
| **Video Codec** | `H.264 (AVC)` High Profile | Standard H.264 profile for YouTube RTMP ingestion |
| **Audio Codec** | `AAC` (128 kbps, 44.1 kHz, Stereo) | Standard AAC stereo audio |
| **Frame Rate** | `30 fps` (or 24 / 25 / 60) | Constant frame rate |
| **Keyframe Interval (GOP)** | `2.0 seconds` (GOP = 60 at 30 fps) | Required by YouTube live ingestion buffer |
| **Bitrate** | `4 Mbps (4000 kbps)` CBR / VBR | Consumes ~49 GB/day (~1.47 TB/30d), well under OCI 10 TB allowance |

### Going Live on the Dashboard
1. **Upload Video:**
   - In the **Video Library** card, drag & drop your exported `.mp4` file.
   - Once probed, confirm the green badge shows **COMPATIBLE**.
   - Click **Set Active** to assign it as the live stream source.

2. **Configure Settings:**
   - Open **Settings ⚙️**.
   - Paste your YouTube **Stream Key**.
   - Confirm RTMPS URL: `rtmps://a.rtmps.youtube.com:443/live2`
   - Confirm Stream Mode: `auto` (or `copy`)
   - Confirm Video Bitrate: `4 Mbps`
   - Click **Save Configuration**. Confirm prompt displays `✅ Settings saved! YouTube stream key is active.`

3. **Start the Stream:**
   - In **Stream Control**, click **START STREAM**.
   - The status badge will update: `STOPPED` → `STARTING` → `RUNNING` (green pulse).
   - The **Health Verdict** card will show `HEALTHY` (speed ≥ 1.0x).
   - In YouTube Studio, verify status transitions to **"Excellent Connection"** with your vertical live video playing!

---

## Phase 7: On-Server Acceptance Checklist (PRD §26.3)

| ID | Test | Procedure & Verification | Status |
|:---|:---|:---|:---:|
| **A1** | Clean Ubuntu install | `sudo bash install.sh` completes cleanly; dashboard reachable via SSH tunnel | ✅ Pass |
| **A2** | Compatible video upload | Upload 1080×1920 H.264/AAC file; badge shows `COMPATIBLE`; stream starts in **copy** mode | ✅ Pass |
| **A3** | Non-compliant video probe | Upload a 1920×1080 (landscape) video; badge shows `REQUIRES TRANSCODING` with plain-language explanation | ✅ Pass |
| **A4** | Transcode benchmark | If transcode is selected, speed gauge and CPU are logged; copy mode runs at < 4% CPU | ✅ Pass |
| **A5** | Continuous loop test | Video loops seamlessly forever; zero frame drops, PTS remains monotonic | ✅ Pass |
| **A6** | Crash recovery test | Run `sudo kill -9 $(pgrep ffmpeg)` on VM; dashboard shows `RECONNECTING` and restarts within 15s | ✅ Pass |
| **A7** | Egress network recovery | Block egress: `sudo iptables -A OUTPUT -p tcp --dport 443 -j DROP`. Wait 1 min, then unblock: `sudo iptables -D OUTPUT -p tcp --dport 443 -j DROP`. Stream auto-reconnects | ✅ Pass |
| **A8** | Server reboot auto-resume | While streaming, run `sudo reboot`. Reconnect SSH tunnel after 60s: stream resumes automatically with usage intact | ✅ Pass |
| **A9** | Safety limit shutdown | In Settings, set safety limit to `0.01 GB`. Stream cleanly stops within 5s with `BANDWIDTH_LIMIT_REACHED` banner; auto-restart blocked | ✅ Pass |
| **A10**| Period rollover reset | Change safety limit back to 9000 GB; lock clears and stream resumes | ✅ Pass |
| **A11**| Zero secrets leak audit | Run `sudo grep -r "<STREAM_KEY>" /opt/yt-live-manager/logs/` and `ps aux \| grep ffmpeg`. Matches found: **0** | ✅ Pass |
| **A12**| Disk space protection | Video upload rejects files if remaining free space is under 5 GB disk reserve | ✅ Pass |
| **A13**| Bitrate calculation | Adjust target bitrate in Settings; monthly forecast and daily allowance update immediately | ✅ Pass |
| **A14**| Safe updater & rollback | Run `sudo bash update.sh`; settings and data are preserved intact; automatic rollback on failure | ✅ Pass |

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
Simply double-click **`YT_Live_GPU_Converter.bat`** in the repository root.
- Automatically selects any video with a file dialog.
- Detects the source video's bitrate and duration.
- **Preserves original file size** (e.g. 2 GB remains ~2 GB, never bloating into 8 GB).
- Automatically caps high-bitrate videos (e.g. 10 Mbps) at **4 Mbps** to stay within YouTube Live & bandwidth limits.
- Outputs 1080×1920 30fps vertical video that is **100% Stream-Copy Ready** (No re-encode errors on upload!).

#### Windows PowerShell Command (Manual):
```powershell
# Probe source bitrate and cap at 4000k max
$input = "input.mp4"
$raw = & ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate -of default=noprint_wrappers=1:nokey=1 "$input"
$b = 0; if ($raw -and [int64]::TryParse($raw.Trim(), [ref]$b) -and $b -gt 0) { } else { $b = 4000000 }
$kb = [Math]::Min([Math]::Max(500, [int][Math]::Round($b / 1000)), 4000)
$buf = [Math]::Min($kb * 2, 8000)

ffmpeg -i "$input" `
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1" `
  -c:v libx264 -preset slow -profile:v high -b:v "${kb}k" -maxrate "${kb}k" -bufsize "${buf}k" `
  -g 60 -keyint_min 60 -sc_threshold 0 `
  -c:a aac -b:a 128k -ar 48000 -ac 2 `
  -pix_fmt yuv420p -movflags +faststart `
  "output_1080x1920.mp4"
```

#### Linux / macOS Terminal Command:
```bash
# Uses -crf 20 with -maxrate 4M to adapt to source complexity without bloating file size
ffmpeg -i "input.mp4" \
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1" \
  -c:v libx264 -preset slow -profile:v high -crf 20 -maxrate 4000k -bufsize 8000k \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -pix_fmt yuv420p -movflags +faststart \
  "output_1080x1920.mp4"
```

---

### 8.5 Direct CLI Video Upload to VPS (Bypassing Browser)

If your browser upload is interrupted or you are transferring large videos (> 2 GB), transfer directly via SSH:

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
*(Once moved, the video will appear immediately in your dashboard Video Library upon refresh.)*

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
If the dashboard reports `In maintenance mode (admin)` or pre-flight gate errors:
```bash
# Run schema and state auto-healer:
cd /opt/yt-live-manager && sudo node scripts/migrate.js
sudo systemctl restart yt-live-manager
```

#### 3. Terminate Stuck FFmpeg Processes & Clear Locks
If an FFmpeg process becomes unresponsive or the engine reports a lock collision:
```bash
# Force-kill any lingering ffmpeg instances
sudo pkill -9 ffmpeg || true

# Remove stale lockfile
sudo rm -f /opt/yt-live-manager/data/ffmpeg.lock

# Restart the service
sudo systemctl restart yt-live-manager
```

#### 4. Test YouTube Ingestion Connectivity
Verify that your OCI VM can reach YouTube's RTMP ingestion endpoints over port 443:
```bash
# Test TCP connection to primary YouTube RTMPS server:
curl -v telnet://a.rtmps.youtube.com:443 --connect-timeout 5

# Test TLS handshake:
openssl s_client -connect a.rtmps.youtube.com:443 -servername a.rtmps.youtube.com </dev/null
```

#### 5. Inspect or Unlock Bandwidth Safety Lock
If the 9 TB safety limit was reached and streaming locked:
```bash
# View current month bandwidth statistics:
cat /opt/yt-live-manager/data/bandwidth-usage.json

# Check current stream state flags:
cat /opt/yt-live-manager/data/stream-state.json
```

#### 6. Create Manual Snapshot Backup
```bash
# Create an on-demand snapshot of settings and state data:
sudo mkdir -p /opt/yt-live-manager/backups
sudo tar -czf /opt/yt-live-manager/backups/manual-snapshot-$(date +%Y%m%d%H%M%S).tar.gz -C /opt/yt-live-manager config data
sudo chown ytlive:ytlive /opt/yt-live-manager/backups/*.tar.gz
```

---

## YouTube URL Direct Import (yt-dlp Feature)

The dashboard includes a **"▶️ YouTube URL"** tab in the Video Library panel that downloads and auto-converts any YouTube video directly into the correct vertical stream format.

### How It Works

1. In the dashboard, click the **"▶️ YouTube URL"** tab in the Video Library card.
2. Paste any YouTube URL (watch, shorts, live, youtu.be).
3. Click **Download** — the server runs a two-stage pipeline:
   - **Stage 1 (Download):** `yt-dlp` downloads the best-quality MP4 stream from YouTube to the server.
   - **Stage 2 (Convert):** FFmpeg re-encodes the video to **1080×1920 30fps** with the exact output format:
     ```
     scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2
     libx264 · veryfast preset · 4 Mbps CBR · 2s GOP · AAC 128k 48kHz stereo · +faststart
     ```
4. Real-time progress (Download % with speed/ETA, then Conversion % with encode speed) is shown in the UI.
5. On completion, a prompt asks whether to set the video as the active live stream source.

### yt-dlp Requirement

`yt-dlp` must be installed on the VPS. Both `install.sh` and `update.sh` handle this automatically:

```bash
# Installed automatically during setup or update:
sudo bash install.sh
# or
sudo bash update.sh

# Verify installation:
yt-dlp --version

# Manual install (if needed):
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
```

### Supported URL Formats

| Type | Example |
|------|---------|
| Standard watch | `https://www.youtube.com/watch?v=VIDEO_ID` |
| Short URL | `https://youtu.be/VIDEO_ID` |
| Shorts | `https://www.youtube.com/shorts/VIDEO_ID` |
| Live | `https://www.youtube.com/live/VIDEO_ID` |
| Mobile | `https://m.youtube.com/watch?v=VIDEO_ID` |

### Notes & Constraints

- Only **one** download/conversion job runs at a time. A second request returns HTTP 409.
- No video length limit — existing disk space reserve checks apply.
- The raw download temp file is cleaned up after conversion.
- Cancel button stops both download and conversion and cleans up temp files.
- If the page is refreshed mid-job, the UI auto-resumes polling on page load.
- If `yt-dlp` is not installed, the button shows a clear error message with the `bash update.sh` command.
