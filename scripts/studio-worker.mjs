/**
 * scripts/studio-worker.mjs
 *
 * STRICT MODE — zero fallbacks. Every step is verified before proceeding.
 * If any critical step fails, the process throws and exits with code 1.
 *
 * Steps:
 *  1. Sync Chrome profile
 *  2. Launch Chrome, wait for debug port
 *  3. Connect Puppeteer
 *  4. Navigate to Studio URL, verify correct page loaded + logged in
 *  5. Dismiss blocking modals and verify they close
 *  6. Wait for page to settle
 *  7. Click Edit button → VERIFY modal opened (throw if not)
 *  8. Read current title → compute new title
 *  9. Click title field (real mouse), Ctrl+A, Backspace, type new title → VERIFY content matches
 * 10. Click Save → VERIFY modal closes (throw if not)
 * 11. Reload page → re-open editor → VERIFY saved title matches (retry once if mismatch)
 * 12. Emit ready_to_stream only after persisted-title read-back succeeds
 * 13. Wait for parent confirmation that RTMPS output is healthy
 * 14. Require preview and verify Studio's LIVE state
 * 15. Report success only after every gate passes
 */

import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(step, message, extra = {}) {
  console.log(`[STUDIO_WORKER] ${JSON.stringify({ time: new Date().toISOString(), step, message, ...extra })}`);
}

function emitEvent(event, data = {}) {
  console.log(`__STUDIO_EVENT__:${JSON.stringify({ event, ...data })}`);
}

function waitForStreamLaunchAck(timeoutMs) {
  return new Promise((resolve, reject) => {
    const input = createInterface({ input: process.stdin });
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.close();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for stream manager to verify RTMPS startup')), timeoutMs);
    input.once('line', line => {
      let response;
      try { response = JSON.parse(line); } catch {
        finish(new Error('Invalid stream startup acknowledgement'));
        return;
      }
      if (response.event !== 'stream_launch_ack' || response.ok !== true) {
        finish(new Error(response.error || 'Stream manager did not confirm healthy RTMPS output'));
        return;
      }
      finish(null, response);
    });
    input.once('close', () => finish(new Error('Stream manager closed its control channel before acknowledging RTMPS startup')));
  });
}

// ---------------------------------------------------------------------------
// Date/time helpers
// ---------------------------------------------------------------------------

function getFormattedDateTime(timeZone = 'Asia/Kolkata') {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(now).replace(/\//g, '-');
  const timeStr = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true })
    .format(now).replace(/[\u202f\xa0]/g, ' ');
  return { dateStr, timeStr, full: `${dateStr} ${timeStr}` };
}

function cleanBaseTitle(title) {
  if (!title) return '';
  let str = title.trim();
  for (let i = 0; i < 3; i++) {
    const prev = str;
    str = str
      .replace(/[\s\-_|•:]*(\d{1,4}[-/]\d{1,2}[-/]\d{2,4})([\s\u202f,]+(\d{1,2}:\d{2}(:\d{2})?([\s\u202f]*(AM|PM|am|pm))?))?[\s\-_|•:]*$/i, '')
      .replace(/[\s\-_|•:]*(\d{1,2}:\d{2}(:\d{2})?([\s\u202f]*(AM|PM|am|pm))?)[\s\-_|•:]*$/i, '')
      .replace(/[\s\-_|•:]*(\d{1,4}[-/]\d{1,2}[-/]\d{2,4})[\s\-_|•:]*$/i, '')
      .trim();
    if (str === prev) break;
  }
  return str.trim();
}

// ---------------------------------------------------------------------------
// Step helpers — each throws on unrecoverable failure
// ---------------------------------------------------------------------------

