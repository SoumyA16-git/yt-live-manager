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
  buildPublisherArgs,
  buildFeederArgs,
  feedMediaSegment,
  stopFeeders,
  isFfmpegRunning,
  getFfmpegPid,
  getLatestProgress,
} from './ffmpeg-manager.js';
import { getSettings, loadSettings, getStreamKey } from './config-manager.js';
import { getState, saveState, appendHistory } from './state-manager.js';
import {
  getVideo,
  resolveVideoPath,
  listVideos,
  setActiveVideo,
  getFreshPlayablePlaylist,
  triggerRandomPlaylistSelection,
} from './video-manager.js';
import { evaluateCompatibility } from './ffprobe-manager.js';
import { recordProgressBytes, flushUsage, resetProcessBaseline } from './usage-manager.js';
import { logger } from './logger.js';
import { isInsideWindow } from './scheduler.js';
import { prepareYouTubeStudioStream } from './youtube-studio-automator.js';
import PATHS from './lib/paths.js';

export const streamEvents = new EventEmitter();

// ─── Module State ─────────────────────────────────────────────────────────────

let _backoffTimer      = null;
let _stabilityTimer    = null;
let _slowRetryTimer    = null;
let _autoRecycleTimer  = null; // dedicated timer for active stream session duration
let _autoResumeTimer   = null; // dedicated timer for pause countdown auto-resume
let _streamStartTime   = null;
let _lastSpawnTime     = 0;
const _spawnTimestamps = []; // for circuit breaker (> 30 in 10 min)
let _lastCycleOrder    = []; // active cycle order of { id, duration }
let _currentSessionStartOffset = 0; // seek offset applied at session start
let _startInProgress   = false; // re-entrancy mutex for startStream
let _stopInProgressPromise = null; // completion barrier for stopStream
let _lastStreamStopTime = 0; // timestamp when stream was completely stopped
let _lastProgressTimestamp = null;

export function getCurrentLifecyclePromise() {
  return null;
}

