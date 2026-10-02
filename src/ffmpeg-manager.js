/**
 * ffmpeg-manager.js — Process lifecycle, argument building, locking, and watchdogs.
 *
 * PRD §4, §10:
 * - spawn() ONLY with argument array and shell: false.
 * - Single-instance mutex + atomic data/ffmpeg.lock file.
 * - Arg builder: pure function buildFfmpegArgs(settings, videoMeta, secretTarget, mode).
 * - Watchdogs: startup timeout, stall watchdog, slow speed watchdog.
 * - Progress parsing: -progress pipe:1 key=value stream via readline.
 * - Stderr: redacted line-by-line, circular buffer (last 50 lines), error classification.
 * - Graceful stop: SIGTERM → wait stopGraceSeconds → SIGKILL.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { redact } from './lib/redact.js';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

// ─── Arg Builder (Pure Function) ──────────────────────────────────────────────

/**
 * Build FFmpeg command-line arguments array.
 *
 * @param {object} settings
 * @param {object} videoMeta
 * @param {string} secretTarget Full destination URL (rtmpsUrl + "/" + streamKey)
 * @param {'copy'|'hybrid'|'transcode'} [mode='copy']
 * @returns {string[]} Argument array (safe for child_process.spawn with shell: false)
 */
export function buildFfmpegArgs(settings, videoMeta, secretTarget, mode = 'copy') {
  const streamCfg = settings.stream || {};
  const videoPath = videoMeta?.filePath || videoMeta?.path || '';

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-nostats',
    '-progress', 'pipe:1',
    '-re',
  ];

  // Infinite looping (PRD §4.5)
  if (streamCfg.loopStrategy === 'concat') {
    args.push('-f', 'concat', '-safe', '0', '-i', PATHS.loopConcat);
  } else {
    args.push('-stream_loop', '-1', '-fflags', '+genpts', '-i', videoPath);
  }

  const fps = streamCfg.fps ?? 30;
  const keyframeSec = streamCfg.keyframeSeconds ?? 2;
  const gop = Math.round(fps * keyframeSec);

  if (mode === 'copy') {
    // Pure Copy Mode (PRD §4.4)
    args.push(
      '-c', 'copy',
      '-flvflags', 'no_duration_filesize',
      '-f', 'flv',
      secretTarget
    );
  } else if (mode === 'hybrid') {
    // Hybrid Mode: Video copy, audio transcoded to AAC or generated silent (PRD §4.4)
    args.push('-map', '0:v:0');

    if (videoMeta?.hasAudio) {
      args.push(
        '-map', '0:a:0?',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', `${streamCfg.audioBitrateKbps ?? 128}k`,
        '-ar', `${streamCfg.audioSampleRate ?? 44100}`,
        '-ac', '2'
      );
    } else {
      // Generate silent audio source
      args.push(
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', `${streamCfg.audioBitrateKbps ?? 128}k`,
        '-ar', `${streamCfg.audioSampleRate ?? 44100}`,
        '-ac', '2'
      );
    }

    args.push(
      '-flvflags', 'no_duration_filesize',
      '-f', 'flv',
      secretTarget
    );
  } else {
    // Transcode Mode (PRD §4.4)
    const resolution = streamCfg.resolution || '1080x1920';
    const [w, h] = resolution.split('x');
    const width = parseInt(w, 10) || 1080;
    const height = parseInt(h, 10) || 1920;

    const maxKbps = (streamCfg.videoBitrateMbps ?? 4) * 1000;
    const sourceKbps = videoMeta?.videoBitrate > 0 ? Math.round(videoMeta.videoBitrate / 1000) : 0;
    // Adapt to source video bitrate up to max 4Mbps ceiling (avoids inflating lower bitrate files)
    const videoKbps = sourceKbps > 0 ? Math.min(sourceKbps, maxKbps) : maxKbps;
    const bufSizeKbps = videoKbps * 2;
    const preset = streamCfg.x264Preset || 'veryfast';

    const vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1',
      `fps=${fps}`,
      'format=yuv420p',
    ].join(',');

    args.push(
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', preset,
      '-profile:v', 'high',
      '-level:v', '4.2',
      '-b:v', `${videoKbps}k`,
      '-minrate', `${videoKbps}k`,
      '-maxrate', `${videoKbps}k`,
      '-bufsize', `${bufSizeKbps}k`,
      '-g', `${gop}`,
      '-keyint_min', `${gop}`,
      '-sc_threshold', '0',
      '-x264-params', 'nal-hrd=cbr:force-cfr=1',
      '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709'
    );

    if (videoMeta && !videoMeta.hasAudio) {
      args.push(
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0',
        '-map', '1:a:0'
      );
    }

    args.push(
      '-c:a', 'aac',
      '-b:a', `${streamCfg.audioBitrateKbps ?? 128}k`,
      '-ar', `${streamCfg.audioSampleRate ?? 44100}`,
      '-ac', '2',
      '-flvflags', 'no_duration_filesize',
      '-f', 'flv',
      secretTarget
    );
  }

  return args;
}

