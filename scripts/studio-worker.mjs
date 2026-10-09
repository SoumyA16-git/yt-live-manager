/**
 * scripts/studio-worker.mjs
 *
 * Standalone worker to automate YouTube Studio in Google Chrome:
 * 1. Syncs Chrome profile to non-default directory so remote debugging is allowed.
 * 2. Launches Chrome on DISPLAY=:10 with user-data-dir and remote-debugging-port=9222.
 * 3. Connects via CDP (http://127.0.0.1:9222).
 * 4. Navigates to YouTube Live Stream Control Room URL.
 * 5. Dismisses any "Stream Finished" or other popup modals.
 * 6. Waits for control panel to settle.
 * 7. Clicks "Edit" (#edit-button) in Title section (with robust retry & visibility checks).
 * 8. Updates title in div#textbox (baseTitle + current date + current time, max 100 chars).
 *    Uses execCommand + InputEvent + real Puppeteer keystrokes to guarantee YouTube's
 *    Polymer/Angular dirty-state triggers and enables the Save button.
 * 9. Clicks "Save" (#save-button) with retry loop until save completes & modal closes.
 * 10. Emits "ready_to_stream" over stdout IPC -> FFmpeg stream launches!
 * 11. Waits for live preview stream in YouTube Studio.
 * 12. Waits configured seconds after preview appears.
 * 13. Closes Chrome completely.
 */

import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

function log(step, message, extra = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    step,
    message,
    ...extra
  });
  console.log(`[STUDIO_WORKER] ${line}`);
}

function emitEvent(event, data = {}) {
  console.log(`__STUDIO_EVENT__:${JSON.stringify({ event, ...data })}`);
}

/**
 * Format current date & time in IST / configured timezone.
 * Returns dateStr (e.g. 09-10-2026), timeStr (e.g. 07:15 PM), and full.
 */