export function getAutoRecycleTimers() {
  return {
    hasRecycleTimer: Boolean(_autoRecycleTimer),
    hasResumeTimer: Boolean(_autoResumeTimer),
  };
}

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
  const isAutoRecycleResume = (reason === 'auto_recycle_resume');

  // 0. Auto-Recycle Pause Check
  if (state.recyclingUntil) {
    const untilMs = new Date(state.recyclingUntil).getTime();
    if (Date.now() < untilMs && !isManualStart && !isAutoRecycleResume) {
      return { allowed: false, code: 'E_RECYCLING_PAUSE', reason: 'Stream is in auto-recycle pause' };
    }
  }

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

  // 4. YouTube Stream Key Configured (Single Canonical Key)
  const streamMode = (settings.stream?.mode || 'horizontal').toLowerCase();
  const streamKey = (getStreamKey() || settings.youtube?.streamKey || '').trim();
  if (!streamKey) {
    return {
      allowed: false,
      code: 'E_KEY_MISSING',
      reason: `Default YouTube stream key is not configured for ${streamMode === 'horizontal' ? 'Horizontal (16:9)' : 'Vertical (9:16)'} mode. Please configure the default YouTube Stream Key in Settings.`,
    };
  }

  // 5. Video / Mode-Specific Playlist Selected and Valid
  const modePlaylists = settings.stream?.playlists;
  let playlist = (modePlaylists && Array.isArray(modePlaylists[streamMode]) && modePlaylists[streamMode].length > 0)
    ? modePlaylists[streamMode]
    : (Array.isArray(settings.stream?.playlist) ? settings.stream.playlist : []);

  if (!Array.isArray(playlist) || playlist.length === 0) {
    if (settings.stream?.videoId) {
      playlist = [settings.stream.videoId];
    } else {
      return {
        allowed: false,
        code: 'E_PLAYLIST_EMPTY',
        reason: `${streamMode === 'horizontal' ? 'Horizontal' : 'Vertical'} playlist is empty`,
      };
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

    // Strict orientation validation
    const isHoriz = (vMeta.probe?.width || 0) >= (vMeta.probe?.height || 0);
    if (streamMode === 'horizontal' && !isHoriz) {
      return {
        allowed: false,
        code: 'E_HORIZONTAL_VIDEO_REQUIRED',
        reason: `Video ${vId} is vertical (9:16) but stream mode is Horizontal (16:9).`,
      };
    }
    if (streamMode === 'vertical' && isHoriz) {
      return {
        allowed: false,
        code: 'E_VERTICAL_VIDEO_REQUIRED',
        reason: `Video ${vId} is horizontal (16:9) but stream mode is Vertical (9:16).`,
      };
    }

    playlistMetas.push(vMeta);
  }

  if (playlistMetas.length === 0) {
    return {
      allowed: false,
      code: 'E_PLAYLIST_EMPTY',
      reason: `${streamMode === 'horizontal' ? 'Horizontal' : 'Vertical'} playlist is empty`,
    };
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
      const getMetaTime = (m) => {
        if (m.uploadedAt) {
          const t = new Date(m.uploadedAt).getTime();
          if (!isNaN(t) && t > 0) return t;
        }
        if (m.mtimeMs && !isNaN(Number(m.mtimeMs))) {
          return Number(m.mtimeMs);
        }
        return 0;
      };

      const sorted = [...playlistMetas].sort((a, b) => getMetaTime(b) - getMetaTime(a));
      const newest = sorted[0];
      const remaining = playlistMetas.filter(m => m.id !== newest.id);

      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      orderedMetas = [newest, ...remaining];
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
    const c = m.probe
      ? evaluateCompatibility(m.probe, settings, orient, { allowDirectCopy: Boolean(m.isDirectCopy || m.isYoutubeDirect) })
      : (m.compatibility || {});
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
    if (!isManualStart) {
      const tz = settings.scheduler?.timezone || 'Asia/Kolkata';
      const windows = settings.scheduler?.windows || [];
      if (!isInsideWindow(new Date(), windows, tz)) {
        return { allowed: false, code: 'E_SCHEDULED', reason: 'Outside scheduled streaming window' };
      }
    }
    // If scheduler says outside window, gate blocks
    if (state.status === 'SCHEDULED' && state.desiredState !== 'running' && !isManualStart) {
      return { allowed: false, code: 'E_SCHEDULED', reason: 'Outside scheduled streaming window' };
    }
  }

  // 8. Desired State
  if (state.desiredState !== 'running' && !isManualStart) {
    return { allowed: false, code: 'E_DESIRED_STOPPED', reason: 'Desired state is stopped' };
  }

  // 9. Single Stream Resolution for Active Mode
  const rtmpsUrl = settings.youtube?.rtmpsUrl || 'rtmps://a.rtmps.youtube.com:443/live2';
  const destUrl = `${rtmpsUrl}/${streamKey.trim()}`;

  return {
    allowed: true,
    videoMeta,
    mode: selectedMode,
    streamMode,
    streamKey,
    destUrl,
    verticalMeta: null,
    horizontalMeta: null,
    dualTarget: null,
    isDualStream: false,
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

// ─── Hot-Sync Segment Transition ─────────────────────────────────────────────

let _transitionInProgress = false;

/**
 * Transition-aware logical video completion handler.
 * Called when the current video reaches its end.
 * Performs a fresh reload of the playlist, selects the next item in active mode,
 * and feeds it seamlessly into the still-open publisher pipe without interrupting
 * the YouTube RTMPS connection.
 *
 * @param {'copy'|'hybrid'|'transcode'} [mode='copy']
 */
export async function handleSegmentFinished(mode = 'copy') {
  if (!isFfmpegRunning()) return;
  if (_transitionInProgress) return;
  _transitionInProgress = true;

  try {
    const currentState = getState();
    const finishedId = currentState.currentLogicalVideoId;
    logger.info('playlist.current_video_finished', `Video finished playback: ${finishedId}`, {
      videoId: finishedId,
    });

    // 1. Read the latest playlist configuration from persistent storage and video library state
    const latestSettings = await loadSettings();
    const allVideos = await listVideos();

    // 2. Fresh reload of mode-specific playable playlist
    const freshPlaylist = await getFreshPlayablePlaylist(latestSettings, allVideos);
    logger.info('playlist.fresh_reload', `Fresh playlist reloaded at boundary with ${freshPlaylist.length} playable items`, {
      itemCount: freshPlaylist.length,
    });

    if (freshPlaylist.length === 0) {
      logger.error('playlist.no_playable_items', 'No playable items available in fresh playlist');
      return;
    }

    // 3. Respect the existing playback order mode (sequential, serial, or shuffle)
    const playbackOrder = (latestSettings.stream?.playbackOrder || 'sequential').toLowerCase();
    let nextLogical = null;

    if (playbackOrder === 'shuffle') {
      if (freshPlaylist.length === 1) {
        nextLogical = freshPlaylist[0];
      } else {
        const candidates = freshPlaylist.filter(item => item.id !== finishedId);
        const pool = candidates.length > 0 ? candidates : freshPlaylist;
        const randomIndex = Math.floor(Math.random() * pool.length);
        nextLogical = pool[randomIndex];
      }
    } else {
      // Sequential / Serial ordering: find current index and advance to next
      const currentIndex = freshPlaylist.findIndex(item => item.id === finishedId);
      const nextIndex = (currentIndex >= 0 && currentIndex + 1 < freshPlaylist.length) ? (currentIndex + 1) : 0;
      nextLogical = freshPlaylist[nextIndex];
    }

    if (!nextLogical) {
      nextLogical = freshPlaylist[0];
    }

    const streamMode = (latestSettings.stream?.mode || 'horizontal').toLowerCase();
    const primaryVideo = nextLogical.horizontal || nextLogical.vertical || nextLogical;

    if (!primaryVideo) {
      logger.warn('playlist.item_missing', `Selected item ${nextLogical.id} missing playable video; skipping to next`, {
        videoId: nextLogical.id,
      });
      setTimeout(() => handleSegmentFinished(mode), 50);
      return;
    }

    logger.info('playlist.next_video_selected', `Selected next video: ${primaryVideo.id} (${streamMode})`, {
      videoId: primaryVideo.id,
      streamMode,
    });

    logger.info('playlist.transition_started', `Transitioning live stream to video ${primaryVideo.id}`);

    await saveState({
      currentLogicalVideoId: primaryVideo.id,
      currentHorizontalVideoId: streamMode === 'horizontal' ? primaryVideo.id : null,
      currentVerticalVideoId: streamMode === 'vertical' ? primaryVideo.id : null,
      currentPlaybackState: 'PLAYING',
      currentVideoStartedAt: new Date().toISOString(),
      activeVideoId: primaryVideo.id,
    });

    const activeFeederMode = latestSettings.stream?.modePreference === 'transcode' ? 'transcode' : 'copy';
    await feedMediaSegment({
      primaryVideo,
      settings: latestSettings,
      mode: activeFeederMode,
      onFinished: async () => {
        await handleSegmentFinished(activeFeederMode);
      },
      onError: async (err) => {
        logger.warn('playlist.next_video_failed', `Failed starting next segment for ${primaryVideo.id}: ${err.message}; selecting next`, {
          videoId: primaryVideo.id,
          error: err.message,
        });
        await handleSegmentFinished(activeFeederMode);
      },
    });

    logger.info('playlist.transition_completed', `Completed transition to video ${primaryVideo.id}`);
  } catch (err) {
    logger.error('playlist.transition_error', `Error during playlist transition: ${err.message}`);
  } finally {
    _transitionInProgress = false;
  }
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

  // 1. STOP COMPLETION BARRIER:
  // If a stop is currently in progress, wait for it to 100% complete before proceeding
  if (_stopInProgressPromise) {
    logger.info('stream.waiting_for_stop', 'Waiting for previous stream stop to complete before starting fresh session');
    try {
      await _stopInProgressPromise;
    } catch (err) {
      logger.warn('stream.stop_wait_error', `Previous stop encountered error: ${err.message}`);
    }
  }

  // 2. Prevent overlapping publisher instances
  if (isFfmpegRunning()) {
    logger.info('stream.already_running', 'Stream is already running; ignoring redundant start request');
    const curState = getState();
    return {
      started: true,
      pid: getFfmpegPid(),
      mode: curState.streamMode,
      streamMode: curState.streamMode,
      isDualStream: false,
      alreadyRunning: true,
    };
  }

  if (_startInProgress) {
    logger.info('stream.start_in_progress', 'Stream start already in progress; waiting');
    return { started: false, code: 'E_START_IN_PROGRESS', message: 'Stream start already in progress' };
  }

  _startInProgress = true;

  try {
    // 3. REMOTE YOUTUBE RTMP SESSION TEARDOWN SETTLE BARRIER:
    // When stopping and restarting on the EXACT SAME YouTube Default/Reusable Stream Key,
    // YouTube's RTMP edge server requires a brief settle window (typically 1.5 - 2s) to cleanly
    // process the TCP socket FIN / RTMP unpublish and finalize the previous broadcast session.
    // If the new connection arrives too quickly, YouTube Studio gets confused by the overlapping
    // connection on the same key and stays stuck in "Preparing stream" instead of Auto-starting LIVE.
    if (_lastStreamStopTime > 0) {
      const elapsed = Date.now() - _lastStreamStopTime;
      const currentSettings = getSettings();
      const minSettleMs = (currentSettings.stream?.rtmpSettleSeconds !== undefined)
        ? (Number(currentSettings.stream.rtmpSettleSeconds) * 1000)
        : (process.env.NODE_ENV === 'test' ? 50 : 2000);
      if (elapsed < minSettleMs) {
        const waitMs = minSettleMs - elapsed;
        logger.info('stream.rtmp_settle_wait', `Enforcing ${waitMs}ms YouTube RTMP edge teardown settle window on default stream key`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    // Clear any pending timers
    if (_backoffTimer)   { clearTimeout(_backoffTimer);   _backoffTimer = null; }
    if (_slowRetryTimer) { clearTimeout(_slowRetryTimer); _slowRetryTimer = null; }

    // If manual start requested, auto-clear maintenance mode and recycle pause
    if (clearMaintenance || reason === 'api_manual_start' || reason === 'manual_start') {
      clearAutoResumeTimer('manual_start');
      clearAutoRecycleTimer('manual_start');
      const currentState = getState();
      if (currentState.maintenance?.active) {
        logger.info('stream.maintenance_auto_cleared', `Manual stream start (${reason}); auto-clearing maintenance mode`);
        await setMaintenance(false, 'manual_start');
      }
      if (currentState.recyclingUntil) {
        logger.info('stream.recycle_pause_cleared', `Manual stream start (${reason}); clearing VOD recycle pause`);
        await saveState({ recyclingUntil: null });
      }
      if (currentState.resumeBookmark) {
        logger.info('stream.resume_bookmark_cleared', `Manual stream start (${reason}); clearing stale bookmark for fresh start`);
        await saveState({ resumeBookmark: null });
      }
    } else if (reason === 'auto_recycle_resume') {
      clearAutoResumeTimer('auto_recycle_resume');
    }

    // Set desired state to running
    await saveState({ desiredState: 'running' });

    // Auto-trigger random video selection before every live start (newest video at #1, remaining shuffled)
    try {
      const activeStreamMode = (getSettings().stream?.mode || 'vertical').toLowerCase();
      const autoSel = await triggerRandomPlaylistSelection(activeStreamMode);
      if (autoSel) {
        logger.info('stream.prestart_random_select', `Pre-start random playlist selection auto-triggered: newest "${autoSel.newestLabel}" at #1, total ${autoSel.count} videos shuffled (${reason})`);
        if (reason === 'auto_recycle_resume') {
          await saveState({ resumeBookmark: null });
        }
      }
    } catch (err) {
      logger.warn('stream.prestart_random_select_error', `Could not auto-trigger random video selection before stream start: ${err.message}`);
    }

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
    const streamMode = (gate.streamMode || settings.stream?.mode || 'horizontal').toLowerCase();
    const primaryKey = gate.streamKey;
    const destUrl = gate.destUrl;

    // Hard guard: ensure key and RTMPS URL are both present before spawning
    const rtmpsUrl = settings.youtube?.rtmpsUrl || 'rtmps://a.rtmps.youtube.com:443/live2';
    if (!primaryKey) {
      logger.error('stream.key_empty', `${streamMode.toUpperCase()} YouTube stream key is empty at spawn time — aborting FFmpeg spawn`);
      await transitionState('ERROR', `${streamMode} YouTube stream key is empty`);
      await saveState({ lastError: { code: 'E_KEY_MISSING', message: `${streamMode} YouTube stream key is not configured`, at: new Date().toISOString() } });
      return { started: false, code: 'E_KEY_MISSING', message: `${streamMode} YouTube stream key is not configured` };
    }
    if (!rtmpsUrl || !rtmpsUrl.startsWith('rtmps://')) {
      logger.error('stream.url_invalid', `Invalid RTMPS URL at spawn time: ${rtmpsUrl}`);
      await transitionState('ERROR', 'RTMPS URL is missing or invalid');
      await saveState({ lastError: { code: 'E_CONFIG_INVALID', message: 'RTMPS URL must start with rtmps://', at: new Date().toISOString() } });
      return { started: false, code: 'E_CONFIG_INVALID', message: 'RTMPS URL must start with rtmps://' };
    }

    // Get fresh playable items for active mode
    const allVideos = await listVideos();
    const freshPlaylist = await getFreshPlayablePlaylist(settings, allVideos);

    // Check resume bookmark if resuming from auto-recycle
    const currentState = getState();
    let bookmarkSeek = 0;
    if (reason === 'auto_recycle_resume' && currentState.resumeBookmark?.offsetSec) {
      bookmarkSeek = Number(currentState.resumeBookmark.offsetSec) || 0;
      logger.info('stream.resume_bookmark_applied', `Resuming auto-recycle session from bookmark at ${bookmarkSeek}s on video ${currentState.resumeBookmark.videoId}`);
    }

    let initialLogical = freshPlaylist.length > 0 ? freshPlaylist[0] : null;
    if (bookmarkSeek > 0 && freshPlaylist.length > 0 && currentState.resumeBookmark?.videoId) {
      const match = freshPlaylist.find(item =>
        item.id === currentState.resumeBookmark.videoId ||
        item.horizontal?.id === currentState.resumeBookmark.videoId ||
        item.vertical?.id === currentState.resumeBookmark.videoId
      );
      if (match) {
        initialLogical = match;
      }
    }

    if (!initialLogical) {
      initialLogical = {
        id: gate.videoMeta.id,
        horizontal: streamMode === 'horizontal' ? gate.videoMeta : null,
        vertical: streamMode === 'vertical' ? gate.videoMeta : null,
      };
    }

    const initialPrimary = initialLogical.horizontal || initialLogical.vertical || gate.videoMeta;

    if (bookmarkSeek > 0) {
      if (initialPrimary) initialPrimary.seekOffset = bookmarkSeek;
      _currentSessionStartOffset = bookmarkSeek;
    }

    // Build persistent publisher arguments (reads continuous MPEG-TS from pipe:0)
    const publisherArgs = buildPublisherArgs(settings, destUrl);

    // Set initial runtime state
    await saveState({
      streamMode,
      currentLogicalVideoId: initialPrimary.id,
      currentHorizontalVideoId: streamMode === 'horizontal' ? initialPrimary.id : null,
      currentVerticalVideoId: streamMode === 'vertical' ? initialPrimary.id : null,
      currentPlaybackState: 'PLAYING',
      currentVideoStartedAt: new Date().toISOString(),
      activeVideoId: initialPrimary.id,
      isDualStream: false,
    });

    logger.info('playlist.next_video_selected', `Selected initial video ${initialPrimary.id} (${streamMode})`, {
      videoId: initialPrimary.id,
      streamMode,
    });

    const launchProcesses = async () => {
      resetProcessBaseline();
      _lastProgressTimestamp = Date.now();
      const { pid } = await spawnFfmpeg({
        args: publisherArgs,
        mode: streamMode,
        settings,
        pipeMode: true,
        onProgress: (p) => {
          const overhead = settings.bandwidth?.overheadPercent ?? 10;
          const now = Date.now();
          const dtSec = _lastProgressTimestamp ? Math.max(0.1, (now - _lastProgressTimestamp) / 1000) : 1;
          _lastProgressTimestamp = now;
          recordProgressBytes(p.total_size, dtSec, overhead);
        },
        onHealthy: async () => {
          _streamStartTime = Date.now();
          await transitionState('RUNNING', 'FFmpeg healthy output detected');
          logger.info('stream.stream_running', `Stream is now RUNNING with FFmpeg PID ${pid} (${streamMode})`);
          armAutoRecycleTimer();

          await saveState({
            streamMode,
            activeVideoId: initialPrimary.id,
            ffmpegPid: pid,
            streamStartedAt: new Date().toISOString(),
            currentSeekOffset: bookmarkSeek || 0,
            isDualStream: false,
            pairedVerticalVideoId: null,
            pairedHorizontalVideoId: null,
            resumeBookmark: null,
            lastError: null,
          });

          await appendHistory({
            event: 'start',
            mode: gate.mode,
            streamMode,
            videoId: initialPrimary.id,
            pid,
            isDualStream: false,
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
          await stopFeeders();
          clearAutoRecycleTimer();
          if (_stabilityTimer) { clearTimeout(_stabilityTimer); _stabilityTimer = null; }
          await flushUsage({ force: true });

          const durationSec = _streamStartTime ? Math.round((Date.now() - _streamStartTime) / 1000) : 0;
          _streamStartTime = null;

          await saveState({
            ffmpegPid: null,
            streamStartedAt: null,
            currentPlaybackState: 'STOPPED',
            currentLogicalVideoId: null,
            currentVerticalVideoId: null,
            currentHorizontalVideoId: null,
            isDualStream: false,
            pairedHorizontalVideoId: null,
            pairedVerticalVideoId: null,
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

      // Feed initial media segment into the publisher pipe
      const activeFeederMode = settings.stream?.modePreference === 'transcode' ? 'transcode' : 'copy';
      feedMediaSegment({
        primaryVideo: initialPrimary,
        settings,
        mode: activeFeederMode,
        onFinished: async () => {
          await handleSegmentFinished(activeFeederMode);
        },
        onError: async (err) => {
          logger.warn('playlist.next_video_failed', `Feeder error for ${initialPrimary.id}: ${err.message}`);
          await handleSegmentFinished(activeFeederMode);
        },
      }).catch(err => {
        logger.error('playlist.feed_initial_error', `Error feeding initial media segment: ${err.message}`);
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
        streamMode,
        isDualStream: false,
      };
    };

    let launchPromise = null;
    let launchResult = null;

    const doLaunch = async () => {
      if (launchResult) return launchResult;
      if (!launchPromise) {
        launchPromise = launchProcesses()
          .then(res => {
            launchResult = res;
            return res;
          })
          .catch(err => {
            launchPromise = null; // allow retry on error
            throw err;
          });
      }
      return await launchPromise;
    };

    try {
      if (settings.studioAutomation?.enabled !== false) {
        if (process.platform !== 'linux') {
          throw Object.assign(new Error(`Studio automation is enabled but unsupported on ${process.platform}`), {
            code: 'E_STUDIO_PLATFORM',
          });
        }

        logger.info('stream.studio_auto_invoked', `Starting strict YouTube Studio gates (reason: ${reason})`);
        try {
          const startupTimeoutMs = ((settings.stream?.startupTimeoutSeconds ?? 30) * 1000) + 5000;
          const verifiedLaunch = await prepareYouTubeStudioStream({
            settings,
            onReadyToStream: async () => {
              const result = await doLaunch();
              if (!result?.started) {
                throw Object.assign(new Error(result?.message || 'FFmpeg process did not start'), {
                  code: result?.code || 'E_STREAM_START_FAILED',
                });
              }

              const deadline = Date.now() + startupTimeoutMs;
              while (Date.now() < deadline) {
                const current = getState();
                if (current.status === 'RUNNING' && isFfmpegRunning()) return result;
                if (!isFfmpegRunning() && current.status === 'ERROR') {
                  throw Object.assign(new Error(current.lastError?.message || 'FFmpeg exited before output became healthy'), {
                    code: current.lastError?.code || 'E_STREAM_HEALTH_FAILED',
                  });
                }
                await new Promise(r => setTimeout(r, 250));
              }

              throw Object.assign(new Error(`RTMPS output did not become healthy within ${startupTimeoutMs}ms`), {
                code: 'E_STREAM_HEALTH_TIMEOUT',
              });
            },
          });

          if (!verifiedLaunch?.started || verifiedLaunch.studioVerified !== true) {
            throw Object.assign(new Error('Studio worker did not confirm every startup stage'), {
              code: 'E_STUDIO_VERIFICATION_FAILED',
            });
          }
          launchResult = launchResult || verifiedLaunch;
          const finalState = getState();
          if (finalState.status !== 'RUNNING' || !isFfmpegRunning()) {
            throw Object.assign(new Error('Stream lost healthy RTMPS output before Studio confirmed the broadcast live'), {
              code: 'E_STREAM_HEALTH_LOST',
            });
          }
        } catch (err) {
          // Disarm the regular recovery path before stopping a publisher whose
          // Studio gate failed, so failure cannot silently restart via fallback.
          try {
            await saveState({ desiredState: 'stopped' });
          } catch (stateErr) {
            logger.error('stream.studio_auto_state_error', `Could not disarm retries after Studio gate failure: ${stateErr.message}`);
          }
          if (launchResult?.started || isFfmpegRunning()) {
            try {
              await stopStream({ keepDesiredRunning: false, reason: 'studio_start_gate_failed' });
            } catch (stopErr) {
              logger.error('stream.studio_auto_cleanup_error', `Could not stop publisher after Studio gate failure: ${stopErr.message}`);
            }
          }
          err.code ||= 'E_STUDIO_AUTOMATION';
          throw err;
        }
      } else {
        logger.info('stream.studio_auto_disabled', 'Studio automation explicitly disabled; using configured direct stream startup');
        launchResult = await doLaunch();
      }

      return launchResult;
    } catch (err) {
      logger.error('stream.start_failed', `Stream startup gate failed: ${err.message}`);
      await transitionState('ERROR', err.message);
      await saveState({
        desiredState: 'stopped',
        lastError: { code: err.code || 'E_START_FAILED', message: err.message, at: new Date().toISOString() },
      });
      return { started: false, code: err.code || 'E_START_FAILED', message: err.message };
    }
  } finally {
    _startInProgress = false;
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
  const streamMode = (settings.stream?.mode || 'horizontal').toLowerCase();
  const playlist = (settings.stream?.playlists && Array.isArray(settings.stream.playlists[streamMode]) && settings.stream.playlists[streamMode].length > 0)
    ? settings.stream.playlists[streamMode]
    : (settings.stream?.playlist || []);
  const primaryId = settings.stream?.videoId;
  const startOffset = _currentSessionStartOffset || 0;
  const totalElapsed = startOffset + Math.max(0, sessionElapsedSec);

  if (playlist.length <= 1) {
    const vidId = playlist[0] || primaryId;
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
  if (_stopInProgressPromise) {
    return _stopInProgressPromise;
  }

  _stopInProgressPromise = (async () => {
    try {
      if (_backoffTimer)   { clearTimeout(_backoffTimer);   _backoffTimer = null; }
      if (_stabilityTimer) { clearTimeout(_stabilityTimer); _stabilityTimer = null; }
      if (_slowRetryTimer) { clearTimeout(_slowRetryTimer); _slowRetryTimer = null; }

      if (reason !== 'auto_recycle') {
        clearAutoRecycleTimer('stream_stopped');
        clearAutoResumeTimer('stream_stopped');
      } else {
        clearAutoRecycleTimer();
      }

      let settings = null;
      try { settings = getSettings(); } catch { /* ignore if settings not initialized in tests */ }
      logger.info('stream.stop', `Stop requested (${reason}); stopping feeders and publisher cleanly`);
      _currentSessionStartOffset = 0;
      _lastProgressTimestamp = null;
      resetProcessBaseline();

      // 1. Wait for feeder process to stop cleanly, unpipe, and fully exit
      await stopFeeders();

      // 2. Mark state as stopping / stopped in persistent storage
      await saveState({
        ...(keepDesiredRunning ? {} : { desiredState: 'stopped' }),
        ffmpegPid: null,
        streamStartedAt: null,
        currentPlaybackState: 'STOPPED',
        currentLogicalVideoId: null,
        currentVerticalVideoId: null,
        currentHorizontalVideoId: null,
        isDualStream: false,
        pairedHorizontalVideoId: null,
        pairedVerticalVideoId: null,
        youtubeStreamActive: false,
        youtubeBroadcastLive: false,
        youtubeIngest: 'INACTIVE',
        youtubeBroadcast: 'INACTIVE',
        ...(reason === 'auto_recycle' ? {} : { resumeBookmark: null, recyclingUntil: null }),
        currentSeekOffset: 0,
      });

      const graceSec = settings.stream?.stopGraceSeconds ?? 8;

      // 3. Stop publisher with graceful EOF -> wait -> SIGTERM -> SIGKILL barrier
      await stopFfmpeg({ force: false, reason, graceSeconds: graceSec });
      await flushUsage({ force: true });

      if (!keepDesiredRunning) {
        await transitionState('STOPPED', reason);
      }

      _lastStreamStopTime = Date.now();
      logger.info('stream.stop_complete', `Stream stop barrier completed cleanly (${reason})`);
      return { stopped: true };
    } finally {
      _stopInProgressPromise = null;
    }
  })();

  return _stopInProgressPromise;
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
  clearAutoRecycleTimer('bandwidth_safety_limit');
  clearAutoResumeTimer('bandwidth_safety_limit');
  await saveState({ recyclingUntil: null });
  logger.error('stream.bandwidth_lock_engaged', 'Bandwidth safety lock engaged; shutting down FFmpeg');
  await stopStream({ keepDesiredRunning: false, reason: 'bandwidth_safety_limit' });
  await transitionState('BANDWIDTH_LIMIT_REACHED', 'Monthly bandwidth safety limit reached');
}

// ─── Master Kill Switch & Maintenance ────────────────────────────────────────

export async function setDisabled(disabled) {
  if (disabled) {
    clearAutoRecycleTimer('admin_disabled');
    clearAutoResumeTimer('admin_disabled');
    await saveState({ disabled: true, recyclingUntil: null });
    await stopStream({ keepDesiredRunning: false, reason: 'admin_disabled' });
    await transitionState('DISABLED', 'Streaming disabled by administrator');
  } else {
    await saveState({ disabled: false });
    const st = getState();
    if (st.status === 'DISABLED') {
      await transitionState('STOPPED', 'Streaming re-enabled by administrator');
    }
  }
}

export async function setMaintenance(active, source = 'admin') {
  if (active) {
    clearAutoRecycleTimer(`maintenance_${source}`);
    clearAutoResumeTimer(`maintenance_${source}`);
  }
  const m = active ? { active: true, source, since: new Date().toISOString() } : null;
  await saveState({ maintenance: m, ...(active ? { recyclingUntil: null } : {}) });
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
    'E_DUAL_HORIZONTAL_KEY_MISSING', 'E_DUAL_STREAM_KEYS_IDENTICAL', 'E_DUAL_PAIR_MISSING',
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

// ─── Auto-Recycle Scheduler Orchestration ────────────────────────────────────

function formatHms(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function clearAutoRecycleTimer(reason = '') {
  if (_autoRecycleTimer) {
    clearTimeout(_autoRecycleTimer);
    _autoRecycleTimer = null;
    if (reason) {
      logger.info('stream.auto_recycle_cancelled', { reason });
    }
  }
}

export function clearAutoResumeTimer(reason = '') {
  if (_autoResumeTimer) {
    clearTimeout(_autoResumeTimer);
    _autoResumeTimer = null;
    if (reason) {
      logger.info('stream.auto_recycle_cancelled', { reason });
    }
  }
}

export function armAutoRecycleTimer() {
  clearAutoRecycleTimer();
  const settings = getSettings();
  const ar = settings.scheduler?.autoRecycle;

  if (!ar || !ar.enabled) {
    return;
  }

  const curState = getState();
  if (curState.status !== 'RUNNING' || !_streamStartTime) {
    return;
  }

  const maxSessionMs = ar.maxSessionMinutes
    ? (ar.maxSessionMinutes * 60 * 1000)
    : ((ar.maxSessionHours || 8) * 60 * 60 * 1000);

  const elapsedMs = Math.max(0, Date.now() - _streamStartTime);
  const remainingMs = Math.max(0, maxSessionMs - elapsedMs);
  const recycleAt = new Date(Date.now() + remainingMs).toISOString();

  logger.info('stream.auto_recycle_armed', {
    sessionStart: new Date(_streamStartTime).toISOString(),
    maxSessionHours: ar.maxSessionHours ?? 8,
    maxSessionMinutes: ar.maxSessionMinutes ?? null,
    recycleAt,
    remainingMs,
  });

  if (remainingMs === 0) {
    triggerAutoRecycle().catch(err => {
      logger.error('stream.auto_recycle_trigger_error', err.message);
    });
  } else {
    _autoRecycleTimer = setTimeout(async () => {
      _autoRecycleTimer = null;
      await triggerAutoRecycle();
    }, remainingMs);
    if (typeof _autoRecycleTimer?.unref === 'function') {
      _autoRecycleTimer.unref();
    }
  }
}

export function recalculateAutoRecycleTimer() {
  const state = getState();
  const settings = getSettings();
  const ar = settings.scheduler?.autoRecycle;

  if (isFfmpegRunning() && state.status === 'RUNNING' && _streamStartTime) {
    if (!ar || !ar.enabled) {
      clearAutoRecycleTimer('auto_recycle_disabled_in_settings');
      return;
    }

    const maxSessionMs = ar.maxSessionMinutes
      ? (ar.maxSessionMinutes * 60 * 1000)
      : ((ar.maxSessionHours || 8) * 60 * 60 * 1000);

    const elapsedMs = Math.max(0, Date.now() - _streamStartTime);
    if (elapsedMs >= maxSessionMs) {
      logger.info('stream.auto_recycle_recalculated_immediate', {
        elapsedMs,
        maxSessionMs,
        msg: 'New maxSession limit already reached by active session; triggering recycle now',
      });
      clearAutoRecycleTimer();
      triggerAutoRecycle().catch(err => {
        logger.error('stream.auto_recycle_trigger_error', err.message);
      });
    } else {
      armAutoRecycleTimer();
    }
  } else if (!isFfmpegRunning()) {
    clearAutoRecycleTimer();
  }
}

export async function triggerAutoRecycle() {
  clearAutoRecycleTimer();

  const settings = getSettings();
  const ar = settings.scheduler?.autoRecycle || {};
  const state = getState();

  // 1. Confirm autoRecycle is still enabled
  if (!ar.enabled) {
    logger.info('stream.auto_recycle_cancelled', { reason: 'auto_recycle_not_enabled' });
    return;
  }
  // 2. Confirm desiredState is still running
  if (state.desiredState !== 'running') {
    logger.info('stream.auto_recycle_cancelled', { reason: 'desired_state_not_running' });
    return;
  }
  // 3. Confirm stream is currently RUNNING
  if (state.status !== 'RUNNING') {
    logger.info('stream.auto_recycle_cancelled', { reason: 'stream_not_running', status: state.status });
    return;
  }

  // 4. Mark this as an EXPECTED recycle
  logger.info('stream.auto_recycle_triggered', {
    sessionStart: _streamStartTime ? new Date(_streamStartTime).toISOString() : null,
    triggeredAt: new Date().toISOString(),
  });

  // 5. Compute/save resume bookmark if resumeBookmark is enabled
  const allowBookmark = ar.resumeBookmark !== false;
  if (allowBookmark) {
    const sessionElapsedSec = _streamStartTime ? Math.round((Date.now() - _streamStartTime) / 1000) : 0;
    try {
      const bookmark = await computeResumeBookmark(sessionElapsedSec);
      if (bookmark) {
        await saveState({ resumeBookmark: bookmark });
        logger.info('stream.resume_bookmark_saved', `Saved auto-recycle playback bookmark at ${bookmark.offsetSec}s (video: ${bookmark.videoId})`);
      }
    } catch (bmErr) {
      logger.warn('stream.auto_recycle_bookmark_error', `Could not compute bookmark: ${bmErr.message}`);
    }
  } else {
    await saveState({ resumeBookmark: null });
  }

  // 6. Stop current FFmpeg cleanly as EXPECTED stop
  logger.info('stream.auto_recycle_stopping', 'Stopping current FFmpeg session for scheduled auto-recycle');
  await stopStream({ keepDesiredRunning: true, reason: 'auto_recycle' });

  // 7. Enter recycle pause state
  const pauseMinutes = ar.pauseMinutes ?? 60;
  const pauseMs = pauseMinutes * 60 * 1000;
  const recyclingUntil = new Date(Date.now() + pauseMs).toISOString();

  await saveState({ recyclingUntil });
  await transitionState('SCHEDULED', 'auto_recycle_pause');

  logger.info('stream.auto_recycle_pause_started', {
    recyclingUntil,
    pauseMinutes,
  });

  // 9. Schedule automatic resume after pause
  scheduleAutoResume(pauseMs);
}

export function scheduleAutoResume(delayMs) {
  clearAutoResumeTimer();

  const resumeAt = new Date(Date.now() + delayMs).toISOString();
  logger.info('stream.auto_recycle_resume_scheduled', {
    delayMs,
    resumeAt,
  });

  _autoResumeTimer = setTimeout(async () => {
    _autoResumeTimer = null;
    await executeAutoResume();
  }, Math.max(0, delayMs));
  if (typeof _autoResumeTimer?.unref === 'function') {
    _autoResumeTimer.unref();
  }
}

export async function executeAutoResume() {
  clearAutoResumeTimer();

  const settings = getSettings();
  const state = getState();
  const ar = settings.scheduler?.autoRecycle;

  // 1. Re-check higher priority gates:
  if (state.disabled) {
    logger.warn('stream.auto_recycle_blocked', { reason: 'streaming_disabled_by_admin' });
    await saveState({ recyclingUntil: null });
    return;
  }
  if (state.maintenance?.active) {
    logger.warn('stream.auto_recycle_blocked', { reason: 'maintenance_mode_active' });
    await saveState({ recyclingUntil: null });
    return;
  }
  if (state.bandwidthLock?.active) {
    logger.warn('stream.auto_recycle_blocked', { reason: 'bandwidth_safety_limit_locked' });
    await saveState({ recyclingUntil: null });
    return;
  }
  if (state.desiredState !== 'running') {
    logger.info('stream.auto_recycle_cancelled', { reason: 'desired_state_not_running' });
    await saveState({ recyclingUntil: null });
    return;
  }
  if (!ar?.enabled) {
    logger.info('stream.auto_recycle_cancelled', { reason: 'auto_recycle_disabled_during_pause' });
    await saveState({ recyclingUntil: null });
    return;
  }
  if (settings.scheduler?.mode === 'scheduled') {
    const tz = settings.scheduler?.timezone || 'Asia/Kolkata';
    const windows = settings.scheduler?.windows || [];
    if (!isInsideWindow(new Date(), windows, tz)) {
      logger.info('stream.auto_recycle_blocked', { reason: 'outside_scheduled_window' });
      await saveState({ recyclingUntil: null });
      return;
    }
  }

  // 2. Clear recyclingUntil
  await saveState({ recyclingUntil: null });

  // 3. Start NEW stream session using existing startStream
  logger.info('stream.auto_recycle_resume', { reason: 'scheduled_auto_recycle' });
  const result = await startStream({ reason: 'auto_recycle_resume' });
  if (!result.started) {
    logger.error('stream.auto_recycle_blocked', {
      reason: 'start_failed',
      code: result.code,
      message: result.message,
    });
  }
}

export async function initAutoRecycleOnBoot() {
  const state = getState();
  const settings = getSettings();
  const ar = settings.scheduler?.autoRecycle;

  if (!state.recyclingUntil) {
    return;
  }

  if (state.desiredState !== 'running' || !ar?.enabled) {
    logger.info('stream.auto_recycle_boot_cleared', {
      reason: state.desiredState !== 'running' ? 'desired_not_running' : 'auto_recycle_disabled',
    });
    await saveState({ recyclingUntil: null });
    return;
  }

  const untilMs = new Date(state.recyclingUntil).getTime();
  const nowMs = Date.now();

  if (nowMs < untilMs) {
    const remainingMs = untilMs - nowMs;
    logger.info('stream.auto_recycle_pause_restored', `Restoring auto-recycle pause on boot (${Math.ceil(remainingMs / 60000)}m remaining)`);
    scheduleAutoResume(remainingMs);
  } else {
    logger.info('stream.auto_recycle_pause_expired_on_boot', 'Auto-recycle pause already expired while offline; auto-resuming stream session');
    await saveState({ recyclingUntil: null });
    scheduleAutoResume(0);
  }
}

export function getAutoRecycleStatus(now = new Date()) {
  const settings = getSettings();
  const state = getState();
  const ar = settings.scheduler?.autoRecycle || { enabled: false, maxSessionHours: 8, pauseMinutes: 60, resumeBookmark: true };

  const isEnabled = Boolean(ar.enabled);
  const isRecycling = Boolean(state.recyclingUntil && new Date(state.recyclingUntil).getTime() > now.getTime());

  let nextRecycleRemainingMs = null;
  let nextRecycleFormatted = null;
  let nextRecycleAt = null;

  if (isEnabled && isFfmpegRunning() && state.status === 'RUNNING' && _streamStartTime) {
    const maxSessionMs = ar.maxSessionMinutes
      ? (ar.maxSessionMinutes * 60 * 1000)
      : ((ar.maxSessionHours || 8) * 60 * 60 * 1000);
    const elapsedMs = Math.max(0, now.getTime() - _streamStartTime);
    nextRecycleRemainingMs = Math.max(0, maxSessionMs - elapsedMs);
    nextRecycleFormatted = formatHms(nextRecycleRemainingMs);
    nextRecycleAt = new Date(_streamStartTime + maxSessionMs).toISOString();
  }

  let nextStreamRemainingMs = null;
  let nextStreamFormatted = null;
  if (state.recyclingUntil) {
    const untilMs = new Date(state.recyclingUntil).getTime();
    nextStreamRemainingMs = Math.max(0, untilMs - now.getTime());
    nextStreamFormatted = formatHms(nextStreamRemainingMs);
  }

  let label = 'AUTO-RECYCLE: OFF';
  let displayMode = 'disabled';

  if (isRecycling) {
    displayMode = 'recycling';
    label = `AUTO-RECYCLE PAUSE\nNext stream in:\n${nextStreamFormatted || '00:00:00'}`;
  } else if (isEnabled && state.status === 'RUNNING') {
    displayMode = 'normal';
    label = `AUTO-RECYCLE\nNext recycle in:\n${nextRecycleFormatted || '00:00:00'}`;
  } else if (isEnabled) {
    displayMode = 'armed';
    label = 'AUTO-RECYCLE: Armed';
  }

  return {
    enabled: isEnabled,
    isRecycling,
    maxSessionHours: ar.maxSessionHours ?? 8,
    maxSessionMinutes: ar.maxSessionMinutes ?? null,
    pauseMinutes: ar.pauseMinutes ?? 60,
    resumeBookmark: ar.resumeBookmark !== false,
    sessionStartTime: _streamStartTime ? new Date(_streamStartTime).toISOString() : null,
    nextRecycleAt,
    nextRecycleRemainingMs,
    nextRecycleFormatted,
    recyclingUntil: state.recyclingUntil || null,
    nextStreamRemainingMs,
    nextStreamFormatted,
    label,
    displayMode,
  };
}

/**
 * Safely change the active stream mode (horizontal or vertical).
 * Fails with E_STREAM_RUNNING (409) if stream is currently running.
 *
 * @param {'horizontal'|'vertical'} newMode
 * @returns {Promise<{ success: boolean, mode: string }>}
 */
export async function setStreamMode(newMode) {
  const normMode = (newMode || '').toLowerCase();
  if (normMode !== 'horizontal' && normMode !== 'vertical') {
    throw Object.assign(new Error('Invalid stream mode. Must be "horizontal" or "vertical".'), {
      code: 'E_INVALID_MODE',
      status: 400,
    });
  }

  const curState = getState();
  if (isFfmpegRunning() || curState.status === 'RUNNING' || curState.status === 'STARTING' || curState.status === 'RECONNECTING') {
    throw Object.assign(new Error('Cannot change stream mode while stream is running. Stop stream before switching mode.'), {
      code: 'E_STREAM_RUNNING',
      status: 409,
    });
  }

  const { saveSettings } = await import('./config-manager.js');
  await saveSettings({ stream: { mode: normMode } });
  await saveState({ streamMode: normMode });
  logger.info('stream.mode_changed', `Stream mode changed to ${normMode}`);
  return { success: true, mode: normMode };
}

