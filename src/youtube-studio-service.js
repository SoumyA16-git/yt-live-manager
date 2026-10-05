/**
 * youtube-studio-service.js — Centralized YouTube Studio automation via Real Google Chrome & CDP.
 *
 * Architecture:
 * - Launches REAL Google Chrome binary (not Playwright bundled Chromium) with a dedicated user-data-dir.
 * - Starts Chrome with localhost-only remote debugging: --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
 * - Connects Playwright over CDP: chromium.connectOverCDP("http://127.0.0.1:9222")
 * - Bypasses Google's "This browser or app may not be secure" block.
 * - Detects authentication state (flags YOUTUBE_AUTH_REQUIRED if Google login is needed).
 * - Dismisses "previous stream ended" / "stream finished" popups dynamically.
 * - Verifies the Live Control Room is fresh and ready for encoder ingest (YOUTUBE_FRESH_STREAM_READY).
 * - Gates FFmpeg start: FFmpeg only spawns after YouTube Studio is confirmed ready.
 * - Keeps Chrome open until YouTube confirms encoder ingest / preview data.
 * - Completely terminates Chrome process immediately after confirmation (never runs 24/7).
 * - Scoped Chrome PID tracking: kills ONLY this automation instance if orphaned.
 * - Async in-memory mutex: prevents concurrent browser sessions.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';
import { getSettings } from './config-manager.js';
import { saveState } from './state-manager.js';
import { getChromeExecutablePath } from './lib/chrome-finder.js';

// ─── Module State & Mutex ───────────────────────────────────────────────────

let _browserMutex = Promise.resolve();
let _trackedBrowserPid = null;

export const YOUTUBE_STATES = Object.freeze({
  IDLE: 'IDLE',
  YOUTUBE_STUDIO_OPEN: 'YOUTUBE_STUDIO_OPEN',
  YOUTUBE_PREVIOUS_STREAM_DIALOG: 'YOUTUBE_PREVIOUS_STREAM_DIALOG',
  YOUTUBE_FRESH_STREAM_READY: 'YOUTUBE_FRESH_STREAM_READY',
  YOUTUBE_OLD_OR_ENDED_STREAM: 'YOUTUBE_OLD_OR_ENDED_STREAM',
  YOUTUBE_AUTH_REQUIRED: 'YOUTUBE_AUTH_REQUIRED',
  YOUTUBE_PREPARATION_FAILED: 'YOUTUBE_PREPARATION_FAILED',
  WAITING_FOR_YOUTUBE_PREVIEW: 'WAITING_FOR_YOUTUBE_PREVIEW',
});

/**
 * Scoped process cleanup: terminates only the tracked Chrome PID belonging
 * to this automation instance if still alive after context.close().
 */
async function cleanupScopedChromiumPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 0); // check if alive
    logger.warn('youtube.browser.orphan_detected', `Chrome PID ${pid} still running after close; sending SIGTERM`);
    process.kill(pid, 'SIGTERM');
    await new Promise(r => setTimeout(r, 600));
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // exited
    }
  } catch {
    // process already exited cleanly
  }
}

/**
 * Acquire in-memory mutex to ensure strictly serialized browser launches.
 */
function acquireBrowserLock() {
  let release;
  const nextLock = new Promise(resolve => {
    release = resolve;
  });
  const currentLock = _browserMutex;
  _browserMutex = _browserMutex.then(() => nextLock);
  return currentLock.then(() => release);
}

/**
 * Polls the Chrome DevTools HTTP endpoint until it answers.
 */
