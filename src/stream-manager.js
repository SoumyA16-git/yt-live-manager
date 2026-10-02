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
import { getSettings, getStreamKey } from './config-manager.js';
import { getState, saveState, appendHistory } from './state-manager.js';
import { getVideo, resolveVideoPath, listVideos, setActiveVideo } from './video-manager.js';
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
export async function evaluateStartGates() {
  const state    = getState();
  const settings = getSettings();

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

  // 5. Video Selected and Valid
  let videoId = settings.stream?.videoId;
  if (!videoId) {
    const allVideos = await listVideos();
    if (allVideos.length === 1) {
      videoId = allVideos[0].id;
      await setActiveVideo(videoId);
      logger.info('stream.auto_select_single', `Auto-selected sole library video ${videoId} for stream start`);
    } else {
      return { allowed: false, code: 'E_NO_VIDEO', reason: 'No video selected for streaming' };
    }
  }

  const videoMeta = await getVideo(videoId);
  if (!videoMeta) {
    return { allowed: false, code: 'E_VIDEO_NOT_FOUND', reason: `Configured video ${videoId} not found in library` };
  }

  const ext = path.extname(videoMeta.filename || `${videoId}.mp4`);
  const resolvedPath = resolveVideoPath(videoId, ext);
  try {
    await fs.access(resolvedPath);
  } catch {
    return { allowed: false, code: 'E_VIDEO_FILE_MISSING', reason: `Video file missing on disk: ${resolvedPath}` };
  }

  videoMeta.filePath = resolvedPath;

  // 6. Mode Selection Resolution
  const modePref = settings.stream?.modePreference || 'auto';
  const compat = videoMeta.compatibility || {};
  const allowTranscode = settings.stream?.allowTranscode !== false;
  let selectedMode = 'transcode';

  if (modePref === 'copy') {
    if (compat.status !== 'COMPATIBLE') {
      return {
        allowed: false,
        code: 'E_NEEDS_TRANSCODE',
        reason: 'Source requires transcoding (not 1080p copy-ready) but copy mode was strictly requested. Switch to Auto or Transcode mode.',
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
        return { allowed: false, code: 'E_NEEDS_TRANSCODE', reason: 'Source requires transcoding but allowTranscode is disabled' };
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

  return {
    allowed: true,
    videoMeta,
    mode: selectedMode,
  };
}

// ─── State Machine Transitions ────────────────────────────────────────────────

async function transitionState(to, reason = '') {
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
  // Clear any pending timers
  if (_backoffTimer)   { clearTimeout(_backoffTimer);   _backoffTimer = null; }
  if (_slowRetryTimer) { clearTimeout(_slowRetryTimer); _slowRetryTimer = null; }

  // If manual start requested, auto-clear maintenance mode
  if (clearMaintenance || reason === 'api_manual_start' || reason === 'manual_start') {
    const currentState = getState();
    if (currentState.maintenance?.active) {
      logger.info('stream.maintenance_auto_cleared', `Manual stream start (${reason}); auto-clearing maintenance mode`);
      await setMaintenance(false, 'manual_start');
    }
  }

  // Set desired state to running
  await saveState({ desiredState: 'running' });

  // Gate evaluation
  const gate = await evaluateStartGates();
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

  const args = buildFfmpegArgs(settings, gate.videoMeta, destUrl, gate.mode);

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
        await saveState({
          streamMode: gate.mode,
          activeVideoId: gate.videoMeta.id,
          ffmpegPid: pid,
          streamStartedAt: new Date().toISOString(),
        });
        await appendHistory({ event: 'start', mode: gate.mode, videoId: gate.videoMeta.id, pid });

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
          lastExit: { code, signal, at: new Date().toISOString() },
        });

        await appendHistory({
          event: 'exit',
          code,
          signal,
          expected,
          durationSec,
          lastError,
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

    return { started: true, pid, mode: gate.mode };
  } catch (err) {
    logger.error('stream.spawn_failed', `Failed to spawn FFmpeg: ${err.message}`);
    await transitionState('ERROR', err.message);
    await saveState({
      lastError: { code: err.code || 'E_SPAWN_FAILED', message: err.message, at: new Date().toISOString() },
    });
    return { started: false, code: err.code || 'E_SPAWN_FAILED', message: err.message };
  }
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

  if (!keepDesiredRunning) {
    await saveState({ desiredState: 'stopped' });
  }

  const settings = getSettings();
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
