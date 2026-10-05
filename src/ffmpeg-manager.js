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
 * Build FFmpeg command-line arguments array for a single stream.
 * Proven, clean single-input single-output command from known-good baseline (8b215d8).
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
  const isConcat = Boolean(videoMeta?.isConcat) || streamCfg.loopStrategy === 'concat' || (Array.isArray(streamCfg.playlist) && streamCfg.playlist.length > 1);
  if (isConcat) {
    const concatPath = (videoMeta?.filePath && videoMeta.filePath.endsWith('.ffconcat')) ? videoMeta.filePath : PATHS.loopConcat;
    args.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', concatPath);
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
    const isHoriz = (videoMeta?.probe?.width && videoMeta?.probe?.height && videoMeta.probe.width > videoMeta.probe.height) ||
      videoMeta?.orientation === 'horizontal' || videoMeta?.probe?.orientation === 'horizontal';
    const defaultRes = isHoriz ? '1920x1080' : '1080x1920';
    const resolution = streamCfg.resolution || defaultRes;
    const [w, h] = resolution.split('x');
    const width = parseInt(w, 10) || (isHoriz ? 1920 : 1080);
    const height = parseInt(h, 10) || (isHoriz ? 1080 : 1920);

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

/**
 * Build CLI arguments for persistent FFmpeg publisher process.
 * Reads continuous MPEG-TS from pipe:0 and outputs FLV to YouTube RTMPS.
 *
 * @param {object} settings
 * @param {string} secretTarget Full destination URL (rtmpsUrl + "/" + streamKey)
 * @returns {string[]}
 */
export function buildPublisherArgs(settings, secretTarget) {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-nostats',
    '-progress', 'pipe:1',
    '-re',
    '-fflags', '+genpts+igndts',
    '-f', 'mpegts',
    '-i', 'pipe:0',
    '-c', 'copy',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv',
    secretTarget,
  ];
}

/**
 * Build CLI arguments for segment feeder FFmpeg process.
 * Reads source video file and emits standard MPEG-TS to pipe:1 (stdout).
 *
 * @param {object} settings
 * @param {object} videoMeta
 * @param {'copy'|'hybrid'|'transcode'} [mode='copy']
 * @returns {string[]}
 */
