/**
 * stream-manager.js — Central state machine, recovery orchestrator, and start/stop authority.
 *
 * PRD §8, §9, §17.1:
 * - The ONLY module permitted to start and stop FFmpeg.
 * - Enforces start-permission precedence (§8.3):
 *     DISABLED → MAINTENANCE → BANDWIDTH_LIMIT_REACHED → PREFLIGHT → SCHEDULER → DESIRED_STATE
 * - State machine: STOPPED, STARTING, RUNNING, RECONNECTING, ERROR, BANDWIDTH_LIMIT_REACHED, DISABLED, SCHEDULED, MAINTENANCE.
 * - Recovery: exponential backoff with jitter, stability timer, slow-retry threshold, circuit breaker.
 * - Mode selection: auto (copy → hybrid → transcode) vs. copy strict vs. transcode.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  spawnFfmpeg,
  stopFfmpeg,
  buildFfmpegArgs,
  isFfmpegRunning,
  getLatestProgress,
} from './ffmpeg-manager.js';
import { getSettings, getStreamKey, getHorizontalStreamKey, isDualStreamEnabled } from './config-manager.js';
import { getState, saveState, appendHistory } from './state-manager.js';
import { getVideo, resolveVideoPath, listVideos, setActiveVideo, findPairedHorizontalVideo, findPairedComplementaryVideo } from './video-manager.js';
import { evaluateCompatibility } from './ffprobe-manager.js';
import { recordProgressBytes, flushUsage } from './usage-manager.js';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

export const streamEvents = new EventEmitter();

// ─── Module State ─────────────────────────────────────────────────────────────

let _backoffTimer      = null;
let _stabilityTimer    = null;
let _slowRetryTimer    = null;
let _streamStartTime   = null;
let _lastSpawnTime     = 0;
const _spawnTimestamps = []; // for circuit breaker (> 30 in 10 min)
let _lastCycleOrder    = []; // active cycle order of { id, duration }
let _currentSessionStartOffset = 0; // seek offset applied at session start

// ─── Helper: Backoff Calculation (PRD §9.2) ──────────────────────────────────

/**
 * Calculate next backoff delay in seconds with jitter.
 *
 * @param {number} consecutiveFailures
 * @param {object} recoveryCfg
 * @returns {number} Delay in seconds (>= 5 s)
 */
export function calculateBackoffDelay(consecutiveFailures, recoveryCfg = {}) {
  const strategy   = recoveryCfg.strategy || 'exponential';
  const base       = recoveryCfg.baseDelaySeconds ?? 10;
  const factor     = recoveryCfg.factor ?? 2;
  const maxDelay   = recoveryCfg.maxDelaySeconds ?? 300;
  const jitterPct  = recoveryCfg.jitterPercent ?? 10;

  const count = Math.max(1, consecutiveFailures);
  let delay = base;

  if (strategy === 'exponential') {
    delay = base * Math.pow(factor, count - 1);
  } else {
    // Linear fallback
    delay = base * count;
  }

  delay = Math.min(delay, maxDelay);

  // Apply jitter (+/- jitterPercent)
  if (jitterPct > 0) {
    const delta = (Math.random() * 2 - 1) * (jitterPct / 100) * delay;
    delay = Math.max(5, delay + delta);
  }

  // Minimum 5 s cooldown between spawns (PRD §9.2)
  return Math.max(5, Math.round(delay));
}

// ─── Circuit Breaker (> 30 spawns in 10 min) ─────────────────────────────────

function checkCircuitBreaker() {
  const now = Date.now();
  _spawnTimestamps.push(now);

  // Keep only timestamps from last 10 minutes
  const tenMinAgo = now - 10 * 60 * 1000;
  while (_spawnTimestamps.length > 0 && _spawnTimestamps[0] < tenMinAgo) {
    _spawnTimestamps.shift();
  }

  if (_spawnTimestamps.length > 30) {
    logger.error('stream.circuit_breaker_tripped', 'Circuit breaker tripped: more than 30 spawn attempts in 10 minutes');
    return true;
  }
  return false;
}

// ─── Pre-flight Gates (PRD §8.3) ─────────────────────────────────────────────

