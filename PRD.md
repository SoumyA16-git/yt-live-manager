# PRD — 24×7 YouTube Vertical Live Streaming Manager

| | |
|---|---|
| **Project folder** | `yt-live-manager/` |
| **Document status** | v1.0 — implementation-ready |
| **Target** | OCI Always Free · Ampere A1 (ARM64/aarch64) · Ubuntu Server LTS |
| **Stack** | Node.js (LTS) · FFmpeg/FFprobe · systemd · Nginx (recommended) · vanilla HTML/CSS/JS |
| **Storage** | JSON files only — **no database** |

---

## 0. How to read this document (rules for the implementing developer)

1. This PRD is the source of truth. If something is ambiguous, pick the **simplest option that preserves 24×7 stability**, and record the decision in `DECISIONS.md`.
2. **Production dependencies are limited to:** `express`, `busboy` (streaming multipart upload), `helmet` (security headers). Everything else uses Node built-ins (`crypto`, `fs`, `child_process`, `os`, `net`, `tls`, `readline`, `Intl`). Adding any other dependency requires a written reason in `DECISIONS.md`.
3. **Forbidden:** Docker, Kubernetes, Redis, PostgreSQL/MySQL/MongoDB/SQLite, any external paid streaming service, any cloud SDK in the core path.
4. **Stability beats features.** If a feature risks the 24×7 stream, cut the feature.
5. "MUST / SHOULD / MAY" follow RFC 2119 meaning. Priority tags: **P0** = MVP, **P1** = ship soon after, **P2** = later.
6. All numbers in examples (thresholds, delays, sizes) are **defaults** and MUST be configurable in `settings.json` unless stated otherwise.

---

## 1. Product Summary

### 1.1 One-line objective
Upload/select **one vertical video**, configure the **YouTube stream key**, press **START**, and the server streams that video to YouTube Live **24 hours a day, 7 days a week** — looping forever, recovering from crashes by itself, tracking bandwidth against a **monthly** allowance, and shutting itself down safely before the allowance is exhausted.

### 1.2 What this is NOT
- Not a short-duration / "3 GB per day" streaming tool. There is **no daily cap**.
- Not a multi-tenant SaaS, not a studio/OBS replacement, not a live-camera tool.
- Not a Shorts-feed distribution tool (see §14.3).

### 1.3 Primary user
A single administrator (non-developer-friendly UI) who wants to set up once and let it run unattended. Must be able to recover from a reboot **without SSH**.

### 1.4 Success criteria
| # | Criterion |
|---|---|
| S1 | Stream runs ≥ 72 h continuously in a soak test with no manual action (copy mode). |
| S2 | `kill -9` on FFmpeg → stream back up automatically within backoff window, restart count increments, no duplicate processes. |
| S3 | Server reboot → stream resumes automatically (if configured) with usage accounting intact. |
| S4 | Setting the safety limit to a tiny value (e.g. 0.01 GB) → stream stops cleanly, state `BANDWIDTH_LIMIT_REACHED`, no auto-restart, survives reboot. |
| S5 | Stream key never appears in logs, API responses (except explicit re-authenticated reveal), error messages, or `ps` output visible to other users. |
| S6 | Idle app + streaming (copy mode) uses < 150 MB RAM for Node process and < 10% of one OCPU on average. |

---

## 2. Deployment Environment

### 2.1 Target platform
- OCI Always Free **Ampere A1** (ARM64 / `aarch64`), Ubuntu Server LTS ARM64 (e.g. 24.04).
- Recommended shape: **2 OCPU / 12 GB** minimum if transcoding may be used; 1 OCPU / 6 GB is sufficient for stream-copy only. (Always Free A1 pool: 4 OCPU / 24 GB total — verify current limits in Oracle docs.)
- Node.js: current **LTS** major, installed via NodeSource; major version pinned in `install.sh` as `NODE_MAJOR` (default `22`, verify current LTS at implementation time). Node ≥ 18.15 is REQUIRED (uses `fs.statfs`).
- FFmpeg + FFprobe from Ubuntu apt (`ffmpeg` package, ARM64 build with `libx264`).
- systemd manages the app. Nginx reverse proxy + HTTPS recommended.

### 2.2 Hard constraints
No AWS, Docker, Kubernetes, Redis, or any database. Must run comfortably on a small ARM64 instance.

### 2.3 Operational risk: OCI idle-instance reclamation (IMPORTANT)
Oracle may **reclaim Always Free compute instances it considers idle** (low CPU / network / memory utilization over a multi-day window). A stream-copy workload is very light on CPU and memory and may look "idle" by those metrics. The implementer and administrator MUST:
- Check Oracle's current idle-reclamation policy (thresholds and exemptions, e.g. upgrading the account to Pay-As-You-Go while still using only Always Free resources) **before** relying on this system for months.
- Document the chosen mitigation in `README.md`.
- Treat this as a deployment risk, not an app bug. The app MAY expose a note on the System card; it MUST NOT generate fake load to game the policy.

---

## 3. Core Functional Requirements (summary)

| ID | Requirement | Pri |
|---|---|---|
| F1 | Continuous 24×7 streaming of a prerecorded video, infinite loop, no manual restart | P0 |
| F2 | YouTube RTMPS output (TLS) | P0 |
| F3 | Stream-copy mode when source is compatible; transcode otherwise | P0 |
| F4 | Configurable bitrate (6 / 8 / 10 Mbps + custom), default 8 Mbps | P0 |
| F5 | Dynamic bandwidth estimate (Mbps, GB/h, GB/day, GB/30d, TB/month) | P0 |
| F6 | Monthly bandwidth monitor, warnings, automatic safety shutdown, configurable reset | P0 |
| F7 | Automatic FFmpeg recovery with backoff, cooldown, failure threshold | P0 |
| F8 | Persistent state machine; resume after reboot | P0 |
| F9 | Scheduler: continuous / scheduled / manual | P0 (continuous+manual), P1 (scheduled) |
| F10 | Video library with FFprobe validation and compatibility status | P0 |
| F11 | Authenticated admin dashboard (vanilla JS, polling) | P0 |
| F12 | Structured, rotated, secret-free logs | P0 |
| F13 | Disk monitoring and upload protection | P0 |
| F14 | `install.sh`, `update.sh`, systemd unit, optional Nginx | P0 |
| F15 | Timestamped JSON backups with retention | P0 |
| F16 | Offline "prepare compatible source" job (pre-encode once, then stream copy) | P1 |
| F17 | OCI Monitoring API integration (authoritative egress) | P2 |
| F18 | Outbound alert webhook (Telegram/Discord/generic) | P2 |
| F19 | YouTube Data API stream-health check | P2 |

---

## 4. Streaming Design

### 4.1 Output profile (defaults)

| Parameter | Default |
|---|---|
| Resolution | 1080×1920 (9:16) |
| FPS | 30 |
| Video codec | H.264 (High profile, level 4.1/4.2) |
| Rate control | CBR (`minrate = maxrate = b:v`, `bufsize = 2 × b:v`) |
| Video bitrate | 8 Mbps (configurable) |
| Audio | AAC-LC, 128 Kbps, stereo, 44.1 or 48 kHz |
| Pixel format | `yuv420p` |
| Color | Rec.709 SDR, limited range |
| Scan | Progressive |
| Keyframe interval | 2 s (`-g 60 -keyint_min 60`, no scenecut) |
| Transport | RTMPS (TLS) to YouTube |

### 4.2 The central design decision: copy vs. transcode

> **Continuous real-time transcoding burns CPU 24×7.** On a small ARM64 VM it is the single biggest stability and cost risk. Therefore:

- **Mode A — Stream copy (PREFERRED).** If the source already meets the profile, FFmpeg only demuxes and remuxes (`-c copy`). CPU ≈ near zero.
- **Mode A2 — Hybrid (video copy + audio re-encode).** Source video is compatible but audio is missing/incompatible (e.g. no audio track, MP3, Opus, mono at odd rate). Video is copied; audio is encoded to AAC (or silent AAC is generated). Audio-only AAC encoding is cheap.
- **Mode B — Transcode.** Source video does not match. FFmpeg re-encodes to the output profile with libx264 (CPU-heavy).

**Recommended workflow for 24×7:** upload any file → if it shows `REQUIRES TRANSCODING`, run the **offline prepare job** (F16: one-time, low-priority pre-encode into a compliant 1080×1920 CBR-style file), then stream the prepared file in copy mode. Real-time transcoding stays available but the UI MUST show a persistent advisory ("Transcoding uses significant CPU for 24×7 streaming — prepare a compatible source instead").

