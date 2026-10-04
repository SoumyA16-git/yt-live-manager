/**
 * server.js — Application bootstrap, Express setup, API mounting, and graceful shutdown.
 *
 * PRD §17.1: Bootstrap only (< 150 lines).
 * PRD §19.2: helmet security headers, strict CSP ('self'), 64 KB JSON limit.
 * PRD §21.1: Handles SIGTERM/SIGINT with graceful shutdown within 30 s.
 */

import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { initLogger, logger } from './logger.js';
import { loadSettings, getSettings } from './config-manager.js';
import { loadState, getState } from './state-manager.js';
import { loadUsage } from './usage-manager.js';
import { cleanupStaleLockOnBoot, getLatestProgress } from './ffmpeg-manager.js';
import { cleanOrphanIncoming, getVideo } from './video-manager.js';
import { getBandwidthSummary } from './bandwidth-monitor.js';
import { getSystemSnapshot } from './system-monitor.js';
import { startStream, stopStream, getCurrentSeekOffset, initAutoRecycleOnBoot } from './stream-manager.js';
import { startScheduler, stopScheduler, getSchedulerStatus } from './scheduler.js';
import { requireAuth, requireCsrf } from './auth.js';
import { createAuthRouter } from './api/auth.routes.js';
import { createStreamRouter } from './api/stream.routes.js';
import { createSettingsRouter } from './api/settings.routes.js';
import { createBandwidthRouter } from './api/bandwidth.routes.js';
import { createVideosRouter } from './api/videos.routes.js';
import { createSystemRouter } from './api/system.routes.js';
import { createSchedulerRouter } from './api/scheduler.routes.js';
import { createYouTubeRouter } from './api/youtube.routes.js';
import { initYouTubeApi, getYouTubeLiveApiState } from './youtube-api-manager.js';
import PATHS from './lib/paths.js';

