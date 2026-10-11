# YT Live Manager

YT Live Manager is a Node.js dashboard and service for managing a continuous YouTube Live stream from local video files. It validates and queues videos, publishes media to YouTube over RTMPS with FFmpeg, monitors and recovers the stream, and can automate YouTube Studio startup through Chrome.

The app uses JSON files for settings, stream state, usage, and the video index. It has no database or Docker requirement.

## Project at a glance

| Concern | Current implementation |
|---|---|
| Runtime | ES modules; Node.js engine declared as >=18.15.0 |
| Web server | Express; dashboard assets are served from public/ |
| Media | FFmpeg and FFprobe; yt-dlp is optional for URL imports |
| Studio automation | puppeteer-core with an installed Chrome/Chromium and a signed-in browser profile |
| Stream destination | YouTube RTMPS ingest; no YouTube Data API or OAuth integration |
| Persistence | Atomic JSON files under config/, data/, videos/, logs/, and backups/ |
| Current publish model | One active stream output at a time; select horizontal or vertical mode |
| UI/API default bind | 127.0.0.1:3000; use an SSH tunnel for remote access |

## What the application does

- **Stream control and health:** Start, stop, restart, enable/disable, maintenance mode, live state, FFmpeg progress, output health, system metrics, and recent logs.
- **Horizontal and vertical libraries:** Keep separate landscape and portrait playlists; 16:9 and 9:16 are common target shapes, while the code gates orientation by width versus height. A stream-mode change is rejected while a stream is starting, running, or reconnecting.
- **Video intake:** Upload MP4, MOV, M4V, or MKV files (default limit 4 GiB, with a 5 GiB free-space reserve) or import a YouTube URL with yt-dlp. The server probes media metadata, checks orientation and copy/transcode compatibility, registers the file, and appends it to the corresponding playlist. The default URL-import pipeline keeps the downloaded video stream; optional GOP normalization is an explicit encode.
- **Playlist behavior:** Before a stream start, the selected mode's eligible videos are reordered so the newest is first and the remaining videos are shuffled. Playlist edits and newly imported videos are picked up at a segment boundary without restarting the persistent RTMPS publisher.
- **Copy/transcode selection:** Automatic mode uses video stream copy when the playlist is compatible; otherwise it can transcode when allowTranscode permits it. A copy preference blocks video that requires re-encoding, but can still select a hybrid path to convert incompatible audio.
- **Studio startup gate:** On Linux, the default startup flow uses Chrome to open YouTube Studio, reach the current live control panel through the Studio UI, set a date/time title from the configured base title, save and read the title back, and verify the encoder preview/live state. FFmpeg is launched only after the saved title has been verified. A Studio gate failure is treated as a failed start; it does not silently fall back to a direct start.
- **Recovery and reboot behavior:** Persist desired state, optionally resume after service boot, detect FFmpeg exit/stall/slow output, and retry with configured backoff and a circuit breaker.
- **Scheduling and auto-recycle:** Run continuously, only inside configured schedule windows, or under manual control. Optional auto-recycle stops a long session, saves a resume bookmark when enabled, pauses, then starts a fresh session.
- **Bandwidth and disk safeguards:** Estimate egress from FFmpeg progress, show forecasts and warning thresholds, and lock streaming at the configured safety limit. Uploads also preserve a configured free-space reserve.
- **Authentication and redacted logs:** Single-admin login, rate limiting, signed session cookies, CSRF checks for state-changing APIs, and stream-key redaction in log output.

## Important media behavior

| Mode | Effect |
|---|---|
| **copy** | Copies compatible video without video re-encoding. If audio is incompatible or absent, the feeder can encode AAC audio or add silent AAC. Source video resolution, detail, and bitrate remain the source's; the configured bitrate cannot add detail to a low-quality file. |
| **hybrid** | Copies compatible video and normalizes audio to AAC when needed, or adds silent AAC when the source has no audio. |
| **transcode** | Encodes video with libx264; this uses CPU and may be unsuitable for small VPS shapes. |
| **auto** | Chooses a compatible copy/hybrid path when possible; otherwise transcodes only if allowTranscode is enabled. |