function getFormattedDateTime(timeZone = 'Asia/Kolkata') {
  const now = new Date();
  const dFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const tFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  const dateStr = dFormatter.format(now).replace(/\//g, '-');
  // Normalize narrow no-break space (\u202f) to regular space if present
  const timeStr = tFormatter.format(now).replace(/[\u202f\xa0]/g, ' ');
  return { dateStr, timeStr, full: `${dateStr} ${timeStr}` };
}

/**
 * Robust multi-pass base title cleaner.
 * Strips previous trailing dates, times, AM/PM, delimiters from existing title.
 */
function cleanBaseTitle(title) {
  if (!title) return '';
  let str = title.trim();

  // Run in loop to strip multiple accumulated dates/times
  for (let pass = 0; pass < 3; pass++) {
    const prev = str;
    str = str
      // Strip trailing date + time e.g. "09-10-2026 07:15 PM" or "09/10/2026 19:15:00"
      .replace(/[\s\-_|•:]*(\d{1,4}[-/]\d{1,2}[-/]\d{2,4})([\s\u202f,]+(\d{1,2}:\d{2}(:\d{2})?([\s\u202f]*(AM|PM|am|pm))?))?[\s\-_|•:]*$/i, '')
      // Strip standalone trailing time e.g. "07:15 PM"
      .replace(/[\s\-_|•:]*(\d{1,2}:\d{2}(:\d{2})?([\s\u202f]*(AM|PM|am|pm))?)[\s\-_|•:]*$/i, '')
      // Strip trailing lonely date
      .replace(/[\s\-_|•:]*(\d{1,4}[-/]\d{1,2}[-/]\d{2,4})[\s\-_|•:]*$/i, '')
      .trim();
    if (str === prev) break;
  }

  return str.trim();
}

/**
 * Dismiss any blocking popup modals in YouTube Studio (e.g. Stream Finished).
 */
async function dismissAnyModals(page) {
  try {
    const dismissed = await page.evaluate(() => {
      // 1. Look for dialogs specifically for "Stream finished"
      const dialogs = Array.from(document.querySelectorAll('ytcp-dialog, [role="dialog"], ytcp-confirmation-dialog'));
      for (const d of dialogs) {
        if (d.closest('ytcp-video-metadata-editor') || d.querySelector('ytcp-social-suggestions-textbox')) {
          continue;
        }

        const text = (d.innerText || '').toLowerCase();
        if (text.includes('stream finished') || text.includes('stream ended') || text.includes('stream stats')) {
          const btn = d.querySelector('#dismiss-button, button[aria-label="Dismiss"], ytcp-button#dismiss-button, button');
          if (btn) {
            const inner = btn.querySelector('button') || btn;
            inner.click();
            btn.click();
            return true;
          }
        }
      }

      // 2. Standalone dismiss button not inside metadata editor
      const dismissBtn = document.querySelector('ytcp-button#dismiss-button, button#dismiss-button');
      if (dismissBtn && !dismissBtn.closest('ytcp-video-metadata-editor, ytcp-live-metadata-editor')) {
        const inner = dismissBtn.querySelector('button') || dismissBtn;
        inner.click();
        dismissBtn.click();
        return true;
      }

      return false;
    });

    if (dismissed) {
      log('dismiss_clicked', 'Dismissed stream finished popup modal');
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    log('dismiss_error', `Non-fatal dismiss check error: ${err.message}`);
  }
}

async function retryControlRoomIfNeeded(page) {
  const clicked = await page.evaluate(() => {
    function findRetryButton(root) {
      const candidates = Array.from(root.querySelectorAll?.('#error-retry-button, [id*="retry-button"], [aria-label*="retry" i], button, ytcp-button') || []);
      for (const candidate of candidates) {
        const label = `${candidate.id || ''} ${candidate.getAttribute('aria-label') || ''} ${candidate.innerText || candidate.textContent || ''}`.toLowerCase();
        if (!label.includes('retry')) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return candidate;
      }

      for (const element of Array.from(root.querySelectorAll?.('*') || [])) {
        if (element.shadowRoot) {
          const nested = findRetryButton(element.shadowRoot);
          if (nested) return nested;
        }
      }
      return null;
    }

    const button = findRetryButton(document);
    if (!button) return false;
    const inner = button.shadowRoot?.querySelector('button') || button.querySelector('button');
    (inner || button).click();
    return true;
  });

  if (clicked) {
    log('control_room_retry', 'Clicked YouTube Studio retry control after detecting a page error');
    await new Promise(r => setTimeout(r, 5000));
    return true;
  }
  return false;
}

async function run() {
  const targetUrl = process.env.STUDIO_URL || 'https://studio.youtube.com/video/I9B8mog4d7c/livestreaming';
  const configuredBaseTitle = process.env.STUDIO_BASE_TITLE || '';
  const timeZone = process.env.STUDIO_TIMEZONE || 'Asia/Kolkata';
  const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const primaryProfileDir = process.env.CHROME_USER_DATA_DIR || '/home/ubuntu/.config/google-chrome';
  const activeUserDataDir = process.env.CHROME_ACTIVE_DATA_DIR || '/home/ubuntu/.config/google-chrome-studio';
  const display = process.env.DISPLAY || ':10';
  const previewWaitSec = Number(process.env.STUDIO_PREVIEW_WAIT_SEC) || 10;
  const timeoutMs = Number(process.env.STUDIO_TIMEOUT_MS) || 120000;
  const debugPort = 9222;

  // Flag set externally by parent process (via IPC file) when FFmpeg is confirmed healthy
  let _streamHealthySignalled = false;
  const healthFlagFile = process.env.STUDIO_HEALTH_FLAG_FILE || '';
  // Poll the health flag file every 1s
  const healthPollInterval = setInterval(() => {
    if (healthFlagFile && fs.existsSync(healthFlagFile)) {
      _streamHealthySignalled = true;
    }
  }, 1000);

  // Global safety watchdog to ensure process terminates
  const watchdog = setTimeout(() => {
    log('watchdog_timeout', 'Safety watchdog triggered after timeout; exiting');
    try { execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' }); } catch {}
    process.exit(0);
  }, timeoutMs);

  log('start', 'Preparing Chrome profile for YouTube Studio automation', {
    targetUrl,
    display,
    chromePath,
    primaryProfileDir,
    activeUserDataDir,
    port: debugPort
  });

  // 1. Sync profile to non-default dir for remote debugging compatibility
  try {
    fs.mkdirSync(activeUserDataDir, { recursive: true });
    execSync(`rsync -a --delete --exclude='Singleton*' "${primaryProfileDir}/" "${activeUserDataDir}/" 2>/dev/null || true`, { stdio: 'ignore' });
    log('profile_synced', 'Chrome user profile synced successfully');
  } catch (err) {
    log('profile_sync_warn', `Profile sync warning: ${err.message}`);
  }

  let browser = null;
  let chromeProcess = null;

  try {
    // Free debug port if previously held
    try {
      execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' });
    } catch {}

    const chromeArgs = [
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${activeUserDataDir}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1920,1080',
    ];

    const env = { ...process.env, DISPLAY: display };
    chromeProcess = spawn(chromePath, chromeArgs, { env, stdio: 'ignore', detached: false });

    // Poll until debugging port is ready
    const t0 = Date.now();
    let portReady = false;
    while (Date.now() - t0 < 15000) {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        if (res.ok) {
          portReady = true;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 400));
    }

    if (!portReady) {
      throw new Error(`Chrome debug port ${debugPort} did not become ready within 15s`);
    }

    log('connecting', `Connecting Puppeteer to Chrome on port ${debugPort}`);
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${debugPort}`,
      defaultViewport: null,
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(35000);

    log('navigating', `Navigating to YouTube Studio: ${targetUrl}`);
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    log('page_loaded', 'YouTube Studio page loaded', { title: await page.title(), url: page.url() });

    // Handle "Improve your experience" / unsupported browser banner if present
    try {
      await page.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll('a, button, [role="button"], span'));
        for (const el of allEls) {
          if ((el.innerText || '').trim().toLowerCase().includes('skip to youtube studio')) {
            el.click();
            break;
          }
        }
      });
      await new Promise(r => setTimeout(r, 2000));
    } catch {}

    // Step 2: Dismiss any lingering popup modals
    log('check_dismiss', 'Checking for Stream Finished modal or overlays');
    for (let d = 0; d < 3; d++) {
      await dismissAnyModals(page);
      await new Promise(r => setTimeout(r, 1000));
    }

    await retryControlRoomIfNeeded(page);

    // Step 3: Wait for control panel to settle and title data to populate
    log('settling', 'Waiting for YouTube Studio control room data to populate');
    for (let w = 0; w < 10; w++) {
      const settled = await page.evaluate(() => {
        const titleEl = document.querySelector('#stream-title, ytcp-live-title, [class*="stream-title"], #title');
        const txt = (titleEl?.innerText || titleEl?.textContent || '').trim();
        return txt.length > 0 && txt !== '—';
      });
      if (settled) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    // Dismiss any initial stream-finished popup before editing
    await dismissAnyModals(page);

    // Step 4: Locate and Click the Edit button with robust retries
    log('edit_title_start', 'Looking for Edit button in Title section');
    let titleBox = null;

    const findTitleBox = async () => {
      // Only match the TITLE box, not description
      // aria-label contains 'title' ensures we get the right contenteditable
      return await page.$(
        'ytcp-video-metadata-editor >>> div#textbox[aria-label*="title" i], ' +
        'ytcp-social-suggestions-textbox >>> div#textbox[aria-label*="title" i], ' +
        'ytcp-video-metadata-editor div#textbox[aria-label*="title" i]'
      );
    };

    for (let attempt = 1; attempt <= 8; attempt++) {
      // Check if title box is already accessible
      titleBox = await findTitleBox();
      if (titleBox) {
        log('edit_modal_detected', `Edit modal already opened on attempt ${attempt}`);
        break;
      }

      // Take screenshot on first attempt to debug page state
      if (attempt === 1) {
        try {
          await page.screenshot({ path: '/tmp/studio-debug.png', fullPage: false });
          log('debug_screenshot', 'Screenshot saved to /tmp/studio-debug.png');
        } catch (e) { /* ignore */ }
      }

      // Strategy: Recursive shadow DOM traversal — finds element at ANY nesting depth
      const evalResult = await page.evaluate(() => {
        // Recursively search all shadow roots for a matching element
        function deepQueryAll(root, selector) {
          const results = [];
          try {
            const direct = Array.from(root.querySelectorAll(selector));
            results.push(...direct);
          } catch (e) {}
          // Walk all elements in this root and recurse into their shadow roots
          const allEls = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          for (const el of allEls) {
            if (el.shadowRoot) {
              const nested = deepQueryAll(el.shadowRoot, selector);
              results.push(...nested);
            }
          }
          return results;
        }

        // Search for edit button by ID
        const editBtns = deepQueryAll(document, 'ytcp-button#edit-button, button#edit-button, [role="button"][aria-label*="edit" i], button[aria-label*="edit" i]');
        for (const btn of editBtns) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            // Found a visible edit button — click inner button or the element itself
            const inner = btn.shadowRoot ? btn.shadowRoot.querySelector('button') : btn.querySelector('button');
            if (inner) { inner.click(); return 'recursive_inner_clicked'; }
            btn.click();
            return 'recursive_host_clicked';
          }
        }

        // Fallback: search all buttons with text 'Edit' at any depth
        const allBtns = deepQueryAll(document, 'button, ytcp-button, [role="button"], tp-yt-paper-button');
        for (const b of allBtns) {
          const labels = [b.getAttribute('aria-label'), b.getAttribute('title'), b.innerText, b.textContent]
            .filter(Boolean)
            .map(value => value.trim().toLowerCase());
          if (labels.some(label => /^(edit|edit title|edit stream details)$/.test(label))) {
            const inner = b.shadowRoot ? b.shadowRoot.querySelector('button') : b.querySelector('button');
            if (inner) { inner.click(); return 'recursive_text_inner_clicked'; }
            b.click();
            return 'recursive_text_clicked';
          }
        }

        // Debug: report what ytcp elements exist
        const ytcpEls = deepQueryAll(document, 'ytcp-button');
        const ids = ytcpEls.slice(0, 10).map(e => e.id || e.tagName).join(',');
        return `not_found|ytcp_ids:${ids}`;
      });
      log('edit_evaluate_result', `Evaluate fallback result on attempt ${attempt}: ${evalResult}`);

      // Wait up to 3 seconds for modal to appear
      for (let w = 0; w < 6; w++) {
        await new Promise(r => setTimeout(r, 500));
        titleBox = await findTitleBox();
        if (titleBox) break;
      }
      if (titleBox) break;

      // Small pause before next attempt
      await new Promise(r => setTimeout(r, 500));
    }

    if (!titleBox) {
      log('edit_not_clicked', 'Could not open Edit modal; proceeding with stream start fallback');
    } else {
      // Step 5: Update the Title inside the Edit Modal
      log('updating_title', 'Updating title in edit modal via native keyboard input');
      const currentText = await page.evaluate(el => (el.innerText || el.textContent || '').trim(), titleBox);

      let base = configuredBaseTitle ? configuredBaseTitle.trim() : '';
      if (!base) {
        base = cleanBaseTitle(currentText);
        if (!base) base = 'Live Stream';
      }

      const dt = getFormattedDateTime(timeZone);
      const dateSuffix = ` ${dt.full}`;
      const maxBaseLen = Math.max(10, 100 - dateSuffix.length);
      if (base.length > maxBaseLen) {
        base = base.substring(0, maxBaseLen).trim();
      }
      const targetTitle = `${base}${dateSuffix}`.trim().slice(0, 100);

      log('typing_title', `Typing new target title into title box`, { targetTitle, oldTitle: currentText });

      // Focus and select all existing text
      await titleBox.click();
      await new Promise(r => setTimeout(r, 300));

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await new Promise(r => setTimeout(r, 200));

      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, 200));

      // Native typing causes Polymer to mark the field dirty and enable the Save button
      await page.keyboard.type(targetTitle, { delay: 10 });
      log('title_typed', `Successfully typed new title into box via keyboard: ${targetTitle}`);
      await new Promise(r => setTimeout(r, 1000));

      // Step 6: Wait for and Click the "Save" Button
      log('save_title', 'Waiting for Save button to become enabled and saving');
      let saveCompleted = false;

      for (let sAttempt = 1; sAttempt <= 15; sAttempt++) {
        const saveStatus = await page.evaluate(() => {
          const host = document.querySelector('ytcp-button#save-button, ytcp-video-metadata-editor ytcp-button#save-button');
          if (!host) return { found: false };
          const btn = host.shadowRoot ? host.shadowRoot.querySelector('button') : host.querySelector('button');
          const disabled = host.hasAttribute('disabled') ||
                           host.getAttribute('aria-disabled') === 'true' ||
                           host.classList.contains('disabled') ||
                           (btn && (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true'));
          return { found: true, disabled: !!disabled, innerText: host.innerText.trim() };
        });

        if (saveStatus.found && !saveStatus.disabled) {
          log('save_button_enabled', `Save button is active on attempt ${sAttempt}`);
          const saveBtn = await page.$('ytcp-button#save-button >>> button, #save-button');
          if (saveBtn) {
            await saveBtn.click();
          } else {
            await page.evaluate(() => {
              const host = document.querySelector('ytcp-button#save-button');
              if (host) {
                const btn = host.shadowRoot ? host.shadowRoot.querySelector('button') : host.querySelector('button');
                if (btn) btn.click();
                host.click();
              }
            });
          }

          log('save_clicked', `Save button clicked on attempt ${sAttempt}`);
          await new Promise(r => setTimeout(r, 3000));

          // Check if modal has closed (either removed or hidden/width 0)
          const modalClosed = await page.evaluate(() => {
            const modal = document.querySelector('ytcp-video-metadata-editor, ytcp-dialog');
            if (!modal) return true;
            const r = modal.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return true;
            if (modal.getAttribute('aria-hidden') === 'true') return true;
            const s = window.getComputedStyle(modal);
            return s.display === 'none' || s.visibility === 'hidden';
          });

          if (modalClosed) {
            saveCompleted = true;
            log('save_verified', 'Edit modal closed; stream title saved successfully', { newTitle: targetTitle });
            break;
          }
        }

        await new Promise(r => setTimeout(r, 1000));
      }

      if (!saveCompleted) {
        log('save_warning', 'Save button timed out or modal did not close; proceeding to stream start');
      }
    }

    // Step 7: Signal to stream-manager that panel is ready and live stream can start!
    log('ready_to_stream', 'Control panel ready; signalling to start live stream');
    emitEvent('ready_to_stream');

    // Step 8: Wait for real encoder preview video and trigger Go Live if needed
    log('waiting_for_preview', 'Waiting for encoder connection, video preview and Go Live readiness in Studio');

    let previewDetected = false;
    let liveConfirmed = false;
    const previewStartWait = Date.now();
    const maxPreviewWaitMs = 90000; // allow up to 90s for RTMP handshake and YouTube player ingestion

    while (Date.now() - previewStartWait < maxPreviewWaitMs) {
      try {
        const status = await page.evaluate(() => {
          // 1. Check if stream is ALREADY LIVE (End Stream button visible or LIVE badge)
          const endBtn = document.querySelector('#end-stream-button, button.end-stream-button, ytcp-button#end-stream-button');
          const isEndBtnVisible = endBtn && endBtn.getBoundingClientRect().width > 0;

          const badges = Array.from(document.querySelectorAll(
            '.badge, [class*="badge"], [class*="health"], ytcp-stream-health-badge, ' +
            '[class*="stream-health"], ytcp-badge, ytls-stream-health, [class*="connection"]'
          ));
          let isLiveBadge = false;
          let isHealthyBadge = false;
          for (const b of badges) {
            const bTxt = (b.innerText || b.textContent || '').trim().toLowerCase();
            if (bTxt === 'live' || bTxt.includes('is live')) isLiveBadge = true;
            if (bTxt.includes('excellent') || bTxt.includes('good')) isHealthyBadge = true;
          }

          if (isEndBtnVisible || isLiveBadge) {
            return { state: 'live', isLive: true };
          }

          // 2. Check if "Go live" button is enabled
          const goLiveBtn = document.querySelector('#start-stream-button, [aria-label*="Go live" i]');
          const isGoLiveEnabled = goLiveBtn &&
            !goLiveBtn.hasAttribute('disabled') &&
            goLiveBtn.getAttribute('aria-disabled') !== 'true';

          // 3. Check if video preview is active and playing
          const video = document.querySelector('video');
          const isVideoPlaying = video && (video.readyState >= 2 || video.currentTime > 0);

          return {
            state: isGoLiveEnabled ? 'go_live_ready' : (isVideoPlaying || isHealthyBadge ? 'preview_active' : 'waiting'),
            isGoLiveEnabled: !!isGoLiveEnabled,
            isVideoPlaying: !!isVideoPlaying,
            isHealthyBadge: !!isHealthyBadge,
          };
        });

        if (status.state === 'live') {
          previewDetected = true;
          liveConfirmed = true;
          log('stream_live_confirmed', 'Stream is confirmed LIVE in YouTube Studio!');
          break;
        }

        if (status.state === 'go_live_ready') {
          previewDetected = true;
          log('go_live_enabled', 'Encoder preview connected! "Go live" button is now enabled. Clicking "Go live"...');

          // Click Go Live
          const clicked = await page.evaluate(() => {
            const btn = document.querySelector('#start-stream-button, [aria-label*="Go live" i]');
            if (btn) {
              const inner = btn.querySelector('button') || btn;
              inner.click();
              btn.click();
              return true;
            }
            return false;
          });

          if (clicked) {
            log('go_live_clicked', 'Clicked "Go live" button in YouTube Studio header');
            // Check for confirmation dialog (e.g. "Are you sure you want to go live?")
            await new Promise(r => setTimeout(r, 2000));
            await page.evaluate(() => {
              const conf = document.querySelector('ytcp-confirmation-dialog #confirm-button, #confirm-button, [aria-label="Go live"]');
              if (conf) {
                const inner = conf.querySelector('button') || conf;
                inner.click();
                conf.click();
              }
            });
            await new Promise(r => setTimeout(r, 4000));
          }
        } else if (status.state === 'preview_active') {
          if (!previewDetected) {
            previewDetected = true;
            log('preview_detected', 'Live video preview detected playing in YouTube Studio player', status);
          }
        }
      } catch (err) {
        log('preview_poll_error', `Non-fatal poll error: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    // Capture visual confirmation screenshot on the VPS
    try {
      const confirmationScreenshotPath = '/opt/yt-live-manager/logs/studio_live_confirmed.png';
      await page.screenshot({ path: confirmationScreenshotPath });
      log('screenshot_saved', `Saved confirmation screenshot to ${confirmationScreenshotPath}`);
    } catch {}

    if (!previewDetected) {
      log('preview_timeout', 'Preview wait reached limit; proceeding with shutdown');
    }

    // Step 9: Wait configured seconds (default 10s) after preview appears
    log('post_preview_wait', `Waiting ${previewWaitSec} seconds before closing Chrome...`);
    await new Promise(r => setTimeout(r, previewWaitSec * 1000));

    log('closing_browser', 'Closing Chrome browser');
    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
    }
    if (chromeProcess) {
      try { chromeProcess.kill('SIGTERM'); } catch {}
      chromeProcess = null;
    }
    try { execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' }); } catch {}

    log('finished', 'YouTube Studio automation workflow completed successfully');
    emitEvent('finished', { success: true });
  } catch (err) {
    log('fatal_error', `Error during studio automation: ${err.message}`, { stack: err.stack });
    emitEvent('finished', { success: false, error: err.message });
  } finally {
    clearTimeout(watchdog);
    clearInterval(healthPollInterval);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    if (chromeProcess) {
      try { chromeProcess.kill('SIGTERM'); } catch {}
    }
    // Clean up health flag file
    if (healthFlagFile) {
      try { fs.unlinkSync(healthFlagFile); } catch {}
    }
    try { execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' }); } catch {}
    process.exit(0);
  }
}

run();