/** Wait up to ms for condition fn() to return truthy. Returns true/false. */
async function waitFor(fn, ms = 8000, pollMs = 300) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readTitleField(page) {
  return page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const editors = Array.from(document.querySelectorAll('ytcp-video-metadata-editor, ytcp-live-metadata-editor')).filter(visible);
    for (const editor of editors) {
      const fields = Array.from(editor.querySelectorAll(
        'div#textbox[aria-label*="title" i], [contenteditable="true"][aria-label*="title" i], ' +
        '[id*="title" i] #textbox, [id*="title" i][contenteditable="true"], ' +
        'ytcp-social-suggestions-textbox #textbox, [contenteditable="true"]#textbox, div#textbox'
      ));
      for (const field of fields) {
        if (!visible(field)) continue;
        const aria = (field.getAttribute('aria-label') || '').toLowerCase();
        const owner = field.closest('[id*="title" i], ytcp-social-suggestions-textbox, ytcp-form-input-container');
        const context = (owner?.innerText || field.parentElement?.innerText || '').toLowerCase();
        if (aria.includes('description') || context.includes('description')) continue;
        if (!aria.includes('title') && !context.includes('title') && !field.closest('ytcp-social-suggestions-textbox')) continue;
        return (field.innerText || field.textContent || '').trim();
      }
    }
    return null;
  });
}

async function getTitleFieldBox(page) {
  return page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const editors = Array.from(document.querySelectorAll('ytcp-video-metadata-editor, ytcp-live-metadata-editor')).filter(visible);
    for (const editor of editors) {
      const fields = Array.from(editor.querySelectorAll(
        'div#textbox[aria-label*="title" i], [contenteditable="true"][aria-label*="title" i], ' +
        '[id*="title" i] #textbox, [id*="title" i][contenteditable="true"], ' +
        'ytcp-social-suggestions-textbox #textbox, [contenteditable="true"]#textbox, div#textbox'
      ));
      for (const field of fields) {
        if (!visible(field)) continue;
        const aria = (field.getAttribute('aria-label') || '').toLowerCase();
        const owner = field.closest('[id*="title" i], ytcp-social-suggestions-textbox, ytcp-form-input-container');
        const context = (owner?.innerText || field.parentElement?.innerText || '').toLowerCase();
        if (aria.includes('description') || context.includes('description')) continue;
        if (!aria.includes('title') && !context.includes('title') && !field.closest('ytcp-social-suggestions-textbox')) continue;
        const rect = field.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }
    }
    return null;
  });
}

async function closeTitleEditor(page) {
  await page.keyboard.press('Escape');
  const closed = await waitFor(async () => page.evaluate(() =>
    !Array.from(document.querySelectorAll('ytcp-video-metadata-editor, ytcp-live-metadata-editor')).some(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })
  ), 5000);
  if (!closed) throw new Error('FATAL: Studio title editor did not close after title verification');
}