stream.videoBitrateMbps is a transcode target/cap and a planning input. It does not raise the bitrate of a stream-copied source. A low-bitrate but otherwise compatible H.264 source is not forced to transcode merely because its bitrate is low. For zero video re-encoding, keep every selected video copy-compatible. If audio must also remain unencoded, provide compatible AAC audio and verify the selected feeder mode.

The compatibility decision is based on probed codec, pixel format, dimensions/orientation, frame rate, audio, and keyframe interval. Use the dashboard's compatibility details or src/ffprobe-manager.js when investigating why a file is not copy-ready.

## Startup and playback flow

The stream manager checks the configured mode, stream key, playlist files/orientation, schedule and safety gates before launching media. The sequence below describes the default strict Studio-enabled path.

~~~mermaid
flowchart TD
    A[Dashboard, scheduler, or boot requests start] --> B[Validate state, key, playlist, files, orientation, schedule, and bandwidth]
    B --> C[Select newest eligible video first; shuffle remaining items]
    C --> D[Open YouTube Studio with the configured Chrome profile]
    D --> E[Set title, save, reload, and verify persisted title]
    E --> F[Launch FFmpeg publisher and media feeder]
    F --> G{RTMPS output healthy?}
    G -- No --> H[Fail start and stop publisher]
    G -- Yes --> I[Wait for Studio preview and verify LIVE state]
    I --> J{All Studio gates passed?}
    J -- No --> H
    J -- Yes --> K[Monitor progress, output stalls, usage, and playlist boundaries]
    K --> L[Feed next item without replacing the publisher]
~~~

When studioAutomation.enabled is explicitly false, startup takes the direct FFmpeg path and skips the browser/title/Studio verification gates. Studio automation is Linux-only and requires a working display, Chrome binary, persistent YouTube-signed-in profile, and a reachable Studio account.

## Architecture and source map

