# 24×7 YouTube Vertical Live Streaming Manager

An ultra-reliable, unattended 24×7 live streaming server designed specifically for vertical YouTube live streams running on Oracle Cloud Infrastructure (OCI) Always-Free Ampere A1 ARM64 architecture with Ubuntu Server LTS.

---

## ⚡ Core Highlights

- **Zero Database / Zero Docker:** Pure JSON state persistence using atomic fsync + rename semantics. Survives hard reboots and power losses without state corruption.
- **Minimal Production Dependencies:** Exactly three dependencies allowed: `express`, `busboy` (streaming multipart upload), and `helmet` (hardened security headers). All other logic utilizes Node.js built-ins (`crypto`, `fs`, `child_process`, `os`, `net`, `tls`, `readline`, `Intl`).
- **Secret Redaction:** The YouTube stream key is never written to normal logs, error traces, backups, or API responses. `lib/redact.js` filters every stderr line and command argument before disk/terminal emission.
- **Bandwidth Safety Backstop:** Continuous accounting in bytes with safety limit lock at 9 TB (configurable) out of 10 TB OCI monthly allowance. Automatic graceful shutdown protects against runaway billing.
- **Process Guard & Single Instance:** FFmpeg is spawned with arg arrays (`shell: false`). Mutex and atomic `data/ffmpeg.lock` strictly forbid duplicate streaming instances.
- **Crash & Stall Recovery:** Automatic recovery with exponential backoff and jitter; detects process crashes, output stalls, and encoding speed degradation.

---

## 🚀 Quick Start (Local Development)

### Requirements
- Node.js LTS (>= 18.15.0)
- FFmpeg and FFprobe on system PATH

### Installation
```bash
npm install
```

### Running Tests
The project features a comprehensive unit and integration test suite using Node's native `node:test` runner:
```bash
npm test
```

### Starting Dev Server
```bash
npm run dev
```
Open `http://localhost:3000` in your browser.

---

## ☁️ Deployment on OCI (Always Free Shapes)
 
### 1. Provision VM
- **Option A (Ultra-Lightweight):** `VM.Standard.E2.1.Micro` (1 OCPU, 1 GB RAM, x86_64 Ubuntu 22.04/24.04). Operates in zero-CPU stream-copy mode (`-c copy`) with automated 2 GB swapfile.
- **Option B (High-Capacity):** `VM.Standard.A1.Flex` (2–4 OCPU, 12–24 GB RAM, ARM64 / aarch64 Ubuntu 22.04/24.04). Suitable for copy and real-time transcode modes.

### 2. Run Idempotent Installer
Copy or clone the repository to the server, then execute:
```bash
sudo ./install.sh
```
The installer automatically:
- Installs Node.js 22 LTS and FFmpeg with `libx264` and `aac`.
- Creates dedicated system user `ytlive`.
- Sets up `/opt/yt-live-manager` with strict directory permissions (`0700`).
- Prompts for the admin password and writes hashed credentials into `/etc/yt-live-manager/env` (`0640`).
- Installs and enables the hardened systemd service unit.

### 3. Connect via SSH Tunnel
By default, the dashboard binds to `127.0.0.1:3000` for security. Connect from your local computer:
```bash
ssh -L 8443:127.0.0.1:3000 ubuntu@<YOUR_OCI_INSTANCE_IP>
```
Then navigate to `http://localhost:8443` in your local web browser.

---

## 🛡️ Acceptance Test Matrix (PRD §26.3)

| ID | Test Description | Verification Path | Status |
|---|---|---|---|
| **A1** | Clean Ubuntu ARM64 install via `install.sh` | Run `sudo ./install.sh` on clean VM | Automated script / Verified |
| **A2** | Upload compliant 1080×1920 video | Probed and marked `COMPATIBLE` | Covered in `test/unit/ffprobe-manager.test.js` & `video-manager.test.js` |
| **A3** | Copy-mode streaming to RTMP sink | `-c copy`, video un-transcoded, CPU < 5% | Covered in `test/unit/ffmpeg-manager.test.js` & `stream-manager.test.js` |
| **A4** | Transcode fallback on non-compliant video | Transcodes to 1080×1920 30fps high-profile | Covered in `test/unit/ffprobe-manager.test.js` |
| **A5** | 24-hour soak test | Verify loop continuity and monotonic PTS | Manual on server (see below) |
| **A6** | Network interrupt recovery | Backoff recovery reconnects stream | Covered in `test/unit/stream-manager.test.js` |
| **A7** | Host reboot auto-resume | Desired state running resumes on boot | Covered in `test/unit/state-manager.test.js` |
| **A8** | `kill -9` on FFmpeg | Watchdog detects exit, restarts within 15s | Covered in `test/unit/stream-manager.test.js` |
| **A9** | Stall watchdog | Stalled progress triggers kill and respawn | Covered in `test/unit/ffmpeg-manager.test.js` |
| **A10**| Bandwidth safety limit shutdown | Reaching 100% of safety limit locks stream | Covered in `test/unit/bandwidth-monitor.test.js` |
| **A11**| Monthly accounting rollover | Rolls over on period boundary, resets counters | Covered in `test/unit/usage-manager.test.js` |
| **A12**| Corrupt `settings.json` recovery | Automatically restores from newest backup | Covered in `test/unit/atomic-json.test.js` & `config-manager.test.js` |
| **A13**| Dynamic bitrate changes | Preview and projections update immediately | Covered in `test/unit/bitrate-calculator.test.js` & `calc.js` |
| **A14**| `update.sh` with rollback | Settings untouched; rollback on forced failure | Automated script / Verified |

---

## 🔬 Acceptance on the Server (Manual Runbook)

Once deployed on your OCI instance, you can run the final manual soak and resilience tests:
1. **Soak Test (A5):** Select your primary video and click **Start Stream**. Confirm live status in YouTube Studio. Allow to loop for at least 20 iterations or 24 hours.
2. **Crash Resilience (A8):** Find the FFmpeg PID from the dashboard or `pgrep ffmpeg`, then execute:
   ```bash
   sudo kill -9 <PID>
   ```
   Observe the dashboard: state transitions to `RECONNECTING` and restarts within backoff window.
3. **Reboot Resilience (A7):** While streaming, reboot the VM (`sudo reboot`). After boot finishes, verify with `sudo systemctl status yt-live-manager` that streaming resumed automatically.
4. **OCI Idle-Reclamation Notice:** OCI reclaims idle Always-Free VMs whose CPU utilization is < 20% and network egress is < 20% over 7 days. A running 24×7 stream at 8 Mbps generates ~88 GB/day (> 2.6 TB/month), which well exceeds the network threshold and keeps the instance active without fake load scripts.

---

## 🛠 Useful Administrative Commands

```bash
# Check service status
sudo systemctl status yt-live-manager

# Restart manager
sudo systemctl restart yt-live-manager

# Stream live application logs (redacted)
sudo journalctl -u yt-live-manager -f

# Generate a new admin password hash
npm run hash-password
```
