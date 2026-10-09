/**
 * Strict YouTube Studio automation gate. The stream is launched only after the
 * worker verifies the saved title, and this function resolves only after Studio
 * confirms the broadcast is live.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

let _activeWorkerProcess = null;

function asError(message, code = 'E_STUDIO_AUTOMATION') {
  return Object.assign(new Error(message), { code });
}

export async function prepareYouTubeStudioStream({ settings, onReadyToStream }) {
  const autoCfg = settings.studioAutomation || {};
  if (autoCfg.enabled === false) {
    throw asError('Studio automation was called while disabled; direct-start is not an automation fallback');
  }
  if (process.platform !== 'linux') {
    throw asError(`Studio automation requires Linux, current platform is ${process.platform}`);
  }

  const baseTitle = autoCfg.baseTitle !== undefined && autoCfg.baseTitle !== ''
    ? autoCfg.baseTitle
    : (settings.youtube?.title || '');
  const timeZone = autoCfg.timezone || settings.scheduler?.timezone || 'Asia/Kolkata';
  const display = autoCfg.display || process.env.DISPLAY || ':10';
  const chromePath = autoCfg.chromePath || process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const userDataDir = autoCfg.userDataDir || process.env.CHROME_USER_DATA_DIR || '/home/ubuntu/.config/google-chrome';
  const previewWaitSec = Number(autoCfg.previewWaitSec ?? 10);
  const timeoutMs = Number(autoCfg.timeoutMs ?? 180000);
  const workerScriptPath = path.join(PATHS.root, 'scripts', 'studio-worker.mjs');

  if (!fs.existsSync(chromePath)) throw asError(`Chrome executable was not found: ${chromePath}`, 'E_CHROME_MISSING');
  if (!fs.existsSync(workerScriptPath)) throw asError(`Studio worker was not found: ${workerScriptPath}`);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw asError(`Invalid Studio automation timeout: ${timeoutMs}`);
  if (!onReadyToStream) throw asError('A stream launch callback is required for strict Studio automation');

  logger.info('studio_auto.start', 'Starting strict YouTube Studio automation', {
    baseTitle,
    timeZone,
    display,
    chromePath,
    previewWaitSec,
    timeoutMs,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let readySeen = false;
    let launchResult = null;
    let finishedPayload = null;
    let workerFailure = null;
    let stdoutBuffer = '';
    let outputQueue = Promise.resolve();
    let exitInfo = null;

    const workerEnv = {
      ...process.env,
      STUDIO_BASE_TITLE: baseTitle,
      STUDIO_TIMEZONE: timeZone,
      STUDIO_PREVIEW_WAIT_SEC: String(previewWaitSec),
      STUDIO_TIMEOUT_MS: String(timeoutMs),
      CHROME_BIN: chromePath,
      CHROME_USER_DATA_DIR: userDataDir,
      DISPLAY: display,
    };

    let child;
    let hardTimeout;

    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (_activeWorkerProcess === child) _activeWorkerProcess = null;
      if (err) reject(err);
      else resolve(result);
    };

    const terminateWorker = () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch {}
      }
    };

    const failAndTerminate = err => {
      workerFailure ||= err instanceof Error ? err : new Error(String(err));
      terminateWorker();
      settle(workerFailure);
    };

    try {
      logger.info('studio_auto.spawn', `Spawning strict Studio worker: ${process.execPath} ${workerScriptPath}`);
      child = spawn(process.execPath, [workerScriptPath], {
        env: workerEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      _activeWorkerProcess = child;
    } catch (err) {
      settle(asError(`Could not spawn Studio worker: ${err.message}`, 'E_STUDIO_WORKER_SPAWN'));
      return;
    }

    hardTimeout = setTimeout(() => {
      const err = asError(`Studio automation exceeded ${timeoutMs}ms; stream startup is blocked`, 'E_STUDIO_TIMEOUT');
      workerFailure = err;
      terminateWorker();
      settle(err);
    }, timeoutMs + 5000);

    const sendLaunchAck = (ok, payload = {}) => {
      if (!child.stdin || child.stdin.destroyed) {
        throw asError('Studio worker control channel closed before launch acknowledgement');
      }
      child.stdin.write(`${JSON.stringify({ event: 'stream_launch_ack', ok, ...payload })}\n`);
      child.stdin.end();
    };

    const processLine = async line => {
      if (line.includes('[STUDIO_WORKER]')) logger.info('studio_auto.worker_log', line.trim());
      const marker = '__STUDIO_EVENT__:';
      const markerAt = line.indexOf(marker);
      if (markerAt < 0) return;

      let payload;
      try {
        payload = JSON.parse(line.slice(markerAt + marker.length).trim());
      } catch (err) {
        throw asError(`Invalid event from Studio worker: ${err.message}`);
      }

      if (payload.event === 'ready_to_stream') {
        if (readySeen) throw asError('Studio worker sent duplicate ready_to_stream events');
        if (payload.titleVerified !== true || typeof payload.title !== 'string' || !payload.title.trim()) {
          throw asError('Studio worker requested stream launch without an explicitly verified title');
        }
        readySeen = true;
        logger.info('studio_auto.ready_to_stream', 'Persisted Studio title was verified; requesting FFmpeg startup', {
          title: payload.title,
        });
        try {
          const result = await onReadyToStream();
          if (!result?.started) {
            throw asError(result?.message || 'Stream manager did not confirm FFmpeg startup', result?.code || 'E_STREAM_START_FAILED');
          }
          launchResult = result;
          sendLaunchAck(true, { pid: result.pid });
          logger.info('studio_auto.stream_launch_verified', 'RTMPS publisher reached healthy output; allowing Studio checks to continue', {
            pid: result.pid,
          });
        } catch (err) {
          workerFailure = asError(`Stream launch did not pass health checks: ${err.message}`, err.code || 'E_STREAM_START_FAILED');
          try { sendLaunchAck(false, { error: workerFailure.message }); } catch {}
        }
        return;
      }

      if (payload.event === 'finished') {
        finishedPayload = payload;
        if (!payload.success) workerFailure = asError(payload.error || 'Studio worker reported a failed stage');
        if (payload.success && (payload.titleVerified !== true || payload.liveVerified !== true)) {
          workerFailure = asError('Studio worker finished without verified title and live-state confirmations');
        }
        logger.info('studio_auto.finished', 'Studio worker reported its final stage', payload);
      }
    };

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        outputQueue = outputQueue.then(() => processLine(line)).catch(err => {
          failAndTerminate(err);
        });
      }
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString().trim();
      if (text) logger.error('studio_auto.worker_stderr', text);
    });

    child.on('error', err => {
      failAndTerminate(asError(`Studio worker process error: ${err.message}`, 'E_STUDIO_WORKER_SPAWN'));
    });

    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      if (_activeWorkerProcess === child) _activeWorkerProcess = null;
      outputQueue = outputQueue.then(() => {
        if (settled) return;
        if (workerFailure) {
          settle(workerFailure);
          return;
        }
        if (code !== 0 || signal) {
          settle(asError(`Studio worker exited before success (code=${code}, signal=${signal || 'none'})`));
          return;
        }
        if (!readySeen || !launchResult?.started || finishedPayload?.success !== true ||
            finishedPayload?.titleVerified !== true || finishedPayload?.liveVerified !== true) {
          settle(asError('Studio worker exited without completing every verified startup stage'));
          return;
        }
        logger.info('studio_auto.worker_exited', 'All Studio and stream startup gates passed', exitInfo);
        settle(null, { ...launchResult, studioVerified: true });
      }).catch(err => settle(err));
    });
  });
}

export function abortYouTubeStudioWorker() {
  if (_activeWorkerProcess && _activeWorkerProcess.exitCode === null) {
    try { _activeWorkerProcess.kill('SIGTERM'); } catch {}
    _activeWorkerProcess = null;
  }
}