Setting `stream.modePreference`: `"auto"` (default) | `"copy"` | `"transcode"`.
- `auto` → copy if COMPATIBLE, hybrid if only audio incompatible, else transcode.
- `copy` → refuse to start (`E_NEEDS_TRANSCODE`) if source isn't compatible.
- `transcode` → always re-encode.
`stream.allowTranscode` (default `true`): if `false`, an incompatible source returns `E_NEEDS_TRANSCODE` instead of transcoding.

### 4.3 Effective bitrate (important for bandwidth math)
- **Transcode mode:** effective video bitrate = configured `videoBitrateMbps`.
- **Copy mode:** the configured bitrate does **not** apply. Effective bitrate = the **source's measured video bitrate** (FFprobe stream `bit_rate`, falling back to `(file_size × 8 / duration) − audio_bitrate`). The bitrate selector in the UI MUST be disabled/greyed in copy mode, with the label "Source bitrate is used in copy mode".
- All bandwidth projections use the effective bitrate of the **currently active mode**.

### 4.4 FFmpeg argument builders (reference)

All invocations use `child_process.spawn('ffmpeg', argsArray, { shell: false })`. **Never** build a shell string.

**Copy mode**
```
ffmpeg -hide_banner -nostdin -loglevel warning -nostats -progress pipe:1
  -re -stream_loop -1 -fflags +genpts
  -i <video_path>
  -c copy -flvflags no_duration_filesize
  -f flv <rtmps_url>/<stream_key>
```

**Hybrid mode (video copy, audio → AAC)**
```
... -re -stream_loop -1 -fflags +genpts -i <video_path>
  -map 0:v:0 -map 0:a:0? -c:v copy
  -c:a aac -b:a 128k -ar 44100 -ac 2
  -f flv <rtmps_url>/<stream_key>
```
If the source has no audio track, add a second input: `-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100` and map it (`-map 1:a`), with `-shortest` NOT used (the video loops forever; anullsrc is infinite).

**Transcode mode (defaults, bitrate in kbps = Mbps×1000)**
```
ffmpeg -hide_banner -nostdin -loglevel warning -nostats -progress pipe:1
  -re -stream_loop -1 -fflags +genpts
  -i <video_path>
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p"
  -c:v libx264 -preset veryfast -profile:v high -level:v 4.2
  -b:v 8000k -minrate 8000k -maxrate 8000k -bufsize 16000k
  -g 60 -keyint_min 60 -sc_threshold 0
  -x264-params "nal-hrd=cbr:force-cfr=1"
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709
  -c:a aac -b:a 128k -ar 44100 -ac 2
  -flvflags no_duration_filesize
  -f flv <rtmps_url>/<stream_key>
```
- `-g`/`-keyint_min` = `fps × keyframeSeconds`, computed by the builder, not hardcoded.
- `preset` is configurable (`ultrafast`…`medium`, default `veryfast`); the benchmark in §22 decides the final default for the chosen shape.
- The builder is a **pure function** `buildFfmpegArgs(settings, videoMeta, secretTarget) → string[]`, unit-tested.

### 4.5 Infinite looping
- Primary strategy: `-re -stream_loop -1` (FFmpeg re-seeks the input; timestamps are offset continuously). The app MUST NOT restart FFmpeg at loop boundaries.
- Fallback strategy `stream.loopStrategy = "concat"` (P1): write `data/loop.ffconcat` containing the same file repeated N times (default 5000 lines) and use `-f concat -safe 0 -i`. Use only if the soak test shows timestamp/AV-sync glitches at the loop point.
- **Soak test requirement:** watch at least 20 loop iterations on a *short* test clip (e.g. 30 s) and verify on YouTube that no stall/freeze/AV desync occurs at loop boundaries.

### 4.6 YouTube destination
- Default ingest base: `rtmps://a.rtmps.youtube.com:443/live2` (stored in `youtube.rtmpsUrl`). Backup ingest (`rtmps://b.rtmps.youtube.com:443/live2?backup=1`) is optional (P2).
- Final URL = `rtmpsUrl + "/" + streamKey`. Only `rtmps://` is accepted by validation. (A test-only env flag `ALLOW_PLAIN_RTMP_FOR_TESTS=1` permits `rtmp://127.0.0.1` for local integration tests; the installer never sets it.)

### 4.7 Compatibility advisory on bitrate
YouTube's published ingest guidance recommends bitrate **ranges per resolution/fps**; 1080p at 30 fps is guided toward the lower-to-mid single-digit Mbps range, and higher rates are generally intended for 60 fps. The **8 Mbps default requested for this project exceeds the typical 30 fps range**; YouTube typically still accepts it, but:
- The UI shows an informational advisory when the effective bitrate is outside `youtubeGuidance.recommendedMbps` (default `[3, 9]`, configurable).
- The implementer MUST verify current numbers against YouTube's live-encoder documentation and update the default if needed. YouTube-side behavior can change independently of this application.

---

## 5. Source Validation (FFprobe)

### 5.1 When
Automatically after every upload, on "re-validate", and at stream start (cheap re-check of file mtime/size; full probe only if changed).

### 5.2 Probe command
```
ffprobe -v error -print_format json -show_format -show_streams <path>
```
Plus keyframe-interval scan (first 60 s, capped):
```
ffprobe -v error -select_streams v:0 -skip_frame nokey
  -show_entries frame=pts_time -read_intervals "%+60" -of csv=p=0 <path>
```
→ compute `maxKeyframeIntervalSec`.

All probes: `spawn` with arg arrays, timeout 60 s, run with `nice`-level lowered priority.

### 5.3 Extracted fields
`width, height, aspectRatio, durationSec, fps (r_frame_rate vs avg_frame_rate → isVFR), videoCodec, videoProfile, pixFmt, fieldOrder, colorSpace/primaries/transfer, videoBitrate, maxKeyframeIntervalSec, audioCodec, audioProfile, audioChannels, audioSampleRate, audioBitrate, fileSizeBytes, container`.

### 5.4 Compatibility rules

Status is exactly one of **`COMPATIBLE`** or **`REQUIRES_TRANSCODING`**, plus a `reasons[]` array (blockers) and `warnings[]` (non-blocking).

A source is **COMPATIBLE** (copy mode) only if **all** blockers pass:

| Check | Rule |
|---|---|
| Resolution | equals configured output (default 1080×1920) |
| Video codec | `h264`; profile baseline/main/high (not High 10 / 4:2:2 / 4:4:4) |
| Pixel format | `yuv420p` |
| Frame rate | within ±0.1 of configured FPS and **not** variable-frame-rate |
| Scan | progressive (`field_order` progressive or unknown) |
| Keyframe interval | `maxKeyframeIntervalSec ≤ keyframeMaxSeconds` (default 4.0; ideal 2.0 → warning if > 2.2) |
| Audio | AAC-LC, 1–2 channels, 44.1/48 kHz. **No audio → hybrid mode** (not a blocker for COMPATIBLE-with-hybrid, shown as warning "silent audio will be generated") |
| Video bitrate | between `copyMinMbps` (default 2) and `copyMaxMbps` (default 12) |

Warnings (do not block): color primaries unspecified/not bt709; bitrate outside YouTube guidance range; source is VBR (copy mode inherits peaks — "prepare as CBR for best results"); duration < 5 s (loop boundary frequency).

### 5.5 Human-readable explanation
Every blocker maps to a plain sentence, e.g.:
- "Resolution is 1920×1080 (landscape). Required: 1080×1920."
- "Video codec is HEVC. YouTube live needs H.264."
- "Keyframes are 8.0 s apart. Required: ≤ 4 s (2 s recommended)."
Shown in the video card and returned in the API as `compatibility.explanations[]`.

---

## 6. Bitrate Calculator & Bandwidth Estimation

### 6.1 Module
`bitrate-calculator.js` — **pure functions, no I/O**, single source of truth for every bandwidth number in UI and API. No hardcoded bandwidth figures anywhere else.

### 6.2 Formulas
```
total_mbps         = video_mbps + audio_kbps / 1000
bytes_per_second   = total_mbps × 1,000,000 / 8
GB_per_hour        = total_mbps × 3600 / 8 / 1000
GB_per_day         = GB_per_hour × 24
GB_per_30_days     = GB_per_day × 30
TB_per_30_days     = GB_per_30_days / 1000
with_overhead(x)   = x × (1 + overheadPercent / 100)
```
Units: **1 GB = 10⁹ bytes, 1 TB = 10¹² bytes** by default (`bandwidth.unitBase = 1000`). Setting `unitBase = 1024` switches to GiB/TiB. Internal counters are always **bytes**.