// ─── Lock File Management ─────────────────────────────────────────────────────

const CMD_MARKER = 'yt-live-manager-ffmpeg';
let _lockPath = PATHS.ffmpegLock;

/**
 * Acquire process lock via atomic write (flag 'wx').
 */
async function acquireLock(pid) {
  const content = JSON.stringify({
    pid,
    startedAt: new Date().toISOString(),
    cmdMarker: CMD_MARKER,
  });

  try {
    await fs.writeFile(_lockPath, content, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw Object.assign(new Error('Another FFmpeg process holds data/ffmpeg.lock'), {
        code: 'E_ALREADY_RUNNING',
      });
    }
    throw err;
  }
}

/**
 * Release process lock file.
 */
async function releaseLock() {
  try {
    await fs.unlink(_lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('ffmpeg.release_lock_error', err.message);
    }
  }
}

/**
 * Check and clean up orphaned locks at startup.
 */
export async function cleanupStaleLockOnBoot() {
  try {
    const raw = await fs.readFile(_lockPath, 'utf8');
    const lock = JSON.parse(raw);
    const pid = lock?.pid;

    if (pid && typeof pid === 'number') {
      let isRunning = false;
      try {
        process.kill(pid, 0); // Check if process exists
        isRunning = true;
      } catch {
        isRunning = false;
      }

      if (isRunning) {
        logger.warn('ffmpeg.orphan_detected', `Orphaned FFmpeg process PID ${pid} found on boot; killing`);
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 2000));
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    }

    await releaseLock();
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('ffmpeg.boot_lock_check_error', err.message);
    }
  }
}

// ─── Module State ─────────────────────────────────────────────────────────────

let _currentChild      = null;
let _currentPid        = null;
let _expectedExit      = false;
let _latestProgress    = null;
const _stderrRing      = []; // capped at 50 entries
const RING_MAX         = 50;

// Watchdog timers & state
let _startupTimer      = null;
let _stallWatchdog     = null;
let _slowWatchdog      = null;
let _lastProgressBytes = 0;
let _lastProgressTime  = 0;
let _slowStartTime     = null;

function clearWatchdogs() {
  if (_startupTimer)  { clearTimeout(_startupTimer);   _startupTimer = null; }
  if (_stallWatchdog) { clearInterval(_stallWatchdog); _stallWatchdog = null; }
  if (_slowWatchdog)  { clearInterval(_slowWatchdog);  _slowWatchdog = null; }
  _slowStartTime = null;
}

// ─── Process Spawning ─────────────────────────────────────────────────────────

/**
 * Spawn an FFmpeg streaming process.
 *
 * @param {object} params
 * @param {string[]} params.args Array of CLI arguments
 * @param {object} params.settings
 * @param {Function} params.onProgress Called on progress updates: (parsedProgress) => void
 * @param {Function} params.onExit     Called when process exits: ({ code, signal, expected, lastError }) => void
 * @param {Function} params.onHealthy  Called once the process becomes healthy (total_size > 0, speed >= min)
 * @returns {Promise<{ pid: number }>}
 */
