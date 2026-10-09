/**
 * scripts/studio-worker.mjs
 *
 * Standalone worker to automate YouTube Studio in Google Chrome:
 * 1. Syncs Chrome profile to non-default directory so remote debugging is allowed.
 * 2. Launches Chrome on DISPLAY=:10 with user-data-dir and remote-debugging-port=9222.
 * 3. Connects via CDP (http://127.0.0.1:9222).
 * 4. Navigates to YouTube Live Stream Control Room URL.
 * 5. Dismisses "Stream Finished" popup modal (#dismiss-button) if present.
 * 6. Waits for control panel to settle.
 * 7. Clicks "Edit" (#edit-button) in Title section.
 * 8. Updates title in div#textbox (baseTitle + current date + current time).
 * 9. Clicks "Save" (#save-button) and waits for modal to close.
 * 10. Emits "ready_to_stream" over stdout IPC -> FFmpeg stream launches!
 * 11. Waits for live preview stream in YouTube Studio.
 * 12. Waits 10 seconds after preview appears.
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
  const timeStr = tFormatter.format(now);
  return { dateStr, timeStr, full: `${dateStr} ${timeStr}` };
}

function stripDateTimeFromTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s+\d{2}[-/]\d{2}[-/]\d{4}(\s+\d{1,2}[:.]\d{2}(\s*(AM|PM))?)?$/i, '')
    .trim();
}

async function run() {
  const targetUrl = process.env.STUDIO_URL || 'https://studio.youtube.com/video/xHUulPKBtJs/livestreaming';
  const configuredBaseTitle = process.env.STUDIO_BASE_TITLE || '';
  const timeZone = process.env.STUDIO_TIMEZONE || 'Asia/Kolkata';
  const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const primaryProfileDir = process.env.CHROME_USER_DATA_DIR || '/home/ubuntu/.config/google-chrome';
  const activeUserDataDir = process.env.CHROME_ACTIVE_DATA_DIR || '/home/ubuntu/.config/google-chrome-studio';
  const display = process.env.DISPLAY || ':10';
  const previewWaitSec = Number(process.env.STUDIO_PREVIEW_WAIT_SEC) || 10;
  const timeoutMs = Number(process.env.STUDIO_TIMEOUT_MS) || 120000;
  const debugPort = 9222;

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
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(35000);

    log('navigating', `Navigating to YouTube Studio: ${targetUrl}`);
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000
    });

    log('page_loaded', 'YouTube Studio page loaded', { title: await page.title(), url: page.url() });

    // Step 2: Check for "Stream Finished" popup modal and dismiss it
    log('check_dismiss', 'Checking for Stream Finished modal');
    await new Promise(r => setTimeout(r, 2000));

    try {
      const dismissClicked = await page.evaluate(() => {
        const dismissBtn = document.querySelector('#dismiss-button, ytcp-button#dismiss-button, button[aria-label="Dismiss"]');
        if (dismissBtn) {
          dismissBtn.click();
          return true;
        }
        return false;
      });

      if (dismissClicked) {
        log('dismiss_clicked', 'Clicked Dismiss on Stream Finished modal');
        await new Promise(r => setTimeout(r, 2500));
      } else {
        log('dismiss_not_found', 'No Stream Finished popup modal found');
      }
    } catch (err) {
      log('dismiss_check_error', `Dismiss check non-fatal error: ${err.message}`);
    }

    // Step 3: Wait for control panel to fully load/settle
    await new Promise(r => setTimeout(r, 2500));

    // Step 4: Click Edit button in Title section
    log('edit_title_start', 'Looking for Edit button in Title section');
    let editClicked = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        editClicked = await page.evaluate(() => {
          const editBtn = document.querySelector('#edit-button, ytcp-button#edit-button, button[aria-label="Edit"]');
          if (editBtn && editBtn.offsetParent !== null) {
            editBtn.click();
            return true;
          }
          return false;
        });

        if (editClicked) {
          log('edit_button_clicked', `Clicked Edit button on attempt ${attempt}`);
          break;
        }
      } catch (e) {
        log('edit_click_retry', `Attempt ${attempt} to click Edit failed: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (editClicked) {
      // Step 5: Wait for Edit modal dialog to open
      await new Promise(r => setTimeout(r, 2500));

      const dt = getFormattedDateTime(timeZone);

      // Determine new title: use configured base title, or preserve current base title
      const updateResult = await page.evaluate((cfgBase, dateTimeFull) => {
        const titleDiv = document.querySelector('div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox');
        if (!titleDiv) return { success: false, reason: 'title_field_not_found' };

        const currentText = (titleDiv.innerText || titleDiv.textContent || '').trim();
        let base = cfgBase;
        if (!base) {
          // Strip trailing date/time from current title
          base = currentText.replace(/\s+\d{2}[-/]\d{2}[-/]\d{4}(\s+\d{1,2}[:.]\d{2}(\s*(AM|PM))?)?$/i, '').trim();
          if (!base) base = currentText || 'Live Stream';
        }

        const newTitle = `${base} ${dateTimeFull}`.trim();

        titleDiv.focus();
        titleDiv.innerText = newTitle;
        titleDiv.dispatchEvent(new Event('input', { bubbles: true }));
        titleDiv.dispatchEvent(new Event('change', { bubbles: true }));

        return { success: true, oldTitle: currentText, newTitle };
      }, configuredBaseTitle, dt.full);

      log('title_updated', 'Updated title in edit modal', updateResult);
      await new Promise(r => setTimeout(r, 1500));

      // Click "Save" button in the modal
      log('save_title', 'Clicking Save button in edit modal');
      const saveClicked = await page.evaluate(() => {
        const saveBtn = document.querySelector('#save-button, ytcp-button#save-button, button[aria-label="Save"]');
        if (saveBtn && saveBtn.offsetParent !== null && !saveBtn.hasAttribute('disabled')) {
          saveBtn.click();
          return true;
        }
        return false;
      });

      log('save_clicked', `Save button clicked: ${saveClicked}`);
      // Wait for modal to save and close
      await new Promise(r => setTimeout(r, 3500));
    } else {
      log('edit_not_clicked', 'Could not locate Edit button; proceeding to stream start');
    }

    // Step 6: Signal to stream-manager that panel is ready and live stream can start!
    log('ready_to_stream', 'Control panel ready; signalling to start live stream');
    emitEvent('ready_to_stream');

    // Step 7: Wait for live video preview to appear in YouTube Studio
    log('waiting_for_preview', 'Waiting for encoder connection and preview video in Studio');
    let previewDetected = false;
    const previewStartWait = Date.now();
    const maxPreviewWaitMs = 60000;

    while (Date.now() - previewStartWait < maxPreviewWaitMs) {
      try {
        previewDetected = await page.evaluate(() => {
          const video = document.querySelector('video');
          if (video && (video.readyState >= 2 || video.currentTime > 0)) {
            return true;
          }

          const bodyText = document.body.innerText || '';
          const hasConnectEncoder = bodyText.includes('Connect your encoder to go live');
          const hasNoData = bodyText.includes('No data');

          const badges = Array.from(document.querySelectorAll('.badge, [class*="badge"], [class*="health"]'));
          for (const b of badges) {
            const bTxt = (b.innerText || '').toLowerCase();
            if (bTxt.includes('excellent') || bTxt.includes('good') || bTxt.includes('live')) {
              return true;
            }
          }

          return !hasConnectEncoder && !hasNoData;
        });

        if (previewDetected) {
          log('preview_detected', 'Live video preview detected in YouTube Studio!');
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!previewDetected) {
      log('preview_timeout', 'Preview wait reached limit; proceeding with shutdown');
    }

    // Step 8: Wait configured seconds (default 10s) after preview appears
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
    if (browser) {
      try { await browser.close(); } catch {}
    }
    if (chromeProcess) {
      try { chromeProcess.kill('SIGTERM'); } catch {}
    }
    try { execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' }); } catch {}
    process.exit(0);
  }
}

run();
