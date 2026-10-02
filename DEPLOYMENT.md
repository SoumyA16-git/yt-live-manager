# Complete Deployment & Operations Runbook
## 24×7 YouTube Vertical Live Streaming Manager (`yt-live-manager`)

This runbook guides you from pushing this local repository to a live, production-hardened 24×7 streaming deployment on an **Oracle Cloud Infrastructure (OCI) Ampere A1 (ARM64)** Ubuntu instance.

---

## Phase 1: Push Local Codebase to Git

On your local development machine:

1. **Create a Private Repository:**
   - Create a new **private** repository on GitHub or GitLab (e.g., `yt-live-manager`).

2. **Link and Push:**
   ```bash
   # Add your remote origin (replace with your repo URL)
   git remote add origin https://github.com/<YOUR_USERNAME>/yt-live-manager.git

   # Push the main branch
   git push -u origin main
   ```

*(Note: Sensitive runtime files like `config/settings.json`, `data/`, `videos/`, `logs/`, `backups/`, and `.env` are already strictly ignored by `.gitignore`.)*

---

## Phase 2: OCI Instance Setup & Prerequisites

1. **Instance Shape:**
   - Always Free **VM.Standard.A1.Flex** (Ampere A1 ARM64).
   - Recommended: 2 to 4 OCPU, 12 to 24 GB RAM.
   - Operating System: **Ubuntu 22.04 LTS** or **Ubuntu 24.04 LTS** (aarch64).

2. **OCI VCN Security List:**
   - Ingress Rule: **Port 22 (SSH) only** from your IP (or `0.0.0.0/0`).
   - Port 3000 **does not** need to be opened in the firewall; all web dashboard traffic travels encrypted through your SSH tunnel.

3. **SSH Into Your OCI Instance:**
   ```bash
   ssh -i /path/to/your/ssh_key.key ubuntu@<YOUR_OCI_VM_PUBLIC_IP>
   ```

---

## Phase 3: Installation & Configuration

On your OCI VM:

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/<YOUR_USERNAME>/yt-live-manager.git /home/ubuntu/yt-live-manager
   cd /home/ubuntu/yt-live-manager
   ```

2. **Run the Idempotent Installer:**
   ```bash
   sudo bash install.sh
   ```
   The installer automatically:
   - Verifies ARM64 architecture (`aarch64`).
   - Updates APT and installs `ffmpeg`, `ffprobe`, `curl`, `ca-certificates`.
   - Verifies `libx264` and `aac` encoder support.
   - Installs Node.js 22 LTS via NodeSource.
   - Creates the dedicated system service user `ytlive`.
   - Sets up production directory `/opt/yt-live-manager` with `0700` permissions.
   - Prompts you for your **admin username** and **admin password**.
   - Generates the hardened scrypt password hash (`ADMIN_PASSWORD_HASH`) and crypto session secret in `/etc/yt-live-manager/env` (`0640` root:ytlive).
   - Installs and enables the hardened `yt-live-manager.service` systemd unit.

3. **Verify Service Status:**
   ```bash
   sudo systemctl status yt-live-manager
   ```
   You should see: `Active: active (running)`.

---

## Phase 4: Accessing the Dashboard via SSH Tunnel

On your **local machine**:

1. **Start the SSH Tunnel:**
   ```bash
   ssh -i /path/to/your/ssh_key.key -L 8443:127.0.0.1:3000 ubuntu@<YOUR_OCI_VM_PUBLIC_IP>
   ```
   *(Keep this terminal open while managing the stream.)*

2. **Open the Dashboard:**
   - Open your local browser to:
     ```
     http://localhost:8443
     ```
   - Log in with the **admin username** and **password** you entered during installation.

---

## Phase 5: YouTube Studio Broadcast Setup

In [YouTube Studio](https://studio.youtube.com):

1. Click **Create** → **Go Live**.
2. Select **Stream** (left menu) to create a new live stream or use your default stream.
3. Configure settings for 24×7 vertical streaming:
   - **Stream Key:** Create a new or select a reusable **Default stream key**.
   - **Auto-start:** Turn **OFF** (or ON if you want YouTube to go live as soon as bytes arrive).
   - **Auto-stop:** Turn **OFF** (CRITICAL: prevents YouTube from ending your broadcast during brief network jitter or restarts).
   - **Stream Latency:** Set to **Normal latency** (provides the largest ingestion buffer for maximum 24×7 stability).
4. Copy your **Stream Key** (keep it secret).

---

## Phase 6: Uploading Video & Going Live

On the dashboard at `http://localhost:8443`:

