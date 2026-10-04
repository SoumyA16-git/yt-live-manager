#!/usr/bin/env node
/**
 * scripts/oauth-setup.js — One-time secure OAuth 2.0 bootstrap for YouTube Data API v3.
 *
 * Obtains:
 *   YOUTUBE_CLIENT_ID
 *   YOUTUBE_CLIENT_SECRET
 *   YOUTUBE_REFRESH_TOKEN
 *
 * Usage:
 *   node scripts/oauth-setup.js
 *   node scripts/oauth-setup.js --client-id=<ID> --client-secret=<SECRET>
 *   node scripts/oauth-setup.js --port=8085 --redirect-uri=http://localhost:8085/oauth2callback
 */

import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSecret } from '../src/lib/redact.js';

const DEFAULT_PORT = 8085;
const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_PORT}/oauth2callback`;
const OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

/**
 * Build the Google OAuth 2.0 authorization URL.
 */
export function buildAuthUrl({
  clientId,
  redirectUri = DEFAULT_REDIRECT_URI,
  state = '',
  scope = YOUTUBE_SCOPE,
}) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline', // Required for refresh_token
    prompt: 'consent',       // Guarantees refresh_token is returned
    state,
  });
  return `${OAUTH_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Extract authorization code from raw string or full redirect URL.
 */
export function extractCodeFromInput(rawInput) {
  if (!rawInput) return '';
  const trimmed = rawInput.trim();
  if (trimmed.includes('code=')) {
    try {
      const urlCandidate = trimmed.startsWith('http')
        ? trimmed
        : (trimmed.includes('?') ? `http://localhost/${trimmed}` : `http://localhost/?${trimmed}`);
      const parsedUrl = new URL(urlCandidate);
      const code = parsedUrl.searchParams.get('code');
      if (code) return code;
    } catch {
      // fallback regex
    }
    const match = trimmed.match(/[?&]?code=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return trimmed;
}

/**
 * Exchange authorization code for access_token and refresh_token.
 */
export async function exchangeCodeForTokens({
  code,
  clientId,
  clientSecret,
  redirectUri = DEFAULT_REDIRECT_URI,
  fetchFn = fetch,
}) {
  setSecret(clientSecret);

  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetchFn(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    const errDesc = data.error_description || data.error || 'Token exchange failed';
    throw new Error(`Google OAuth error [${res.status}]: ${errDesc}`);
  }

  if (data.refresh_token) {
    setSecret(data.refresh_token);
  }
  if (data.access_token) {
    setSecret(data.access_token);
  }

  return data;
}

/**
 * Verify credentials and fetch channel info to confirm permissions.
 */
export async function verifyYouTubeChannel(accessToken, fetchFn = fetch) {
  const url = 'https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true';
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`YouTube API verification failed [${res.status}]: ${errText}`);
  }

  const data = await res.json();
  const items = data.items || [];
  if (items.length === 0) {
    return { title: 'Unknown Channel (No channel resource found)', id: 'unknown' };
  }

  return {
    title: items[0].snippet?.title || 'Unnamed Channel',
    id: items[0].id || 'unknown',
  };
}

// ─── CLI Interactive Runner ───────────────────────────────────────────────────

function parseCliArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (const arg of args) {
    if (arg.startsWith('--client-id=')) {
      parsed.clientId = arg.slice('--client-id='.length);
    } else if (arg.startsWith('--client-secret=')) {
      parsed.clientSecret = arg.slice('--client-secret='.length);
    } else if (arg.startsWith('--redirect-uri=')) {
      parsed.redirectUri = arg.slice('--redirect-uri='.length);
    } else if (arg.startsWith('--port=')) {
      parsed.port = parseInt(arg.slice('--port='.length), 10);
    } else if (arg.startsWith('--out=')) {
      parsed.outFile = arg.slice('--out='.length);
    }
  }
  return parsed;
}

