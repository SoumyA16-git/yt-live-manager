#!/usr/bin/env node
/**
 * scripts/youtube-login.js — One-time YouTube Studio authentication bootstrap.
 *
 * Uses REAL Google Chrome (not Playwright bundled Chromium) to prevent Google's:
 * "This browser or app may not be secure" error.
 *
 * Usage:
 *   npm run youtube:login
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import PATHS from '../src/lib/paths.js';
import { getChromeExecutablePath } from '../src/lib/chrome-finder.js';

let xvfbProcess = null;
let x11vncProcess = null;
let chromeProcess = null;

function cleanupProcesses() {
  if (chromeProcess) {
    try { chromeProcess.kill('SIGTERM'); } catch {}
    chromeProcess = null;
  }
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
  cleanupProcesses();
  process.exit(1);
});

process.on('exit', () => {
  cleanupProcesses();
});

/**
 * Polls the Chrome DevTools HTTP endpoint until it answers.
 */
function waitForCdpEndpoint(port, timeoutMs = 30000) {
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
        setTimeout(check, 500);
      }
    };

    check();
  });
}

async function main() {
  console.log('========================================================');
  console.log('   YOUTUBE STUDIO AUTHENTICATION BOOTSTRAP (REAL CHROME)');
  console.log('========================================================\n');

  const profileDir = PATHS.youtubeProfile;
  await fs.mkdir(profileDir, { recursive: true });
  console.log(`[PROFILE] Target user data directory: ${profileDir}`);

  // 1. Locate real Google Chrome binary
  const chromePath = getChromeExecutablePath();
  console.log(`[CHROME] Using Chrome binary: ${chromePath}`);

  // 2. Display check
  const isWindows = process.platform === 'win32';
  const hasDisplay = Boolean(process.env.DISPLAY);

  if (!isWindows && !hasDisplay) {
    console.log('[HEADLESS VPS DETECTED] No $DISPLAY found.');
    console.log('[DISPLAY] Starting temporary virtual display (Xvfb :99) and VNC bridge (x11vnc on localhost:5900)...');

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
      console.log('3. Complete Google sign-in and 2FA in the REAL Google Chrome window.');
      console.log('========================================================\n');
    } catch (dispErr) {
      console.warn('[WARNING] Could not start Xvfb/x11vnc automatically:', dispErr.message);
      console.log('Ensure xvfb and x11vnc are installed: sudo apt-get install -y xvfb x11vnc');
    }
  } else {
    console.log(`[DISPLAY] Active display detected (${process.env.DISPLAY || 'local GUI'}).`);
  }

  // 3. Launch REAL Google Chrome with dedicated user-data-dir and remote-debugging-port
  const cdpPort = 9222;
  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    'https://studio.youtube.com/live',
  ];

  console.log('[BROWSER] Launching real Google Chrome process...');
  chromeProcess = spawn(chromePath, chromeArgs, {
    stdio: 'ignore',
    detached: false,
  });

  const chromePid = chromeProcess.pid;
  console.log(`[BROWSER] Google Chrome launched (PID: ${chromePid}) on port ${cdpPort}`);

  // 4. Wait for DevTools port to become ready
  try {
    await waitForCdpEndpoint(cdpPort, 20000);
  } catch (cdpErr) {
    console.error('[ERROR] Chrome remote debugging port failed to start:', cdpErr.message);
    cleanupProcesses();
    process.exit(1);
  }

  // 5. Connect Playwright via connectOverCDP to monitor login state non-intrusively
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    console.warn('[INFO] Playwright not found in local node_modules; will monitor via CDP HTTP directly.');
  }

  console.log('\n[WAITING] Please complete your Google / YouTube login in the Chrome window.');
  console.log('[WAITING] This script will automatically detect when YouTube Studio is ready...\n');

  let authenticated = false;
  const maxWaitMs = 15 * 60 * 1000; // 15 minutes
  const startTime = Date.now();

  let browserCdp = null;
  if (pw) {
    try {
      const chromium = pw.chromium || pw;
      browserCdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch (err) {
      console.warn('[CDP] Warning connecting Playwright over CDP:', err.message);
    }
  }

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      if (browserCdp) {
        const contexts = browserCdp.contexts();
        for (const ctx of contexts) {
          for (const page of ctx.pages()) {
            const url = page.url();
            if (!url.includes('accounts.google.com') && !url.includes('signin') && url.includes('studio.youtube.com')) {
              const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
              if (bodyText.includes('stream') || bodyText.includes('live') || bodyText.includes('channel') || bodyText.includes('studio')) {
                authenticated = true;
                console.log('[SUCCESS] YouTube Studio session verified!');
                console.log(`[SUCCESS] Current page: ${url}`);
                break;
              }
            }
          }
          if (authenticated) break;
        }
      } else {
        // Fallback: poll DevTools HTTP /json/list
        const pagesRes = await new Promise(resolve => {
          http.get(`http://127.0.0.1:${cdpPort}/json/list`, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch { resolve([]); }
            });
          }).on('error', () => resolve([]));
        });

        for (const p of pagesRes) {
          const url = p.url || '';
          if (!url.includes('accounts.google.com') && !url.includes('signin') && url.includes('studio.youtube.com')) {
            authenticated = true;
            console.log('[SUCCESS] YouTube Studio session verified via CDP JSON API!');
            console.log(`[SUCCESS] Current page: ${url}`);
            break;
          }
        }
      }

      if (authenticated) break;
    } catch {
      // transient page navigation
    }
  }

  if (authenticated) {
    console.log('\n[SAVING] Allowing persistent profile data to flush to disk...');
    await new Promise(r => setTimeout(r, 3000));

    if (browserCdp) {
      try { await browserCdp.close(); } catch {}
    }

    cleanupProcesses();

    console.log('========================================================');
    console.log('   AUTHENTICATION SUCCESSFUL!                           ');
    console.log(`   Session saved to: ${profileDir}`);
    console.log('   The application can now prepare YouTube live sessions');
    console.log('   automatically using connectOverCDP.                  ');
    console.log('========================================================\n');
    process.exit(0);
  } else {
    console.error('\n[TIMEOUT] Login was not completed within 15 minutes.');
    if (browserCdp) {
      try { await browserCdp.close(); } catch {}
    }
    cleanupProcesses();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  cleanupProcesses();
  process.exit(1);
});
