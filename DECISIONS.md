# DECISIONS.md — 24×7 YouTube Vertical Live Streaming Manager

All decisions logged per PRD §0 rule 1: if ambiguous, choose simplest option that
preserves 24×7 stability, and record here.

| # | Decision | Reason |
|---|---|---|
| D-001 | Project root = `YT247/` workspace root (not a subfolder) | User confirmed |
| D-002 | ESM modules (`"type":"module"` in package.json) | Node 22 best practice; cleaner imports; no circular-dep issues |
| D-003 | Test runner: `node:test` built-in only | PRD §26.1 specifies this; avoids extra dependency |
| D-004 | Default scheduler timezone: `Asia/Kolkata` | User confirmed (India) |
| D-005 | HTTPS access: SSH tunnel only (`ssh -L 8443:127.0.0.1:3000`) | User confirmed; no Nginx/certbot by default; `--with-nginx` flag retained in install.sh for future use |
| D-006 | Session store: in-memory only | PRD §19.1; user confirmed; single-admin; restart logs everyone out — acceptable |
| D-007 | Loop strategy default: `stream_loop` (`-stream_loop -1`) | PRD §4.5 primary strategy; concat is P1 fallback; user confirmed |
| D-008 | `stream_loop -1` timestamp overflow: document as soak-test risk (A5) | Concat config option wired in but untested until P1 approval |
| D-009 | `busboy` version pinned to `^1.6.0` | v1.x is current stable; v0.x has incompatible API (not `new busboy()`); needed for streaming multipart upload |
| D-010 | `unitBase = 1000` (decimal GB/TB) | PRD §6.2 default; conservative vs. OCI billing (which also uses decimal) |
| D-011 | Clock sanity re-check reuses usage-manager 30 s tick | PRD §7.7: "re-check every 30 s"; reusing the same tick avoids an extra `setInterval` |
| D-012 | `/proc/stat` CPU delta: requires two 1 s samples; first call returns 0 | Simplest implementation; system-monitor caches previous sample in module scope |
| D-013 | `safetyLimitGB` takes priority over `safetyLimitTB`; normalized to `safetyLimitTB` on save | PRD §7.4: "If both present, `safetyLimitGB` wins"; normalising avoids dual-state bugs |
| D-014 | Backup throttle for `stream-state` and `bandwidth-usage`: 1 h default + forced on lock/unlock/rollover/shutdown | PRD §18.3: "written very often, so backups are throttled" |
| D-015 | Node.js 22 LTS pinned in `install.sh` (`NODE_MAJOR=22`) | User confirmed; PRD §2.1 |
| D-016 | OCI idle reclamation: README note + System card informational message only | User confirmed; PRD §2.3 explicitly forbids fake load |
| D-017 | Dark mode dashboard | User preference; suits 24×7 server monitoring |
| D-018 | System fonts only (`system-ui / -apple-system` stack) | PRD §15.1: strict CSP `'self'`, no CDN assets |
| D-019 | `ALLOW_PLAIN_RTMP_FOR_TESTS=1` env flag checked in ffmpeg-manager arg builder | Keeps validate.js pure (no env checks); test-only relaxation never reaches install.sh |
| D-020 | Logger is safe to call before `initLogger()`; pre-init writes to stdout only | Avoids init-order fragility; config-manager can log during its own load |
| D-021 | `deepMerge` in config-manager: starts from DEFAULTS, overrides with user values; arrays replaced wholesale | Ensures all fields always exist; prevents partial-array corruption |
| D-022 | Unknown keys in settings.json loaded from disk are passed through (lenient load) | Prevents data loss across versions; API path still rejects unknowns via validate.js |
| D-023 | Health verdict computed in `/api/status` | PRD §15.4 computes HEALTHY/DEGRADED/UNHEALTHY from encoder speed, failures, gates, and system metrics |
| D-024 | Primary operational video strategy: pre-encoded 1080×1920 H.264 / AAC (2.0s GOP) for stream-copy mode | User confirmed; ensures < 10% CPU usage on OCI Ampere A1, rock-solid 24×7 stability, zero transcoding artifacts |
| D-025 | YouTube Studio broadcast settings: Reusable key, Auto-stop OFF, Normal Latency | PRD §4.7, §14.3; prevents broadcast termination on reconnects, maximizes ingestion buffer resilience for 24×7 uptime |
| D-026 | Optimization for VM.Standard.E2.1.Micro (1 OCPU, 1 GB RAM, x86_64): Enforce Stream-Copy ONLY | User confirmed; 1/8 OCPU burstable AMD core cannot encode 1080p in real-time. Enforcing stream-copy mode keeps CPU < 5%, RAM ~25 MB, zero-lag streaming |
| D-027 | Memory & OOM Protection for E2.1.Micro: 2 GB swapfile (`swappiness=10`) + `--max-old-space-size=256` in systemd unit | User confirmed; prevents Linux OOM killer on 1 GB RAM while maintaining fast responsiveness |
| D-028 | Video encoding workflow: User pre-encodes via editing software (Premiere, DaVinci, Handbrake) to 1080×1920 H.264/AAC (2s GOP) prior to uploading | User confirmed; zero server CPU overhead, guaranteed stream-copy mode compatibility on E2.1.Micro |
| D-029 | Default `modePreference` is `auto` with `allowTranscode: true` | PRD §5.3 / §24 alignment; executes Zero-CPU stream copy for 1080p compatible sources while enabling smooth transcoding for 720p/non-copy sources with interactive prompt in dashboard |
| D-030 | Default `videoBitrateMbps` set to 4 Mbps | User requested; reduces data consumption to ~49 GB/day (~1.47 TB/month), highly optimized for OCI Always Free bandwidth limits |