function waitForCdpEndpoint(port, timeoutMs = 20000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, res => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          retry();
        }
      });
      req.on('error', () => {
        retry();
      });
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Timed out waiting for Chrome remote debugging on port ${port}`));
      } else {
        setTimeout(check, 300);
      }
    };

    check();
  });
}

// ─── Core Service Class ─────────────────────────────────────────────────────

export class YouTubeStudioAutomationService {
  /**
   * Central entry point called before starting FFmpeg.
   *
   * @param {object} [options]
   * @param {string} [options.reason='manual_start']
   * @param {object} [options.injectedPlaywright] For test mocking
   * @returns {Promise<{
   *   sessionState: string,
   *   confirmIngestAndClose: (opts?: { timeoutMs?: number }) => Promise<{ success: boolean }>,
   *   abort: (err?: Error) => Promise<void>
   * }>}
   */
  static async prepareNextLiveSession(options = {}) {
    const { reason = 'manual_start', injectedPlaywright = null } = options;
    const settings = getSettings();
    const studioCfg = settings.youtube?.studioAutomation || {};

    // 1. Bypass during unit test mode unless an injected mock playwright is provided
    if (process.env.NODE_ENV === 'test' && !injectedPlaywright && studioCfg.bypassInTest !== false) {
      logger.info('youtube.prepare.test_bypass', `Bypassing YouTube Studio preparation in NODE_ENV=test (reason: ${reason})`);
      await saveState({ stage: 'STARTING_FFMPEG', youtubeStatus: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY });
      return {
        sessionState: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY,
        confirmIngestAndClose: async () => {
          logger.info('youtube.preview.test_bypass', 'Bypassing ingest confirmation in NODE_ENV=test');
          return { success: true };
        },
        abort: async () => {},
      };
    }

    if (studioCfg.enabled === false) {
      logger.info('youtube.prepare.disabled', `YouTube Studio automation is disabled in settings; proceeding directly`);
      await saveState({ stage: 'STARTING_FFMPEG', youtubeStatus: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY });
      return {
        sessionState: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY,
        confirmIngestAndClose: async () => ({ success: true }),
        abort: async () => {},
      };
    }

    logger.info('youtube.prepare.start', `Starting YouTube Studio preparation (reason: ${reason})`);
    await saveState({ stage: 'PREPARING_YOUTUBE', youtubeStatus: YOUTUBE_STATES.IDLE });

    const releaseLock = await acquireBrowserLock();
    let chromeProc = null;
    let browserCdp = null;
    let page = null;
    let browserPid = null;

    try {
      // 2. Resolve Playwright library
      let pw = injectedPlaywright;
      if (!pw) {
        try {
          pw = await import('playwright');
        } catch (importErr) {
          logger.error('youtube.browser.missing_dependency', `Playwright package is not installed: ${importErr.message}`);
          throw new Error(`Playwright is not installed. Please run "npm install playwright"`);
        }
      }

      const profileDir = PATHS.youtubeProfile;
      await fs.mkdir(profileDir, { recursive: true });

      const isHeadless = studioCfg.headless !== false && process.env.YOUTUBE_HEADLESS !== 'false';
      const prepareTimeoutMs = studioCfg.prepareTimeoutMs || 90000;
      const previewTimeoutMs = studioCfg.previewTimeoutMs || 45000;
      const cdpPort = studioCfg.remoteDebuggingPort || 9222;

      // 3. Launch REAL Google Chrome process
      if (!injectedPlaywright || !injectedPlaywright._skipChromeSpawn) {
        const chromePath = getChromeExecutablePath();
        logger.info('youtube.browser.launching_real_chrome', `Launching real Google Chrome on port ${cdpPort}: ${chromePath}`, {
          profileDir,
          headless: isHeadless,
          cdpPort,
        });

        const chromeArgs = [
          `--user-data-dir=${profileDir}`,
          `--remote-debugging-port=${cdpPort}`,
          '--remote-debugging-address=127.0.0.1',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--js-flags=--max-old-space-size=256',
        ];

        if (isHeadless) {
          chromeArgs.push('--headless=new');
        }

        chromeProc = spawn(chromePath, chromeArgs, {
          stdio: 'ignore',
          detached: false,
        });

        browserPid = chromeProc.pid;
        _trackedBrowserPid = browserPid;
        logger.info('youtube.browser.spawned', `Real Google Chrome spawned with PID ${browserPid}`);

        // Wait for CDP endpoint to answer
        await waitForCdpEndpoint(cdpPort, 20000);
      }

      // 4. Connect Playwright using connectOverCDP
      const chromium = pw.chromium || pw;
      logger.info('youtube.cdp.connecting', `Connecting Playwright over CDP to http://127.0.0.1:${cdpPort}`);

      if (typeof chromium.connectOverCDP === 'function') {
        browserCdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
        const contexts = browserCdp.contexts();
        const context = contexts.length > 0 ? contexts[0] : await browserCdp.newContext();
        const pages = context.pages();
        page = pages.length > 0 ? pages[0] : await context.newPage();
      } else if (typeof chromium.launchPersistentContext === 'function') {
        // Mock fallback for test harnesses that provide launchPersistentContext
        browserCdp = await chromium.launchPersistentContext(profileDir, { headless: isHeadless });
        const pages = browserCdp.pages();
        page = pages.length > 0 ? pages[0] : await browserCdp.newPage();
      } else {
        throw new Error('Playwright chromium does not support connectOverCDP or launchPersistentContext');
      }

      // Collect console logs for diagnostic evidence without screenshots
      const recentConsoleLogs = [];
      page.on('console', msg => {
        recentConsoleLogs.push(`[${msg.type()}] ${msg.text()}`);
        if (recentConsoleLogs.length > 30) recentConsoleLogs.shift();
      });

      // 5. Navigate to YouTube Studio Live Control Room
      const targetUrl = studioCfg.channelUrl?.trim() || 'https://studio.youtube.com/live';
      logger.info('youtube.navigation.start', `Navigating to YouTube Studio: ${targetUrl}`);
      await saveState({ youtubeStatus: YOUTUBE_STATES.YOUTUBE_STUDIO_OPEN });

      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: prepareTimeoutMs,
      });

      // Allow initial dynamic components to settle
      await page.waitForTimeout(2000);

      // 6. Authentication check
      const currentUrl = page.url();
      if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin') || currentUrl.includes('ServiceLogin')) {
        logger.error('youtube.auth.required', `Google authentication required. Current URL: ${currentUrl}`);
        await saveState({
          youtubeStatus: YOUTUBE_STATES.YOUTUBE_AUTH_REQUIRED,
          stage: 'YOUTUBE_AUTH_REQUIRED',
          lastError: {
            code: 'YOUTUBE_AUTH_REQUIRED',
            message: 'YouTube/Google authentication required. Please run: npm run youtube:login on server.',
            at: new Date().toISOString(),
          },
        });
        const err = new Error('YOUTUBE_AUTH_REQUIRED: Please run "npm run youtube:login" on server to authenticate.');
        err.code = 'YOUTUBE_AUTH_REQUIRED';
        throw err;
      }

      logger.info('youtube.auth.ok', 'YouTube Studio authentication validated successfully');

      // 7. Inspect & dismiss "previous stream ended" / "stream finished" dialog
      await this._handlePreviousStreamDialog(page);

      // 8. Inspect Live Control Room state
      const roomState = await this._inspectLiveControlRoomState(page);
      logger.info('youtube.room.state', `Live Control Room evaluated: ${roomState.state}`, {
        url: page.url(),
        details: roomState.details,
      });

      if (roomState.state === YOUTUBE_STATES.YOUTUBE_OLD_OR_ENDED_STREAM) {
        logger.warn('youtube.room.ended_stream_detected', `Detected old/ended stream. Attempting re-navigation to /live`);
        await page.goto('https://studio.youtube.com/live', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        await this._handlePreviousStreamDialog(page);
        const retryState = await this._inspectLiveControlRoomState(page);
        if (retryState.state !== YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY) {
          const err = new Error(`YOUTUBE_OLD_OR_ENDED_STREAM: Page remains stuck on an old/ended stream. Details: ${retryState.details}`);
          err.code = 'YOUTUBE_OLD_OR_ENDED_STREAM';
          throw err;
        }
      } else if (roomState.state !== YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY) {
        const err = new Error(`YOUTUBE_STREAM_NOT_READY: Live Control Room is not ready. Observed: ${roomState.state} (${roomState.details})`);
        err.code = 'YOUTUBE_STREAM_NOT_READY';
        throw err;
      }

      logger.info('youtube.stream.prepare.ok', 'Live Control Room is fresh and ready for encoder ingest. Opening FFmpeg start gate.');
      await saveState({
        youtubeStatus: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY,
        stage: 'STARTING_FFMPEG',
      });

      // 9. Construct Two-Phase Session Handle
      let sessionClosed = false;

      const confirmIngestAndClose = async (confirmOpts = {}) => {
        if (sessionClosed) return { success: true };
        const timeout = confirmOpts.timeoutMs || previewTimeoutMs;
        logger.info('youtube.preview.waiting', `Waiting up to ${timeout}ms for YouTube encoder ingest / preview confirmation...`);
        await saveState({
          youtubeStatus: YOUTUBE_STATES.WAITING_FOR_YOUTUBE_PREVIEW,
          stage: 'WAITING_FOR_YOUTUBE_PREVIEW',
        });

        try {
          const ingestConfirmed = await this._waitForEncoderIngest(page, timeout);
          if (!ingestConfirmed) {
            const err = new Error(`YOUTUBE_PREVIEW_TIMEOUT: YouTube did not confirm encoder ingest within ${timeout}ms`);
            err.code = 'YOUTUBE_PREVIEW_TIMEOUT';
            throw err;
          }

          logger.info('youtube.preview.ready', 'Encoder ingest confirmed live by YouTube Studio. Closing Chrome.');
          await saveState({
            youtubeStatus: 'RUNNING',
            stage: 'RUNNING',
          });
          return { success: true };
        } catch (confirmErr) {
          logger.error('youtube.preview.failed', `Ingest confirmation failed: ${confirmErr.message}`, {
            url: page ? page.url() : 'unknown',
            recentLogs: recentConsoleLogs.slice(-10),
          });
          throw confirmErr;
        } finally {
          sessionClosed = true;
          await this._safeCloseBrowser(browserCdp, chromeProc, browserPid);
          browserCdp = null;
          chromeProc = null;
          releaseLock();
        }
      };

      const abort = async (abortErr) => {
        if (sessionClosed) return;
        sessionClosed = true;
        logger.warn('youtube.session.aborted', `Session aborted: ${abortErr?.message || 'unknown'}`);
        await this._safeCloseBrowser(browserCdp, chromeProc, browserPid);
        browserCdp = null;
        chromeProc = null;
        releaseLock();
      };

      return {
        sessionState: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY,
        confirmIngestAndClose,
        abort,
      };

    } catch (prepErr) {
      logger.error('youtube.prepare.error', `YouTube Studio preparation failed: ${prepErr.message}`, {
        code: prepErr.code || 'YOUTUBE_PREPARATION_FAILED',
        url: page ? page.url() : null,
      });

      await saveState({
        youtubeStatus: prepErr.code || YOUTUBE_STATES.YOUTUBE_PREPARATION_FAILED,
        stage: prepErr.code === 'YOUTUBE_AUTH_REQUIRED' ? 'YOUTUBE_AUTH_REQUIRED' : 'ERROR',
        lastError: {
          code: prepErr.code || 'YOUTUBE_PREPARATION_FAILED',
          message: prepErr.message,
          at: new Date().toISOString(),
        },
      });

      await this._safeCloseBrowser(browserCdp, chromeProc, browserPid);
      releaseLock();
      throw prepErr;
    }
  }

  // ─── Helper: Dismiss Previous Stream Ended Dialog ─────────────────────────

  static async _handlePreviousStreamDialog(page) {
    logger.info('youtube.previous_dialog.inspecting', 'Checking for stream-ended / previous-session modal dialog');

    const dialogSelectors = [
      'tp-yt-paper-dialog',
      'ytcp-dialog',
      '[role="dialog"]',
      '.ytcp-dialog',
    ];

    for (const selector of dialogSelectors) {
      try {
        const dialogs = await page.$$(selector);
        for (const dialog of dialogs) {
          const isVisible = await dialog.isVisible();
          if (!isVisible) continue;

          const text = (await dialog.innerText()).toLowerCase();
          if (text.includes('stream ended') || text.includes('stream finished') || text.includes('edit in studio') || text.includes('dismiss') || text.includes('close')) {
            logger.info('youtube.previous_dialog.detected', `Found visible stream-ended dialog (${selector})`);
            await saveState({ youtubeStatus: YOUTUBE_STATES.YOUTUBE_PREVIOUS_STREAM_DIALOG });

            // Look for Dismiss / Close button
            const buttons = await dialog.$$('button, tp-yt-paper-button, [role="button"]');
            let clicked = false;
            for (const btn of buttons) {
              const bText = (await btn.innerText()).trim().toLowerCase();
              const aria = ((await btn.getAttribute('aria-label')) || '').toLowerCase();
              if (bText === 'dismiss' || bText === 'close' || bText === 'done' || aria.includes('close') || aria.includes('dismiss')) {
                logger.info('youtube.previous_dialog.dismissing', `Clicking dialog dismiss button: "${bText || aria}"`);
                await btn.click();
                clicked = true;
                await page.waitForTimeout(1000);
                break;
              }
            }

            if (!clicked) {
              logger.info('youtube.previous_dialog.fallback_escape', 'Dismissing dialog via Escape key');
              await page.keyboard.press('Escape');
              await page.waitForTimeout(500);
            }

            logger.info('youtube.previous_dialog.dismissed', 'Previous stream dialog dismissed');
          }
        }
      } catch (err) {
        logger.warn('youtube.previous_dialog.check_warning', `Dialog inspect warning: ${err.message}`);
      }
    }
  }

  // ─── Helper: Inspect Live Control Room State ──────────────────────────────

  static async _inspectLiveControlRoomState(page) {
    const currentUrl = page.url();
    const bodyText = (await page.innerText('body')).toLowerCase();

    // 1. Detect if page indicates an old ended stream
    const endedIndicators = [
      'stream has ended',
      'this stream has ended',
      'broadcast has ended',
      'stream completed',
    ];
    if (endedIndicators.some(phrase => bodyText.includes(phrase))) {
      return {
        state: YOUTUBE_STATES.YOUTUBE_OLD_OR_ENDED_STREAM,
        details: 'Page text explicitly states stream has ended',
      };
    }

    // 2. Fresh usable Live Control Room indicators:
    const freshReadyIndicators = [
      'connect your encoder to go live',
      'connect streaming software to go live',
      'connect your encoder',
      'waiting for video',
      'waiting for live stream',
      'no data',
      'default stream key',
      'stream settings',
      'stream url',
    ];

    const matchedIndicators = freshReadyIndicators.filter(phrase => bodyText.includes(phrase));

    if (matchedIndicators.length >= 2 || bodyText.includes('connect your encoder') || bodyText.includes('stream settings')) {
      return {
        state: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY,
        details: `Matched indicators: ${matchedIndicators.join(', ')}`,
      };
    }

    // Check if player / control room container exists
    const hasLivePlayer = (await page.$('#live-player, .live-player-container, ytcp-live-preview')) !== null;
    const hasStreamSettings = (await page.$('#stream-settings, ytcp-stream-settings-tab')) !== null;

    if (hasLivePlayer || hasStreamSettings) {
      return {
        state: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY,
        details: `Found Live Control Room components (player: ${hasLivePlayer}, settings: ${hasStreamSettings})`,
      };
    }

    return {
      state: YOUTUBE_STATES.YOUTUBE_PREPARATION_FAILED,
      details: `Live Control Room UI elements not found. URL: ${currentUrl}`,
    };
  }

  // ─── Helper: Wait for Encoder Ingest & Preview Data ───────────────────────

  static async _waitForEncoderIngest(page, timeoutMs) {
    const startTime = Date.now();
    const checkInterval = 2000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const bodyText = (await page.innerText('body')).toLowerCase();

        const liveIndicators = [
          'excellent connection',
          'good connection',
          'incoming stream',
          'receiving video',
          'stream health',
        ];

        const hasConnectionSignal = liveIndicators.some(sig => bodyText.includes(sig)) ||
          (/\b(you're live|stream is live|broadcasting live)\b/i.test(bodyText));

        const noDataPresent = bodyText.includes('no data') && !bodyText.includes('excellent connection');

        const videoReceiving = await page.evaluate(() => {
          const video = document.querySelector('video');
          if (video && video.videoWidth > 0 && video.videoHeight > 0) return true;
          const healthBadge = document.querySelector('[aria-label*="connection"], [aria-label*="Connection"]');
          if (healthBadge) return true;
          return false;
        }).catch(() => false);

        if (hasConnectionSignal || (videoReceiving && !noDataPresent)) {
          logger.info('youtube.preview.detected', `Confirmed encoder data arriving in YouTube Studio`, {
            hasConnectionSignal,
            videoReceiving,
            elapsedMs: Date.now() - startTime,
          });
          return true;
        }
      } catch (err) {
        logger.warn('youtube.preview.check_err', `Polling preview error: ${err.message}`);
      }

      await page.waitForTimeout(checkInterval);
    }

    return false;
  }

  // ─── Helper: Safe Scoped Browser Close ────────────────────────────────────

  static async _safeCloseBrowser(browserCdp, chromeProc, browserPid) {
    if (browserCdp) {
      logger.info('youtube.cdp.closing', 'Closing Playwright CDP browser connection');
      try {
        await browserCdp.close();
      } catch (err) {
        logger.warn('youtube.cdp.close_warning', `Error during browser.close(): ${err.message}`);
      }
    }

    if (chromeProc) {
      logger.info('youtube.browser.stopping', 'Terminating real Google Chrome process');
      try {
        chromeProc.kill('SIGTERM');
      } catch (err) {
        logger.warn('youtube.browser.kill_warning', `Error stopping Chrome process: ${err.message}`);
      }
    }

    if (browserPid) {
      await cleanupScopedChromiumPid(browserPid);
    }

    _trackedBrowserPid = null;
    logger.info('youtube.browser.closed', 'Real Google Chrome terminated cleanly');
  }
}