The overhead factor (default 10%) models TCP/TLS/RTMP/FLV framing. Both numbers are always shown: **Estimated Payload** and **Estimated With Overhead**.

### 6.3 Reference values (audio 128 Kbps; verify via unit tests)

| Video | Total Mbps | GB/hour | GB/day | GB/30 d | TB/30 d | TB/30 d (+10 %) |
|---|---|---|---|---|---|---|
| 6 Mbps | 6.128 | 2.758 | 66.18 | 1,985 | 1.985 | 2.184 |
| **8 Mbps (default)** | **8.128** | **3.658** | **87.78** | **2,633** | **2.633** | **2.897** |
| 10 Mbps | 10.128 | 4.558 | 109.38 | 3,281 | 3.281 | 3.610 |

### 6.4 Design note — the 9 TB limit is a backstop
A single 24×7 stream at 8–10 Mbps uses roughly **2.6–3.6 TB/month**, far below the 10 TB allowance. The 9 TB safety limit therefore protects against: misconfiguration (bitrate set absurdly high), a runaway/duplicate process, other egress on the same VM (apt, uploads, dashboard traffic, future additional streams), and counter drift. This is intended and the UI should simply show the numbers honestly.

### 6.5 Dynamic behaviour
Changing bitrate (or toggling copy/transcode, or audio bitrate, or overhead) MUST immediately update every projection on the dashboard on the next poll — and the settings form SHOULD show a live preview **before** saving (computed client-side from the same formulas, mirrored in `public/js/calc.js` and verified by a shared test vector file).

---

## 7. Bandwidth Safety System

### 7.1 Module split (keep responsibilities separate)
| Module | Responsibility |
|---|---|
| `bitrate-calculator.js` | Pure math (above). |
| `usage-manager.js` | Byte counting, persistence of `data/bandwidth-usage.json`, accounting-period logic, rollover/reset. |
| `bandwidth-monitor.js` | Evaluates thresholds, fires alerts, computes forecasts, **triggers the safety lock** by calling `stream-manager`. |

### 7.2 How usage is measured (application estimate)
Primary method — **FFmpeg progress deltas:** `-progress pipe:1` emits `total_size` (bytes written to output so far). Per FFmpeg process, `usage-manager` keeps `lastTotalSize`; each update adds `(total_size − lastTotalSize)` to the period counter (guard: if `total_size < lastTotalSize` → new process/reset baseline, add nothing). Multiply by `(1 + overheadPercent/100)` when computing "estimated with overhead".

Fallback — **time × bitrate:** if progress data is missing for > 15 s while the process is alive, accrue `effective_bytes_per_second × elapsed` and flag `source: "bitrate-estimate"`.

Optional cross-check (P1) — **host NIC counter:** read `/sys/class/net/<iface>/statistics/tx_bytes` (interface configurable, auto-detected default route). Store as `hostTxBytesThisPeriod` with baseline handling across reboots (counter resets on boot). Displayed as "Host TX (includes everything, not just the stream)". It is a **cross-check only**, never the shutdown trigger by default.

Persist counters at most every **30 s** (and immediately on stream stop, lock, shutdown signal). Worst-case loss after a hard crash: ≤ 30 s of data.

