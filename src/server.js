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
import { cleanupStaleLockOnBoot } from './ffmpeg-manager.js';
import { cleanOrphanIncoming } from './video-manager.js';
import { startStream, stopStream } from './stream-manager.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { requireAuth, requireCsrf } from './auth.js';
import { createAuthRouter } from './api/auth.routes.js';
import { createStreamRouter } from './api/stream.routes.js';
import { createSettingsRouter } from './api/settings.routes.js';
import { createBandwidthRouter } from './api/bandwidth.routes.js';
import { createVideosRouter } from './api/videos.routes.js';
import { createSystemRouter } from './api/system.routes.js';
import { createSchedulerRouter } from './api/scheduler.routes.js';
import PATHS from './lib/paths.js';

export async function createApp(envConfig = {}) {
  const app = express();

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
        imgSrc:     ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc:    ["'self'", "https://fonts.gstatic.com"],
        objectSrc:  ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  }));

  // JSON Body Parser (64 KB cap per PRD §19.2, excluded for multipart uploads)
  app.use(express.json({ limit: '64kb' }));

  // API Cache-Control: no-store
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Health endpoint (public)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
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
    if (settings.stream?.autoResume && state.desiredState === 'running') {
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