async function readStudioBroadcastStatus(page) {
  return page.evaluate(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const endButton = Array.from(document.querySelectorAll(
      '#stop-stream-button, #end-stream-button, [aria-label*="End stream" i], [title*="End stream" i]'
    )).find(el => visible(el) && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true');
    const livePhrases = Array.from(document.querySelectorAll(
      '[class*="status" i], [class*="badge" i], [id*="status" i], [aria-label], [title]'
    )).filter(visible).some(el => {
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
      return /^(live( now)?|streaming)$/i.test(text) || /^(live( now)?|streaming)$/i.test(label) ||
        /you(?:'|’)re live|you are live/i.test(text);
    });
    const healthyPreviewBadge = Array.from(document.querySelectorAll(
      '[class*="badge" i], [class*="health" i], [aria-label*="stream health" i]'
    )).filter(visible).some(el => /^(excellent|good)( connection)?$/i.test((el.innerText || el.textContent || '').trim()));
    const videoPreview = Array.from(document.querySelectorAll('ytcp-live-control-room video, #preview-player video, video'))
      .some(video => visible(video) && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
    const goLiveButton = Array.from(document.querySelectorAll(
      '#start-stream-button, [aria-label*="Go live" i]'
    )).find(visible);
    let goLive = null;
    if (goLiveButton) {
      const rect = goLiveButton.getBoundingClientRect();
      const inner = goLiveButton.matches('button') ? goLiveButton : goLiveButton.querySelector('button');
      const disabled = goLiveButton.hasAttribute('disabled') || goLiveButton.getAttribute('aria-disabled') === 'true' ||
        goLiveButton.classList.contains('disabled') || (inner && (inner.disabled || inner.getAttribute('aria-disabled') === 'true'));
      goLive = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, disabled };
    }
    return { live: Boolean(endButton || livePhrases), preview: Boolean(videoPreview || healthyPreviewBadge), goLive };
  });
}

async function clickConfirmationIfPresent(page) {
  const confirmation = await page.evaluate(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialog = Array.from(document.querySelectorAll('ytcp-confirmation-dialog, ytcp-dialog[open], [role="dialog"]')).find(visible);
    if (!dialog) return { present: false };
    if (!/go live|start stream/i.test(dialog.innerText || '')) return { present: false };
    const button = Array.from(dialog.querySelectorAll(
      '#confirm-button, button[aria-label*="Go live" i], ytcp-button[aria-label*="Go live" i], button'
    )).find(el => visible(el) && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true');
    if (!button) return { present: true, buttonFound: false };
    const rect = button.getBoundingClientRect();
    return { present: true, buttonFound: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (confirmation.present && !confirmation.buttonFound) {
    throw new Error('Studio displayed a Go Live confirmation dialog without an enabled confirmation button');
  }
  if (confirmation.buttonFound) await page.mouse.click(confirmation.x, confirmation.y);
  return confirmation.present;
}

/**
 * Dismiss a supported blocking modal and verify that it closes.
 */
async function dismissModals(page) {
  const action = await page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialog = Array.from(document.querySelectorAll('ytcp-dialog, tp-yt-paper-dialog, [role="dialog"]'))
      .find(el => visible(el) && !el.closest('ytcp-video-metadata-editor, ytcp-live-metadata-editor'));
    if (!dialog) return null;
    const buttons = Array.from(dialog.querySelectorAll('button, ytcp-button, tp-yt-paper-button, [role="button"]'));
    const button = buttons.find(el => {
      if (!visible(el) || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      return ['dismiss', 'got it', 'done', 'close', 'okay', 'ok'].includes(text) ||
        ['dismiss', 'got it', 'done', 'close', 'okay', 'ok'].includes(label);
    });
    if (!button) return { blocked: true, text: (dialog.innerText || '').trim().slice(0, 200) };
    button.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = button.getBoundingClientRect();
    return { blocked: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });

  if (!action) return false;
  if (action.x === undefined) throw new Error(`Studio has a blocking dialog without a supported dismiss action: ${action.text}`);
  await page.mouse.click(action.x, action.y);
  const dismissed = await waitFor(() => page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return !Array.from(document.querySelectorAll('ytcp-dialog, tp-yt-paper-dialog, [role="dialog"]'))
      .some(el => visible(el) && !el.closest('ytcp-video-metadata-editor, ytcp-live-metadata-editor'));
  }), 5000);
  if (!dismissed) throw new Error('Studio blocking dialog remained open after its dismiss action');
  log('modal_dismissed', 'Dismissed a blocking popup and verified it closed');
  await sleep(800);
  return true;
}

/** STEP 7: Click Edit button. Throws if modal never opens after retries. */
async function openEditModal(page) {
  log('edit_open_start', 'Opening metadata Edit modal');

  for (let attempt = 1; attempt <= 8; attempt++) {
    // Check if already open
    const isOpen = (await readTitleField(page)) !== null;
    if (isOpen) {
      log('edit_modal_open', `Metadata editor already open (attempt ${attempt})`);
      return;
    }

    // Try clicking Edit
    const clicked = await page.evaluate(() => {
      const candidates = [
        ...Array.from(document.querySelectorAll(
          '#edit-button, ytcp-button#edit-button, button[aria-label="Edit"], ' +
          '[aria-label*="Edit" i], ytcp-button[aria-label="Edit"], ' +
          'ytcp-stream-metadata-editor ytcp-button, ytcp-stream-metadata-editor button'
        )),
        ...Array.from(document.querySelectorAll('ytcp-button, button')).filter(el =>
          (el.textContent || '').trim().toLowerCase() === 'edit'
        )
      ];
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          const box = el.getBoundingClientRect();
          return { clicked: true, tag: el.tagName, id: el.id, x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }
      }
      return { clicked: false };
    });

    if (clicked.clicked) {
      await page.mouse.click(clicked.x, clicked.y);
      log('edit_button_clicked', `Edit clicked on attempt ${attempt}`, clicked);
      // Wait for textbox to appear
      const opened = await waitFor(async () => (await readTitleField(page)) !== null, 4000);
      if (opened) {
        log('edit_modal_verified', 'Metadata editor opened and title textbox visible');
        return;
      }
    } else {
      log('edit_button_not_found', `Attempt ${attempt}: Edit button not found, retrying`);
    }
    await sleep(1500);
  }

  throw new Error('FATAL: Could not open Edit modal after 8 attempts — aborting');
}

/** STEP 8+9: Type new title. Throws if content doesn't match after retries. */
async function typeTitle(page, newTitle) {
  log('type_title_start', 'Typing new title into editor', { newTitle });

  for (let attempt = 1; attempt <= 5; attempt++) {
    // Get bounding box of the title textbox
    const box = await getTitleFieldBox(page);

    if (!box) {
      log('type_title_no_box', `Attempt ${attempt}: Title textbox not found`);
      await sleep(800);
      continue;
    }

    // Real mouse click to focus
    await page.mouse.click(box.x, box.y);
    await sleep(250);

    // Ctrl+A to select all, then Backspace to clear
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await sleep(100);
    await page.keyboard.press('Backspace');
    await sleep(150);

    // Verify field is empty
    const afterClear = await readTitleField(page);
    if (afterClear) {
      // Field not cleared — try triple-click select then delete
      await page.mouse.click(box.x, box.y, { clickCount: 3 });
      await sleep(100);
      await page.keyboard.press('Delete');
      await sleep(100);
    }

    // Type the new title
    await page.keyboard.type(newTitle, { delay: 12 });
    await sleep(300);

    // Verify the typed content
    const actual = await readTitleField(page);

    if (actual === newTitle) {
      log('type_title_ok', `Title field contains correct value (attempt ${attempt})`, { actual });
      return;
    }

    log('type_title_mismatch', `Attempt ${attempt}: field has wrong content`, { expected: newTitle, actual });
    await sleep(600);
  }

  throw new Error(`FATAL: Could not type correct title after 5 attempts — last attempt did not match`);
}

/** STEP 10: Click Save and verify modal closes. Throws if save fails. */
async function saveAndVerify(page) {
  log('save_start', 'Clicking Save button');

  for (let attempt = 1; attempt <= 10; attempt++) {
    const result = await page.evaluate(() => {
      const candidates = [
        ...Array.from(document.querySelectorAll(
          '#save-button, ytcp-button#save-button, button[aria-label="Save"], ' +
          'ytcp-button[aria-label="Save"], ytcp-button.save-button, ' +
          'ytcp-video-metadata-editor #save-button, ytcp-live-metadata-editor #save-button'
        )),
        ...Array.from(document.querySelectorAll('ytcp-button, button')).filter(el =>
          (el.textContent || '').trim().toLowerCase() === 'save'
        )
      ];
      for (const btn of candidates) {
        const r = btn.getBoundingClientRect();
        const s = window.getComputedStyle(btn);
        if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') continue;
        if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('disabled')) {
          return { found: true, disabled: true };
        }
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        const box = btn.getBoundingClientRect();
        return { found: true, disabled: false, clicked: true, x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      return { found: false };
    });

    if (result.disabled) {
      log('save_disabled', `Save button disabled on attempt ${attempt} — waiting for YouTube to enable it`);
      await sleep(700);
      continue;
    }

    if (!result.found) {
      log('save_not_found', `Save button not found on attempt ${attempt}`);
      await sleep(700);
      continue;
    }

    // Save clicked — wait for modal to close
    log('save_clicked', `Save button clicked on attempt ${attempt}`);
    await page.mouse.click(result.x, result.y);
    const closed = await waitFor(() => page.evaluate(() => {
      const modal = document.querySelector('ytcp-video-metadata-editor, ytcp-live-metadata-editor');
      if (!modal) return true;
      const r = modal.getBoundingClientRect();
      return r.width === 0 || r.height === 0;
    }), 6000);

    if (closed) {
      log('save_modal_closed', 'Metadata editor closed after Save — save likely succeeded');
      await sleep(1000);
      return;
    }

    log('save_modal_still_open', `Attempt ${attempt}: Modal still open after save click, retrying`);
    await sleep(800);
  }

  throw new Error('FATAL: Save button could not be clicked or modal did not close — aborting');
}

/** STEP 11: Reload Studio page and verify saved title. Throws if mismatch after retry. */
async function verifyPersistedTitle(page, expectedTitle, timeZone, configuredBaseTitle) {
  log('verify_start', 'Reloading Studio page to verify saved title');

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);

  // Re-open editor
  await openEditModal(page);
  await sleep(500);

  const persistedTitle = await readTitleField(page);

  if (persistedTitle === expectedTitle) {
    log('verify_ok', 'Saved title verified on reload', { savedTitle: persistedTitle });
    await closeTitleEditor(page);
    return;
  }

  log('verify_mismatch', 'Reload shows different title — retrying type+save once more', {
    expected: expectedTitle,
    actual: persistedTitle
  });

  // One more attempt — compute fresh title (time may have changed slightly)
  const dt = getFormattedDateTime(timeZone);
  let base = configuredBaseTitle ? configuredBaseTitle.trim() : '';
  if (!base && persistedTitle) base = cleanBaseTitle(persistedTitle);
  if (!base) base = 'Live Stream';
  const dateSuffix = ` ${dt.full}`;
  const maxBaseLen = Math.max(10, 100 - dateSuffix.length);
  if (base.length > maxBaseLen) base = base.substring(0, maxBaseLen).trim();
  const retryTitle = `${base}${dateSuffix}`.trim().slice(0, 100);

  await typeTitle(page, retryTitle);
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el && el.blur) el.blur();
  });
  await saveAndVerify(page);

  // Second reload verify
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);
  await openEditModal(page);
  await sleep(500);

  const finalTitle = await readTitleField(page);

  if (finalTitle !== retryTitle) {
    throw new Error(`FATAL: Title did not persist after 2 save attempts. Expected: "${retryTitle}", Got: "${finalTitle}"`);
  }

  await closeTitleEditor(page);
  log('verify_retry_ok', 'Title persisted after retry', { savedTitle: finalTitle });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const targetUrl       = process.env.STUDIO_URL || 'https://studio.youtube.com/video/xHUulPKBtJs/livestreaming';
  const configBaseTitle = process.env.STUDIO_BASE_TITLE || '';
  const timeZone        = process.env.STUDIO_TIMEZONE || 'Asia/Kolkata';
  const chromePath      = process.env.CHROME_BIN || '/usr/bin/google-chrome';
  const primaryDir      = process.env.CHROME_USER_DATA_DIR || '/home/ubuntu/.config/google-chrome';
  const activeDir       = process.env.CHROME_ACTIVE_DATA_DIR || '/home/ubuntu/.config/google-chrome-studio';
  const display         = process.env.DISPLAY || ':10';
  const previewWaitSec  = Number(process.env.STUDIO_PREVIEW_WAIT_SEC) || 10;
  const timeoutMs       = Number(process.env.STUDIO_TIMEOUT_MS) || 180000;
  const debugPort       = 9222;

  log('start', 'Studio worker starting', { targetUrl, display, timeoutMs });

  let browser = null;
  let chromeProcess = null;
  let watchdog = null;

  process.once('SIGTERM', () => {
    log('termination_signal', 'Worker was asked to stop; terminating its owned Chrome process');
    try { chromeProcess?.kill('SIGTERM'); } catch {}
    if (browser) {
      browser.close().catch(() => {}).finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  });

  try {
    // -----------------------------------------------------------------------
    // STEP 1: Sync Chrome profile
    // -----------------------------------------------------------------------
    log('step1_profile_sync', 'Syncing Chrome profile');
    if (!fs.existsSync(chromePath)) throw new Error(`Chrome executable not found: ${chromePath}`);
    if (!fs.existsSync(primaryDir) || !fs.statSync(primaryDir).isDirectory()) {
      throw new Error(`Chrome source profile directory does not exist: ${primaryDir}`);
    }
    const resolvedPrimary = path.resolve(primaryDir);
    const resolvedActive = path.resolve(activeDir);
    const relativeActive = path.relative(resolvedPrimary, resolvedActive);
    const relativePrimary = path.relative(resolvedActive, resolvedPrimary);
    if (!relativeActive || (!relativeActive.startsWith('..') && !path.isAbsolute(relativeActive)) ||
        (!relativePrimary.startsWith('..') && !path.isAbsolute(relativePrimary))) {
      throw new Error('Chrome source and automation profile directories must be separate and non-nested');
    }
    fs.mkdirSync(activeDir, { recursive: true });
    execFileSync('rsync', ['-a', '--delete', "--exclude=Singleton*", `${resolvedPrimary}${path.sep}`, `${resolvedActive}${path.sep}`], {
      stdio: 'pipe',
      timeout: 60000,
    });
    if (!fs.existsSync(resolvedActive) || !fs.statSync(resolvedActive).isDirectory()) {
      throw new Error('Chrome automation profile directory was not created');
    }
    log('step1_ok', 'Chrome profile sync completed and destination verified');

    watchdog = setTimeout(async () => {
      log('watchdog', 'Strict Studio workflow timed out — terminating owned Chrome and worker');
      try {
        await Promise.race([browser?.close() || Promise.resolve(), sleep(2000)]);
      } catch {}
      try { chromeProcess?.kill('SIGTERM'); } catch {}
      process.exit(1);
    }, timeoutMs);

    // -----------------------------------------------------------------------
    // STEP 2: Require an available debug port, then launch our Chrome process
    // -----------------------------------------------------------------------
    log('step2_chrome_launch', 'Launching Chrome');
    try {
      const existing = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (existing.ok) throw new Error(`Chrome debug port ${debugPort} is already occupied; refusing to kill an unrelated process`);
    } catch (err) {
      if (err.message.includes('already occupied')) throw err;
    }

    const chromeArgs = [
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${activeDir}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1920,1080',
    ];
    chromeProcess = spawn(chromePath, chromeArgs, {
      env: { ...process.env, DISPLAY: display },
      stdio: 'ignore',
      detached: false,
    });
    let chromeLaunchError = null;
    chromeProcess.once('error', err => { chromeLaunchError = err; });

    // Wait for debug port
    const portReady = await waitFor(async () => {
      if (chromeLaunchError) throw new Error(`Chrome failed to launch: ${chromeLaunchError.message}`);
      if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
        throw new Error(`Chrome exited before its debug endpoint was ready (code=${chromeProcess.exitCode}, signal=${chromeProcess.signalCode})`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return false;
        const version = await res.json();
        return Boolean(version.Browser && version.webSocketDebuggerUrl);
      } catch { return false; }
    }, 20000, 400);

    if (!portReady) throw new Error('FATAL: Chrome debug port did not become ready within 20s');
    log('step2_ok', `Chrome debug port ${debugPort} ready`);

    // -----------------------------------------------------------------------
    // STEP 3: Connect Puppeteer
    // -----------------------------------------------------------------------
    log('step3_connect', 'Connecting Puppeteer to Chrome');
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${debugPort}`,
      defaultViewport: null,
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(35000);
    log('step3_ok', 'Puppeteer connected');

    // -----------------------------------------------------------------------
    // STEP 4: Navigate to Studio and verify correct page + logged in
    // -----------------------------------------------------------------------
    log('step4_navigate', `Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    const pageInfo = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      isSignedOut: !!document.querySelector('ytd-signin-renderer, [data-screen="signin"]'),
    }));
    log('step4_loaded', 'Page loaded', pageInfo);

    const expectedStudioUrl = new URL(targetUrl);
    const actualStudioUrl = new URL(pageInfo.url);
    const expectedVideoId = expectedStudioUrl.pathname.match(/\/video\/([^/]+)/)?.[1];
    const actualVideoId = actualStudioUrl.pathname.match(/\/video\/([^/]+)/)?.[1];
    if (pageInfo.isSignedOut || /accounts\.google\.com|\/signin/i.test(pageInfo.url)) {
      throw new Error('FATAL: Chrome is not logged into YouTube — sign in required');
    }
    if (actualStudioUrl.hostname !== 'studio.youtube.com') {
      throw new Error(`FATAL: Redirected away from Studio: ${pageInfo.url}`);
    }
    if (!expectedVideoId || actualVideoId !== expectedVideoId) {
      throw new Error(`FATAL: Studio opened the wrong broadcast (expected ${expectedVideoId || 'video route'}, got ${actualVideoId || pageInfo.url})`);
    }
    if (!actualStudioUrl.pathname.includes('/livestreaming')) {
      throw new Error(`FATAL: Studio did not open the livestream control room: ${pageInfo.url}`);
    }
    log('step4_ok', 'Correct livestream control room and signed-in Studio session verified');

    // -----------------------------------------------------------------------
    // STEP 5: Dismiss any blocking modals
    // -----------------------------------------------------------------------
    log('step5_dismiss', 'Dismissing any blocking modals');
    for (let i = 0; i < 4; i++) {
      await dismissModals(page);
      await sleep(800);
    }
    log('step5_ok', 'Modal dismiss pass complete');

    // -----------------------------------------------------------------------
    // STEP 6: Wait for control panel to settle
    // -----------------------------------------------------------------------
    log('step6_settle', 'Waiting for Studio control panel to settle');
    await sleep(2000);

    // Wait for stream metadata editor element to appear
    const metaEditorReady = await waitFor(() => page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        'ytcp-stream-metadata-editor, #edit-button, ytcp-button#edit-button'
      ));
      return candidates.some(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
    }), 15000);

    if (!metaEditorReady) {
      throw new Error('FATAL: Stream metadata editor section did not appear within 15s');
    }
    log('step6_ok', 'Studio control panel settled and metadata editor section visible');

    // -----------------------------------------------------------------------
    // STEP 7: Open Edit modal (throws if fails)
    // -----------------------------------------------------------------------
    await openEditModal(page);
    await sleep(500);

    // -----------------------------------------------------------------------
    // STEP 8: Compute target title from current text
    // -----------------------------------------------------------------------
    log('step8_compute_title', 'Reading current title and computing new title');
    const currentTitle = await readTitleField(page);

    if (currentTitle === null) throw new Error('FATAL: Could not read current title from open editor');
    log('step8_current_title', 'Current title read', { currentTitle });

    const dt = getFormattedDateTime(timeZone);
    let base = configBaseTitle ? configBaseTitle.trim() : '';
    if (!base) {
      base = cleanBaseTitle(currentTitle);
      if (!base) base = 'Live Stream';
    }
    const dateSuffix = ` ${dt.full}`;
    const maxBaseLen = 100 - dateSuffix.length;
    if (maxBaseLen <= 0) throw new Error('FATAL: Date/time suffix leaves no room for a YouTube title');
    if (base.length > maxBaseLen) base = base.substring(0, maxBaseLen).trim();
    const newTitle = `${base}${dateSuffix}`.trim();
    if (!newTitle || newTitle.length > 100) throw new Error(`FATAL: Generated title is invalid (${newTitle.length} characters)`);
    log('step8_ok', 'New title computed', { base, newTitle, charCount: newTitle.length });

    // -----------------------------------------------------------------------
    // STEP 9: Type title (throws if verification fails)
    // -----------------------------------------------------------------------
    await typeTitle(page, newTitle);

    // Blur to trigger any remaining change events
    await page.evaluate(() => { if (document.activeElement?.blur) document.activeElement.blur(); });
    await sleep(300);

    // -----------------------------------------------------------------------
    // STEP 10: Save (throws if save fails)
    // -----------------------------------------------------------------------
    await saveAndVerify(page);

    // -----------------------------------------------------------------------
    // STEP 11: Reload and verify title persisted (throws if double-retry fails)
    // -----------------------------------------------------------------------
    await verifyPersistedTitle(page, newTitle, timeZone, configBaseTitle);

    // -----------------------------------------------------------------------
    // STEP 12: Signal stream-manager, then wait for its verified RTMPS health ack
    // -----------------------------------------------------------------------
    log('step12_ready', 'Saved title was read back exactly — requesting stream launch');
    emitEvent('ready_to_stream', { titleVerified: true, title: newTitle });
    const streamAck = await waitForStreamLaunchAck(Math.min(timeoutMs, 60000));
    log('step12_stream_healthy', 'Stream manager confirmed healthy RTMPS output', { pid: streamAck.pid });

    // -----------------------------------------------------------------------
    // STEP 13: Require a real preview, issue Go Live if needed, then verify LIVE
    // -----------------------------------------------------------------------
    log('step13_preview_wait', 'Waiting for a decoded encoder preview in Studio');
    const previewDeadline = Date.now() + 60000;
    let status = null;
    while (Date.now() < previewDeadline) {
      status = await readStudioBroadcastStatus(page);
      if (status.preview) break;
      await sleep(1500);
    }
    if (!status?.preview) {
      throw new Error('FATAL: Studio did not show a decoded encoder preview within 60 seconds');
    }
    log('step13_preview_ok', 'Studio decoded encoder preview verified', status);

    if (!status.live && status.goLive && !status.goLive.disabled) {
      log('step14_go_live', 'Preview is ready; clicking enabled Go Live control');
      await page.mouse.click(status.goLive.x, status.goLive.y);
      const confirmationDeadline = Date.now() + 5000;
      while (Date.now() < confirmationDeadline) {
        const confirmationPresent = await clickConfirmationIfPresent(page);
        if (confirmationPresent) {
          log('step14_confirmation', 'Confirmed Studio Go Live dialog');
          break;
        }
        if ((await readStudioBroadcastStatus(page)).live) break;
        await sleep(300);
      }
    }

    log('step15_live_wait', 'Waiting for Studio to confirm the broadcast is LIVE');
    const liveDeadline = Date.now() + 60000;
    let liveStatus = status;
    while (Date.now() < liveDeadline) {
      liveStatus = await readStudioBroadcastStatus(page);
      if (liveStatus.live) break;
      await sleep(1500);
    }
    if (!liveStatus?.live) {
      throw new Error('FATAL: Studio never confirmed the broadcast LIVE; stopping the startup sequence');
    }
    log('step15_live_verified', 'Studio confirms broadcast is LIVE');

    // -----------------------------------------------------------------------
    // STEP 16: Report success only after title, RTMPS health, preview, and LIVE checks pass
    // -----------------------------------------------------------------------
    log('step16_post_wait', `Waiting ${previewWaitSec}s after verified LIVE before closing Chrome`);
    await sleep(previewWaitSec * 1000);

    log('closing_browser', 'Closing Chrome');
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    if (chromeProcess) { try { chromeProcess.kill('SIGTERM'); } catch {} chromeProcess = null; }

    log('finished', 'Studio and stream startup gates all passed');
    emitEvent('finished', { success: true, titleVerified: true, liveVerified: true, title: newTitle });

  } catch (err) {
    log('fatal_error', `FATAL: ${err.message}`, { stack: err.stack });
    emitEvent('finished', { success: false, error: err.message });
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    if (browser) { try { await browser.close(); } catch {} }
    if (chromeProcess) { try { chromeProcess.kill('SIGTERM'); } catch {} }
  }
}

run();