### 7.3 Application estimate vs. OCI-reported usage (MUST be shown separately)
The dashboard shows two clearly labelled blocks:
1. **App estimate** (this system's counter) — drives the safety shutdown by default.
2. **OCI-reported outbound** — manual field in P0 (`manualOciReportedGB` + timestamp, entered by admin from the OCI console) ; automatic via OCI Monitoring in P2.

Rules:
- Never imply the two are equal. Label: "Estimate — may differ from OCI billing."
- **Authoritative source:** if OCI-reported usage is available and fresher than `oci.maxAgeHours`, safety evaluation uses `max(appEstimate, ociReported)`; the UI states which source drove the decision.
- **Reconcile:** `POST /api/bandwidth/adjust` sets `manualOffsetBytes` so the app estimate can be aligned to an OCI console reading. Audit-logged.
- OCI Monitoring (P2): query the VCN VNIC outbound-bytes metric for the instance's VNIC. Metric/namespace names MUST be verified against current OCI docs; use an Instance Principal or API-key config; all optional and off by default.

### 7.4 Settings
```json
"bandwidth": {
  "monthlyAllowanceTB": 10,
  "safetyLimitTB": 9,
  "unitBase": 1000,
  "overheadPercent": 10,
  "warningThresholds": [70, 80, 90, 95],
  "accounting": { "resetDay": 1, "resetHour": 0, "timezone": "UTC" },
  "persistIntervalSeconds": 30
}
```
Alternative accepted form: `safetyLimitGB` (e.g. `9216`). If both present, `safetyLimitGB` wins and the UI shows the resolved bytes. Percentages are **relative to the safety limit** (so 100 % = shutdown); the UI also shows % of the full monthly allowance.

### 7.5 Alert levels (default)
| % of safety limit | Level | UI behaviour |
|---|---|---|
| ≥ 70 | `warning` | yellow banner |
| ≥ 80 | `warning-strong` | orange banner, bold |
| ≥ 90 | `critical` | red banner |
| ≥ 95 | `critical-protection` | red banner: "Protection threshold — stream will stop at 100 %" |
| ≥ 100 | `limit` | **automatic stop** |

Each threshold fires **once per accounting period** (persisted in `alertsFired[]`), is logged (`bandwidth.warning`), and the banner persists while the level is active. Thresholds list is editable (validated: ascending, 1–99, max 8 entries).

### 7.6 When the safety limit is reached
1. `bandwidth-monitor` tells `stream-manager` to **stop FFmpeg cleanly** (SIGTERM → grace → SIGKILL).
2. State → **`BANDWIDTH_LIMIT_REACHED`**; `bandwidthLock = { active: true, since, periodId, usedBytes, limitBytes }` persisted in `stream-state.json`.
3. Auto-restart, scheduler start, boot auto-resume, and the manual START button are all **blocked** (`E_BW_LIMIT`).
4. Dashboard shows, prominently: **"Monthly bandwidth safety limit reached. Streaming has been automatically stopped."**
5. Log `bandwidth.limit_reached`; append to `stream-history.json`.
6. All usage data preserved.
7. Unlock paths: (a) automatic at next accounting-period rollover (§7.7); (b) admin `POST /api/bandwidth/unlock` with password re-entry **and** a raised `safetyLimitTB` above current usage (otherwise the lock would immediately re-trigger). Both logged.

### 7.7 Monthly accounting & reset
- **Period identity** is *computed from the wall clock*, never from "app started": `periodId = YYYY-MM` of `(now_in_accounting_tz − resetDay/resetHour offset)`. Default: calendar month, UTC, day 1 00:00. (OCI billing/usage reporting boundaries may differ from the local calendar — hence configurable. Verify against the OCI console.)
- Stored in `bandwidth-usage.json`: `periodId`, `periodStart`, `lastResetAt`, `estimatedBytes`, `overheadBytes`, `streamingSeconds`, `alertsFired`, `manualOffsetBytes`, `manualOciReportedGB`, `hostTx…`, `history[]` (last 12 closed periods: id, bytes, seconds).
- **Evaluated** on every usage tick (≥ every 30 s), on boot, and on scheduler tick.
- **Rollover** when computed `periodId` ≠ stored `periodId` **and** computed > stored (monotonic guard so a clock jump backwards cannot double-reset): archive closed period into `history[]`, zero counters, clear `alertsFired`, clear `bandwidthLock` **only if** it belongs to the old period, log `bandwidth.period_reset`, then let the scheduler/auto-resume start the stream if desired state allows.
- **Downtime catch-up:** if the server was off across a boundary, the first boot evaluation performs the rollover. Reset survives reboots because it's derived from persisted JSON + current time.
- **Clock sanity:** systemd unit orders after `time-sync.target`; additionally, if system time is earlier than the stored `lastSeenAt` by > 1 h at boot, enter `ERROR` state with message "System clock appears wrong" and do **not** start streaming or roll over until time is plausible (re-check every 30 s).

### 7.8 Forecasting
Computed in `bandwidth-monitor` and returned by `GET /api/bandwidth`:
- `currentMonthlyAverageGBPerDay` = used / elapsed days in period (min elapsed clamp 1 h)
- `projected30DayUsage` = `used + rateWithOverhead × remainingStreamingHoursInPeriod` (continuous mode: all remaining hours; scheduled mode: only scheduled hours)
- `remainingSafeGB = limit − used`
- `remainingSafeHours = remainingSafeGB / GBperHourWithOverhead`
- `remainingSafeDays = remainingSafeHours / 24`
- `projectedLimitReachedAt` (ISO time or `null` if period ends first)
Dashboard sentence: "At the current bitrate, estimated safe remaining streaming time: **XXX hours (≈ Y days)**."

---

## 8. Stream State Machine

### 8.1 Desired vs. actual state
Two separate concepts, both persisted in `data/stream-state.json`:
- **`desiredState`**: `"running"` | `"stopped"` — what the admin/scheduler wants.
- **`status`** (actual): one of the states below.
- **Overrides** (independent flags): `disabled` (admin master kill switch), `maintenance`, `bandwidthLock`.

### 8.2 States
| State | Meaning |
|---|---|
| `STOPPED` | No FFmpeg; admin stopped it (desiredState = stopped). |
| `STARTING` | Pre-flight checks passed; FFmpeg spawned; waiting for first progress/output. |
| `RUNNING` | FFmpeg alive, progress advancing, speed healthy. |
| `RECONNECTING` | FFmpeg exited/stalled; waiting out backoff or respawning. |
| `ERROR` | Failure threshold exceeded or unrecoverable config error (e.g. no key, ffmpeg missing, clock wrong). In slow-retry mode the app still retries on a long cooldown (§9.3). |
| `BANDWIDTH_LIMIT_REACHED` | Safety lock active. No auto-start of any kind. |
| `DISABLED` | Admin disabled streaming. Nothing starts, including after reboot. |
| `SCHEDULED` | Scheduled mode, currently outside a window; waiting for next start. |
| `MAINTENANCE` | Admin/update script set maintenance; streaming blocked until cleared. |

### 8.3 Start-permission precedence (evaluated before ANY spawn)
```
DISABLED → MAINTENANCE → BANDWIDTH_LIMIT_REACHED → config/pre-flight errors
        → scheduler window (if scheduled mode) → desiredState
```
First failing gate wins and its human-readable reason is returned/logged.

### 8.4 Key transitions
| From → To | Trigger |
|---|---|
| STOPPED → STARTING | START (manual), scheduler window opens, boot auto-resume |
| STARTING → RUNNING | first progress with `total_size` > 0 and `speed` ≥ min |
| STARTING → RECONNECTING | exit/timeout before RUNNING (startup timeout default 30 s) |
| RUNNING → RECONNECTING | unexpected exit, stall watchdog, output error |
| RECONNECTING → STARTING | backoff elapsed, permission gates still pass |
| RECONNECTING → ERROR | consecutive-failure threshold exceeded |
| ERROR → STARTING | slow-retry timer, or manual START |
| any running → STOPPED | STOP (sets desiredState = stopped) |
| any → BANDWIDTH_LIMIT_REACHED | safety limit hit |
| BANDWIDTH_LIMIT_REACHED → STOPPED/STARTING | period rollover or admin unlock; then normal rules |
| RUNNING → SCHEDULED | scheduled window closes (graceful stop) |

Every transition is logged (`stream.state_change`) with `from`, `to`, `reason`.

### 8.5 Reboot restore rules (from persisted JSON)
- Restore `desiredState`, `disabled`, `maintenance`, `bandwidthLock`, restart counters.
- Auto-resume **only if** `stream.autoResume = true` (default) **and** `desiredState = running` **and** none of: `disabled`, `maintenance`, `bandwidthLock.active`, scheduler-closed window, clock-sanity failure.
- Manual mode: after reboot the stream does **not** auto-start unless `desiredState = running` was set and `autoResume = true`.
- `maintenance` is cleared automatically at boot only if it was set by `update.sh` (flag `maintenance.source = "update"`); admin-set maintenance persists.

---

## 9. Automatic Recovery

### 9.1 Failure detection
FFmpeg is considered failed on any of:
1. Process exit (any code) while `desiredState = running`.
2. **Stall watchdog:** `total_size` has not increased for `stallSeconds` (default 30) while process is alive → kill and restart.
3. **Speed watchdog:** `speed` < `minSpeed` (default 0.90×) for `slowSeconds` (default 60) → treat as encoder/network overload; restart (and surface a warning, since repeated slow-speed means transcode is too heavy).
4. **Startup timeout:** no valid progress within `startupTimeoutSeconds` (default 30).
5. stderr patterns indicating connect/auth/IO errors are *classified* (not used as the primary trigger) to give friendly reasons: connection refused/reset/timeout, TLS failure, "Broken pipe", invalid key/forbidden, input file error.

### 9.2 Backoff
```json
"recovery": {
  "strategy": "exponential",
  "baseDelaySeconds": 10,
  "factor": 2,
  "maxDelaySeconds": 300,
  "jitterPercent": 10,
  "stableAfterSeconds": 120,
  "maxConsecutiveFailures": 20,
  "onThresholdExceeded": "slow_retry",
  "slowRetryCooldownSeconds": 600
}
```
- `strategy: "exponential"` → delays 10, 20, 40, 80, 160, 300, 300… s. `strategy: "linear"` → 10, 20, 30, … capped at `maxDelaySeconds` (the example sequence in the brief).
- `consecutiveFailures` resets to 0 only after FFmpeg stays `RUNNING` for `stableAfterSeconds` — so a process that connects then dies after 5 s is still a failure.
- **Cooldown:** minimum 5 s between any two spawns, always, even if a delay computes lower.
- **Threshold:** after `maxConsecutiveFailures`, state → `ERROR`. Because 24×7 unattended operation must survive long internet/YouTube outages, the default `onThresholdExceeded = "slow_retry"` keeps retrying every `slowRetryCooldownSeconds`; `"stop"` makes it wait for a manual START.
- Never a tight loop: a restart storm (> 30 spawns in 10 min regardless of settings) trips a hard circuit breaker → `ERROR` + critical log.

### 9.3 What recovery must NOT do
Must not spawn a second FFmpeg while one is alive/being killed; must not retry while any gate in §8.3 blocks; must not count bandwidth for a process that produced zero output.

### 9.4 Observability counters
`restartCountSession`, `restartCountTotal`, `consecutiveFailures`, `lastExit {code, signal, at}`, `lastError {code, message, at}` — all in `stream-state.json` and returned by `/api/status`.

---

## 10. FFmpeg Process Management (`ffmpeg-manager.js`)

| Requirement | Specification |
|---|---|
| Spawn | `spawn(ffmpegPath, args, { shell:false, stdio:['ignore','pipe','pipe'], detached:false })` |
| Single instance | In-memory mutex **plus** lock file `data/ffmpeg.lock` (`{pid, startedAt, cmdMarker}`, atomic create `wx`). On boot: if lock exists, check `/proc/<pid>/cmdline` contains our marker → orphan → SIGTERM → SIGKILL; then remove stale lock. Spawn only if no live managed child. |
| Stdout | `-progress pipe:1` key=value blocks parsed line-by-line via `readline` (`frame, fps, bitrate, total_size, out_time_us, speed, progress`). Only latest block kept in memory. |
| Stderr | `-loglevel warning`; line-buffered; passed through the **redaction filter** then classified; keep last 50 lines ring buffer for the "last error" view. |
| Exit | `child.on('exit')` handles code/signal; distinguishes **expected** (we sent stop) from **unexpected** via an `expectedExit` flag. |
| Graceful stop | `SIGTERM` → wait `stopGraceSeconds` (default 8) → `SIGKILL`. Await `exit` event before releasing lock/state. |
| Tree kill | FFmpeg spawns no children in this design; still, on SIGKILL path use `process.kill(-pgid)` only if spawned detached; systemd `KillMode=control-group` is the safety net on service stop. |
| Zombies | Always attach `exit`/`error` handlers; never leave an un-awaited child. |
| Priority | Streaming FFmpeg: normal priority. Prepare job & FFprobe: `os.setPriority(pid, 15)` + `ionice -c3` where available. |
| PID | Exposed in `/api/status`; written into lock file. |
| Secret handling | The full output URL contains the stream key and necessarily appears in argv. Mitigations: (a) dedicated service user; (b) mount `/proc` with `hidepid=2` (documented in README/installer, optional) so other users can't read argv; (c) argv is **never** logged — the logger logs a *redacted* command (`…/live2/****`); (d) every stderr line and error object runs through `redact()` which replaces the key, the full URL, and any `rtmps://…` token. |
| Spawn errors | `ENOENT` → `E_FFMPEG_MISSING`; `EACCES` → friendly permission error. |

---

## 11. Scheduler (`scheduler.js`)

Lightweight in-process timer (tick every 15 s). **No cron dependency.** It controls `stream-manager` directly.

### 11.1 Modes
| Mode | Behaviour |
|---|---|
| `continuous` (default) | Always desired-running (unless gates in §8.3 block). |
| `scheduled` | Runs only inside configured windows. Outside → `SCHEDULED` state, FFmpeg stopped gracefully. |
| `manual` | Scheduler idle; only START/STOP buttons control the stream. |

### 11.2 Scheduled-mode config
```json
"scheduler": {
  "mode": "continuous",
  "timezone": "Asia/Kolkata",
  "windows": [
    { "days": ["mon","tue","wed","thu","fri","sat","sun"], "start": "06:00", "stop": "23:30" }
  ]
}
```
- Timezone: IANA name validated via `Intl.DateTimeFormat`. Day/time evaluation uses `Intl.DateTimeFormat(...).formatToParts` in that zone (handles DST).
- Overnight windows (`start > stop`, e.g. 22:00→02:00) are supported; the "day" belongs to the **start** day.
- Multiple windows allowed; overlapping windows merge.
- Window open + gates pass → start; window close → graceful stop with reason `scheduler.window_closed`.
- Manual STOP in scheduled mode sets `desiredState = stopped` until the **next** window opens (then it is re-armed). Document this in the UI tooltip.
- Events logged: `scheduler.window_opened`, `scheduler.window_closed`, `scheduler.mode_changed`.

---

## 12. YouTube Configuration & Stream-Key Handling

Fields: `rtmpsUrl` (validated `rtmps://` only), `streamKey` (secret), `title` (optional label), `label` (optional identifier). Title/label are informational (not pushed to YouTube in P0).

Stream-key rules:
- **Masked in UI** (`••••••••abcd`, last 4 chars only).
- **Never** in normal logs, error messages, history, backups export views, or API responses.
- `GET /api/settings` returns `{ youtube: { rtmpsUrl, streamKeySet: true, streamKeyHint: "abcd" } }`.
- `PUT /api/settings` updates the key **only if** a non-empty `streamKey` is supplied (empty/absent = unchanged).
- **SHOW/HIDE:** the UI button calls `POST /api/settings/reveal-stream-key` with `{ password }` (re-authentication) → returns the key in that response only, `Cache-Control: no-store`, rate-limited (3/min), audit-logged as `settings.key_revealed` (no key). The key auto-hides in the UI after 30 s and on tab hide.
- Stored in `config/settings.json` (mode `0600`, dir `0700`). Backups inherit `0600`. Optional P1: AES-256-GCM encryption at rest with `SECRETS_KEY` from the env file.
- Validation: key trimmed, 8–128 chars, `[A-Za-z0-9_-]` plus `-` groups as used by YouTube; reject whitespace/control chars.
- All outbound streaming is TLS (RTMPS). The dashboard additionally performs a **destination reachability probe**: TLS connect (`tls.connect`) to the ingest host:443 every 60 s (timeout 5 s) → `reachable` / `unreachable` + latency. This proves network path only — it does **not** prove YouTube shows the stream as live (P2: YouTube Data API `liveStreams` health check).

---

## 13. Video Library (`video-manager.js`)

### 13.1 Storage & identity
- Files in `videos/`. Filenames on disk are **generated IDs** (`vid_<8 hex>.mp4`), never the user's raw filename (original name kept as display label in `data/videos.json`).
- `data/videos.json` = metadata cache `{ id, label, originalName, sizeBytes, uploadedAt, probe:{…}, compatibility:{…}, mtimeMs }`.
- Example logical names (`main-stream`, `backup-stream`) are supported as `slug` aliases; `stream.videoId` references the id/slug.

### 13.2 Features
Upload · list · delete · select active · view duration/resolution/codec/bitrate/FPS/audio codec/file size · re-validate · (P1) prepare-compatible job. One active source initially; schema already stores `videos[]` and `stream.videoId` so multiple videos/playlists can be added later without migration.

### 13.3 Upload rules
- Streamed to `videos/.incoming/<tmp>` via `busboy` (never buffered in RAM). Max size `uploads.maxBytes` (default 4 GiB).
- Allowed extensions: `.mp4 .mov .m4v .mkv` (config). **Extension is not trusted**: after upload, FFprobe must succeed and report ≥ 1 video stream, else delete and reject (`E_VIDEO_UNSUPPORTED`).
- Pre-check disk: reject early if `Content-Length` + `diskReserveBytes` (default 5 GiB or 10 %, whichever larger) > free space (`E_DISK_LOW`); abort mid-stream if free space falls below reserve.
- Atomic `rename` from `.incoming` into `videos/` only after successful probe.
- Path-traversal protection: IDs matched against `^vid_[a-f0-9]{8}$`; resolved path must stay inside `videos/` (`path.resolve` + prefix check); no user-supplied path ever reaches `spawn`.
- Delete: refuse (`409`) if the video is the active source of a running stream. Deleting the active video while stopped clears `stream.videoId`.
- Select while LIVE: `409` with message unless `?restart=true`, in which case a graceful restart onto the new file is performed.
- Orphan cleanup: `.incoming` leftovers older than 1 h removed at boot.

### 13.4 Prepare-compatible job (F16, P1)
`POST /api/videos/:id/prepare` → one background job at a time, low priority, writes new `vid_…` file with the full output profile (x264 CBR-style, 2 s GOP, AAC, bt709, yuv420p, 1080×1920), progress reported via FFmpeg `-progress`; refuses to start while streaming in transcode mode on small shapes (to avoid starving the live stream) unless `force`. Result is auto-probed and marked COMPATIBLE.

---

## 14. YouTube Compatibility Statement

### 14.1 Targets
RTMPS · H.264 · CBR · AAC · 1080p vertical · 30 fps · ~2 s keyframes · stable bitrate · progressive · Rec.709 SDR.

### 14.2 Bitrate guidance
See §4.7 (default 8 Mbps is above typical 30 fps guidance; advisory shown).

### 14.3 Shorts caveat (MUST appear in README and in a dashboard "About" note)
A 9:16 live stream is **not** guaranteed placement in the Shorts feed. *Vertical live compatibility* and *Shorts-feed distribution* are separate concerns controlled by YouTube. YouTube-side behavior, ingestion requirements and policies (including policies on repetitive/looped content and live-stream duration/archive limits) can change independently of this application; the administrator is responsible for compliance.

---

## 15. Dashboard (frontend)

### 15.1 Technology
HTML + CSS + vanilla JS (ES modules). No React/Vue/Angular, no CSS framework, **no CDN assets** (strict CSP `'self'`), no WebSockets. System fonts only.

### 15.2 Behavior
- Poll `GET /api/status` every **3 s** (config 2–5 s); `GET /api/bandwidth` and `/api/system` every **10 s**; videos on demand.
- **Pause polling when the tab is hidden** (`visibilitychange`); on resume, refresh immediately.
- Exponential backoff on API failures with a visible "Dashboard disconnected" banner.
- Mobile-first responsive grid (1 column phone → 2–3 columns desktop). Large touch targets for START/STOP.
- Destructive actions (STOP, RESTART, delete video) require a confirm dialog.

### 15.3 Cards
**Stream Status** — LIVE/OFFLINE badge + state, FFmpeg PID, uptime, restart count, last error, current source, resolution, FPS, video/audio bitrate, mode (COPY/HYBRID/TRANSCODE), FFmpeg speed, destination reachability.

**Bandwidth** — month usage (GB and TB), % of safety limit, % of allowance, remaining safety allowance, estimated GB/day, estimated TB/month (payload and with overhead), projected 30-day usage, remaining safe hours/days, alert banner, **App estimate vs OCI-reported** blocks, period start/next reset.

**Controls** — `START STREAM`, `STOP STREAM`, `RESTART STREAM`; disabled with reason tooltip when gates block (e.g. "Monthly bandwidth safety limit reached…"). Maintenance and Disable toggles.

**Video** — active video + duration, resolution, codec, compatibility badge and explanations; library list with upload progress bar.

**System** — CPU %, RAM, disk (used/free/videos/logs), OS uptime, FFmpeg version, Node version, instance-idle note (§2.3).

**Settings** — stream (mode, bitrate chips 6/8/10 + custom, FPS, audio kbps, keyframe s, preset), YouTube (URL, key with SHOW/HIDE), bandwidth, recovery, scheduler, with **live bandwidth preview**.

**Logs** — last N events with level filter.

### 15.4 "Is my stream healthy?" panel
A single computed verdict **HEALTHY / DEGRADED / UNHEALTHY** with the reasons listed, derived from: stream running · FFmpeg alive · progress advancing · speed ≥ 0.95 · no restarts in last 60 min · destination reachable · disk < warn · bandwidth < 70 % · CPU/RAM not saturated. Also shows: uptime, restart count, last error, source, bitrate, estimated bandwidth, monthly usage, safety threshold, projected monthly usage, disk, CPU, RAM.

---

## 16. REST API

All endpoints under `/api`, JSON, `Content-Type: application/json` (except upload). All except `/api/auth/login` and `/api/health` require an authenticated session. State-changing requests require header `X-CSRF-Token` (value from `/api/auth/me`) in addition to `SameSite=Strict` cookie.

### 16.1 Auth
| Method & Path | Purpose |
|---|---|
| `POST /api/auth/login` | `{username,password}` → sets session cookie. Rate-limited. |
| `POST /api/auth/logout` | Invalidate session. |
| `GET /api/auth/me` | `{username, csrfToken}` |

### 16.2 Core
| Method & Path | Purpose |
|---|---|
| `GET /api/health` | Unauthenticated, minimal: `{ok:true}` (bound to be safe for uptime monitors). |
| `GET /api/status` | Full stream status (§15.3 Stream Status) + health verdict. |
| `GET /api/system` | CPU, RAM, disk breakdown, OS uptime, versions. |
| `GET /api/bandwidth` | Usage, thresholds, alerts, forecasts, calculator output for current + 6/8/10 Mbps comparison. |
| `GET /api/settings` | Settings with secrets masked. |
| `PUT /api/settings` | Partial update, validated; returns masked settings + `requiresRestart: bool`. |
| `POST /api/settings/reveal-stream-key` | `{password}` → `{streamKey}` (one-shot). |
| `GET /api/videos` | Library with probe + compatibility. |
| `POST /api/videos/upload` | `multipart/form-data` (`file`). Returns video record. |
| `DELETE /api/videos/:id` | Delete (409 if active & live). |
| `POST /api/videos/:id/select` | Set active (`?restart=true` optional). |
| `POST /api/videos/:id/revalidate` | Re-run FFprobe. |
| `POST /api/videos/:id/prepare` | (P1) pre-encode job. |
| `POST /api/stream/start` | Start (gates enforced). |
| `POST /api/stream/stop` | Graceful stop; desiredState = stopped. |
| `POST /api/stream/restart` | Stop + start. |
| `POST /api/stream/disable` / `enable` | Master kill switch. |
| `POST /api/maintenance` | `{enabled}`. |
| `POST /api/bandwidth/adjust` | `{offsetGB}` or `{ociReportedGB}` reconcile. |
| `POST /api/bandwidth/unlock` | `{password, newSafetyLimitTB?}`. |
| `GET /api/logs` | `?limit=200&level=&event=` tail of current log (max 500). |

### 16.3 Response conventions
Success: `{ ok:true, data:{…} }`. Error: `{ ok:false, error:{ code, message } }` — `message` is human-readable; **no stack traces** in production (`NODE_ENV=production`); full detail goes to the log only (redacted).

| HTTP | Used for |
|---|---|
| 400 | validation errors |
| 401 / 403 | not authenticated / CSRF or re-auth failure |
| 409 | state conflicts (already running, delete active video) |
| 413 | upload too large |
| 423 | blocked by lock (bandwidth/disabled/maintenance) |
| 429 | rate limited |
| 507 | disk too low |

### 16.4 Error catalog (human-readable)
| Code | Message |
|---|---|
| `E_NO_VIDEO` | No video selected. |
| `E_VIDEO_UNSUPPORTED` | Video codec is unsupported. |
| `E_NEEDS_TRANSCODE` | Source video requires transcoding. |
| `E_FFMPEG_MISSING` | FFmpeg is not installed. |
| `E_NO_STREAM_KEY` | YouTube stream key is not configured. |
| `E_YT_CONNECT` | YouTube connection failed. |
| `E_BW_LIMIT` | Monthly bandwidth safety limit reached. |
| `E_DISK_LOW` | Insufficient disk space. |
| `E_ALREADY_RUNNING` | Another stream process is already running. |
| `E_DISABLED` / `E_MAINTENANCE` | Streaming is disabled / in maintenance mode. |
| `E_CLOCK` | System clock appears wrong; streaming paused. |

---

## 17. Backend Architecture

### 17.1 Module map
| File | Responsibility |
|---|---|
| `server.js` | Bootstrap only: load config/state, init modules, mount API, graceful shutdown (SIGTERM/SIGINT). < 150 lines. |
| `stream-manager.js` | State machine, gates, desired-state logic, recovery/backoff orchestration. The **only** module allowed to start/stop FFmpeg. |
| `ffmpeg-manager.js` | Spawn/kill/lock, progress+stderr parsing, watchdogs, argument builder call. |
| `ffprobe-manager.js` | Probing, keyframe scan, compatibility evaluation. |
| `scheduler.js` | Mode/window evaluation and ticking. |
| `bandwidth-monitor.js` | Thresholds, alerts, forecasts, safety-lock trigger. |
| `bitrate-calculator.js` | Pure bandwidth math. |
| `usage-manager.js` | Byte accounting, period rollover, persistence of usage JSON. |
| `config-manager.js` | Load/validate/merge/save `settings.json`, defaults, masking, schema versioning. |
| `state-manager.js` | Load/save `stream-state.json` and `stream-history.json` (capped). |
| `video-manager.js` | Library, upload handling, metadata cache, prepare job. |
| `system-monitor.js` | CPU (`/proc/stat` deltas), RAM (`/proc/meminfo`), disk (`fs.statfs`), dir sizes (cached 60 s), ffmpeg CPU/RSS via `/proc/<pid>`, TLS reachability probe. |
| `logger.js` | JSON-lines logger, redaction, size-based rotation. |
| `auth.js` | scrypt verification, sessions, CSRF, login rate limiting. |
| `api/*.js` | Thin route files per area; no business logic. |
| `lib/atomic-json.js` | Atomic read/write + per-file write queue + backup hook. |
| `lib/redact.js` | Central secret redaction. |
| `lib/validate.js` | Hand-written schema validation for settings/inputs. |
| `lib/paths.js` | All paths, resolved once from `APP_ROOT`. |

### 17.2 Rules
- Modules communicate via explicit function calls and a small `EventEmitter` bus (`stream:state`, `usage:tick`, `bandwidth:level`). No global mutable singletons beyond module-scoped state.
- Dependency direction: `api → stream-manager → ffmpeg-manager`; `bandwidth-monitor → stream-manager` (stop only); nothing imports `api`.
- No unbounded in-memory structures (all rings/arrays capped).

---

## 18. Persistence (JSON, no database)

### 18.1 Files
```
config/settings.json            (0600)  main settings incl. secrets
config/settings.example.json            no secrets, committed
data/stream-state.json                  desired state, status, locks, counters
data/bandwidth-usage.json               period accounting
data/stream-history.json                capped list of sessions (last 500)
data/videos.json                        video metadata cache
data/ffmpeg.lock                        runtime lock (not backed up)
backups/                                timestamped copies
```
All created automatically with defaults if missing. Every file carries `"schemaVersion": N` with a migration function table in `config-manager`/`state-manager`.

### 18.2 Atomic write protocol
1. Serialize through a **per-file promise queue** (no concurrent writers).
2. Write to `<file>.tmp-<pid>` in the **same directory** (mode preserved).
3. `fsync` the temp file, `rename` over target, `fsync` the directory.
4. On load: parse; on failure → try newest valid backup → else defaults + `ERROR`-level log + dashboard banner "Settings file was corrupt and has been restored".

### 18.3 Backups
- `settings.json`: timestamped backup **before every change** (`settings.2026-10-02T10-15-00Z.json`).
- `stream-state.json`, `bandwidth-usage.json`: written very often, so backups are **throttled** — at most once per `backups.minIntervalSeconds` (default 3600) plus forced on lock/unlock, period rollover and shutdown.
- Retention: `backups.keep` (default 20 per file); oldest pruned. Backup files `0600`.

---

## 19. Authentication & Security

### 19.1 Authentication
- Env-based admin: `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` in `/etc/yt-live-manager/env` (`0640 root:ytlive`).
- Hash format: `scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>` (Node `crypto.scrypt`; defaults N=16384, r=8, p=1, 64-byte key; **no `$` characters** so the env file is shell/systemd-safe). Helper: `npm run hash-password` prompts and prints the hash. Compare with `crypto.timingSafeEqual`.
- Session: random 256-bit ID in an HMAC-signed cookie `__Host-ytlm_sid` (`HttpOnly; Secure; SameSite=Strict; Path=/`), server-side in-memory store, idle timeout 12 h, absolute 7 d, logout invalidates. Restart of the app logs everyone out (acceptable).
- Login rate limiting (in-memory, per IP **and** per username): 5 failures / 15 min → lock 15 min with growing penalty; constant-time failure responses; every attempt logged (never the password).
- No default credentials. App refuses to start (clear console message) if `ADMIN_PASSWORD_HASH` or `SESSION_SECRET` is missing.

### 19.2 Hardening checklist
| Area | Requirement |
|---|---|
| Process | Non-root dedicated user `ytlive`; no sudo; systemd hardening (§21). |
| Network | App binds `127.0.0.1:3000` by default; public access only via Nginx 443. |
| HTTPS | Nginx + Let's Encrypt when a domain exists; otherwise access via SSH tunnel (`ssh -L 8443:127.0.0.1:3000`) or a private overlay network — plain HTTP over the public internet is NOT supported. `trust proxy` set only when behind Nginx. |
| Headers | `helmet` + CSP `default-src 'self'`; `X-Frame-Options: DENY`; `Referrer-Policy: no-referrer`; HSTS at Nginx. `Cache-Control: no-store` on API. |
| Input | Every body field validated (type, range, length); unknown fields rejected; JSON body limit 64 KB (except upload). |
| Uploads | §13.3 (size cap, probe-validated, generated filenames, traversal-safe). |
| Processes | `spawn` with arg arrays only; **no shell, no string concatenation** of user input; video path comes from ID lookup only. |
| CSRF | SameSite=Strict + `X-CSRF-Token` on non-GET. |
| Secrets | Redaction everywhere (§20); `0600` files; optional encryption at rest. |
| Firewall | OCI Security List / NSG: ingress 22 (restricted source CIDR), 80/443 only. Ubuntu on OCI ships with restrictive `iptables` rules — installer/README must show how to persist allowed ports (`iptables-persistent`/`netfilter-persistent`) rather than disabling the firewall. Egress: allow TCP 443 (RTMPS + apt). |
| `/proc` | Optional `hidepid=2` to hide argv from other users. |
| Updates | `unattended-upgrades` recommended for security patches (not forced to reboot during streaming without admin choice). |

---

## 20. Logging (`logger.js`)

- JSON Lines, one object per line: `{ ts, level, event, msg, ...fields }`. Written to `logs/app.log` and to stdout (journald).
- Levels: `debug|info|warn|error`; default `info`.
- **Own size-based rotation:** `logs.maxFileMB` (default 10) × `logs.maxFiles` (default 5), gzip optional; total log footprint hard-capped. Also configure journald `SystemMaxUse` guidance in README.
- FFmpeg stderr: forwarded at `warn` after redaction and de-duplication (collapse identical repeating lines with a counter) to avoid log floods.
- Event catalog (minimum): `stream.started`, `stream.stopped`, `stream.state_change`, `ffmpeg.crash`, `ffmpeg.restart`, `ffmpeg.stall`, `connection.failure`, `source.changed`, `video.uploaded`, `video.validated`, `video.deleted`, `bandwidth.warning`, `bandwidth.limit_reached`, `bandwidth.period_reset`, `bandwidth.adjusted`, `scheduler.*`, `config.changed` (keys changed only, **not values for secrets**), `auth.login_success|failure|lockout`, `settings.key_revealed`, `system.disk_warning`, `app.boot`, `app.shutdown`.
- **Never logged:** stream key, full RTMPS URL with key, admin password, password hash, `SESSION_SECRET`, cookies, CSRF tokens. `redact()` is applied inside the logger itself as a last line of defence, and unit-tested with the real key string.

---

## 21. systemd, Installation, Updates

### 21.1 Service unit (`systemd/yt-live-manager.service`)
```ini
[Unit]
Description=24x7 YouTube Vertical Live Streaming Manager
After=network-online.target time-sync.target
Wants=network-online.target time-sync.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=ytlive
Group=ytlive
WorkingDirectory=/opt/yt-live-manager
EnvironmentFile=/etc/yt-live-manager/env
Environment=NODE_ENV=production
Environment=APP_ROOT=/opt/yt-live-manager
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
KillSignal=SIGTERM
LimitNOFILE=4096
UMask=0077

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/opt/yt-live-manager/config /opt/yt-live-manager/data /opt/yt-live-manager/videos /opt/yt-live-manager/logs /opt/yt-live-manager/backups

[Install]
WantedBy=multi-user.target
```
The app MUST handle `SIGTERM`: stop FFmpeg gracefully, flush usage/state JSON, then exit within 30 s.

### 21.2 `install.sh` (idempotent; re-running must not destroy data)
Flags: `--domain example.com`, `--with-nginx` / `--no-nginx`, `--port 3000`, `--node-major 22`.
Steps: (1) `apt update/upgrade`; (2) install Node.js LTS (NodeSource) and `ffmpeg`, `nginx` (optional), `certbot` (if domain); (3) verify `uname -m` = `aarch64` (warn otherwise), verify `ffmpeg -encoders` contains `libx264` and `aac`; (4) create user `ytlive` (no login shell); (5) create `/opt/yt-live-manager` with `config data videos logs backups`, correct owners/modes; (6) `npm ci --omit=dev`; (7) create initial JSON from `settings.example.json` **only if absent**; (8) prompt for admin username/password → write hash + generated `SESSION_SECRET` into `/etc/yt-live-manager/env` (`0640 root:ytlive`), never echoing the password; (9) install/enable systemd unit; (10) optional Nginx site + certbot; (11) print firewall reminders (OCI Security List + iptables persistence); (12) print access URL and commands:
```
sudo systemctl status yt-live-manager
sudo systemctl restart yt-live-manager
sudo journalctl -u yt-live-manager -f
```

### 21.3 `update.sh`
Stop safely (set `maintenance` with `source:"update"`, graceful stream stop, `systemctl stop`) → backup `config/ data/` to `backups/update-<timestamp>.tar.gz` (`0600`) → pull/unpack new code **excluding** `config/`, `data/`, `videos/`, `logs/`, `backups/`, env file → `npm ci --omit=dev` → run migration check (`node scripts/migrate.js --dry-run`) → `systemctl start` → verify `systemctl is-active` and `GET /api/health` within 30 s → clear update-maintenance → if verification fails, **roll back** to the previous code directory and report. Never overwrite secrets or user configuration.

### 21.4 Nginx (`nginx/yt-live-manager.conf`, reference)
```nginx
server {
  listen 443 ssl http2;
  server_name example.com;
  # ssl_certificate / ssl_certificate_key via certbot
  add_header Strict-Transport-Security "max-age=31536000" always;

  client_max_body_size 4g;

  location /api/videos/upload {
    proxy_pass http://127.0.0.1:3000;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
server { listen 80; server_name example.com; return 301 https://$host$request_uri; }
```

---

## 22. Performance & Stability Requirements

- Node RSS target < 150 MB steady state; no memory growth over 72 h (soak check: RSS slope ≈ 0).
- Polling: ≤ 1 request/3 s per open dashboard; tab-hidden pause; `/proc` reads cached 2 s; dir-size scans cached 60 s.
- No background workers other than: scheduler tick (15 s), usage persist (30 s), system sampler (5 s), reachability probe (60 s).
- No FFmpeg re-initialisation at loop boundaries; no restart on settings changes that don't affect the pipeline (`PUT /api/settings` returns `requiresRestart` and the UI offers "Apply & restart").
- **Benchmark gate before release:** on the actual OCI shape, run the transcode profile for ≥ 1 h and record average CPU, `speed`, and dropped-frame indicators. If `speed` < 0.95 sustained, the default `preset` must be lowered or the UI must warn that transcode is unsuitable for that shape.

---

## 23. Storage Management

- Show: total/used/free disk, `videos/` size, `logs/` size, `backups/` size, available space (via `fs.statfs`, directory sizes cached).
- Thresholds (configurable): **80 % warning**, **90 % critical**, **95 % emergency**.
- At ≥ 95 % (or free < `diskReserveBytes`): block uploads and prepare jobs (`E_DISK_LOW`); keep streaming (copy mode reads from disk only). Logs and backups self-limit via rotation/retention.
- Disk alerts fire once per level per boot/crossing and are logged (`system.disk_warning`).

---

## 24. Settings File (reference schema, `config/settings.json`)

```json
{
  "schemaVersion": 1,
  "stream": {
    "videoId": "",
    "modePreference": "auto",
    "allowTranscode": true,
    "autoResume": true,
    "resolution": "1080x1920",
    "fps": 30,
    "videoBitrateMbps": 8,
    "audioBitrateKbps": 128,
    "audioSampleRate": 44100,
    "keyframeSeconds": 2,
    "keyframeMaxSeconds": 4,
    "x264Preset": "veryfast",
    "loopStrategy": "stream_loop",
    "copyMinMbps": 2,
    "copyMaxMbps": 12,
    "stallSeconds": 30,
    "slowSeconds": 60,
    "minSpeed": 0.9,
    "startupTimeoutSeconds": 30,
    "stopGraceSeconds": 8
  },
  "youtube": {
    "rtmpsUrl": "rtmps://a.rtmps.youtube.com:443/live2",
    "streamKey": "",
    "title": "",
    "label": ""
  },
  "youtubeGuidance": { "recommendedMbps": [3, 9] },
  "bandwidth": {
    "monthlyAllowanceTB": 10,
    "safetyLimitTB": 9,
    "unitBase": 1000,
    "overheadPercent": 10,
    "warningThresholds": [70, 80, 90, 95],
    "accounting": { "resetDay": 1, "resetHour": 0, "timezone": "UTC" },
    "persistIntervalSeconds": 30,
    "oci": { "enabled": false, "maxAgeHours": 24 }
  },
  "recovery": {
    "strategy": "exponential",
    "baseDelaySeconds": 10,
    "factor": 2,
    "maxDelaySeconds": 300,
    "jitterPercent": 10,
    "stableAfterSeconds": 120,
    "maxConsecutiveFailures": 20,
    "onThresholdExceeded": "slow_retry",
    "slowRetryCooldownSeconds": 600
  },
  "scheduler": {
    "mode": "continuous",
    "timezone": "Asia/Kolkata",
    "windows": []
  },
  "uploads": { "maxBytes": 4294967296, "allowedExtensions": [".mp4", ".mov", ".m4v", ".mkv"], "diskReserveBytes": 5368709120 },
  "disk": { "warnPercent": 80, "criticalPercent": 90, "emergencyPercent": 95 },
  "logs": { "level": "info", "maxFileMB": 10, "maxFiles": 5 },
  "backups": { "keep": 20, "minIntervalSeconds": 3600 },
  "ui": { "pollSeconds": 3 }
}
```
Validation: unknown keys rejected; `safetyLimit ≤ monthlyAllowance`; `videoBitrateMbps` 1–50 (custom allowed); `fps` ∈ {24, 25, 30, 60}; `warningThresholds` ascending 1–99; `rtmpsUrl` must start `rtmps://`; changes to `resolution/fps/bitrate/audio/keyframe/preset/videoId/rtmpsUrl/streamKey` set `requiresRestart = true`.

---

## 25. Project Structure

```
yt-live-manager/
├── src/
│   ├── server.js
│   ├── stream-manager.js
│   ├── ffmpeg-manager.js
│   ├── ffprobe-manager.js
│   ├── scheduler.js
│   ├── bandwidth-monitor.js
│   ├── bitrate-calculator.js
│   ├── usage-manager.js
│   ├── config-manager.js
│   ├── state-manager.js
│   ├── video-manager.js
│   ├── system-monitor.js
│   ├── logger.js
│   ├── auth.js
│   ├── lib/
│   │   ├── atomic-json.js
│   │   ├── redact.js
│   │   ├── validate.js
│   │   └── paths.js
│   └── api/
│       ├── auth.routes.js
│       ├── status.routes.js
│       ├── settings.routes.js
│       ├── videos.routes.js
│       ├── stream.routes.js
│       ├── bandwidth.routes.js
│       └── logs.routes.js
├── public/
│   ├── index.html
│   ├── login.html
│   ├── style.css
│   ├── app.js                 # entry, polling loop
│   └── js/                    # api.js, calc.js, cards/*.js, upload.js
├── config/        settings.json (generated) · settings.example.json
├── data/          stream-state.json · bandwidth-usage.json · stream-history.json · videos.json
├── videos/        (+ .incoming/)
├── logs/
├── backups/
├── scripts/       hash-password.js · migrate.js
├── test/          unit/ · integration/ · vectors/bandwidth.json
├── systemd/       yt-live-manager.service
├── nginx/         yt-live-manager.conf
├── install.sh
├── update.sh
├── package.json
├── README.md
├── DECISIONS.md
└── PRD.md
```
`.gitignore` MUST exclude `config/settings.json`, `data/`, `videos/`, `logs/`, `backups/`, `.env*`.

---

## 26. Testing & Acceptance

### 26.1 Unit tests (Node built-in `node:test`)
`bitrate-calculator` (vector file shared with frontend `calc.js`, incl. §6.3 table) · `buildFfmpegArgs` (copy/hybrid/transcode snapshots) · compatibility evaluator (table-driven probe fixtures) · backoff sequence/jitter/reset · usage period rollover with injected clock (boundary, downtime catch-up, backwards clock) · progress-delta accounting incl. process restart baseline · threshold firing once per period · atomic JSON write + corrupt-file recovery · `redact()` with real key patterns · path-traversal rejection · scheduler windows incl. overnight + DST · auth rate limit.

### 26.2 Integration tests
Local RTMP sink (`ffmpeg -listen 1 -i rtmp://127.0.0.1:1935/live/test -f null -`, with `ALLOW_PLAIN_RTMP_FOR_TESTS=1`): start/stop; kill sink → reconnect with backoff; `kill -9` FFmpeg → recovery; double-START race → one process; tiny safety limit → lock, no restart, survives app restart; upload invalid file/oversized/traversal attempt.

### 26.3 On-server acceptance checklist
| # | Test | Pass condition |
|---|---|---|
| A1 | Fresh install on clean OCI Ubuntu ARM64 | Dashboard reachable over HTTPS, login works |
| A2 | Upload compatible 1080×1920 file | `COMPATIBLE`, stream starts in **copy** mode, YouTube shows live |
| A3 | Upload landscape/HEVC file | `REQUIRES TRANSCODING` with plain-language reasons |
| A4 | Transcode benchmark (≥ 1 h) | speed ≥ 0.95, no restarts; CPU recorded |
| A5 | Soak 72 h copy mode | Zero unintended stops; memory flat; loops clean |
| A6 | `kill -9` FFmpeg ×5 | Backoff visible; stable-run reset works; never 2 PIDs |
| A7 | Block egress 443 for 5 min, restore | Reconnects automatically, counters sane |
| A8 | `sudo reboot` | Resumes without SSH; usage intact; lock respected |
| A9 | Safety limit → 0.01 GB | `BANDWIDTH_LIMIT_REACHED`, banner text exact, no auto-restart after reboot |
| A10 | Period rollover (set clock/test hook) | Counters reset, lock cleared, stream resumes |
| A11 | Grep logs + API + `ps` (as another user) for stream key | **Zero** matches |
| A12 | Fill disk to 95 % | Uploads blocked, stream continues |
| A13 | Change 8 → 10 Mbps in UI | Preview and projections update immediately |
| A14 | `update.sh` | Settings/secrets untouched; rollback works on forced failure |

---

## 27. Phasing

**P0 (MVP):** install/systemd, auth, settings + atomic JSON, video upload/probe/compatibility, copy + transcode streaming, loop, recovery/backoff, state machine + reboot resume, usage accounting + safety lock + monthly reset + alerts + forecast, dashboard (all cards), logging/rotation, disk monitor, backups, tests A1–A14.
**P1:** scheduled mode UI, prepare-compatible job, concat loop fallback, host NIC cross-check, secrets encryption at rest, `/proc hidepid` installer option.
**P2:** OCI Monitoring integration (authoritative egress), outbound webhook alerts, YouTube Data API health check, backup ingest URL, multiple videos/playlist.

---

## 28. Open Questions / Assumptions to Confirm Before Build

1. **Accounting boundary:** is OCI's monthly egress measured on the UTC calendar month? (Default assumes UTC, day 1.) Confirm in the OCI console.
2. **TB definition:** default decimal (1 TB = 10¹² bytes) — conservative relative to a 1024-based reading. Change `unitBase` if a different reading is wanted.
3. **Instance shape:** final OCPU/RAM decides whether transcode mode is allowed in production.
4. **Domain/HTTPS:** domain available for Let's Encrypt, or SSH-tunnel/private-network access?
5. **Idle-reclamation mitigation** (§2.3) — chosen approach.
6. **YouTube bitrate guidance** (§4.7) — confirm 8 Mbps default against current YouTube docs.
7. **YouTube policy exposure** for looped/repetitive 24×7 content (§14.3) — administrator's responsibility.

---

*End of PRD.*
