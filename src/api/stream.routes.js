/**
 * api/stream.routes.js — Live stream control and status endpoints.
 */

import { Router } from 'express';
import {
  startStream,
  stopStream,
  setDisabled,
  setMaintenance,
} from '../stream-manager.js';
import { getState } from '../state-manager.js';
import { getLatestProgress, getRecentStderr, getOutputsStatus } from '../ffmpeg-manager.js';
import { getYouTubeLiveApiState } from '../youtube-api-manager.js';

export function createStreamRouter() {
  const router = Router();

  // GET /api/stream/status (and /api/status)
  router.get(['/', '/status'], async (req, res) => {
    const state = getState();
    const progress = getLatestProgress();
    const outputs = getOutputsStatus();

    // Compute Health Verdict (PRD §15.4)
    const reasons = [];
    let healthStatus = 'HEALTHY';

    if (outputs.vertical.status === 'FAILED') {
      healthStatus = 'UNHEALTHY';
      reasons.push(`RTMPS vertical output failed: ${outputs.vertical.lastError || 'Connection error'}`);
    }
    if (outputs.horizontal.enabled && outputs.horizontal.status === 'FAILED') {
      healthStatus = 'DEGRADED';
      reasons.push(`RTMPS horizontal output failed: ${outputs.horizontal.lastError || 'Connection error'}`);
    }

    if (state.status === 'ERROR') {
      healthStatus = 'UNHEALTHY';
      reasons.push(state.lastError?.message || 'Stream encountered a fatal error');
    } else if (state.status === 'BANDWIDTH_LIMIT_REACHED') {
      healthStatus = 'UNHEALTHY';
      reasons.push('Monthly bandwidth safety limit reached');
    } else if (state.status === 'RECONNECTING') {
      healthStatus = 'DEGRADED';
      reasons.push(`Stream is reconnecting (failure count: ${state.consecutiveFailures})`);
    } else if (state.status === 'RUNNING') {
      if (progress && progress.speed > 0 && progress.speed < 0.95) {
        healthStatus = 'DEGRADED';
        reasons.push(`Encoding speed is low: ${progress.speed}x (target ≥ 0.95x)`);
      }
      if (state.consecutiveFailures > 0) {
        healthStatus = 'DEGRADED';
        reasons.push(`Recent recovery attempts: ${state.consecutiveFailures}`);
      }
    } else if (state.status === 'STARTING') {
      healthStatus = 'HEALTHY';
      reasons.push('Stream is starting up');
    } else {
      // STOPPED, DISABLED, SCHEDULED, MAINTENANCE
      healthStatus = state.desiredState === 'running' ? 'DEGRADED' : 'HEALTHY';
      if (state.desiredState === 'running') {
        reasons.push(`Stream is ${state.status} despite desiredState=running`);
      } else {
        reasons.push(`Stream is currently ${state.status}`);
      }
    }

    res.json({
      status:              state.status,
      desiredState:        state.desiredState,
      disabled:            state.disabled,
      maintenance:         state.maintenance,
      bandwidthLock:       state.bandwidthLock,
      activeVideoId:       state.activeVideoId,
      streamMode:          state.streamMode,
      ffmpegPid:           state.ffmpegPid,
      streamStartedAt:     state.streamStartedAt,
      restartCountSession: state.restartCountSession,
      restartCountTotal:   state.restartCountTotal,
      consecutiveFailures: state.consecutiveFailures,
      lastExit:            state.lastExit,
      lastError:           state.lastError,
      isDualStream:        Boolean(state.isDualStream),
      pairedHorizontalVideoId: state.pairedHorizontalVideoId,
      progress,
      outputs,
      healthVerdict: {
        status: healthStatus,
        reasons,
      },
      youtubeLive:         getYouTubeLiveApiState(),
      recentStderr:        getRecentStderr().slice(-10),
    });
  });

  // POST /api/stream/start
  router.post('/start', async (req, res) => {
    const result = await startStream({ reason: 'api_manual_start' });
    if (!result.started) {
      return res.status(400).json({ success: false, code: result.code, error: result.message });
    }
    res.json({ success: true, pid: result.pid, mode: result.mode });
  });

  // POST /api/stream/stop
  router.post('/stop', async (req, res) => {
    await stopStream({ keepDesiredRunning: false, reason: 'api_manual_stop' });
    res.json({ success: true });
  });

  // POST /api/stream/restart
  router.post('/restart', async (req, res) => {
    await stopStream({ keepDesiredRunning: true, reason: 'api_restart' });
    const result = await startStream({ reason: 'api_restart' });
    if (!result.started) {
      return res.status(400).json({ success: false, code: result.code, error: result.message });
    }
    res.json({ success: true, pid: result.pid, mode: result.mode });
  });

  // POST /api/stream/disable
  router.post('/disable', async (req, res) => {
    await setDisabled(true);
    res.json({ success: true, disabled: true });
  });

  // POST /api/stream/enable
  router.post('/enable', async (req, res) => {
    await setDisabled(false);
    res.json({ success: true, disabled: false });
  });

  // POST /api/maintenance (PRD §16.2)
  router.post('/maintenance', async (req, res) => {
    const { enabled, active, source } = req.body || {};
    const isActive = typeof enabled === 'boolean' ? enabled : Boolean(active);
    await setMaintenance(isActive, source || 'admin');
    res.json({ success: true, maintenance: getState().maintenance });
  });

  return router;
}
