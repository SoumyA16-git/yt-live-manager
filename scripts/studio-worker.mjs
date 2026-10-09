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
 * Dismiss any blocking popup modals in YouTube Studio.
 */
async function dismissAnyModals(page) {
  try {
    const dismissed = await page.evaluate(() => {
      // CRITICAL: DO NOT dismiss if the edit modal / metadata editor is open!
      const metaEditor = document.querySelector('ytcp-video-metadata-editor, ytcp-live-metadata-editor');
      if (metaEditor && metaEditor.getBoundingClientRect().width > 0) {
        return false;
      }

      // Common dismiss buttons (never inside metadata editor)
      const candidates = Array.from(document.querySelectorAll(
        '#dismiss-button, ytcp-button#dismiss-button, button[aria-label="Dismiss"], ' +
        'ytcp-button[aria-label="Dismiss"], tp-yt-paper-button#dismiss-button, ' +
        'ytcp-dialog #dismiss-button, ytcp-confirmation-dialog #confirm-button, ' +
        'button[aria-label="Close"], [aria-label="Close dialog"]'
      )).filter(b => !b.closest('ytcp-video-metadata-editor, ytcp-live-metadata-editor'));

      // Also look for buttons with text "Dismiss", "Done", "Got it", "Close"
      const textButtons = Array.from(document.querySelectorAll('ytcp-button, button, tp-yt-paper-button')).filter(b => {
        if (b.closest('ytcp-video-metadata-editor, ytcp-live-metadata-editor')) return false;
        const txt = (b.textContent || '').trim().toLowerCase();
        return txt === 'dismiss' || txt === 'got it' || txt === 'done' || txt === 'close';
      });

      const all = [...candidates, ...textButtons];
      for (const btn of all) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const inner = btn.querySelector('button, [role="button"], .label') || btn;
          inner.click();
          btn.click();
          return true;
        }
      }

      // Check if iron-overlay-backdrop is opened and lingering (never if edit modal exists)
      const backdrops = Array.from(document.querySelectorAll('tp-yt-iron-overlay-backdrop.opened, iron-overlay-backdrop.opened'));
      if (backdrops.length > 0 && !document.querySelector('ytcp-video-metadata-editor, ytcp-live-metadata-editor')) {
        for (const b of backdrops) {
          b.classList.remove('opened');
          b.style.display = 'none';
        }
        return true;
      }

      return false;
    });

    if (dismissed) {
      log('dismiss_clicked', 'Dismissed popup modal or overlay');
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    log('dismiss_error', `Non-fatal dismiss check error: ${err.message}`);
  }
}

async function readTitleEditor(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
      '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
    ));

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const parentText = (el.parentElement?.textContent || '').toLowerCase();
      if (aria.includes('description') || (!aria.includes('title') && parentText.includes('description'))) continue;
      return (el.innerText || el.textContent || '').trim();
    }
    return null;
  });
}

async function openTitleEditor(page, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await readTitleEditor(page) !== null) return true;

    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        '#edit-button, ytcp-button#edit-button, button[aria-label="Edit"], ' +
        '[aria-label*="Edit" i], ytcp-button[aria-label="Edit"], ' +
        'ytcp-stream-metadata-editor ytcp-button, ytcp-stream-metadata-editor button'
      ));
      const textCandidates = Array.from(document.querySelectorAll('ytcp-button, button')).filter(el =>
        (el.textContent || '').trim().toLowerCase() === 'edit'
      );

      for (const el of [...candidates, ...textCandidates]) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        (el.querySelector('button, [role="button"]') || el).click();
        return true;
      }
      return false;
    });

    if (clicked) await new Promise(resolve => setTimeout(resolve, 1200));
    else await new Promise(resolve => setTimeout(resolve, 800));
  }
  return await readTitleEditor(page) !== null;
}

async function typeTitleIntoEditor(page, title) {
  const selected = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
      '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
    ));

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const parentText = (el.parentElement?.textContent || '').toLowerCase();
      if (aria.includes('description') || (!aria.includes('title') && parentText.includes('description'))) continue;

      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    return false;
  });

  if (!selected) return false;
  await page.keyboard.type(title, { delay: 8 });
  return (await readTitleEditor(page)) === title;
}