export async function createApp(envConfig = {}) {
  const app = express();

  // Initialize YouTube Live API integration
  initYouTubeApi(envConfig);

  // Environment credentials
  const adminUsername     = envConfig.ADMIN_USERNAME      || process.env.ADMIN_USERNAME      || 'admin';
  const adminPasswordHash = envConfig.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD_HASH || '';
  const sessionSecret     = envConfig.SESSION_SECRET      || process.env.SESSION_SECRET      || 'insecure-dev-session-secret-change-in-prod';

  const authEnv = { adminUsername, adminPasswordHash, sessionSecret };

  // Security Headers (PRD §19.2)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],
        styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc:     ["'self'", 'data:', 'blob:', 'https://i.ytimg.com', 'https://*.ytimg.com', 'https://*.googleusercontent.com', 'https://*.ggpht.com'],
        connectSrc: ["'self'"],
        fontSrc:    ["'self'", "https://fonts.gstatic.com"],
        objectSrc:  ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  }));

  // JSON Body Parser (10 MB cap for custom thumbnail uploads and metadata)
  app.use(express.json({ limit: '10mb' }));

  // API Cache-Control: no-store
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Health endpoint (public)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // CLI / Localhost live status endpoint (restricted strictly to local loopback)
  app.get('/api/internal/cli-status', async (req, res) => {
    const remoteIp = req.socket?.remoteAddress || req.ip || '';
    const isLoopback = (
      remoteIp === '127.0.0.1' ||
      remoteIp === '::1' ||
      remoteIp === '::ffff:127.0.0.1'
    ) && !req.headers['x-forwarded-for'];

    if (!isLoopback) {
      return res.status(403).json({ error: 'Access denied: CLI status is restricted to localhost loopback' });
    }

    try {
      const state = getState();
      const progress = getLatestProgress();
      const settings = getSettings();
      const [sysSnapshot, bwSummary] = await Promise.all([
        getSystemSnapshot().catch(() => null),
        getBandwidthSummary().catch(() => null),
      ]);

      let activeVideo = null;
      if (state.activeVideoId) {
        activeVideo = await getVideo(state.activeVideoId).catch(() => null);
      }

      const reasons = [];
      let healthStatus = 'HEALTHY';
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
      } else {
        healthStatus = state.desiredState === 'running' ? 'DEGRADED' : 'HEALTHY';
      }

      const schedulerStatus = getSchedulerStatus();
      const currentSeekOffset = getCurrentSeekOffset();

      res.json({
        state: {
          ...state,
          currentSeekOffset,
        },
        progress,
        bandwidth: bwSummary,
        system: sysSnapshot,
        video: activeVideo ? {
          id: activeVideo.id,
          name: activeVideo.originalName || activeVideo.filename,
          durationSec: Number(activeVideo.probe?.durationSec || activeVideo.probe?.duration || 0),
          resolution: activeVideo.probe?.resolution || null,
          fps: activeVideo.probe?.fps || null,
        } : null,
        scheduler: schedulerStatus,
        autoRecycle: schedulerStatus?.autoRecycle || settings.scheduler?.autoRecycle || {},
        youtubeLive: getYouTubeLiveApiState(),
        healthVerdict: { status: healthStatus, reasons },
        serverUptime: Math.round(process.uptime()),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public Auth Router
  app.use('/api/auth', createAuthRouter(authEnv));

  // Protected API Routers (require session authentication & CSRF)
  const authMw = requireAuth(sessionSecret);
  const csrfMw = requireCsrf();

  const streamRouter = createStreamRouter();
  const systemRouter = createSystemRouter();

  app.use('/api/stream', authMw, csrfMw, streamRouter);
  app.use('/api/status', authMw, streamRouter);
  app.post('/api/maintenance', authMw, csrfMw, (req, res, next) => {
    req.url = '/maintenance';
    streamRouter(req, res, next);
  });
  app.use('/api/settings',  authMw, csrfMw, createSettingsRouter(authEnv));
  app.use('/api/bandwidth', authMw, csrfMw, createBandwidthRouter(authEnv));
  app.use('/api/scheduler', authMw, csrfMw, createSchedulerRouter());
  app.use('/api/videos',    authMw, csrfMw, createVideosRouter());
  app.use('/api/youtube',   authMw, csrfMw, createYouTubeRouter());
  app.use('/api/system',    authMw, systemRouter);
  app.get('/api/logs', authMw, (req, res, next) => {
    req.url = '/logs';
    systemRouter(req, res, next);
  });

  // Static files (served from public/)
  app.use(express.static(PATHS.public));

  return app;
}

// ─── Direct Execution Bootstrap ───────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  (async () => {
    initLogger();
    initYouTubeApi();
    logger.info('app.boot', 'Starting 24×7 YouTube Vertical Live Streaming Manager');

    // 1. Load settings & register stream key
    const settings = await loadSettings();

    // 2. Load state & usage
    const state = await loadState();
    await loadUsage(settings.bandwidth?.accounting);

    // 3. Clean up stale runtime locks & orphan uploads
    await cleanupStaleLockOnBoot();
    await cleanOrphanIncoming();

    // 4. Start HTTP Server
    const port = parseInt(process.env.PORT, 10) || 3000;
    const host = process.env.HOST || '127.0.0.1';
    const app  = await createApp();

    const server = app.listen(port, host, () => {
      logger.info('app.listening', `Server listening on http://${host}:${port}`);
    });

    // Disable requestTimeout & socket timeout to allow multi-gigabyte video uploads without 5-minute disconnect
    server.requestTimeout = 0;
    server.timeout = 0;
    server.headersTimeout = 300000;
    server.keepAliveTimeout = 120000;

    // 5. Start in-process scheduler
    startScheduler();

    // 5b. Recover auto-recycle pause on boot if active
    await initAutoRecycleOnBoot();

    // Idle Garbage Collection (runs every 2 minutes if --expose-gc is enabled to trim memory)
    if (typeof global.gc === 'function') {
      setInterval(() => {
        try {
          global.gc();
          logger.debug('system.gc_sweep', 'Periodic idle memory compaction completed');
        } catch { /* ignore */ }
      }, 120000).unref();
    }

    // 6. Auto-resume stream if configured (PRD §8.5)
    // Only trigger boot auto-resume if not currently in an active or pending auto-recycle pause
    const bootState = getState();
    if (settings.stream?.autoResume && bootState.desiredState === 'running' && !bootState.recyclingUntil) {
      logger.info('app.auto_resume', 'Auto-resume enabled and desiredState is running; initiating stream start');
      startStream({ reason: 'boot_auto_resume' }).catch(err => {
        logger.error('app.auto_resume_failed', err.message);
      });
    }

    // 7. Graceful Shutdown Handler (PRD §21.1)
    const handleShutdown = async (signal) => {
      logger.info('app.shutdown', `Received ${signal}; initiating graceful shutdown`);
      stopScheduler();

      // Gracefully stop FFmpeg and flush all state
      await stopStream({ keepDesiredRunning: true, reason: `system_${signal.toLowerCase()}` });

      server.close(() => {
        logger.info('app.shutdown_complete', 'HTTP server closed; exiting');
        process.exit(0);
      });

      // Force exit if not finished within 25 s
      setTimeout(() => {
        logger.error('app.shutdown_forced', 'Shutdown timed out; force exiting');
        process.exit(1);
      }, 25000).unref();
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT',  () => handleShutdown('SIGINT'));
  })().catch(err => {
    console.error('Fatal bootstrap error:', err);
    process.exit(1);
  });
}
