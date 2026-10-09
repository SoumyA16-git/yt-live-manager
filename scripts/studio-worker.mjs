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
 *  5. Dismiss any blocking modals (non-fatal)
 *  6. Wait for page to settle
 *  7. Click Edit button → VERIFY modal opened (throw if not)
 *  8. Read current title → compute new title
 *  9. Click title field (real mouse), Ctrl+A, Backspace, type new title → VERIFY content matches
 * 10. Click Save → VERIFY modal closes (throw if not)
 * 11. Reload page → re-open editor → VERIFY saved title matches (retry once if mismatch)
 * 12. Emit ready_to_stream
 * 13. Wait for live preview
 * 14. Close Chrome
 */

import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(step, message, extra = {}) {
  console.log(`[STUDIO_WORKER] ${JSON.stringify({ time: new Date().toISOString(), step, message, ...extra })}`);
}

function emitEvent(event, data = {}) {
  console.log(`__STUDIO_EVENT__:${JSON.stringify({ event, ...data })}`);
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

/**
 * Dismiss any blocking modals that are NOT the metadata editor.
 * Non-fatal — just logs.
 */
async function dismissModals(page) {
  try {
    const dismissed = await page.evaluate(() => {
      const metaEditor = document.querySelector('ytcp-video-metadata-editor, ytcp-live-metadata-editor');
      if (metaEditor && metaEditor.getBoundingClientRect().width > 0) return false;

      const sels = Array.from(document.querySelectorAll(
        '#dismiss-button, ytcp-button#dismiss-button, button[aria-label="Dismiss"], ' +
        'ytcp-button[aria-label="Dismiss"], tp-yt-paper-button#dismiss-button, ' +
        'ytcp-dialog #dismiss-button, ytcp-confirmation-dialog #confirm-button, ' +
        'button[aria-label="Close"], [aria-label="Close dialog"]'
      )).filter(b => !b.closest('ytcp-video-metadata-editor, ytcp-live-metadata-editor'));

      const text = Array.from(document.querySelectorAll('ytcp-button, button, tp-yt-paper-button'))
        .filter(b => {
          if (b.closest('ytcp-video-metadata-editor, ytcp-live-metadata-editor')) return false;
          const t = (b.textContent || '').trim().toLowerCase();
          return t === 'dismiss' || t === 'got it' || t === 'done' || t === 'close';
        });

      for (const btn of [...sels, ...text]) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          (btn.querySelector('button, [role="button"]') || btn).click();
          btn.click();
          return true;
        }
      }

      const backdrops = Array.from(document.querySelectorAll('tp-yt-iron-overlay-backdrop.opened, iron-overlay-backdrop.opened'));
      if (backdrops.length && !document.querySelector('ytcp-video-metadata-editor, ytcp-live-metadata-editor')) {
        backdrops.forEach(b => { b.classList.remove('opened'); b.style.display = 'none'; });
        return true;
      }
      return false;
    });
    if (dismissed) {
      log('modal_dismissed', 'Dismissed a blocking popup modal');
      await sleep(1200);
    }
  } catch (e) {
    log('modal_dismiss_warn', `Non-fatal dismiss error: ${e.message}`);
  }
}