export async function spawnFfmpeg({
  args,
  settings,
  onProgress,
  onExit,
  onHealthy,
}) {
  if (_currentChild) {
    throw Object.assign(new Error('FFmpeg is already running in this instance'), {
      code: 'E_ALREADY_RUNNING',
    });
  }

  _expectedExit      = false;
  _latestProgress    = null;
  _stderrRing.length = 0;
  _lastProgressBytes = 0;
  _lastProgressTime  = Date.now();
  _slowStartTime     = null;

  // Masked command for logging (PRD §10, §20)
  const safeLogCmd = args.map(arg => redact(arg)).join(' ');
  logger.info('ffmpeg.spawn', `Spawning FFmpeg: ffmpeg ${safeLogCmd}`);

  let child;
  try {
    child = spawn('ffmpeg', args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(new Error('FFmpeg binary not found on system PATH'), { code: 'E_FFMPEG_MISSING' });
    }
    throw err;
  }

  _currentChild = child;
  _currentPid   = child.pid;

  // Lock acquisition
  try {
    await acquireLock(child.pid);
  } catch (err) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    _currentChild = null;
    _currentPid   = null;
    throw err;
  }

  const streamCfg = settings.stream || {};
  const startupTimeoutMs = (streamCfg.startupTimeoutSeconds ?? 30) * 1000;
  const stallMs          = (streamCfg.stallSeconds ?? 30) * 1000;
  const slowMs           = (streamCfg.slowSeconds ?? 60) * 1000;
  const minSpeed         = streamCfg.minSpeed ?? 0.90;

  let becameHealthy = false;

  // 1. Startup Watchdog: must emit valid progress within startupTimeoutSeconds
  _startupTimer = setTimeout(() => {
    if (!becameHealthy) {
      logger.error('ffmpeg.startup_timeout', `FFmpeg failed to produce healthy output within ${startupTimeoutMs / 1000}s`);
      stopFfmpeg({ force: true, reason: 'startup_timeout' });
    }
  }, startupTimeoutMs);

  // 2. Parse Stdout (-progress pipe:1)
  const rlStdout = readline.createInterface({ input: child.stdout, terminal: false });
  let block = {};

  rlStdout.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      block[key] = val;
    }

    if (trimmed.startsWith('progress=')) {
      const totalSize = parseInt(block.total_size, 10) || 0;
      const speedStr  = (block.speed || '').replace('x', '').trim();
      const speed     = parseFloat(speedStr) || 0;
      const fps       = parseFloat(block.fps) || 0;
      const bitrate   = block.bitrate || '';
      const frame     = parseInt(block.frame, 10) || 0;

      const progressData = {
        frame,
        fps,
        bitrate,
        total_size: totalSize,
        speed,
        speedStr: block.speed || '',
        progress: block.progress || '',
        at: new Date().toISOString(),
      };

      _latestProgress = progressData;

      // Check Healthy trigger
      if (!becameHealthy && totalSize > 0 && speed >= minSpeed) {
        becameHealthy = true;
        if (_startupTimer) { clearTimeout(_startupTimer); _startupTimer = null; }
        if (typeof onHealthy === 'function') onHealthy(progressData);
      }

      // Check stall watchdog delta
      if (totalSize > _lastProgressBytes) {
        _lastProgressBytes = totalSize;
        _lastProgressTime  = Date.now();
      }

      // Check speed watchdog
      if (becameHealthy) {
        if (speed < minSpeed) {
          if (!_slowStartTime) _slowStartTime = Date.now();
          else if (Date.now() - _slowStartTime >= slowMs) {
            logger.warn('ffmpeg.speed_overload', `FFmpeg encoding speed (${speed}x) below threshold (${minSpeed}x) for ${slowMs / 1000}s`);
            stopFfmpeg({ force: true, reason: 'encoder_slow' });
          }
        } else {
          _slowStartTime = null;
        }
      }

      if (typeof onProgress === 'function') {
        onProgress(progressData);
      }

      block = {};
    }
  });

  // 3. Periodic Stall Watchdog
  _stallWatchdog = setInterval(() => {
    if (becameHealthy && Date.now() - _lastProgressTime >= stallMs) {
      logger.error('ffmpeg.stall_detected', `FFmpeg output stalled for ${stallMs / 1000}s`);
      stopFfmpeg({ force: true, reason: 'stall_watchdog' });
    }
  }, 5000);

  // 4. Stderr line buffering & redaction (PRD §10)
  const rlStderr = readline.createInterface({ input: child.stderr, terminal: false });
  rlStderr.on('line', line => {
    const redacted = redact(line.trim());
    if (!redacted) return;

    _stderrRing.push({ line: redacted, at: new Date().toISOString() });
    if (_stderrRing.length > RING_MAX) _stderrRing.shift();

    if (redacted.includes('error') || redacted.includes('Error') || redacted.includes('failed')) {
      logger.warn('ffmpeg.stderr', redacted);
    } else {
      logger.debug('ffmpeg.stderr', redacted);
    }
  });

  // 5. Child Exit & Error Handling
  child.on('error', err => {
    clearWatchdogs();
    logger.error('ffmpeg.child_error', `FFmpeg process error: ${err.message}`);
  });

  child.on('exit', async (code, signal) => {
    clearWatchdogs();
    const wasExpected = _expectedExit;
    const pid = _currentPid;

    _currentChild   = null;
    _currentPid     = null;
    _expectedExit   = false;

    await releaseLock();

    const lastErrLine = _stderrRing.length > 0 ? _stderrRing[_stderrRing.length - 1].line : null;
    logger.info('ffmpeg.exit', `FFmpeg process PID ${pid} exited with code ${code}, signal ${signal} (expected: ${wasExpected})`);

    if (typeof onExit === 'function') {
      onExit({
        code,
        signal,
        expected: wasExpected,
        lastError: lastErrLine,
      });
    }
  });

  return { pid: child.pid };
}