async function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function runCli() {
  const cliArgs = parseCliArgs();

  let clientId = cliArgs.clientId || process.env.YOUTUBE_CLIENT_ID || '';
  let clientSecret = cliArgs.clientSecret || process.env.YOUTUBE_CLIENT_SECRET || '';
  const port = cliArgs.port || DEFAULT_PORT;
  const redirectUri = cliArgs.redirectUri || `http://localhost:${port}/oauth2callback`;
  const outFile = cliArgs.outFile || null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n======================================================================');
  console.log('  YOUTUBE LIVE MANAGER — OAUTH 2.0 CREDENTIALS SETUP');
  console.log('======================================================================\n');
  console.log('This utility obtains the required OAuth2 refresh token for autonomous');
  console.log('YouTube Live broadcast management without browser or manual Studio actions.\n');

  if (!clientId) {
    clientId = (await prompt(rl, 'Enter Google OAuth Client ID: ')).trim();
  }
  if (!clientSecret) {
    clientSecret = (await prompt(rl, 'Enter Google OAuth Client Secret: ')).trim();
  }

  if (!clientId || !clientSecret) {
    console.error('\n[ERROR] Both Client ID and Client Secret are required.');
    rl.close();
    process.exit(1);
  }

  setSecret(clientId);
  setSecret(clientSecret);

  const stateToken = crypto.randomBytes(16).toString('hex');
  const authUrl = buildAuthUrl({ clientId, redirectUri, state: stateToken });

  console.log('\n----------------------------------------------------------------------');
  console.log('STEP 1: AUTHORIZE VIA GOOGLE');
  console.log('----------------------------------------------------------------------');
  console.log('Open the following authorization URL in your browser:\n');
  console.log(`  ${authUrl}\n`);
  console.log('• Sign in with the YouTube account that owns your live channel.');
  console.log('• Click "Allow" to grant YouTube live broadcast management permissions.');
  console.log('• If running locally or with port-forwarding, the callback is captured automatically.');
  console.log('• If running on a remote VPS without port-forwarding, copy the redirected URL');
  console.log('  from your browser address bar and paste it below.\n');

  // Start temporary local HTTP server to capture callback automatically if accessible
  let capturedCode = null;
  let server = null;

  const serverPromise = new Promise((resolve) => {
    try {
      server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url, `http://localhost:${port}`);
          if (reqUrl.pathname === '/oauth2callback') {
            const code = reqUrl.searchParams.get('code');
            const state = reqUrl.searchParams.get('state');
            const error = reqUrl.searchParams.get('error');

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<h1>Authorization Failed</h1><p>Google returned error: ' + error + '</p>');
              return;
            }

            if (code) {
              capturedCode = code;
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <html>
                  <body style="font-family:sans-serif; text-align:center; padding:40px; background:#121212; color:#fff;">
                    <h2 style="color:#4ade80;">&#10004; Authorization Succeeded!</h2>
                    <p>Authorization code received. You can now close this browser tab and return to your terminal.</p>
                  </body>
                </html>
              `);
              resolve(code);
            }
          }
        } catch {
          // ignore invalid requests
        }
      });

      server.listen(port, () => {
        // server listening
      });

      server.on('error', () => {
        // port busy or not bindable, manual entry fallback will still work
      });
    } catch {
      // fallback to manual prompt
    }
  });

  // Prompt user for manual code or redirect URL in parallel
  const promptPromise = (async () => {
    const rawAnswer = await prompt(rl, 'Enter authorization code (or paste full redirected URL): ');
    return extractCodeFromInput(rawAnswer);
  })();

  // Race between automatic HTTP callback and manual CLI paste
  const authCode = await Promise.race([serverPromise, promptPromise]);

  rl.close();
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }

  if (!authCode) {
    console.error('\n[ERROR] No authorization code received. Setup aborted.');
    process.exit(1);
  }

  console.log('\n----------------------------------------------------------------------');
  console.log('STEP 2: EXCHANGING CODE FOR REFRESH TOKEN');
  console.log('----------------------------------------------------------------------');

  let tokenData;
  try {
    tokenData = await exchangeCodeForTokens({
      code: authCode,
      clientId,
      clientSecret,
      redirectUri,
    });
  } catch (err) {
    console.error(`\n[ERROR] Failed to exchange code for tokens: ${err.message}`);
    process.exit(1);
  }

  const refreshToken = tokenData.refresh_token;
  if (!refreshToken) {
    console.error('\n[WARNING] Google did not return a refresh_token.');
    console.error('This typically happens if access was already granted previously.');
    console.error('To fix: Revoke access at https://myaccount.google.com/permissions and run this script again.');
    process.exit(1);
  }

  setSecret(refreshToken);

  console.log('\n----------------------------------------------------------------------');
  console.log('STEP 3: VERIFYING YOUTUBE API PERMISSIONS');
  console.log('----------------------------------------------------------------------');

  try {
    const channelInfo = await verifyYouTubeChannel(tokenData.access_token);
    console.log(`\n✔ Successfully verified YouTube Channel: "${channelInfo.title}" (ID: ${channelInfo.id})`);
  } catch (err) {
    console.warn(`\n[NOTE] Channel verification check: ${err.message}`);
  }

  console.log('\n======================================================================');
  console.log('  CONFIGURATION READY FOR PRODUCTION');
  console.log('======================================================================\n');
  console.log('Append these EXACT lines to your production environment file (/etc/yt-live-manager/env):\n');

  const envBlock = `YOUTUBE_CLIENT_ID="${clientId}"\nYOUTUBE_CLIENT_SECRET="${clientSecret}"\nYOUTUBE_REFRESH_TOKEN="${refreshToken}"`;
  console.log(envBlock);

  console.log('\nThen restart the service:\n');
  console.log('  sudo systemctl restart yt-live-manager\n');
  console.log('Verify autonomous status:\n');
  console.log('  curl -s http://127.0.0.1:3000/api/internal/cli-status | jq .youtubeLive\n');

  if (outFile) {
    try {
      await fs.writeFile(outFile, envBlock + '\n', { mode: 0o600 });
      console.log(`✔ Configuration securely saved to: ${outFile} (permissions: 0600)`);
    } catch (err) {
      console.error(`Could not write to ${outFile}: ${err.message}`);
    }
  }

  console.log('======================================================================\n');
}

// Execute when run directly as CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runCli().catch((err) => {
    console.error('\nFatal setup error:', err.message);
    process.exit(1);
  });
}