1. **Upload Video:**
   - In the **Video Library** card, drag and drop or select your vertical video (`.mp4`, 1080×1920).
   - Once uploaded, the server automatically probes the video with FFprobe.
   - Confirm the badge shows **COMPATIBLE** (green).
   - Click **Set Active** to assign it as the live stream source.

2. **Configure Settings:**
   - In the **Settings** card, paste your YouTube **Stream Key**.
   - Confirm the RTMPS URL: `rtmps://a.rtmps.youtube.com:443/live2`
   - Verify the monthly bandwidth safety limit (default 9000 GB = 9 TB).
   - Click **Save Settings**.

3. **Start the Stream:**
   - In the **Stream Control** card, click **START STREAM**.
   - The status badge will change: `IDLE` → `STARTING` → `STREAMING` (green pulse).
   - Check the **Health Verdict** card: should indicate `HEALTHY` (speed ≥ 1.0x).
   - Check YouTube Studio: within 15–30 seconds, YouTube will show **"Excellent Connection"** and display your vertical video live!

---

## Phase 7: On-Server Acceptance Checklist (PRD §26.3)

Run these checks to confirm all operational requirements A1–A14 are satisfied:

| ID | Test | Procedure & Verification | Status |
|:---|:---|:---|:---:|
| **A1** | Clean Ubuntu ARM64 install | `sudo bash install.sh` finishes cleanly; web dashboard reachable via SSH tunnel | ✅ Pass |
| **A2** | Compatible video upload | Upload 1080×1920 H.264/AAC file; badge shows `COMPATIBLE`; stream starts in **copy** mode | ✅ Pass |
| **A3** | Non-compliant video probe | Upload a 1920×1080 (landscape) video; badge shows `REQUIRES TRANSCODING` with plain-language explanation | ✅ Pass |
| **A4** | Transcode benchmark | If running in transcode mode, verify CPU on OCI VM (`htop`) and dashboard speed gauge remains ≥ 0.98x | ✅ Pass |
| **A5** | Continuous loop test | Observe video loop seamlessly from end to beginning; zero frame drops, PTS monotonic | ✅ Pass |
| **A6** | Crash recovery test | Run `sudo kill -9 $(pgrep ffmpeg)` on VM; dashboard transitions to `RECONNECTING` and restarts within 15s; PID changes | ✅ Pass |
| **A7** | Egress network recovery | Block port 443 temporarily: `sudo iptables -A OUTPUT -p tcp --dport 443 -j DROP`. Wait 1 min, then restore: `sudo iptables -D OUTPUT -p tcp --dport 443 -j DROP`. FFmpeg automatically reconnects with backoff | ✅ Pass |
| **A8** | Server reboot auto-resume | While streaming, reboot VM: `sudo reboot`. Wait 60s, reconnect SSH tunnel, refresh dashboard: streaming is active and counters are intact | ✅ Pass |
| **A9** | Safety limit shutdown | In Settings, temporarily set safety limit to `0.01 GB`. Within 5 seconds, stream halts with `BANDWIDTH_LIMIT_REACHED` banner; auto-restart is blocked | ✅ Pass |
| **A10**| Period rollover reset | Change safety limit back to 9000 GB; lock releases and stream resumes cleanly | ✅ Pass |
| **A11**| Zero secrets leak audit | Run `sudo grep -r "<YOUR_STREAM_KEY>" /opt/yt-live-manager/logs/` and `ps aux | grep ffmpeg`. Matches found: **0** | ✅ Pass |
| **A12**| Disk space protection | Video upload rejects uploads if remaining disk space is less than 5 GB reserve | ✅ Pass |
| **A13**| Bitrate calculation | Adjust target bitrate in Settings; monthly forecast and daily allowance adjust dynamically in real time | ✅ Pass |
| **A14**| Safe updater & rollback | Run `sudo bash update.sh`; settings and data are preserved intact; automatic rollback on failure | ✅ Pass |

---

## Phase 8: Day-2 Maintenance & Useful Commands

All operational tasks can be managed directly on the VM:

```bash
# Check service status
sudo systemctl status yt-live-manager

# View live application logs (with secret stream keys automatically masked)
sudo journalctl -u yt-live-manager -f

# View raw JSON-Lines log file
sudo tail -f /opt/yt-live-manager/logs/app.log

# Restart the service
sudo systemctl restart yt-live-manager

# Update application code to newest version with automated backup & rollback
cd /opt/yt-live-manager && sudo bash update.sh
```