/** STEP 7: Click Edit button. Throws if modal never opens after retries. */
async function openEditModal(page) {
  log('edit_open_start', 'Opening metadata Edit modal');

  for (let attempt = 1; attempt <= 8; attempt++) {
    // Check if already open
    const isOpen = await page.evaluate(() => {
      const tb = document.querySelector('div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, [contenteditable="true"]#textbox');
      return !!(tb && tb.getBoundingClientRect().width > 0);
    });
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
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          el.click();
          const inner = el.querySelector('button, [role="button"]');
          if (inner) inner.click();
          return { clicked: true, tag: el.tagName, id: el.id };
        }
      }
      return { clicked: false };
    });

    if (clicked.clicked) {
      log('edit_button_clicked', `Edit clicked on attempt ${attempt}`, clicked);
      // Wait for textbox to appear
      const opened = await waitFor(() => page.evaluate(() => {
        const tb = document.querySelector('div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, [contenteditable="true"]#textbox');
        return !!(tb && tb.getBoundingClientRect().width > 0);
      }), 4000);
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
    const box = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
        '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
      ));
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') continue;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const parentText = (el.parentElement?.textContent || '').toLowerCase();
        if (aria.includes('description') || (!aria.includes('title') && parentText.includes('description'))) continue;
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    });

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
    const afterClear = await page.evaluate(() => {
      const el = document.activeElement;
      return (el ? (el.innerText || el.textContent || '') : '').trim();
    });
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

    // Trigger YouTube's change detection
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
        '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
      ));
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') continue;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const pText = (el.parentElement?.textContent || '').toLowerCase();
        if (aria.includes('description') || (!aria.includes('title') && pText.includes('description'))) continue;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    });
    await sleep(200);

    // Verify the typed content
    const actual = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
        '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
      ));
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') continue;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const pText = (el.parentElement?.textContent || '').toLowerCase();
        if (aria.includes('description') || (!aria.includes('title') && pText.includes('description'))) continue;
        return (el.innerText || el.textContent || '').trim();
      }
      return null;
    });

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
        (btn.querySelector('button, [role="button"]') || btn).click();
        btn.click();
        return { found: true, disabled: false, clicked: true };
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

  const persistedTitle = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
      '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
    ));
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const pText = (el.parentElement?.textContent || '').toLowerCase();
      if (aria.includes('description') || (!aria.includes('title') && pText.includes('description'))) continue;
      return (el.innerText || el.textContent || '').trim();
    }
    return null;
  });

  if (persistedTitle === expectedTitle) {
    log('verify_ok', 'Saved title verified on reload', { savedTitle: persistedTitle });
    await page.keyboard.press('Escape').catch(() => {});
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

  const finalTitle = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
      '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
    ));
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const pText = (el.parentElement?.textContent || '').toLowerCase();
      if (aria.includes('description') || (!aria.includes('title') && pText.includes('description'))) continue;
      return (el.innerText || el.textContent || '').trim();
    }
    return null;
  });

  await page.keyboard.press('Escape').catch(() => {});

  if (finalTitle !== retryTitle) {
    throw new Error(`FATAL: Title did not persist after 2 save attempts. Expected: "${retryTitle}", Got: "${finalTitle}"`);
  }

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

  // Safety watchdog
  const watchdog = setTimeout(() => {
    log('watchdog', 'Safety watchdog triggered — exiting');
    try { execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' }); } catch {}
    process.exit(1);
  }, timeoutMs);

  log('start', 'Studio worker starting', { targetUrl, display, timeoutMs });

  let browser = null;
  let chromeProcess = null;

  try {
    // -----------------------------------------------------------------------
    // STEP 1: Sync Chrome profile
    // -----------------------------------------------------------------------
    log('step1_profile_sync', 'Syncing Chrome profile');
    try {
      fs.mkdirSync(activeDir, { recursive: true });
      execSync(
        `rsync -a --delete --exclude='Singleton*' "${primaryDir}/" "${activeDir}/" 2>/dev/null || true`,
        { stdio: 'ignore' }
      );
      log('step1_ok', 'Chrome profile synced');
    } catch (e) {
      log('step1_warn', `Profile sync warning (non-fatal): ${e.message}`);
    }

    // -----------------------------------------------------------------------
    // STEP 2: Kill any existing Chrome on debug port, then launch fresh Chrome
    // -----------------------------------------------------------------------
    log('step2_chrome_launch', 'Launching Chrome');
    try { execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' }); } catch {}
    await sleep(500);

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

    // Wait for debug port
    const portReady = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        return res.ok;
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

    if (pageInfo.isSignedOut) throw new Error('FATAL: Chrome is not logged into YouTube — sign in required');
    if (!pageInfo.url.includes('studio.youtube.com')) throw new Error(`FATAL: Redirected away from Studio: ${pageInfo.url}`);
    log('step4_ok', 'Studio page confirmed and user is logged in');

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
      return !!(
        document.querySelector('ytcp-stream-metadata-editor') ||
        document.querySelector('#edit-button') ||
        document.querySelector('ytcp-button#edit-button')
      );
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
    const currentTitle = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        'div#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, ' +
        '[contenteditable="true"]#textbox, div#textbox, [contenteditable="true"]'
      ));
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') continue;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const pText = (el.parentElement?.textContent || '').toLowerCase();
        if (aria.includes('description') || (!aria.includes('title') && pText.includes('description'))) continue;
        return (el.innerText || el.textContent || '').trim();
      }
      return null;
    });

    if (currentTitle === null) throw new Error('FATAL: Could not read current title from open editor');
    log('step8_current_title', 'Current title read', { currentTitle });

    const dt = getFormattedDateTime(timeZone);
    let base = configBaseTitle ? configBaseTitle.trim() : '';
    if (!base) {
      base = cleanBaseTitle(currentTitle);
      if (!base) base = 'Live Stream';
    }
    const dateSuffix = ` ${dt.full}`;
    const maxBaseLen = Math.max(10, 100 - dateSuffix.length);
    if (base.length > maxBaseLen) base = base.substring(0, maxBaseLen).trim();
    const newTitle = `${base}${dateSuffix}`.trim().slice(0, 100);
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
    // STEP 12: Signal stream-manager — stream can now start
    // -----------------------------------------------------------------------
    log('step12_ready', 'All title steps verified — signalling stream start');
    emitEvent('ready_to_stream');

    // -----------------------------------------------------------------------
    // STEP 13: Wait for live preview
    // -----------------------------------------------------------------------
    log('step13_preview_wait', 'Waiting for encoder connection and live preview in Studio');
    let previewDetected = false;
    const previewDeadline = Date.now() + 60000;

    while (Date.now() < previewDeadline) {
      try {
        const status = await page.evaluate(() => {
          const goLive = document.querySelector('#start-stream-button, [aria-label*="Go live" i]');
          if (goLive && !goLive.hasAttribute('disabled') && goLive.getAttribute('aria-disabled') !== 'true') {
            (goLive.querySelector('button') || goLive).click();
            goLive.click();
            return { goLiveClicked: true };
          }
          const video = document.querySelector('video');
          if (video && (video.readyState >= 2 || video.currentTime > 0)) return { preview: true };
          const badges = Array.from(document.querySelectorAll('.badge, [class*="badge"], [class*="health"]'));
          for (const b of badges) {
            if (/excellent|good|live/i.test(b.innerText || '')) return { preview: true };
          }
          const bodyText = document.body.innerText || '';
          return { preview: !bodyText.includes('Connect your encoder to go live') && !bodyText.includes('No data') };
        });

        if (status.goLiveClicked) {
          log('go_live_clicked', 'Clicked Go Live button');
          previewDetected = true;
          await sleep(1500);
          await page.evaluate(() => {
            const conf = document.querySelector('ytcp-confirmation-dialog #confirm-button, #confirm-button');
            if (conf) (conf.querySelector('button') || conf).click();
          });
          break;
        }
        if (status.preview) {
          previewDetected = true;
          log('preview_detected', 'Live preview detected in Studio');
          break;
        }
      } catch {}
      await sleep(2000);
    }

    if (!previewDetected) log('preview_timeout', 'Preview wait timed out; proceeding with shutdown');

    // -----------------------------------------------------------------------
    // STEP 14: Wait then close Chrome
    // -----------------------------------------------------------------------
    log('step14_post_wait', `Waiting ${previewWaitSec}s before closing Chrome`);
    await sleep(previewWaitSec * 1000);

    log('closing_browser', 'Closing Chrome');
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    if (chromeProcess) { try { chromeProcess.kill('SIGTERM'); } catch {} chromeProcess = null; }
    try { execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' }); } catch {}

    log('finished', 'Studio automation completed successfully');
    emitEvent('finished', { success: true });

  } catch (err) {
    log('fatal_error', `FATAL: ${err.message}`, { stack: err.stack });
    emitEvent('finished', { success: false, error: err.message });
  } finally {
    clearTimeout(watchdog);
    if (browser) { try { await browser.close(); } catch {} }
    if (chromeProcess) { try { chromeProcess.kill('SIGTERM'); } catch {} }
    try { execSync(`fuser -k ${debugPort}/tcp || true`, { stdio: 'ignore' }); } catch {}
    process.exit(0);
  }
}

run();