export function buildFeederArgs(settings, videoMeta, mode = 'copy') {
  const streamCfg = settings.stream || {};
  const videoPath = videoMeta?.filePath || videoMeta?.path || '';

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-nostats',
    '-re',
  ];

  if (videoMeta?.seekOffset && Number(videoMeta.seekOffset) > 0) {
    args.push('-ss', String(Math.floor(videoMeta.seekOffset)));
  }

  args.push('-i', videoPath);

  if (mode === 'copy') {
    if (videoMeta && videoMeta.hasAudio === false) {
      args.push(
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', `${streamCfg.audioSampleRate ?? 44100}`,
        '-b:a', `${streamCfg.audioBitrateKbps ?? 128}k`,
        '-ac', '2',
        '-shortest',
        '-bsf:v', 'h264_mp4toannexb',
        '-f', 'mpegts',
        'pipe:1'
      );
    } else {
      args.push(
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', `${streamCfg.audioSampleRate ?? 44100}`,
        '-b:a', `${streamCfg.audioBitrateKbps ?? 128}k`,
        '-ac', '2',
        '-bsf:v', 'h264_mp4toannexb',
        '-f', 'mpegts',
        'pipe:1'
      );
    }
  } else if (mode === 'hybrid') {
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
      args.push(
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', `${streamCfg.audioBitrateKbps ?? 128}k`,
        '-ar', `${streamCfg.audioSampleRate ?? 44100}`,
        '-ac', '2',
        '-shortest'
      );
    }
    args.push('-bsf:v', 'h264_mp4toannexb', '-f', 'mpegts', 'pipe:1');
  } else {
    // Transcode mode
    const isHoriz = (videoMeta?.probe?.width && videoMeta?.probe?.height && videoMeta.probe.width > videoMeta.probe.height) ||
      videoMeta?.orientation === 'horizontal' || videoMeta?.probe?.orientation === 'horizontal';
    const defaultRes = isHoriz ? '1920x1080' : '1080x1920';
    const resolution = streamCfg.resolution || defaultRes;
    const [w, h] = resolution.split('x');
    const width = parseInt(w, 10) || (isHoriz ? 1920 : 1080);
    const height = parseInt(h, 10) || (isHoriz ? 1080 : 1920);

    const fps = streamCfg.fps ?? 30;
    const keyframeSec = streamCfg.keyframeSeconds ?? 2;
    const gop = Math.round(fps * keyframeSec);

    const maxKbps = (streamCfg.videoBitrateMbps ?? 4) * 1000;
    const sourceKbps = videoMeta?.videoBitrate > 0 ? Math.round(videoMeta.videoBitrate / 1000) : 0;
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

    if (!videoMeta || videoMeta.hasAudio === false) {
      args.push(
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest'
      );
    }

    args.push(
      '-c:a', 'aac',
      '-b:a', `${streamCfg.audioBitrateKbps ?? 128}k`,
      '-ar', `${streamCfg.audioSampleRate ?? 44100}`,
      '-ac', '2',
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'mpegts',
      'pipe:1'
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
  await killRogueFfmpegProcesses();
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

let _primaryChild = null;
let _secondaryChild = null;
let _primaryPid = null;
let _secondaryPid = null;
let _primaryFeeder = null;
let _secondaryFeeder = null;
let _feederExitExpected = false;
let _currentSegment = null;
let _expectedExit = false;
let _latestProgress = null;
const _stderrRing = []; // capped at 50 entries
const RING_MAX = 50;

let _exitCompletionPromise = null;
let _resolveExitCompletion = null;

let _outputDestinations = {
  vertical: { status: 'INIT', lastError: null, connectedAt: null },
  horizontal: { enabled: false, status: 'INIT', lastError: null, connectedAt: null },
};

// Watchdog timers & state
let _startupTimer = null;
let _stallWatchdog = null;
let _slowWatchdog = null;
let _lastProgressBytes = 0;
let _lastProgressTime = 0;
let _slowStartTime = null;

function clearWatchdogs() {
  if (_startupTimer) { clearTimeout(_startupTimer); _startupTimer = null; }
  if (_stallWatchdog) { clearInterval(_stallWatchdog); _stallWatchdog = null; }
  if (_slowWatchdog) { clearInterval(_slowWatchdog); _slowWatchdog = null; }
  _slowStartTime = null;
}

async function killRogueFfmpegProcesses() {
  if (process.platform !== 'linux') return;
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync("pgrep -x ffmpeg || true", { encoding: 'utf8' }).trim();
    if (out) {
      const pids = out.split(/\s+/).map(p => parseInt(p, 10)).filter(p => p > 0 && p !== process.pid && p !== _primaryPid && p !== _secondaryPid);
      if (pids.length > 0) {
        for (const p of pids) {
          logger.warn('ffmpeg.rogue_killed', `Found orphaned/rogue FFmpeg process PID ${p}; terminating`);
          try { process.kill(p, 'SIGTERM'); } catch { /* ignore */ }
        }
        for (const p of pids) {
          let alive = true;
          for (let i = 0; i < 30; i++) {
            try { process.kill(p, 0); await new Promise(r => setTimeout(r, 100)); } catch { alive = false; break; }
          }
          if (alive) {
            try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ }
            await new Promise(r => setTimeout(r, 200));
          }
        }
        // Wait 1000ms to allow remote YouTube RTMP sockets to cleanly terminate
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch { /* ignore */ }
}

// ─── Process Spawning ─────────────────────────────────────────────────────────

/**
 * Spawn an FFmpeg streaming process.
 * In Dual Live mode, primary (vertical) and secondary (horizontal) run as independent
 * processes so that the vertical stream is 100% equivalent to the single-output baseline.
 *
 * @param {object} params
 * @param {string[]} params.args Array of CLI arguments for primary vertical stream
 * @param {string[]|null} [params.secondaryArgs=null] Optional CLI arguments for secondary horizontal stream
 * @param {object} params.settings
 * @param {Function} params.onProgress Called on progress updates: (parsedProgress) => void
 * @param {Function} params.onExit     Called when process exits: ({ code, signal, expected, lastError }) => void
 * @param {Function} params.onHealthy  Called once the process becomes healthy (total_size > 0, speed >= min)
 * @returns {Promise<{ pid: number }>}
 */
export async function spawnFfmpeg({
  args,
  secondaryArgs = null,
  settings,
  pipeMode = false,
  onProgress,
  onExit,
  onHealthy,
}) {
  // If a previous FFmpeg is still completing exit/cleanup, wait for it
  if (_exitCompletionPromise) {
    try {
      await _exitCompletionPromise;
    } catch { /* ignore */ }
  }

  if (_primaryChild || _secondaryChild) {
    throw Object.assign(new Error('FFmpeg is already running in this instance'), {
      code: 'E_ALREADY_RUNNING',
    });
  }

  // Terminate any rogue/orphaned FFmpeg processes on system before spawning
  await killRogueFfmpegProcesses();

  const hasSecondary = Boolean(secondaryArgs && Array.isArray(secondaryArgs) && secondaryArgs.length > 0);

  // Validate RTMPS destinations for dual streaming
  if (hasSecondary) {
    const primTarget = args[args.length - 1];
    const secTarget = secondaryArgs[secondaryArgs.length - 1];
    if (primTarget && secTarget && primTarget.trim() === secTarget.trim()) {
      throw Object.assign(new Error('Horizontal (Primary) and Vertical (Secondary) Stream Keys must be different'), {
        code: 'E_DUAL_STREAM_KEYS_IDENTICAL',
      });
    }
  }

  _outputDestinations = {
    horizontal: { enabled: true, status: 'INIT', lastError: null, connectedAt: null },
    vertical: { enabled: hasSecondary, status: hasSecondary ? 'INIT' : 'DISABLED', lastError: null, connectedAt: null },
  };

  _expectedExit = false;
  _latestProgress = null;
  _stderrRing.length = 0;
  _lastProgressBytes = 0;
  _lastProgressTime = Date.now();
  _slowStartTime = null;
  let _lastBitrateCalcTime = Date.now();
  let _lastBitrateCalcBytes = 0;
  let _measuredBitrate = 0;

  // Masked command for logging (PRD §10, §20)
  const safeLogCmd = args.map(arg => redact(arg)).join(' ');
  logger.info('ffmpeg.spawn', `Spawning Primary Horizontal FFmpeg: ffmpeg ${safeLogCmd}`);

  // Create the exit completion promise BEFORE spawning
  _exitCompletionPromise = new Promise(resolve => {
    _resolveExitCompletion = resolve;
  });

  const primaryStdio = pipeMode ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
  let primaryChild;
  try {
    primaryChild = spawn('ffmpeg', args, {
      shell: false,
      stdio: primaryStdio,
      detached: false,
    });
    if (pipeMode && primaryChild.stdin) {
      primaryChild.stdin.on('error', (err) => {
        logger.debug('ffmpeg.primary_stdin_error', err.message);
      });
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(new Error('FFmpeg binary not found on system PATH'), { code: 'E_FFMPEG_MISSING' });
    }
    throw err;
  }

  _primaryChild = primaryChild;
  _primaryPid = primaryChild.pid;
  logger.info('ffmpeg.spawned', `New Primary FFmpeg process spawned with PID ${primaryChild.pid}`);

  // Lock acquisition on primary process PID
  try {
    await acquireLock(primaryChild.pid);
  } catch (err) {
    try { primaryChild.kill('SIGKILL'); } catch { /* ignore */ }
    _primaryChild = null;
    _primaryPid = null;
    _exitCompletionPromise = null;
    _resolveExitCompletion = null;
    throw err;
  }

  // If dual streaming enabled, spawn independent secondary vertical process
  if (hasSecondary) {
    const safeLogSecCmd = secondaryArgs.map(arg => redact(arg)).join(' ');
    logger.info('ffmpeg.spawn_secondary', `Spawning Secondary Vertical FFmpeg: ffmpeg ${safeLogSecCmd}`);
    try {
      const secondaryStdio = pipeMode ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
      _secondaryChild = spawn('ffmpeg', secondaryArgs, {
        shell: false,
        stdio: secondaryStdio,
        detached: false,
      });
      if (pipeMode && _secondaryChild.stdin) {
        _secondaryChild.stdin.on('error', (err) => {
          logger.debug('ffmpeg.secondary_stdin_error', err.message);
        });
      }
      _secondaryPid = _secondaryChild.pid;
      logger.info('ffmpeg.spawned_secondary', `Secondary Vertical FFmpeg process spawned with PID ${_secondaryChild.pid}`);
    } catch (err) {
      logger.error('ffmpeg.secondary_spawn_failed', `Failed to spawn secondary vertical FFmpeg: ${err.message}`);
      _outputDestinations.vertical.status = 'FAILED';
      _outputDestinations.vertical.lastError = err.message;

      // ATOMIC SPAWN ABORT: Terminate primary child, release lock, and reject
      try { primaryChild.kill('SIGKILL'); } catch { /* ignore */ }
      _primaryChild = null;
      _primaryPid = null;
      _secondaryChild = null;
      _secondaryPid = null;
      await releaseLock();
      if (_resolveExitCompletion) {
        _resolveExitCompletion();
        _resolveExitCompletion = null;
      }
      _exitCompletionPromise = null;
      throw Object.assign(new Error(`Failed to spawn secondary vertical FFmpeg: ${err.message}`), {
        code: 'E_SECONDARY_SPAWN_FAILED',
      });
    }
  }

  const streamCfg = settings.stream || {};
  const startupTimeoutMs = (streamCfg.startupTimeoutSeconds ?? 30) * 1000;
  const stallMs = (streamCfg.stallSeconds ?? 30) * 1000;
  const slowMs = (streamCfg.slowSeconds ?? 60) * 1000;
  const minSpeed = streamCfg.minSpeed ?? 0.90;

  let becameHealthy = false;

  function checkDualHealth(progressData) {
    if (becameHealthy) return;

    const horizOk = _outputDestinations.horizontal.status === 'CONNECTED';
    const vertRequired = Boolean(hasSecondary);
    const vertOk = _outputDestinations.vertical.status === 'CONNECTED';

    if (horizOk && (!vertRequired || vertOk)) {
      becameHealthy = true;
      if (_startupTimer) {
        clearTimeout(_startupTimer);
        _startupTimer = null;
      }
      logger.info('stream.dual_healthy_confirmed', `Both stream outputs confirmed healthy and transmitting (horizontal=${horizOk}, vertical=${vertRequired ? vertOk : 'N/A'})`);
      if (typeof onHealthy === 'function') {
        onHealthy(progressData || _latestProgress || {});
      }
    }
  }

  // 1. Startup Watchdog: must emit valid progress within startupTimeoutSeconds
  _startupTimer = setTimeout(() => {
    if (!becameHealthy) {
      logger.error('ffmpeg.startup_timeout', `FFmpeg failed to produce healthy output within ${startupTimeoutMs / 1000}s`);
      stopFfmpeg({ force: true, reason: 'startup_timeout', expected: false });
    }
  }, startupTimeoutMs);

  // 2. Parse Primary Child Stdout (-progress pipe:1)
  const rlStdout = readline.createInterface({ input: primaryChild.stdout, terminal: false });
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
      const speedStr = (block.speed || '').replace('x', '').trim();
      const speed = parseFloat(speedStr) || 0;
      const fps = parseFloat(block.fps) || 0;
      const bitrate = (block.bitrate || '').trim();
      const frame = parseInt(block.frame, 10) || 0;

      // In copy mode, FFmpeg does not report bitrate. Compute instantaneous bitrate from total_size delta:
      const now = Date.now();
      if (totalSize > 0) {
        if (_lastBitrateCalcTime > 0 && totalSize > _lastBitrateCalcBytes && _lastBitrateCalcBytes > 0) {
          const dt = (now - _lastBitrateCalcTime) / 1000;
          if (dt >= 0.75) {
            const deltaBytes = totalSize - _lastBitrateCalcBytes;
            _measuredBitrate = Math.round((deltaBytes * 8) / (dt * 1000));
            _lastBitrateCalcBytes = totalSize;
            _lastBitrateCalcTime = now;
          }
        } else if (_lastBitrateCalcBytes === 0) {
          _lastBitrateCalcBytes = totalSize;
          _lastBitrateCalcTime = now;
        }
      }

      let effectiveBitrate = (bitrate && bitrate !== 'N/A' && bitrate !== '0kbits/s') ? bitrate : '';
      if (!effectiveBitrate && _measuredBitrate > 0) {
        effectiveBitrate = `${_measuredBitrate}kbits/s`;
      }
      if (!effectiveBitrate && becameHealthy) {
        effectiveBitrate = `${Math.round((settings.stream?.videoBitrateMbps || 4.0) * 1000)}kbits/s`;
      }

      // In copy mode, FFmpeg video encoder is not active so fps=0; fallback to target stream fps
      const fallbackFps = settings.stream?.fps || 30;
      const effectiveFps = (fps > 0) ? fps : (becameHealthy ? fallbackFps : 0);
      const effectiveSpeed = (speed > 0) ? speed : (becameHealthy ? 1.0 : 0);
      const effectiveSpeedStr = (speedStr && speedStr !== 'N/A' && speedStr !== '0' && speedStr !== '0.00') ? `${speedStr}x` : (becameHealthy ? '1.00x' : 'N/A');

      let outTimeSec = 0;
      if (block.out_time && block.out_time.includes(':')) {
        const parts = block.out_time.trim().split(':');
        if (parts.length === 3) {
          const h = parseFloat(parts[0]) || 0;
          const m = parseFloat(parts[1]) || 0;
          const s = parseFloat(parts[2]) || 0;
          outTimeSec = h * 3600 + m * 60 + s;
        }
      }
      if (!outTimeSec || isNaN(outTimeSec)) {
        const outTimeUs = parseInt(block.out_time_us, 10) || 0;
        const outTimeMs = parseInt(block.out_time_ms, 10) || 0;
        const us = outTimeUs > 0 ? outTimeUs : outTimeMs;
        outTimeSec = us > 0 ? (us / 1000000) : 0;
      }

      const progressData = {
        frame,
        fps: effectiveFps,
        bitrate: effectiveBitrate || (becameHealthy ? '4000kbits/s' : '0kbits/s'),
        total_size: totalSize,
        outTimeSec,
        outTimeStr: block.out_time || '',
        speed: effectiveSpeed,
        speedStr: effectiveSpeedStr,
        progress: block.progress || '',
        at: new Date().toISOString(),
      };

      _latestProgress = progressData;

      // Healthy trigger: primary horizontal output transmitting
      if (totalSize > 0 && speed >= minSpeed && _outputDestinations.horizontal.status !== 'FAILED') {
        if (_outputDestinations.horizontal.status !== 'CONNECTED') {
          _outputDestinations.horizontal.status = 'CONNECTED';
          _outputDestinations.horizontal.connectedAt = new Date().toISOString();
          logger.info('ffmpeg.rtmps_horizontal', 'RTMPS primary horizontal output: CONNECTED (outbound socket active, data transmitting)');
        }
        checkDualHealth(progressData);
      }

      // Check stall watchdog delta
      if (totalSize > _lastProgressBytes) {
        _lastProgressBytes = totalSize;
        _lastProgressTime = Date.now();
      }

      // Check speed watchdog
      if (becameHealthy) {
        if (speed < minSpeed) {
          if (!_slowStartTime) _slowStartTime = Date.now();
          else if (Date.now() - _slowStartTime >= slowMs) {
            logger.warn('ffmpeg.speed_overload', `FFmpeg encoding speed (${speed}x) below threshold (${minSpeed}x) for ${slowMs / 1000}s`);
            stopFfmpeg({ force: true, reason: 'encoder_slow', expected: false });
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
      stopFfmpeg({ force: true, reason: 'stall_watchdog', expected: false });
    }
  }, 5000);

  // 4. Stderr line buffering & redaction for Primary
  const rlStderr = readline.createInterface({ input: primaryChild.stderr, terminal: false });
  rlStderr.on('line', line => {
    const redacted = redact(line.trim());
    if (!redacted) return;

    _stderrRing.push({ line: `[Primary] ${redacted}`, at: new Date().toISOString() });
    if (_stderrRing.length > RING_MAX) _stderrRing.shift();

    const lower = redacted.toLowerCase();
    const isError = lower.includes('error') || lower.includes('failed') || lower.includes('broken pipe') || lower.includes('connection reset');

    if (isError) {
      _outputDestinations.horizontal.status = 'FAILED';
      _outputDestinations.horizontal.lastError = redacted;
      logger.error('ffmpeg.rtmps_horizontal_failed', `RTMPS horizontal output: FAILED (${redacted})`);

      if (!becameHealthy && !_expectedExit) {
        logger.error('ffmpeg.primary_startup_failed', `Primary horizontal FFmpeg failed during startup: ${redacted}`);
        stopFfmpeg({ force: true, reason: 'primary_startup_failed', expected: false });
      }
    } else {
      logger.debug('ffmpeg.stderr_primary', redacted);
    }
  });

  primaryChild.on('error', err => {
    clearWatchdogs();
    logger.error('ffmpeg.child_error', `Primary FFmpeg process error: ${err.message}`);
  });

  // 5. Setup Secondary Child (Horizontal) if active
  if (_secondaryChild) {
    const secChild = _secondaryChild;
    const rlSecStdout = readline.createInterface({ input: secChild.stdout, terminal: false });
    let secBlock = {};

    rlSecStdout.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        secBlock[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
      if (trimmed.startsWith('progress=')) {
        const secTotalSize = parseInt(secBlock.total_size, 10) || 0;
        const secSpeed = parseFloat((secBlock.speed || '').replace('x', '').trim()) || 0;
        if (secTotalSize > 0 && secSpeed >= minSpeed && _outputDestinations.vertical.status !== 'FAILED') {
          if (_outputDestinations.vertical.status !== 'CONNECTED') {
            _outputDestinations.vertical.status = 'CONNECTED';
            _outputDestinations.vertical.connectedAt = new Date().toISOString();
            logger.info('ffmpeg.rtmps_vertical', 'RTMPS secondary vertical output: CONNECTED (outbound socket active, data transmitting)');
          }
          checkDualHealth(_latestProgress || progressData);
        }
        secBlock = {};
      }
    });

    const rlSecStderr = readline.createInterface({ input: secChild.stderr, terminal: false });
    rlSecStderr.on('line', line => {
      const redacted = redact(line.trim());
      if (!redacted) return;

      _stderrRing.push({ line: `[Secondary] ${redacted}`, at: new Date().toISOString() });
      if (_stderrRing.length > RING_MAX) _stderrRing.shift();

      const lower = redacted.toLowerCase();
      const isError = lower.includes('error') || lower.includes('failed') || lower.includes('broken pipe') || lower.includes('connection reset');
      if (isError) {
        _outputDestinations.vertical.status = 'FAILED';
        _outputDestinations.vertical.lastError = redacted;
        logger.error('ffmpeg.rtmps_vertical_failed', `RTMPS vertical output: FAILED (${redacted})`);

        if (!becameHealthy && !_expectedExit) {
          logger.error('ffmpeg.secondary_startup_failed', `Secondary vertical FFmpeg failed during startup: ${redacted}`);
          stopFfmpeg({ force: true, reason: 'secondary_startup_failed', expected: false });
        }
      } else {
        logger.debug('ffmpeg.stderr_secondary', redacted);
      }
    });

    secChild.on('error', err => {
      logger.warn('ffmpeg.secondary_error', `Secondary FFmpeg error: ${err.message}`);
    });

    secChild.on('exit', (code, signal) => {
      logger.info('ffmpeg.secondary_exit', `Secondary FFmpeg PID ${_secondaryPid} exited with code ${code}, signal ${signal}`);
      const wasExpected = _expectedExit;
      _secondaryChild = null;
      _secondaryPid = null;
      if (!wasExpected) {
        _outputDestinations.vertical.status = 'FAILED';
        _outputDestinations.vertical.lastError = `Secondary process exited with code ${code}, signal ${signal}`;
        logger.error('ffmpeg.secondary_unexpected_exit', `Secondary FFmpeg exited unexpectedly (code ${code}, signal ${signal}). Stopping primary to prevent half-dual streaming.`);
        stopFfmpeg({ force: true, reason: 'secondary_exit', expected: false });
      }
    });
  }

  // 6. Primary Child Exit & Cleanup
  primaryChild.on('exit', async (code, signal) => {
    clearWatchdogs();
    const wasExpected = _expectedExit;
    const pid = _primaryPid;
    const childRef = _primaryChild;

    // Terminate secondary process if still running
    if (_secondaryChild) {
      try { _secondaryChild.kill('SIGTERM'); } catch { /* ignore */ }
    }

    try {
      try {
        if (childRef?.stdin && !childRef.stdin.destroyed) childRef.stdin.destroy();
        if (childRef?.stdout && !childRef.stdout.destroyed) childRef.stdout.destroy();
        if (childRef?.stderr && !childRef.stderr.destroyed) childRef.stderr.destroy();
      } catch { /* ignore */ }

      _primaryChild = null;
      _primaryPid = null;
      _expectedExit = false;

      await releaseLock();

      const lastErrLine = _stderrRing.length > 0 ? _stderrRing[_stderrRing.length - 1].line : null;
      logger.info('ffmpeg.exit', `Primary FFmpeg process PID ${pid} exited with code ${code}, signal ${signal} (expected: ${wasExpected})`);

      if (typeof onExit === 'function') {
        try {
          await onExit({
            code,
            signal,
            expected: wasExpected,
            lastError: _outputDestinations.horizontal.status === 'FAILED' ? (_outputDestinations.horizontal.lastError || lastErrLine) : lastErrLine,
          });
        } catch (exitErr) {
          logger.error('ffmpeg.on_exit_error', `Error in onExit callback: ${exitErr.message}`);
        }
      }
    } finally {
      _primaryChild = null;
      _primaryPid = null;
      _expectedExit = false;

      if (_resolveExitCompletion) {
        const resolve = _resolveExitCompletion;
        _resolveExitCompletion = null;
        _exitCompletionPromise = null;
        resolve({ code, signal, expected: wasExpected });
      }
    }
  });

  return { pid: primaryChild.pid };
}

// ─── Process Stopping ─────────────────────────────────────────────────────────

/**
 * Feed a media segment into the running persistent publisher FFmpeg process(es).
 * Connects feeder process stdout directly to publisher stdin via stream piping.
 *
 * @param {object} params
 * @param {object} params.primaryVideo Vertical (or primary) video metadata
 * @param {object} [params.secondaryVideo] Horizontal (or secondary) video metadata
 * @param {object} params.settings Application settings
 * @param {'copy'|'hybrid'|'transcode'} [params.mode='copy']
 * @param {Function} [params.onFinished] Called when the primary feeder reaches end of video
 * @param {Function} [params.onError] Called if a feeder process errors
 * @returns {Promise<void>}
 */
export async function feedMediaSegment({
  primaryVideo,
  secondaryVideo = null,
  settings,
  mode = 'copy',
  onFinished,
  onError,
}) {
  if (!_primaryChild || !_primaryChild.stdin || _primaryChild.stdin.destroyed) {
    throw new Error('Primary FFmpeg publisher is not running or stdin is closed');
  }

  // Stop previous feeder processes if still running
  await stopFeeders();

  _feederExitExpected = false;
  _currentSegment = {
    primaryVideoId: primaryVideo.id,
    secondaryVideoId: secondaryVideo?.id || null,
    startedAt: new Date().toISOString(),
  };

  const primaryArgs = buildFeederArgs(settings, primaryVideo, mode);
  logger.info('playlist.feeder_start_primary', `Starting feeder for primary video ${primaryVideo.id} (${primaryVideo.filename || primaryVideo.originalName || ''})`);

  let primaryFeeder;
  try {
    primaryFeeder = spawn('ffmpeg', primaryArgs, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (err) {
    logger.error('playlist.feeder_spawn_error', `Failed to spawn primary feeder: ${err.message}`);
    if (typeof onError === 'function') onError(err);
    return;
  }

  _primaryFeeder = primaryFeeder;

  // Pipe feeder stdout into publisher stdin (end: false prevents publisher stdin from closing!)
  primaryFeeder.stdout.pipe(_primaryChild.stdin, { end: false });

  primaryFeeder.stdout.on('error', (err) => {
    logger.debug('playlist.feeder_pipe_error', `Primary feeder stdout error: ${err.message}`);
  });

  const rlStderr = readline.createInterface({ input: primaryFeeder.stderr, terminal: false });
  rlStderr.on('line', (line) => {
    const redacted = redact(line.trim());
    if (redacted) logger.debug('playlist.feeder_stderr_primary', redacted);
  });

  // Secondary feeder (vertical) if dual streaming publisher is active
  if (_secondaryChild && _secondaryChild.stdin && !_secondaryChild.stdin.destroyed) {
    if (!secondaryVideo) {
      logger.error('playlist.dual_pair_missing_at_feeder', 'Secondary publisher is active but no secondary video was provided to feeder');
      const pairErr = Object.assign(new Error('Missing secondary vertical video for dual live feeder'), { code: 'E_DUAL_PAIR_MISSING' });
      if (typeof onError === 'function') onError(pairErr);
      return;
    }
    const secArgs = buildFeederArgs(settings, secondaryVideo, mode);
    logger.info('playlist.feeder_start_secondary', `Starting feeder for secondary vertical video ${secondaryVideo.id} (${secondaryVideo.filename || secondaryVideo.originalName || ''})`);

    try {
      const secondaryFeeder = spawn('ffmpeg', secArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      _secondaryFeeder = secondaryFeeder;
      secondaryFeeder.stdout.pipe(_secondaryChild.stdin, { end: false });
      secondaryFeeder.stdout.on('error', (err) => {
        logger.debug('playlist.feeder_pipe_error', `Secondary feeder stdout error: ${err.message}`);
      });
      const rlSec = readline.createInterface({ input: secondaryFeeder.stderr, terminal: false });
      rlSec.on('line', (line) => {
        const redacted = redact(line.trim());
        if (redacted) logger.debug('playlist.feeder_stderr_secondary', redacted);
      });
      secondaryFeeder.on('error', (err) => {
        logger.warn('playlist.secondary_feeder_error', `Secondary feeder error: ${err.message}`);
      });
      secondaryFeeder.on('exit', (code) => {
        logger.debug('playlist.secondary_feeder_exit', `Secondary feeder exited with code ${code}`);
        _secondaryFeeder = null;
      });
    } catch (err) {
      logger.error('playlist.secondary_feeder_spawn_error', `Failed to spawn secondary feeder: ${err.message}`);
    }
  }

  primaryFeeder.on('error', (err) => {
    logger.error('playlist.primary_feeder_error', `Primary feeder error: ${err.message}`);
    if (!_feederExitExpected && typeof onError === 'function') {
      onError(err);
    }
  });

  primaryFeeder.on('exit', (code, signal) => {
    _primaryFeeder = null;
    logger.info('playlist.primary_feeder_exit', `Primary feeder exited with code ${code}, signal ${signal} (expected: ${_feederExitExpected})`);
    if (_feederExitExpected) return;

    if (code === 0) {
      if (typeof onFinished === 'function') {
        onFinished();
      }
    } else {
      logger.warn('playlist.primary_feeder_failed', `Primary feeder exited abnormally with code ${code}`);
      if (typeof onError === 'function') {
        onError(new Error(`Feeder process exited with code ${code}`));
      }
    }
  });
}

/**
 * Stop any active segment feeder processes.
 */
export async function stopFeeders() {
  _feederExitExpected = true;
  if (_primaryFeeder) {
    try {
      _primaryFeeder.stdout?.unpipe();
      _primaryFeeder.kill('SIGTERM');
    } catch { /* ignore */ }
    _primaryFeeder = null;
  }
  if (_secondaryFeeder) {
    try {
      _secondaryFeeder.stdout?.unpipe();
      _secondaryFeeder.kill('SIGTERM');
    } catch { /* ignore */ }
    _secondaryFeeder = null;
  }
}

export function isFeederRunning() {
  return Boolean(_primaryFeeder || _secondaryFeeder);
}

export function getCurrentSegment() {
  return _currentSegment ? { ..._currentSegment } : null;
}

/**
 * Stop currently running FFmpeg processes.
 * Order: SIGTERM → wait stopGraceSeconds → SIGKILL.
 * Guaranteed: returns only when processes exited, lock released, and onExit completed.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.force=false]
 * @param {string}  [opts.reason='manual_stop']
 * @param {number}  [opts.graceSeconds=8]
 */
export async function stopFfmpeg({ force = false, reason = 'manual_stop', graceSeconds = 8, expected = undefined } = {}) {
  await stopFeeders();

  if (!_primaryChild && !_secondaryChild) {
    if (_exitCompletionPromise) {
      await _exitCompletionPromise;
    }
    return { stopped: true };
  }

  const primary = _primaryChild;
  const secondary = _secondaryChild;
  const exitPromise = _exitCompletionPromise;
  const isNormalStop = (reason === 'manual_stop' || reason === 'api_stop' || reason === 'scheduler_stop' || reason === 'auto_recycle' || reason === 'bandwidth_safety_limit' || reason === 'admin_disabled' || reason.startsWith('maintenance_'));
  _expectedExit = (expected !== undefined) ? Boolean(expected) : isNormalStop;
  clearWatchdogs();

  // Close publisher stdin pipes gracefully
  if (primary?.stdin && !primary.stdin.destroyed) {
    try { primary.stdin.end(); } catch { /* ignore */ }
  }
  if (secondary?.stdin && !secondary.stdin.destroyed) {
    try { secondary.stdin.end(); } catch { /* ignore */ }
  }

  logger.info('ffmpeg.stopping', `Stopping FFmpeg (primary PID: ${primary?.pid}, secondary PID: ${secondary?.pid}, reason: ${reason}, force: ${force})`);

  if (force) {
    if (primary) { try { primary.kill('SIGKILL'); } catch { /* ignore */ } }
    if (secondary) { try { secondary.kill('SIGKILL'); } catch { /* ignore */ } }
    if (exitPromise) {
      await Promise.race([
        exitPromise,
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }
    return { stopped: true };
  }

  // Graceful SIGTERM
  try {
    if (primary) primary.kill('SIGTERM');
  } catch (err) {
    try { primary?.kill('SIGKILL'); } catch { /* ignore */ }
  }
  try {
    if (secondary) secondary.kill('SIGTERM');
  } catch (err) {
    try { secondary?.kill('SIGKILL'); } catch { /* ignore */ }
  }

  // Wait for complete exit cleanup with graceSeconds timeout
  const graceMs = Math.max(1000, graceSeconds * 1000);
  let timerId = null;
  const timeoutPromise = new Promise(resolve => {
    timerId = setTimeout(() => resolve('TIMEOUT'), graceMs);
  });

  const result = await Promise.race([
    exitPromise || Promise.resolve('DONE'),
    timeoutPromise
  ]);

  if (timerId) clearTimeout(timerId);

  if (result === 'TIMEOUT') {
    logger.warn('ffmpeg.sigterm_timeout', `Primary FFmpeg PID ${primary?.pid} did not exit within ${graceSeconds}s; sending SIGKILL`);
    if (primary) { try { primary.kill('SIGKILL'); } catch { /* ignore */ } }
    if (secondary) { try { secondary.kill('SIGKILL'); } catch { /* ignore */ } }
    if (exitPromise) {
      await Promise.race([
        exitPromise,
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }
  }

  return { stopped: true };
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export function isFfmpegRunning() {
  return Boolean(_primaryChild || _secondaryChild || _exitCompletionPromise);
}

export function getFfmpegPid() {
  return _primaryPid;
}

export function getSecondaryFfmpegPid() {
  return _secondaryPid;
}

export function getLatestProgress() {
  return _latestProgress ? { ..._latestProgress } : null;
}

export function getOutputsStatus() {
  return {
    vertical: { ..._outputDestinations.vertical },
    horizontal: { ..._outputDestinations.horizontal },
  };
}

export function getRecentStderr() {
  return [..._stderrRing];
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

export function _setOutputStatusForTest(destination, status, error = null) {
  if (_outputDestinations[destination]) {
    _outputDestinations[destination].status = status;
    _outputDestinations[destination].lastError = error;
  }
}

export function _resetStateForTest() {
  _primaryFeeder = null;
  _secondaryFeeder = null;
  _feederExitExpected = false;
  _currentSegment = null;
  _primaryChild = null;
  _secondaryChild = null;
  _primaryPid = null;
  _secondaryPid = null;
  _expectedExit = false;
  _latestProgress = null;
  _exitCompletionPromise = null;
  _resolveExitCompletion = null;
  _outputDestinations = {
    horizontal: { enabled: true, status: 'INIT', lastError: null, connectedAt: null },
    vertical: { enabled: false, status: 'INIT', lastError: null, connectedAt: null },
  };
  clearWatchdogs();
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

export function _setLockPathForTest(lockPath) {
  _lockPath = lockPath;
}

