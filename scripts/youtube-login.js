#!/usr/bin/env node
/**
 * scripts/youtube-login.js — One-time YouTube Studio authentication bootstrap.
 *
 * Usage:
 *   npm run youtube:login
 *
 * Behavior:
 * - Detects if a graphical display ($DISPLAY) is available.
 * - If headless (e.g. remote VPS), spawns temporary Xvfb (:99) and x11vnc on localhost:5900
 *   so the operator can tunnel in via: ssh -L 5900:localhost:5900 user@host
 * - Opens persistent Chromium in headful mode using the dedicated profile directory.
 * - Navigates to YouTube Studio Live Control Room.
 * - Waits for the operator to sign into Google and complete 2FA.
 * - Automatically detects when YouTube Studio is reached, saves session, closes browser,
 *   and tears down temporary Xvfb/VNC processes cleanly.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import PATHS from '../src/lib/paths.js';

let xvfbProcess = null;
let x11vncProcess = null;

function cleanupDisplayTools() {
  if (x11vncProcess) {
    try { x11vncProcess.kill('SIGTERM'); } catch {}
    x11vncProcess = null;
  }
  if (xvfbProcess) {
    try { xvfbProcess.kill('SIGTERM'); } catch {}
    xvfbProcess = null;
  }
}

process.on('SIGINT', () => {
  console.log('\n[LOGIN] Interrupted. Cleaning up...');
  cleanupDisplayTools();
  process.exit(1);
});

process.on('exit', () => {
  cleanupDisplayTools();
});

async function main() {
  console.log('========================================================');
  console.log('   YOUTUBE STUDIO AUTHENTICATION BOOTSTRAP (ONE-TIME)  ');
  console.log('========================================================\n');

  const profileDir = PATHS.youtubeProfile;
  await fs.mkdir(profileDir, { recursive: true });
  console.log(`[PROFILE] Target user data directory: ${profileDir}`);

  // 1. Resolve Playwright
  let pw;
  try {
    pw = await import('playwright');
  } catch (err) {
    console.error('[ERROR] Playwright is not installed in node_modules.');
    console.error('Please run: npm install playwright && npx playwright install chromium');
    process.exit(1);
  }

  // 2. Display check
  const isWindows = process.platform === 'win32';
  const hasDisplay = Boolean(process.env.DISPLAY);

  if (!isWindows && !hasDisplay) {
    console.log('[HEADLESS VPS DETECTED] No $DISPLAY found.');
    console.log('[DISPLAY] Starting temporary virtual display (Xvfb :99) and VNC bridge (x11vnc)...');

    try {
      xvfbProcess = spawn('Xvfb', [':99', '-screen', '0', '1280x720x24'], { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 1000));

      x11vncProcess = spawn('x11vnc', ['-display', ':99', '-localhost', '-nopw', '-forever'], { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 1000));

      process.env.DISPLAY = ':99';

      console.log('\n========================================================');
      console.log('   ACTION REQUIRED TO COMPLETE ONE-TIME LOGIN:          ');
      console.log('========================================================');
      console.log('1. On your local machine, run this SSH tunnel command:');
      console.log('   ssh -L 5900:localhost:5900 <your-vps-user>@<your-vps-ip>');
      console.log('2. Open any VNC Viewer on your computer and connect to:');
      console.log('   localhost:5900');
      console.log('3. Complete Google sign-in and 2FA in the browser window.');
      console.log('========================================================\n');
    } catch (dispErr) {
      console.warn('[WARNING] Could not start Xvfb/x11vnc automatically:', dispErr.message);
      console.log('Ensure xvfb and x11vnc are installed: sudo apt-get install -y xvfb x11vnc');
    }
  } else {
    console.log(`[DISPLAY] Active display detected (${process.env.DISPLAY || 'local GUI'}).`);
  }

  console.log('[BROWSER] Launching Chromium...');

  const chromium = pw.chromium || pw;
  let browserContext;
  try {
    browserContext = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: { width: 1280, height: 720 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    });
  } catch (launchErr) {
    console.error('[ERROR] Failed to launch Chromium:', launchErr.message);
    cleanupDisplayTools();
    process.exit(1);
  }

  const pages = browserContext.pages();
  const page = pages.length > 0 ? pages[0] : await browserContext.newPage();

  console.log('[NAVIGATE] Opening https://studio.youtube.com/live ...');
  try {
    await page.goto('https://studio.youtube.com/live', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (navErr) {
    console.warn('[NAVIGATE] Initial navigation error (will still allow login):', navErr.message);
  }

  console.log('\n[WAITING] Please complete your Google / YouTube login in the browser window.');
  console.log('[WAITING] This script will automatically detect when YouTube Studio is ready...\n');

  // 3. Poll for successful login
  const maxWaitMs = 15 * 60 * 1000; // 15 minutes
  const startTime = Date.now();
  let authenticated = false;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const url = page.url();
      if (!url.includes('accounts.google.com') && !url.includes('signin') && url.includes('studio.youtube.com')) {
        // Confirm studio page body has loaded
        const bodyText = (await page.innerText('body')).toLowerCase();
        if (bodyText.includes('stream') || bodyText.includes('live') || bodyText.includes('channel') || bodyText.includes('studio')) {
          authenticated = true;
          console.log('[SUCCESS] YouTube Studio session verified!');
          console.log(`[SUCCESS] Current page: ${url}`);
          break;
        }
      }
    } catch {
      // transient page reload during login
    }
  }

  if (authenticated) {
    console.log('\n[SAVING] Allowing persistent profile data to flush to disk...');
    await new Promise(r => setTimeout(r, 3000));
    await browserContext.close();
    cleanupDisplayTools();

    console.log('========================================================');
    console.log('   AUTHENTICATION SUCCESSFUL!                           ');
    console.log(`   Session saved to: ${profileDir}`);
    console.log('   The application can now prepare YouTube live sessions');
    console.log('   automatically without interactive login.             ');
    console.log('========================================================\n');
    process.exit(0);
  } else {
    console.error('\n[TIMEOUT] Login was not completed within 15 minutes.');
    await browserContext.close();
    cleanupDisplayTools();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  cleanupDisplayTools();
  process.exit(1);
});
