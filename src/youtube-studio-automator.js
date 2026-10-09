/**
 * src/youtube-studio-automator.js
 *
 * Automates YouTube Studio live broadcast management prior to starting a live stream:
 * 1. Launches Chrome with logged-in user profile on VPS.
 * 2. Opens https://studio.youtube.com/video/xHUulPKBtJs/livestreaming.
 * 3. Dismisses "Stream Finished" popup if present.
 * 4. Edits stream title: Base Title + Current Date + Current Time (Asia/Kolkata).
 * 5. Saves changes and waits for control panel to settle.
 * 6. Signals stream-manager to start live stream (FFmpeg).
 * 7. Waits for live video preview to appear in YouTube Studio.
 * 8. Waits 10 seconds after preview appears.
 * 9. Closes Chrome completely.
 *
 * Resilience guarantee:
 * - If automation times out or errors, live stream start is NEVER permanently blocked.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

let _activeWorkerProcess = null;
let _currentHealthFlagFile = null;

/**
 * Execute YouTube Studio preparation workflow before launching stream.
 *
 * @param {object} options
 * @param {object} options.settings - Application settings
 * @param {Function} options.onReadyToStream - Callback invoked when panel is ready to accept stream
 * @returns {Promise<boolean>}
 */
export async function prepareYouTubeStudioStream({ settings, onReadyToStream }) {
  const autoCfg = settings.studioAutomation || {};
  if (autoCfg.enabled === false) {
    logger.info('studio_auto.disabled', 'YouTube Studio automation disabled in settings; starting stream directly');
    if (onReadyToStream) await onReadyToStream();
    return true;
  }

  const studioUrl = autoCfg.url || settings.youtube?.studioUrl || 'https://studio.youtube.com/video/xHUulPKBtJs/livestreaming';
  const baseTitle = (autoCfg.baseTitle !== undefined && autoCfg.baseTitle !== '')
    ? autoCfg.baseTitle
    : (settings.youtube?.title || '');
  const timeZone = autoCfg.timezone || settings.scheduler?.timezone || 'Asia/Kolkata';
  const display = autoCfg.display || process.env.DISPLAY || ':10';
  const chromePath = autoCfg.chromePath || process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const userDataDir = autoCfg.userDataDir || process.env.CHROME_USER_DATA_DIR || '/home/ubuntu/.config/google-chrome';
  const previewWaitSec = Number(autoCfg.previewWaitSec ?? 10);
  const timeoutMs = Number(autoCfg.timeoutMs ?? 120000);

  // Check if Chrome binary exists
  if (process.platform === 'linux' && !fs.existsSync(chromePath)) {
    logger.warn('studio_auto.chrome_not_found', `Chrome binary not found at ${chromePath}; skipping automation`);
    if (onReadyToStream) await onReadyToStream();
    return false;
  }

  logger.info('studio_auto.start', 'Starting YouTube Studio browser automation', {
    studioUrl,
    baseTitle,
    timeZone,
    display,
    chromePath,
    previewWaitSec,
  });

  const workerScriptPath = path.join(PATHS.root, 'scripts', 'studio-worker.mjs');

  return new Promise((resolve) => {
    let streamTriggered = false;
    let finished = false;

    // Trigger stream fallback after 45 seconds if worker hasn't emitted ready_to_stream
    const fallbackTimer = setTimeout(async () => {
      if (!streamTriggered) {
        streamTriggered = true;
        logger.warn('studio_auto.fallback_trigger', 'Worker delayed past 45s; triggering stream start fallback');
        try {
          if (onReadyToStream) await onReadyToStream();
        } catch (e) {
          logger.error('studio_auto.fallback_start_error', `Error in fallback stream trigger: ${e.message}`);
        }
      }
    }, 45000);

    // Hard ceiling timeout
    const hardTimeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        logger.warn('studio_auto.hard_timeout', 'Studio automation hit hard timeout; terminating worker');
        if (_activeWorkerProcess) {
          try { _activeWorkerProcess.kill('SIGKILL'); } catch { }
          _activeWorkerProcess = null;
        }
        resolve(true);
      }
    }, timeoutMs);

    // Spawn worker as user ubuntu if on Linux and running as ytlive
    let cmd = process.execPath;
    let args = [workerScriptPath];

    if (process.platform === 'linux') {
      try {
        const userInfo = process.getuid ? process.getuid() : -1;
        // If not running as root or ubuntu, use sudo -u ubuntu
        if (userInfo !== 0 && userInfo !== 1001) {
          cmd = 'sudo';
          args = ['-u', 'ubuntu', process.execPath, workerScriptPath];
        }
      } catch { }
    }

    const healthFlagFile = `/tmp/yt-studio-healthy-${Date.now()}.flag`;
  _currentHealthFlagFile = healthFlagFile;

  const workerEnv = {
      ...process.env,
      STUDIO_URL: studioUrl,
      STUDIO_BASE_TITLE: baseTitle,
      STUDIO_TIMEZONE: timeZone,
      STUDIO_PREVIEW_WAIT_SEC: String(previewWaitSec),
      STUDIO_TIMEOUT_MS: String(timeoutMs),
      CHROME_BIN: chromePath,
      CHROME_USER_DATA_DIR: userDataDir,
      DISPLAY: display,
      STUDIO_HEALTH_FLAG_FILE: healthFlagFile,
    };

    logger.info('studio_auto.spawn', `Spawning worker: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      env: workerEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    _activeWorkerProcess = child;

    let stdoutBuffer = '';
    child.stdout.on('data', async (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop(); // keep last unfinished line

      for (const line of lines) {
        if (line.includes('__STUDIO_EVENT__:')) {
          try {
            const jsonPart = line.substring(line.indexOf('__STUDIO_EVENT__:') + '__STUDIO_EVENT__:'.length).trim();
            const payload = JSON.parse(jsonPart);

            if (payload.event === 'ready_to_stream') {
              if (!streamTriggered) {
                streamTriggered = true;
                clearTimeout(fallbackTimer);
                logger.info('studio_auto.ready_to_stream', 'Received ready_to_stream event from browser worker');
                try {
                  if (onReadyToStream) await onReadyToStream();
                } catch (e) {
                  logger.error('studio_auto.stream_trigger_error', `Error triggering stream start: ${e.message}`);
                }
              }
            } else if (payload.event === 'finished') {
              logger.info('studio_auto.finished', 'Browser worker finished automation', payload);
            }
          } catch (e) {
            logger.warn('studio_auto.event_parse_error', `Failed to parse event: ${e.message}`);
          }
        } else if (line.includes('[STUDIO_WORKER]')) {
          logger.info('studio_auto.worker_log', line.trim());
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const errStr = chunk.toString().trim();
      if (errStr) {
        logger.warn('studio_auto.worker_stderr', errStr);
      }
    });

    child.on('exit', async (code, signal) => {
      _activeWorkerProcess = null;
      clearTimeout(fallbackTimer);
      clearTimeout(hardTimeout);

      if (!streamTriggered) {
        streamTriggered = true;
        logger.warn('studio_auto.early_exit', `Worker exited (${code || signal}) before stream trigger; triggering now`);
        try {
          if (onReadyToStream) await onReadyToStream();
        } catch (e) {
          logger.error('studio_auto.exit_trigger_error', `Error triggering stream on exit: ${e.message}`);
        }
      }

      if (!finished) {
        finished = true;
        logger.info('studio_auto.worker_exited', `Browser worker exited with code ${code}, signal ${signal}`);
        resolve(code === 0);
      }
    });

    child.on('error', async (err) => {
      logger.error('studio_auto.worker_spawn_error', `Failed to spawn worker: ${err.message}`);
      if (!streamTriggered) {
        streamTriggered = true;
        clearTimeout(fallbackTimer);
        try {
          if (onReadyToStream) await onReadyToStream();
        } catch { }
      }
      if (!finished) {
        finished = true;
        clearTimeout(hardTimeout);
        resolve(false);
      }
    });
  });
}

/**
 * Kill any running browser worker process.
 */
export function abortYouTubeStudioWorker() {
  if (_activeWorkerProcess) {
    try {
      _activeWorkerProcess.kill('SIGTERM');
    } catch { }
    _activeWorkerProcess = null;
  }
}

/**
 * Signal to studio-worker that FFmpeg stream is healthy.
 * Called by stream-manager when RTMPS connection is confirmed.
 * Worker polls a flag file and exits Chrome immediately on detection.
 */
export function signalStudioStreamHealthy() {
  if (_currentHealthFlagFile) {
    try {
      fs.writeFileSync(_currentHealthFlagFile, '1');
      logger.info('studio_auto.health_signal_sent', 'FFmpeg healthy signal written to flag file for studio-worker');
    } catch (e) {
      logger.warn('studio_auto.health_signal_error', `Could not write health flag: ${e.message}`);
    }
    _currentHealthFlagFile = null;
  }
}