/**
 * Evaluate start-permission precedence.
 * First failing gate wins.
 *
 * @returns {Promise<{ allowed: boolean, reason?: string, code?: string, videoMeta?: object, mode?: string }>}
 */
export async function evaluateStartGates(options = {}) {
  const state    = getState();
  const settings = getSettings();
  const reason   = options.reason || '';
  const isManualStart = (reason === 'api_manual_start' || reason === 'manual_start');

  // 1. Master Kill Switch (DISABLED)
  if (state.disabled) {
    return { allowed: false, code: 'E_DISABLED', reason: 'Streaming is disabled by administrator' };
  }

  // 2. Maintenance Mode
  if (state.maintenance?.active) {
    return { allowed: false, code: 'E_MAINTENANCE', reason: `In maintenance mode (${state.maintenance.source || 'admin'})` };
  }

  // 3. Bandwidth Safety Lock
  if (state.bandwidthLock?.active) {
    return { allowed: false, code: 'E_BW_LIMIT', reason: 'Monthly bandwidth safety limit reached' };
  }

  // 4. YouTube Stream Key Configured
  const streamKey = getStreamKey();
  if (!streamKey) {
    return { allowed: false, code: 'E_KEY_MISSING', reason: 'YouTube stream key is not configured' };
  }

  // 5. Video / Playlist Selected and Valid
  let playlist = settings.stream?.playlist;
  if (!Array.isArray(playlist) || playlist.length === 0) {
    if (settings.stream?.videoId) {
      playlist = [settings.stream.videoId];
    } else {
      const allVideos = await listVideos();
      if (allVideos.length === 1) {
        playlist = [allVideos[0].id];
        await setActiveVideo(allVideos[0].id);
        logger.info('stream.auto_select_single', `Auto-selected sole library video ${allVideos[0].id} for stream start`);
      } else {
        return { allowed: false, code: 'E_NO_VIDEO', reason: 'No video selected for streaming' };
      }
    }
  }

  // Load and validate all videos in playlist
  const playlistMetas = [];
  for (const vId of playlist) {
    const vMeta = await getVideo(vId);
    if (!vMeta) {
      return { allowed: false, code: 'E_VIDEO_NOT_FOUND', reason: `Configured video ${vId} not found in library` };
    }
    const ext = path.extname(vMeta.filename || `${vId}.mp4`);
    const resolvedPath = resolveVideoPath(vId, ext);
    try {
      await fs.access(resolvedPath);
    } catch {
      return { allowed: false, code: 'E_VIDEO_FILE_MISSING', reason: `Video file missing on disk: ${resolvedPath}` };
    }
    vMeta.filePath = resolvedPath;
    playlistMetas.push(vMeta);
  }

  if (playlistMetas.length === 0) {
    return { allowed: false, code: 'E_NO_VIDEO', reason: 'No video selected for streaming' };
  }

  let videoMeta;
  let orderedMetas = [];
  _currentSessionStartOffset = 0;

  if (playlistMetas.length === 1) {
    videoMeta = playlistMetas[0];
    videoMeta.isConcat = false;
    videoMeta.seekOffset = 0;
    const vDur = Number(videoMeta.probe?.durationSec || videoMeta.probe?.duration || 0);
    _lastCycleOrder = [{ id: videoMeta.id, duration: vDur }];
  } else {
    // Multi-video playlist
    orderedMetas = [...playlistMetas];
    const playbackOrder = settings.stream?.playbackOrder || 'sequential';

    if (playbackOrder === 'shuffle') {
      for (let i = orderedMetas.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [orderedMetas[i], orderedMetas[j]] = [orderedMetas[j], orderedMetas[i]];
      }
    }

    _lastCycleOrder = orderedMetas.map(m => ({ id: m.id, duration: Number(m.probe?.durationSec || m.probe?.duration || 0) }));

    const concatLines = ['ffconcat version 1.0'];
    for (const meta of orderedMetas) {
      const normalized = meta.filePath.replace(/\\/g, '/').replace(/'/g, "\\'");
      concatLines.push(`file '${normalized}'`);
    }

    await fs.mkdir(path.dirname(PATHS.loopConcat), { recursive: true });
    await fs.writeFile(PATHS.loopConcat, concatLines.join('\n') + '\n', 'utf8');

    videoMeta = {
      ...orderedMetas[0],
      isConcat: true,
      playlistCount: orderedMetas.length,
      playlistOrder: playbackOrder,
    };
  }

  // 6. Mode Selection Resolution
  const modePref = settings.stream?.modePreference || 'auto';
  const allowTranscode = settings.stream?.allowTranscode !== false;

  let allCompatible = true;
  let allCopyAllowed = true;
  for (const m of playlistMetas) {
    const orient = (m.probe?.width && m.probe?.height)
      ? (m.probe.width > m.probe.height ? 'horizontal' : 'vertical')
      : (m.orientation || 'vertical');
    const c = m.probe ? evaluateCompatibility(m.probe, settings, orient) : (m.compatibility || {});
    if (c.status !== 'COMPATIBLE') {
      allCompatible = false;
    }
    if (!c.modeAllowed?.copy) {
      allCopyAllowed = false;
    }
  }

  const compat = {
    status: allCompatible ? 'COMPATIBLE' : 'NEEDS_TRANSCODE',
    modeAllowed: {
      copy: allCompatible && allCopyAllowed,
      hybrid: allCompatible && !allCopyAllowed,
      transcode: true,
    },
  };

  let selectedMode = 'transcode';

  if (modePref === 'copy') {
    if (compat.status !== 'COMPATIBLE') {
      return {
        allowed: false,
        code: 'E_NEEDS_TRANSCODE',
        reason: playlistMetas.length > 1
          ? 'One or more selected videos require transcoding (not 1080p copy-ready) but copy mode was strictly requested. Switch to Auto or Transcode mode.'
          : 'Source requires transcoding (not 1080p copy-ready) but copy mode was strictly requested. Switch to Auto or Transcode mode.',
      };
    }
    selectedMode = compat.modeAllowed?.copy ? 'copy' : 'hybrid';
  } else if (modePref === 'transcode') {
    if (!allowTranscode) {
      return { allowed: false, code: 'E_TRANSCODE_FORBIDDEN', reason: 'Transcoding is disabled in settings' };
    }
    selectedMode = 'transcode';
  } else {
    // 'auto' mode
    if (compat.status === 'COMPATIBLE') {
      selectedMode = compat.modeAllowed?.copy ? 'copy' : 'hybrid';
    } else {
      if (!allowTranscode) {
        return {
          allowed: false,
          code: 'E_NEEDS_TRANSCODE',
          reason: playlistMetas.length > 1
            ? 'One or more selected videos require transcoding but allowTranscode is disabled'
            : 'Source requires transcoding but allowTranscode is disabled',
        };
      }
      selectedMode = 'transcode';
    }
  }

  // 7. Scheduler Mode Window Check
  if (settings.scheduler?.mode === 'scheduled') {
    // If scheduler says outside window, gate blocks
    if (state.status === 'SCHEDULED' && state.desiredState !== 'running') {
      return { allowed: false, code: 'E_SCHEDULED', reason: 'Outside scheduled streaming window' };
    }
  }

  // 8. Desired State
  if (state.desiredState !== 'running') {
    return { allowed: false, code: 'E_DESIRED_STOPPED', reason: 'Desired state is stopped' };
  }

  // 9. Dual Stream Resolution (Shorts Vertical + Normal Horizontal)
  let horizontalMeta = null;
  let dualTarget = null;
  const horizontalKey = getHorizontalStreamKey();
  const dualEnabled = isDualStreamEnabled();

  if (dualEnabled && horizontalKey && horizontalKey.trim()) {
    const allVideos = await listVideos();
    const rtmpsUrl = settings.youtube?.rtmpsUrl || 'rtmps://a.rtmps.youtube.com:443/live2';

    if (playlistMetas.length === 1) {
      const pairedH = findPairedComplementaryVideo(playlistMetas[0], allVideos);
      if (pairedH) {
        const hExt = path.extname(pairedH.filename || `${pairedH.id}.mp4`);
        const resolvedHPath = resolveVideoPath(pairedH.id, hExt);
        try {
          await fs.access(resolvedHPath);
          horizontalMeta = {
            ...pairedH,
            filePath: resolvedHPath,
            isConcat: false,
            seekOffset: 0,
          };
          dualTarget = `${rtmpsUrl}/${horizontalKey.trim()}`;
          logger.info('stream.dual_stream_paired', `Dual streaming enabled: Paired primary ${playlistMetas[0].id} with complementary ${pairedH.id}`);
        } catch {
          logger.warn('stream.dual_stream_file_missing', `Paired complementary video file missing: ${resolvedHPath}; streaming primary only`);
        }
      } else {
        logger.info('stream.dual_stream_no_pair', 'Secondary stream key configured, but no matching complementary video found. Streaming primary only.');
      }
    } else {
      // Multi-video playlist: find paired complementary video for each
      const horizontalMap = new Map();
      let allPaired = true;

      for (const vMeta of playlistMetas) {
        const pairedH = findPairedComplementaryVideo(vMeta, allVideos);
        if (!pairedH) {
          allPaired = false;
          break;
        }
        const hExt = path.extname(pairedH.filename || `${pairedH.id}.mp4`);
        const resolvedHPath = resolveVideoPath(pairedH.id, hExt);
        try {
          await fs.access(resolvedHPath);
          horizontalMap.set(vMeta.id, { ...pairedH, filePath: resolvedHPath });
        } catch {
          allPaired = false;
          break;
        }
      }

      if (allPaired && horizontalMap.size === playlistMetas.length) {
        // Build loop_horizontal.ffconcat in same order as orderedMetas
        const concatLines = ['ffconcat version 1.0'];
        for (const meta of orderedMetas) {
          const hMeta = horizontalMap.get(meta.id);
          const normH = hMeta.filePath.replace(/\\/g, '/').replace(/'/g, "\\'");
          concatLines.push(`file '${normH}'`);
        }

        await fs.mkdir(path.dirname(PATHS.loopConcatHorizontal), { recursive: true });
        await fs.writeFile(PATHS.loopConcatHorizontal, concatLines.join('\n') + '\n', 'utf8');

        horizontalMeta = {
          ...firstH,
          filePath: PATHS.loopConcatHorizontal,
          isConcat: true,
          playlistCount: orderedMetas.length,
        };
        dualTarget = `${rtmpsUrl}/${horizontalKey.trim()}`;
        logger.info('stream.dual_stream_playlist_paired', `Dual streaming enabled for playlist: paired ${orderedMetas.length} horizontal videos`);
      } else {
        logger.warn('stream.dual_stream_playlist_partial', 'Not all playlist videos have matching horizontal videos. Streaming vertical only.');
      }
    }
  }

  return {
    allowed: true,
    videoMeta,
    mode: selectedMode,
    horizontalMeta,
    dualTarget,
  };
}

// ─── State Machine Transitions ────────────────────────────────────────────────

export async function transitionState(to, reason = '') {
  const prev = getState().status;
  if (prev === to) return;

  logger.info('stream.state_change', `Stream state changed: ${prev} → ${to} (${reason})`, {
    from: prev,
    to,
    reason,
  });

  await saveState({ status: to });
  streamEvents.emit('state', { from: prev, to, reason });
}

// ─── Stream Starting & FFmpeg Execution ──────────────────────────────────────

/**
 * Attempt to start the live stream.
 *
 * @param {object} [opts]
 * @param {string} [opts.reason='manual_start']
 */
export async function startStream({ reason = 'manual_start', clearMaintenance = false } = {}) {
  logger.info('stream.start_requested', `Stream start requested (reason: ${reason})`);
  // Clear any pending timers
  if (_backoffTimer)   { clearTimeout(_backoffTimer);   _backoffTimer = null; }
  if (_slowRetryTimer) { clearTimeout(_slowRetryTimer); _slowRetryTimer = null; }

  // If manual start requested, auto-clear maintenance mode and recycle pause
  if (clearMaintenance || reason === 'api_manual_start' || reason === 'manual_start') {
    const currentState = getState();
    if (currentState.maintenance?.active) {
      logger.info('stream.maintenance_auto_cleared', `Manual stream start (${reason}); auto-clearing maintenance mode`);
      await setMaintenance(false, 'manual_start');
    }
    if (currentState.recyclingUntil) {
      logger.info('stream.recycle_pause_cleared', `Manual stream start (${reason}); clearing VOD recycle pause`);
      await saveState({ recyclingUntil: null });
    }
  }

  // Set desired state to running
  await saveState({ desiredState: 'running' });

  // Gate evaluation
  const gate = await evaluateStartGates({ reason });
  if (!gate.allowed) {
    logger.warn('stream.start_blocked', `Stream start blocked: ${gate.reason} (${gate.code})`);
    if (gate.code === 'E_SCHEDULED') {
      await transitionState('SCHEDULED', gate.reason);
    } else if (gate.code === 'E_BW_LIMIT') {
      await transitionState('BANDWIDTH_LIMIT_REACHED', gate.reason);
    } else if (gate.code === 'E_DISABLED') {
      await transitionState('DISABLED', gate.reason);
    } else if (gate.code === 'E_MAINTENANCE') {
      await transitionState('MAINTENANCE', gate.reason);
    } else {
      await transitionState('ERROR', gate.reason);
      await saveState({ lastError: { code: gate.code, message: gate.reason, at: new Date().toISOString() } });
    }
    return { started: false, code: gate.code, message: gate.reason };
  }

  // Check cooldown & circuit breaker
  const now = Date.now();
  if (now - _lastSpawnTime < 5000) {
    const waitMs = 5000 - (now - _lastSpawnTime);
    logger.info('stream.cooldown_wait', `Enforcing 5s cooldown; waiting ${waitMs} ms before spawn`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  _lastSpawnTime = Date.now();

  if (checkCircuitBreaker()) {
    await transitionState('ERROR', 'Circuit breaker tripped');
    return { started: false, code: 'E_CIRCUIT_BREAKER', message: 'Too many restarts in short period' };
  }

  await transitionState('STARTING', reason);

  const settings = getSettings();
  const secretKey = getStreamKey();

  // Hard guard: ensure key and RTMPS URL are both present before spawning
  const rtmpsUrl = settings.youtube?.rtmpsUrl;
  if (!secretKey || !secretKey.trim()) {
    logger.error('stream.key_empty', 'Stream key is empty at spawn time — aborting FFmpeg spawn');
    await transitionState('ERROR', 'YouTube stream key is empty');
    await saveState({ lastError: { code: 'E_KEY_MISSING', message: 'YouTube stream key is not configured', at: new Date().toISOString() } });
    return { started: false, code: 'E_KEY_MISSING', message: 'YouTube stream key is not configured' };
  }
  if (!rtmpsUrl || !rtmpsUrl.startsWith('rtmps://')) {
    logger.error('stream.url_invalid', `Invalid RTMPS URL at spawn time: ${rtmpsUrl}`);
    await transitionState('ERROR', 'RTMPS URL is missing or invalid');
    await saveState({ lastError: { code: 'E_CONFIG_INVALID', message: 'RTMPS URL must start with rtmps://', at: new Date().toISOString() } });
    return { started: false, code: 'E_CONFIG_INVALID', message: 'RTMPS URL must start with rtmps://' };
  }

  const destUrl = `${rtmpsUrl}/${secretKey.trim()}`;

  const args = buildFfmpegArgs(
    settings,
    gate.videoMeta,
    destUrl,
    gate.mode,
    gate.dualTarget,
    gate.horizontalMeta
  );

  try {
    const { pid } = await spawnFfmpeg({
      args,
      settings,
      onProgress: (p) => {
        const overhead = settings.bandwidth?.overheadPercent ?? 10;
        recordProgressBytes(p.total_size, 1, overhead);
      },
      onHealthy: async () => {
        _streamStartTime = Date.now();
        await transitionState('RUNNING', 'FFmpeg healthy output detected');
        logger.info('stream.stream_running', `Stream is now RUNNING with FFmpeg PID ${pid}`);
        await saveState({
          streamMode: gate.mode,
          activeVideoId: gate.videoMeta.id,
          ffmpegPid: pid,
          streamStartedAt: new Date().toISOString(),
          currentSeekOffset: 0,
          isDualStream: Boolean(gate.dualTarget && gate.horizontalMeta),
          pairedHorizontalVideoId: gate.horizontalMeta?.id || null,
          resumeBookmark: null,
          lastError: null,
        });
        await appendHistory({
          event: 'start',
          mode: gate.mode,
          videoId: gate.videoMeta.id,
          pid,
          isDualStream: Boolean(gate.dualTarget && gate.horizontalMeta),
        });

        // Start stability timer
        const stableSec = settings.recovery?.stableAfterSeconds ?? 120;
        if (_stabilityTimer) clearTimeout(_stabilityTimer);
        _stabilityTimer = setTimeout(async () => {
          logger.info('stream.stable', `Stream has run stably for ${stableSec}s; resetting failure counter`);
          await saveState({ consecutiveFailures: 0 });
        }, stableSec * 1000);
      },
      onExit: async ({ code, signal, expected, lastError }) => {
        if (_stabilityTimer) { clearTimeout(_stabilityTimer); _stabilityTimer = null; }
        await flushUsage({ force: true });

        const durationSec = _streamStartTime ? Math.round((Date.now() - _streamStartTime) / 1000) : 0;
        _streamStartTime = null;

        await saveState({
          ffmpegPid: null,
          streamStartedAt: null,
          isDualStream: false,
          pairedHorizontalVideoId: null,
          lastExit: { code, signal, at: new Date().toISOString() },
        });

        await appendHistory({
          event: 'exit',
          code,
          signal,
          expected,
          durationSec,
          lastError,
          isDualStream: false,
        });

        if (expected) {
          const desired = getState().desiredState;
          if (desired === 'stopped') {
            await transitionState('STOPPED', 'FFmpeg stopped as requested');
          }
        } else {
          // Unexpected exit → trigger recovery
          await handleUnexpectedExit({ code, signal, lastError });
        }
      },
    });

    // Update restart counters
    const st = getState();
    await saveState({
      restartCountSession: (st.restartCountSession || 0) + 1,
      restartCountTotal:   (st.restartCountTotal || 0) + 1,
      ffmpegPid: pid,
    });

    return {
      started: true,
      pid,
      mode: gate.mode,
      isDualStream: Boolean(gate.dualTarget && gate.horizontalMeta),
    };
  } catch (err) {
    logger.error('stream.spawn_failed', `Failed to spawn FFmpeg: ${err.message}`);
    await transitionState('ERROR', err.message);
    await saveState({
      lastError: { code: err.code || 'E_SPAWN_FAILED', message: err.message, at: new Date().toISOString() },
    });
    return { started: false, code: err.code || 'E_SPAWN_FAILED', message: err.message };
  }
}

// ─── Bookmark & Resume Calculation ──────────────────────────────────────────

/**
 * Compute bookmark position for resuming playback on next session.
 *
 * @param {number} sessionElapsedSec
 * @returns {Promise<{ type: 'single'|'playlist', videoId: string, offsetSec: number, at: string }|null>}
 */
export async function computeResumeBookmark(sessionElapsedSec) {
  const settings = getSettings();
  const playlist = settings.stream?.playlist || [];
  const primaryId = settings.stream?.videoId;
  const startOffset = _currentSessionStartOffset || 0;
  const totalElapsed = startOffset + Math.max(0, sessionElapsedSec);

  if (playlist.length <= 1) {
    const vidId = primaryId || playlist[0];
    if (!vidId) return null;
    const video = await getVideo(vidId);
    const duration = Number(video?.probe?.durationSec || video?.probe?.duration || 0);
    const offsetSec = duration > 0 ? (totalElapsed % duration) : 0;
    return {
      type: 'single',
      videoId: vidId,
      offsetSec: Math.max(0, Math.floor(offsetSec)),
      at: new Date().toISOString(),
    };
  }

  // Multi-video playlist: find which video was playing and the offset
  const allVideos = await listVideos();
  const videoMap = new Map(allVideos.map(v => [v.id, v]));

  const playlistIds = new Set(playlist);
  const cycleOrderValid = Array.isArray(_lastCycleOrder) &&
    _lastCycleOrder.length === playlist.length &&
    _lastCycleOrder.every(item => playlistIds.has(item.id));

  const orderMetas = cycleOrderValid
    ? _lastCycleOrder
    : playlist.map(id => {
        const v = videoMap.get(id);
        return { id, duration: Number(v?.probe?.durationSec || v?.probe?.duration || 0) };
      });

  let totalCycleDuration = 0;
  for (const item of orderMetas) {
    totalCycleDuration += (item.duration || 0);
  }

  if (totalCycleDuration <= 0) {
    return {
      type: 'playlist',
      videoId: orderMetas[0]?.id || primaryId,
      offsetSec: 0,
      at: new Date().toISOString(),
    };
  }

  const cyclePos = totalElapsed % totalCycleDuration;
  let cum = 0;
  let activeItem = orderMetas[0];
  let itemOffset = 0;

  for (const item of orderMetas) {
    const dur = item.duration || 0;
    if (cyclePos >= cum && cyclePos < cum + dur) {
      activeItem = item;
      itemOffset = cyclePos - cum;
      break;
    }
    cum += dur;
  }

  return {
    type: 'playlist',
    videoId: activeItem.id,
    offsetSec: Math.max(0, Math.floor(itemOffset)),
    at: new Date().toISOString(),
  };
}

// ─── Stopping Stream ──────────────────────────────────────────────────────────

/**
 * Stop the live stream.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.keepDesiredRunning=false]  If true, desiredState stays 'running' (e.g. for restart/reload)
 * @param {string}  [opts.reason='manual_stop']
 */
export async function stopStream({ keepDesiredRunning = false, reason = 'manual_stop' } = {}) {
  if (_backoffTimer)   { clearTimeout(_backoffTimer);   _backoffTimer = null; }
  if (_stabilityTimer) { clearTimeout(_stabilityTimer); _stabilityTimer = null; }
  if (_slowRetryTimer) { clearTimeout(_slowRetryTimer); _slowRetryTimer = null; }

  const settings = getSettings();
  logger.info('stream.stop', `Stop requested (${reason}); stream will start from 00:00 on next run`);
  _currentSessionStartOffset = 0;

  await saveState({
    ...(keepDesiredRunning ? {} : { desiredState: 'stopped' }),
    streamStartedAt: null,
    isDualStream: false,
    pairedHorizontalVideoId: null,
    resumeBookmark: null,
    currentSeekOffset: 0,
  });

  const graceSec = settings.stream?.stopGraceSeconds ?? 8;

  await stopFfmpeg({ force: false, reason, graceSeconds: graceSec });
  await flushUsage({ force: true });

  if (!keepDesiredRunning) {
    await transitionState('STOPPED', reason);
  }

  return { stopped: true };
}

// ─── Unexpected Exit & Recovery (PRD §9) ──────────────────────────────────────

async function handleUnexpectedExit({ code, signal, lastError }) {
  const state    = getState();
  const settings = getSettings();

  // If desired state is stopped, do not recover
  if (state.desiredState === 'stopped') {
    await transitionState('STOPPED', 'FFmpeg exited and desired state is stopped');
    return;
  }

  // Clear any pending resume bookmark on unexpected crash so retry starts clean
  if (state.resumeBookmark) {
    logger.warn('stream.resume_bookmark_dropped', 'Stream exited unexpectedly; clearing bookmark to prevent looping seek errors');
    await saveState({ resumeBookmark: null });
    _currentSessionStartOffset = 0;
  }

  // Increment failure count
  const failures = (state.consecutiveFailures || 0) + 1;
  await saveState({
    consecutiveFailures: failures,
    lastError: {
      code: 'E_PROCESS_EXIT',
      message: `Process exited with code ${code}, signal ${signal}: ${lastError || ''}`,
      at: new Date().toISOString(),
    },
  });

  const recoveryCfg = settings.recovery || {};
  const maxFailures = recoveryCfg.maxConsecutiveFailures ?? 20;

  if (failures > maxFailures) {
    logger.warn('stream.threshold_exceeded', `Consecutive failures (${failures}) exceeded max (${maxFailures})`);

    if (recoveryCfg.onThresholdExceeded === 'slow_retry') {
      await transitionState('ERROR', 'Failure threshold exceeded; slow retry armed');
      const cooldownSec = recoveryCfg.slowRetryCooldownSeconds ?? 600;
      logger.info('stream.slow_retry_armed', `Retrying in ${cooldownSec}s (slow-retry mode)`);

      _slowRetryTimer = setTimeout(async () => {
        logger.info('stream.slow_retry_trigger', 'Slow-retry timer fired; attempting restart');
        await startStream({ reason: 'slow_retry' });
      }, cooldownSec * 1000);
    } else {
      await transitionState('ERROR', 'Failure threshold exceeded; waiting for manual start');
      await saveState({ desiredState: 'stopped' });
    }
    return;
  }

  // Normal exponential backoff
  await transitionState('RECONNECTING', `Failure ${failures}/${maxFailures}`);
  const delaySec = calculateBackoffDelay(failures, recoveryCfg);
  logger.info('stream.reconnecting', `Waiting ${delaySec}s before reconnection attempt`);

  _backoffTimer = setTimeout(async () => {
    logger.info('stream.backoff_elapsed', 'Backoff elapsed; attempting restart');
    await startStream({ reason: 'recovery_reconnect' });
  }, delaySec * 1000);
}

// ─── Bandwidth Limit Shutdown Trigger (PRD §7.6) ──────────────────────────────

/**
 * Triggered by bandwidth-monitor when monthly limit is reached.
 */
export async function triggerBandwidthSafetyStop() {
  logger.error('stream.bandwidth_lock_engaged', 'Bandwidth safety lock engaged; shutting down FFmpeg');
  await stopStream({ keepDesiredRunning: false, reason: 'bandwidth_safety_limit' });
  await transitionState('BANDWIDTH_LIMIT_REACHED', 'Monthly bandwidth safety limit reached');
}

// ─── Master Kill Switch & Maintenance ────────────────────────────────────────

export async function setDisabled(disabled) {
  await saveState({ disabled: Boolean(disabled) });
  if (disabled) {
    await stopStream({ keepDesiredRunning: false, reason: 'admin_disabled' });
    await transitionState('DISABLED', 'Streaming disabled by administrator');
  } else {
    const st = getState();
    if (st.status === 'DISABLED') {
      await transitionState('STOPPED', 'Streaming re-enabled by administrator');
    }
  }
}

export async function setMaintenance(active, source = 'admin') {
  const m = active ? { active: true, source, since: new Date().toISOString() } : null;
  await saveState({ maintenance: m });
  if (active) {
    await stopStream({ keepDesiredRunning: false, reason: `maintenance_${source}` });
    await transitionState('MAINTENANCE', `Maintenance mode set by ${source}`);
  } else {
    const st = getState();
    if (st.status === 'MAINTENANCE') {
      await transitionState('STOPPED', 'Maintenance mode cleared');
    }
  }
}

export async function clearConfigGateError() {
  const state = getState();
  const configErrors = [
    'E_NEEDS_TRANSCODE', 'E_KEY_MISSING', 'E_NO_VIDEO',
    'E_TRANSCODE_FORBIDDEN', 'E_CONFIG_INVALID',
    'E_VIDEO_NOT_FOUND', 'E_VIDEO_FILE_MISSING',
  ];
  if (state.status === 'ERROR' && state.lastError && configErrors.includes(state.lastError.code)) {
    await saveState({ lastError: null });
    await transitionState('STOPPED', 'Configuration updated; cleared pre-flight error');

    // Auto-retry if stream was desired
    if (state.desiredState === 'running') {
      logger.info('stream.config_cleared_retry', 'Config gate cleared; auto-retrying stream start');
      setTimeout(() => {
        startStream({ reason: 'config_gate_cleared' }).catch(e => {
          logger.warn('stream.config_cleared_retry_fail', e.message);
        });
      }, 1000);
    }
  }
}

export function getCurrentSeekOffset() {
  return _currentSessionStartOffset || 0;
}