| Path | Responsibility |
|---|---|
| src/server.js | App bootstrap, security headers, route mounting, static dashboard, service startup, scheduler, boot recovery, and graceful shutdown |
| src/api/*.routes.js | HTTP handlers for auth, stream, settings, bandwidth, videos, scheduler, and system status |
| src/stream-manager.js | Startup gates, desired/actual state, playlist feeder lifecycle, FFmpeg recovery, resume bookmarks, mode switching, and auto-recycle |
| src/ffmpeg-manager.js | FFmpeg argument builders and child-process management, progress parsing, output health, locks, and feeder/publisher pipes |
| src/ffprobe-manager.js | FFprobe inspection and media compatibility decisions |
| src/video-manager.js | Video index and disk synchronization, uploads/imports, orientation playlists, random selection, and hot segment transitions |
| src/ytdlp-manager.js | URL validation, cookie handling, download job/progress/cancel, media registration, and playlist append |
| src/youtube-studio-automator.js | Starts and coordinates the strict Studio worker protocol |
| scripts/studio-worker.mjs | Puppeteer/Chrome Studio workflow: dynamic navigation, title edit/read-back, preview, and live checks |
| src/scheduler.js | In-process 15-second scheduler for manual, continuous, scheduled, and recycle behavior |
| src/config-manager.js | Defaults, schema migration, validation, settings persistence, stream-key masking, and derived config helpers |
| src/state-manager.js | Persisted stream state and bounded stream history |
| src/bandwidth-monitor.js, src/usage-manager.js, src/bitrate-calculator.js | Usage accounting, alerts, estimates, forecasts, and bitrate math |
| src/system-monitor.js | CPU, memory, disk, FFmpeg process, and RTMPS reachability snapshots |
| src/auth.js, src/lib/redact.js, src/logger.js | Sessions, password hashing, CSRF, secret redaction, structured logs, and rotation |
| src/lib/atomic-json.js, src/lib/paths.js, src/lib/validate.js | Atomic JSON persistence, shared path resolution, and input/config validation |
| public/index.html, public/login.html, public/css/, public/js/ | Single-page dark dashboard, login, API client, scheduler/settings forms, video library, and live status UI |
| config/settings.example.json | Installer's initial settings template; it is not the complete runtime schema |
| systemd/yt-live-manager.service, nginx/yt-live-manager.conf | Linux service unit and optional reference reverse-proxy configuration |
| install.sh, update.sh | Ubuntu installer and VPS update/rollback scripts |
| test/unit/, test/integration/ | Node built-in test suites; see Testing below |
| PRD.md, DECISIONS.md, DEPLOYMENT.md | Product/design history and operations material; some sections are older than the current code |

### Runtime data

src/lib/paths.js resolves all application files from APP_ROOT when set, or from the repository/install location otherwise.

| Path | Purpose |
|---|---|
| config/settings.json | Runtime configuration, including the YouTube stream key |
| data/stream-state.json | Desired/actual state, errors, counters, active video, and resume bookmark |
| data/stream-history.json | Capped stream start/exit history |
| data/bandwidth-usage.json | Per-accounting-period usage estimate and manual OCI observations |
| data/videos.json | Video metadata/index; source media stays in videos/ |
| data/ffmpeg.lock | Single-publisher process guard |
| data/loop*.ffconcat | Generated playlist input lists |
| videos/.incoming/ | Temporary upload/download files before registration |
| logs/app.log | Structured JSON-lines app log; rotated according to log settings |
| backups/ | JSON backups used for recovery and update snapshots |

JSON writes are queued per file, written to a temporary file, fsynced, and atomically renamed. Settings/state/usage readers can recover from valid backups when the primary JSON is unreadable. Runtime files are intentionally ignored by Git.

## Configuration

The runtime schema and defaults live in src/config-manager.js (DEFAULTS); src/lib/validate.js defines accepted fields and validation. Settings are deep-merged with defaults when loaded, and patches from the dashboard/API are validated before saving. See config/settings.example.json for the installer template.

| Section | Main controls |
|---|---|
| stream | Active mode (horizontal or vertical), per-mode playlists, playbackOrder, modePreference, allowTranscode, target resolution, fps, video/audio bitrate, keyframe interval, loop method, auto-resume, and stall/speed/startup/stop thresholds |
| youtube | RTMPS base URL, canonical streamKey, optional title/base metadata |
| studioAutomation | enabled, baseTitle, timezone, preview wait, timeout, display, Chrome binary, and Chrome user-data directory |
| scheduler | mode (manual, continuous, or scheduled), timezone, schedule windows, and optional autoRecycle configuration |
| recovery | Exponential retry base/factor/maximum/jitter, stable interval, failure limit, and slow-retry behavior |
| bandwidth | Monthly allowance, safety limit, decimal/binary unit base, overhead, alert thresholds, accounting reset time/timezone, persistence cadence, and optional OCI observations |
| uploads | Allowed extensions, maximum upload bytes, and minimum free-space reserve |
| disk, logs, backups, ui | Disk warning thresholds, log level/rotation, JSON backup retention, and dashboard polling |

Notable code defaults include horizontal mode, modePreference auto, allowTranscode true, 4 Mbps configured video target, 30 fps, 128 Kbps audio, continuous scheduling in Asia/Kolkata, Studio automation enabled, and a 9 TB safety limit against a 10 TB monthly allowance. Auto-recycle is disabled by default; its fallback session/pause values are 8 hours/60 minutes.

The example file does not contain every default. On load, the current code also normalizes stream.copyMinMbps, stream.copyMaxMbps, and stream.keyframeMaxSeconds; inspect the effective settings returned by the app instead of assuming every example value survives normalization. The checked-in example currently sets stream.resolution to 1080x1920, while the code default is 1920x1080 and the default mode is horizontal. Review the target settings file and orientation before streaming.

### Environment variables

| Variable | Use |
|---|---|
| HOST, PORT | HTTP bind address and port; defaults are 127.0.0.1 and 3000 |
| ADMIN_USERNAME, ADMIN_PASSWORD_HASH, SESSION_SECRET | Admin login and cookie signing; production values are supplied through the service environment file |
| APP_ROOT | Override the application root used for runtime paths |
| DISPLAY, CHROME_BIN, CHROME_USER_DATA_DIR | Studio browser/display overrides |
| AUTO_NORMALIZE_GOP=true | Optional download-time GOP normalization; this invokes an encode and is off by default |
| ALLOW_PLAIN_RTMP_FOR_TESTS=1 | Test-only relaxation in FFmpeg argument validation; do not set in production |

The YouTube stream key is stored in config/settings.json as ordinary JSON (the installed file is permission-restricted, but it is **not encrypted at rest**). It is masked in normal settings API responses and redacted from logs; the reveal endpoint requires the admin password and is rate-limited. The admin password is stored as a scrypt hash in the service environment. Login sessions are memory-only and are invalidated when the process restarts.

## HTTP API map

All routes except /api/health, /api/auth/*, and the loopback-only CLI endpoint require authentication as appropriate. Mutating protected routes use the CSRF middleware. The browser app obtains and sends the CSRF token through public/js/api.js.

| Prefix/path | Operations |
|---|---|
| /api/health | Public process health and uptime |
| /api/auth | POST /login, POST /logout, GET /me |
| /api/stream | GET / or /status, GET /mode, POST /mode, /start, /stop, /restart, /enable, /disable, /maintenance |
| /api/status | Stream status alias |
| /api/settings | GET /, PUT /, POST /reveal-stream-key |
| /api/bandwidth | GET /, POST /adjust, /manual-oci, /unlock |
| /api/scheduler | GET /, PUT / |
| /api/videos | List/sync library; get/set playlists; random select; upload/delete/select/revalidate/play video; YouTube URL download/status/cancel/duplicate check; cookie status/upload/Chrome sync |
| /api/system | GET / metrics and GET /logs recent redacted log lines |
| /api/logs | Authenticated alias for recent application log lines |
| /api/internal/cli-status | Unauthenticated only from loopback and without forwarded-IP headers; used by npm run status |

Video preview streaming supports HTTP byte ranges. The full endpoint behavior and validation live in the route files under src/api/.

## Local development

### Requirements

- Node.js meeting the package engine requirement.
- FFmpeg and FFprobe on PATH for media probing and streaming features.
- Chrome/Chromium, a signed-in persistent browser profile, and a working Linux display only when exercising Studio automation.
- yt-dlp only for YouTube URL imports.

### Install and run

~~~bash
npm ci
npm run dev
~~~

The development server binds to http://127.0.0.1:3000 by default. The dashboard is served by Express; there is no separate frontend build step. The server can load factory defaults if config/settings.json is absent. To use the login-protected dashboard locally, set ADMIN_USERNAME, a generated ADMIN_PASSWORD_HASH, and a non-default SESSION_SECRET in the shell environment.

Generate an admin password hash interactively with:

~~~bash
node scripts/hash-password.js
~~~

The repository also provides these npm scripts:

| Command | Purpose |
|---|---|
| npm start | Start the production-style Node server |
| npm run dev | Start Node with watch/reload for local development |
| npm test | Run unit tests with Node's built-in test runner |
| npm run test:integration | Run the separate integration test suite |
| npm run hash-password | Generate a scrypt password hash |
| npm run migrate | Migrate settings/state schemas, sync disk videos, and clear selected stale state |
| npm run status | Show local service/state telemetry; -- --watch enables a live view, -- --json outputs JSON |
| npm run seek -- HH:MM:SS | Write a resume bookmark and restart the service; this is disruptive |

## Ubuntu/VPS deployment

The repository includes install.sh, a systemd unit, a reverse-proxy example, and an update script. The intended deployment is an Ubuntu host with Node.js, FFmpeg/FFprobe (including the libx264 and AAC encoders), optional yt-dlp, and Chrome plus a usable display/profile for default Studio automation.

The installer command is:

~~~bash
sudo ./install.sh
~~~

**Do not assume a clean install is ready to stream without resolving the service-account mismatch below.** install.sh creates and owns the application tree as ytlive, while systemd/yt-live-manager.service currently runs as ubuntu and grants writes under /opt/yt-live-manager and /home/ubuntu. The settings file is created with restrictive permissions, so these identities and file permissions must be made consistent before relying on the service.

The installer also installs OS/npm dependencies, initializes config/settings.json only if absent, asks for an admin username/password, writes the service environment file, enables systemd, and restarts the service. It does not install or sign in to Chrome. Its systemd unit expects DISPLAY=:10; configure that display and the Chrome profile used in studioAutomation before enabling the default Studio gate.

For remote dashboard access, the server defaults to loopback. Keep an SSH tunnel open from your workstation:

~~~bash
ssh -L 8443:127.0.0.1:3000 ubuntu@YOUR_SERVER
~~~

Then open http://localhost:8443. nginx/yt-live-manager.conf is a reference configuration, not an automatically installed proxy. The installer currently does not provision Nginx from its --with-nginx option.

Useful service commands:

~~~bash
sudo systemctl status yt-live-manager
sudo journalctl -u yt-live-manager -f
sudo systemctl stop yt-live-manager
sudo systemctl start yt-live-manager
~~~

Stopping/restarting the service interrupts the RTMPS session. update.sh is especially disruptive: it stops the service, runs a broad pkill -9 -f ffmpeg, clears the saved resume bookmark, takes a config/data backup, copies code, migrates files, and restarts with a health check/rollback. Run it only when that interruption is acceptable and after reviewing its effects on the host.

## Tests and verification

~~~bash
npm test
npm run test:integration
~~~

Unit tests are in test/unit/; the integration test is in test/integration/. Coverage is grouped around stream lifecycle/recovery, FFmpeg/FFprobe compatibility, playlists and random selection, YouTube title/Studio behavior, scheduler/auto-recycle, API/auth/config validation, atomic persistence, bandwidth/usage, and yt-dlp.

These tests do not by themselves verify a real YouTube channel, Studio DOM changes, the VPS Chrome profile/display, RTMPS ingest quality, Oracle's reported bandwidth, or 24-hour operation. Those require a controlled environment and a deliberate server-side acceptance run. The scripts/verify-*.js and scripts/test-studio-worker.sh tools are specialized operational checks; inspect each script before running it against a VPS or live channel because some exercise production state and service behavior.

## Utility scripts and bundled helpers

| File | Purpose / caution |
|---|---|
| scripts/studio-worker.mjs | Strict Chrome/Puppeteer Studio startup worker |
| scripts/hash-password.js | Generate the admin scrypt hash |
| scripts/migrate.js | Migrate schemas, resync media, and clear selected stale errors; mutates runtime files unless --dry-run |
| scripts/status.js | Terminal status view using local API with disk fallback |
| scripts/seek.js | Set playback bookmark and restart the service |
| scripts/normalize-video.js | Offline H.264 GOP normalization; **re-encodes video and replaces the source file** |
| scripts/optimize-vps.sh | Ubuntu memory/daemon tuning; changes host services and settings |
| scripts/preserve-bookmark.js | Save current playback position before a planned stop/update |
| scripts/find-active-broadcast.mjs | Browser-based Studio diagnostic |
| scripts/set-desired-running.js, scripts/set-prod-defaults.js, scripts/update-settings.js | Directly mutate stream state or production settings; inspect code and paths before use |
| scripts/verify-*.js, scripts/test-studio-worker.sh | Acceptance/diagnostic tooling; may interact with a real service/Studio |
| YT_Live_GPU_Converter.bat, YT_Live_GPU_Converter.ps1 | Optional Windows helper for local FFmpeg video preparation |
| yt-live-login.bat | Machine-specific SSH/browser helper; it contains a hard-coded endpoint and must not be reused as a generic deployment script |

## Current implementation caveats and documentation authority

Read the current source before treating design docs or old acceptance claims as guarantees. PRD.md, DECISIONS.md, and especially parts of DEPLOYMENT.md contain historical or planned assumptions that no longer match runtime code; examples include browserless Studio lifecycle claims, transcode-on-import claims, and dual-output claims.

Specific current facts:

1. **Single output:** stream-manager.js launches one publisher using the canonical youtube.streamKey and reports isDualStream: false. Legacy dual-stream settings/pairing helpers and an optional secondary FFmpeg argument interface remain, but the active stream path does not publish two simultaneous outputs.
2. **Settings template drift:** the example omits some runtime defaults and sets a vertical resolution while the code default mode/resolution are horizontal. Runtime normalization can also change example copy/keyframe thresholds. Inspect effective settings before starting.
3. **Installer identity drift:** align the ytlive ownership in install.sh with User=ubuntu in the systemd unit before deployment.
4. **Update is not live-safe:** the current update script terminates FFmpeg and clears the resume bookmark before replacing code.
5. **Credential hygiene:** stream keys are not encrypted in the JSON file. The repository also tracks key-like SSH artifacts and a machine-specific login helper; verify that no real credentials are present, rotate any that were exposed, and remove sensitive material from repository history before sharing.

Use the implementation under src/, public/, and scripts/ for current behavior; use this README as its map. Tests provide regression evidence for code paths, not proof of external YouTube or VPS behavior.