// ─── Process Stopping ─────────────────────────────────────────────────────────

/**
 * Stop currently running FFmpeg process.
 * Order: SIGTERM → wait stopGraceSeconds → SIGKILL.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.force=false]
 * @param {string}  [opts.reason='manual_stop']
 * @param {number}  [opts.graceSeconds=8]
 */
export async function stopFfmpeg({ force = false, reason = 'manual_stop', graceSeconds = 8 } = {}) {
  const child = _currentChild;
  if (!child) return { stopped: true };

  _expectedExit = true;
  clearWatchdogs();

  logger.info('ffmpeg.stopping', `Stopping FFmpeg PID ${child.pid} (reason: ${reason}, force: ${force})`);

  if (force) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    return { stopped: true };
  }

  // Graceful SIGTERM
  try {
    child.kill('SIGTERM');
  } catch (err) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    return { stopped: true };
  }

  // Wait for exit with timeout
  const graceMs = graceSeconds * 1000;
  const exitPromise = new Promise(resolve => child.once('exit', resolve));
  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), graceMs));

  const result = await Promise.race([exitPromise, timeoutPromise]);
  if (result === 'TIMEOUT') {
    logger.warn('ffmpeg.sigterm_timeout', `FFmpeg PID ${child.pid} did not exit within ${graceSeconds}s; sending SIGKILL`);
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  return { stopped: true };
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export function isFfmpegRunning() {
  return Boolean(_currentChild);
}

export function getFfmpegPid() {
  return _currentPid;
}

export function getLatestProgress() {
  return _latestProgress ? { ..._latestProgress } : null;
}

export function getRecentStderr() {
  return [..._stderrRing];
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

export function _setLockPathForTest(lockPath) {
  _lockPath = lockPath;
}