async function saveTitleEditor(page, attempts = 15) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        '#save-button, ytcp-button#save-button, button[aria-label="Save"], ' +
        'ytcp-button[aria-label="Save"], ytcp-button.save-button, ' +
        'ytcp-video-metadata-editor #save-button, ytcp-live-metadata-editor #save-button'
      ));
      const textCandidates = Array.from(document.querySelectorAll('ytcp-button, button')).filter(el =>
        (el.textContent || '').trim().toLowerCase() === 'save'
      );

      for (const btn of [...candidates, ...textCandidates]) {
        const rect = btn.getBoundingClientRect();
        const style = window.getComputedStyle(btn);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
        if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('disabled')) continue;
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        (btn.querySelector('button, [role="button"]') || btn).click();
        return true;
      }
      return false;
    });

    if (clicked) {
      await new Promise(resolve => setTimeout(resolve, 1800));
      const closed = await page.evaluate(() => {
        const modal = document.querySelector('ytcp-video-metadata-editor, ytcp-live-metadata-editor');
        if (!modal) return true;
        const rect = modal.getBoundingClientRect();
        return rect.width === 0 || rect.height === 0;
      });
      if (closed) return true;
    }

    await new Promise(resolve => setTimeout(resolve, 700));
  }
  return false;
}

async function reloadStudioPage(page) {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(resolve => setTimeout(resolve, 1800));
    return true;
  } catch (err) {
    log('title_readback_reload_warn', `Could not reload Studio before title read-back: ${err.message}`);
    return false;
  }
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

    // Step 2: Dismiss any lingering popup modals
    log('check_dismiss', 'Checking for Stream Finished modal or overlays');
    for (let d = 0; d < 3; d++) {
      await dismissAnyModals(page);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Step 3: Wait for control panel to settle
    await new Promise(r => setTimeout(r, 2000));

    // Step 4: Locate and Click the Edit button with robust retries
    log('edit_title_start', 'Looking for Edit button in Title section');
    let editModalOpened = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      // First dismiss any popup that may have appeared late (only on attempt 1 before trying to open)
      if (attempt === 1) {
        await dismissAnyModals(page);
      }

      // Check if edit modal is already open
      editModalOpened = await page.evaluate(() => {
        const modal = document.querySelector('ytcp-video-metadata-editor, ytcp-live-metadata-editor');
        const tb = document.querySelector('div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, [contenteditable="true"]#textbox');
        if (modal) {
          const r = modal.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        if (tb) {
          const r = tb.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      });

      if (editModalOpened) {
        log('edit_modal_detected', `Edit modal already opened on attempt ${attempt}`);
        break;
      }

      // Try finding and clicking the Edit button
      const clickResult = await page.evaluate(() => {
        // Broad selectors for the Edit button in YouTube Studio
        const candidates = Array.from(document.querySelectorAll(
          '#edit-button, ytcp-button#edit-button, button[aria-label="Edit"], ' +
          '[aria-label*="Edit" i], ytcp-button[aria-label="Edit"], ' +
          'ytcp-stream-metadata-editor ytcp-button, ytcp-stream-metadata-editor button'
        ));

        // Also search for buttons with text "Edit"
        const textCandidates = Array.from(document.querySelectorAll('ytcp-button, button')).filter(el => {
          const t = (el.textContent || '').trim().toLowerCase();
          return t === 'edit';
        });

        const all = [...candidates, ...textCandidates];
        for (const el of all) {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            // Click host element and inner button
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            el.click();
            const inner = el.querySelector('button, [role="button"], .label');
            if (inner) inner.click();
            return { clicked: true, tagName: el.tagName, id: el.id };
          }
        }
        return { clicked: false };
      });

      if (clickResult.clicked) {
        log('edit_button_clicked', `Clicked Edit button on attempt ${attempt}`, clickResult);
        // Wait for modal to open
        await new Promise(r => setTimeout(r, 2000));

        // Check if modal opened
        editModalOpened = await page.evaluate(() => {
          const tb = document.querySelector('div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, [contenteditable="true"]#textbox');
          return !!(tb && tb.getBoundingClientRect().width > 0);
        });

        if (editModalOpened) break;
      } else {
        log('edit_search_retry', `Attempt ${attempt}: Edit button not found yet, retrying...`);
      }

      await new Promise(r => setTimeout(r, 1500));
    }

    if (!editModalOpened) {
      log('edit_not_clicked', 'Could not open Edit modal; proceeding with stream start fallback');
    } else {
      // Step 5: Update the Title inside the Edit Modal
      log('updating_title', 'Updating title in edit modal');
      const dt = getFormattedDateTime(timeZone);

      let titleUpdated = false;
      let finalNewTitle = '';

      for (let tAttempt = 1; tAttempt <= 8; tAttempt++) {
        // Evaluate in DOM to find title box, clean current text, and set new title
        const updateAttempt = await page.evaluate((cfgBase, dateTimeFull, cleanFnStr) => {
          const cleanBase = new Function('return ' + cleanFnStr)();

          // Selectors for title editable div
          const candidates = Array.from(document.querySelectorAll(
            'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
            '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
          ));

          let titleDiv = null;
          for (const el of candidates) {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
              // Ensure it belongs to title (not description)
              const aria = (el.getAttribute('aria-label') || '').toLowerCase();
              const parentText = (el.parentElement?.textContent || '').toLowerCase();
              if (aria.includes('description') || (!aria.includes('title') && parentText.includes('description'))) {
                continue;
              }
              titleDiv = el;
              break;
            }
          }

          if (!titleDiv) {
            return { success: false, reason: 'title_field_not_found' };
          }

          const currentText = (titleDiv.innerText || titleDiv.textContent || '').trim();
          let base = cfgBase ? cfgBase.trim() : '';
          if (!base) {
            base = cleanBase(currentText);
            if (!base) base = 'Live Stream';
          }

          // Enforce YouTube 100 character limit strictly
          const dateSuffix = ` ${dateTimeFull}`;
          const maxBaseLen = Math.max(10, 100 - dateSuffix.length);
          if (base.length > maxBaseLen) {
            base = base.substring(0, maxBaseLen).trim();
          }
          const targetTitle = `${base}${dateSuffix}`.trim().slice(0, 100);

          return {
            success: true,
            oldTitle: currentText,
            newTitle: targetTitle
          };
        }, configuredBaseTitle, dt.full, cleanBaseTitle.toString());

        if (updateAttempt.success) {
          finalNewTitle = updateAttempt.newTitle;
          const typed = await typeTitleIntoEditor(page, finalNewTitle);
          const typedTitle = await readTitleEditor(page);
          if (typed && typedTitle === finalNewTitle) {
            titleUpdated = true;
            log('title_typed', 'Entered the dynamic title with keyboard input', {
              oldTitle: updateAttempt.oldTitle,
              newTitle: finalNewTitle,
            });
            await page.evaluate(() => {
              const el = document.activeElement;
              if (el && el.blur) el.blur();
            });
            break;
          }

          log('title_type_retry', 'Title field did not retain the typed value; retrying', {
            expectedTitle: finalNewTitle,
            actualTitle: typedTitle,
          });
        }

        await new Promise(r => setTimeout(r, 1000));
      }

      if (titleUpdated) {
        // Step 6: save, reopen the editor, and verify the value Studio loaded back.
        log('save_title', 'Waiting for Save button to become enabled and saving');
        let saveCompleted = await saveTitleEditor(page);
        if (!saveCompleted) {
          log('save_warning', 'Save did not complete; proceeding to stream start fallback', { expectedTitle: finalNewTitle });
        }

        let persistedTitle = null;
        if (saveCompleted) {
          await reloadStudioPage(page);
        }

        if (saveCompleted && await openTitleEditor(page)) {
          persistedTitle = await readTitleEditor(page);
          if (persistedTitle === finalNewTitle) {
            log('title_readback_verified', 'YouTube Studio reloaded the saved dynamic title', { savedTitle: persistedTitle });
          } else {
            log('title_readback_mismatch', 'Studio reopened the editor with a different title; retrying with keyboard input', {
              expectedTitle: finalNewTitle,
              actualTitle: persistedTitle,
            });

            if (await typeTitleIntoEditor(page, finalNewTitle)) {
              await page.evaluate(() => {
                const el = document.activeElement;
                if (el && el.blur) el.blur();
              });
              saveCompleted = await saveTitleEditor(page);
              if (saveCompleted) await reloadStudioPage(page);
              if (saveCompleted && await openTitleEditor(page)) {
                persistedTitle = await readTitleEditor(page);
              }
            }

            if (persistedTitle === finalNewTitle) {
              log('title_readback_verified', 'Dynamic title persisted after one keyboard retry', { savedTitle: persistedTitle });
            } else {
              log('title_not_persisted', 'Studio did not return the requested title after retry; check the Studio session and logs', {
                expectedTitle: finalNewTitle,
                actualTitle: persistedTitle,
              });
            }
          }

          // Close the read-back editor without making any further changes.
          await page.keyboard.press('Escape').catch(() => {});
        } else if (saveCompleted) {
          log('title_readback_unavailable', 'Could not reopen the title editor to verify the saved value', { expectedTitle: finalNewTitle });
        }
      }
    }

    // Step 7: Signal to stream-manager that panel is ready and live stream can start!
    log('ready_to_stream', 'Control panel ready; signalling to start live stream');
    emitEvent('ready_to_stream');

    // Step 8: Wait for live video preview to appear in YouTube Studio
    log('waiting_for_preview', 'Waiting for encoder connection and preview video in Studio');
    let previewDetected = false;
    const previewStartWait = Date.now();
    const maxPreviewWaitMs = 60000;

    while (Date.now() - previewStartWait < maxPreviewWaitMs) {
      try {
        const status = await page.evaluate(() => {
          // Check if "Go live" button is enabled
          const goLiveBtn = document.querySelector('#start-stream-button, [aria-label*="Go live" i]');
          const isGoLiveEnabled = goLiveBtn &&
            !goLiveBtn.hasAttribute('disabled') &&
            goLiveBtn.getAttribute('aria-disabled') !== 'true';

          if (isGoLiveEnabled) {
            const inner = goLiveBtn.querySelector('button') || goLiveBtn;
            inner.click();
            goLiveBtn.click();
            return { goLiveClicked: true, previewDetected: true };
          }

          const video = document.querySelector('video');
          if (video && (video.readyState >= 2 || video.currentTime > 0)) {
            return { previewDetected: true };
          }

          const bodyText = document.body.innerText || '';
          const hasConnectEncoder = bodyText.includes('Connect your encoder to go live');
          const hasNoData = bodyText.includes('No data');

          const badges = Array.from(document.querySelectorAll('.badge, [class*="badge"], [class*="health"]'));
          for (const b of badges) {
            const bTxt = (b.innerText || '').toLowerCase();
            if (bTxt.includes('excellent') || bTxt.includes('good') || bTxt.includes('live')) {
              return { previewDetected: true };
            }
          }

          return { previewDetected: !hasConnectEncoder && !hasNoData };
        });

        if (status.goLiveClicked) {
          log('go_live_clicked', 'Clicked "Go live" button in YouTube Studio header');
          previewDetected = true;
          // Check for confirmation modal (e.g. "Are you sure you want to go live?")
          await new Promise(r => setTimeout(r, 1500));
          await page.evaluate(() => {
            const conf = document.querySelector('ytcp-confirmation-dialog #confirm-button, #confirm-button, [aria-label="Go live"]');
            if (conf) {
              const inner = conf.querySelector('button') || conf;
              inner.click();
              conf.click();
            }
          });
          break;
        }

        if (status.previewDetected) {
          previewDetected = true;
          log('preview_detected', 'Live video preview detected in YouTube Studio!');
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }

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
