# Complete Deployment & Operations Runbook
## 24×7 YouTube Vertical Live Streaming Manager (`yt-live-manager`)

This runbook guides you through deploying and operating the live streaming server on an **Oracle Cloud Infrastructure (OCI) Always Free VM.Standard.E2.1.Micro (AMD x86_64)** or **Ampere A1 (ARM64)** Ubuntu instance.

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
   - **Shape:** `VM.Standard.E2.1.Micro`
   - **CPU:** 1 core OCPU (burstable AMD EPYC)
   - **RAM:** 1 GB Memory
   - **Bandwidth:** 0.48 Gbps (480 Mbps)
   - **OS:** Ubuntu 22.04 LTS or 24.04 LTS (`x86_64`)
   - *(Also fully compatible with Ampere A1 `VM.Standard.A1.Flex` ARM64)*

2. **OCI VCN Firewall & Security List:**
   - Ingress Rule: **Port 22 (SSH) only** from your IP (or `0.0.0.0/0`).
   - Port 3000 **does not** need to be opened in the OCI firewall. The dashboard binds to `127.0.0.1:3000` and is accessed securely through your SSH tunnel.

3. **SSH Into Your OCI Instance:**
   ```bash
   ssh -i /path/to/your/ssh_key.key ubuntu@<YOUR_OCI_VM_PUBLIC_IP>
   ```

---

## Phase 3: Installation on OCI Server

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
4. Copy your secret **Stream Key**.

---

## Phase 6: Video Export & Going Live

### Video Export Guidelines (Zero CPU Stream-Copy Mode)
On your editing software (Premiere / DaVinci / CapCut / Handbrake), export your vertical video with these parameters:

| Parameter | Recommended Setting |
|:---|:---|
| **Resolution** | `1080 × 1920` (9:16 Vertical) |
| **Video Codec** | `H.264 (AVC)` High Profile |
| **Audio Codec** | `AAC` (128 kbps, 44.1 kHz) |
| **Frame Rate** | `30 fps` (or 24 / 25 / 60) |
| **Keyframe Interval (GOP)** | `2 seconds` (GOP = 60 at 30 fps) |
| **Bitrate** | `4 Mbps (4000 kbps)` CBR or VBR |

### Going Live on the Dashboard
1. **Upload Video:**
   - In the **Video Library** card, drag & drop your exported `.mp4` file.
   - Once probed, confirm the green badge shows **COMPATIBLE**.
   - Click **Set Active** to assign it as the live stream source.

2. **Configure Settings:**
   - Open **Settings ⚙️**.
   - Paste your YouTube **Stream Key**.
   - Confirm RTMPS URL: `rtmps://a.rtmps.youtube.com:443/live2`
   - Confirm Stream Mode: `copy`
   - Confirm Video Bitrate: `4 Mbps`
   - Click **Save Settings**.

3. **Start the Stream:**
   - In **Stream Control**, click **START STREAM**.
   - The status badge will update: `IDLE` → `STARTING` → `STREAMING` (green pulse).
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

## Phase 8: Operational Commands & Day-2 Maintenance

Execute these commands directly on the OCI VM:

```bash
# Check service status
sudo systemctl status yt-live-manager

# View live application logs (with secret stream keys masked)
sudo journalctl -u yt-live-manager -f

# View raw JSON-Lines log file
sudo tail -f /opt/yt-live-manager/logs/app.log

# Monitor CPU, RAM, and Swap
htop

# Check memory and swap usage
free -h

# Restart the streaming service
sudo systemctl restart yt-live-manager

# Update application code to latest git version with automated backup & rollback
cd /opt/yt-live-manager && sudo bash update.sh
```
# 1. Pull the updates and apply the new 64MB memory limits
cd ~/yt-live-manager && git pull origin main && sudo bash update.sh

# 2. Run the Ubuntu VPS memory pruning script (frees ~250MB+ OS RAM)
sudo bash scripts/optimize-vps.sh
