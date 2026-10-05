/**
 * test/unit/routes-audit.test.js — Exhaustive verification of all application API routes.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/server.js';
import { hashPassword } from '../../src/auth.js';
import { loadSettings, _setPathsForTest as _setConfigPaths } from '../../src/config-manager.js';
import { loadState, _setPathsForTest as _setStatePaths } from '../../src/state-manager.js';
import { loadUsage, _setPathsForTest as _setUsagePaths } from '../../src/usage-manager.js';
import { _setPathsForTest as _setVideoPaths } from '../../src/video-manager.js';

let server;
let baseUrl;
let tmpDir;

const TEST_USER = 'admin';
const TEST_PASS = 'TestAdminPass123!';
const TEST_SECRET = 'super-secret-session-key-for-routes-audit';

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-routes-test-'));

  const sPath = path.join(tmpDir, 'settings.json');
  const stPath = path.join(tmpDir, 'state.json');
  const hPath = path.join(tmpDir, 'history.json');
  const uPath = path.join(tmpDir, 'usage.json');
  const vDir = path.join(tmpDir, 'videos');
  const inDir = path.join(tmpDir, 'incoming');
  const vIndex = path.join(tmpDir, 'vindex.json');
  const bDir = path.join(tmpDir, 'backups');

  await fs.mkdir(vDir, { recursive: true });
  await fs.mkdir(inDir, { recursive: true });

  _setConfigPaths(sPath, bDir);
  _setStatePaths(stPath, hPath, bDir);
  _setUsagePaths(uPath, bDir);
  _setVideoPaths(vDir, inDir, vIndex);

  await loadSettings();
  await loadState();
  await loadUsage();

  const hash = await hashPassword(TEST_PASS);
  const app = await createApp({
    ADMIN_USERNAME: TEST_USER,
    ADMIN_PASSWORD_HASH: hash,
    SESSION_SECRET: TEST_SECRET,
  });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('All Dashboard Action Routes Audit', () => {
  let sessionCookie = '';
  let csrfToken = '';

  test('Login and capture CSRF token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    csrfToken = body.csrfToken;
    const setCookie = res.headers.get('set-cookie');
    sessionCookie = setCookie.split(';')[0];
    assert.ok(csrfToken, 'CSRF token must be present');
  });

  test('POST /api/stream/disable and POST /api/stream/enable', async () => {
    // Disable
    const res1 = await fetch(`${baseUrl}/api/stream/disable`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.disabled, true);

    // Enable
    const res2 = await fetch(`${baseUrl}/api/stream/enable`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.disabled, false);
  });

  test('POST /api/stream/stop succeeds when stopped', async () => {
    const res = await fetch(`${baseUrl}/api/stream/stop`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  test('POST /api/stream/start rejects cleanly when no stream key configured', async () => {
    const res = await fetch(`${baseUrl}/api/stream/start`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
    });
    // Expected 400 because stream key is not configured in test environment
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(body.code.includes('KEY_MISSING') || body.code.includes('GATE'));
  });

  test('POST /api/settings/reveal-stream-key verifies password and returns key', async () => {
    const res = await fetch(`${baseUrl}/api/settings/reveal-stream-key`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ password: TEST_PASS }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.streamKey !== undefined);
  });

  test('GET /api/system/logs returns logs array', async () => {
    const res = await fetch(`${baseUrl}/api/system/logs?limit=40`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.lines));
  });

  test('GET /api/videos returns videos catalog', async () => {
    const res = await fetch(`${baseUrl}/api/videos`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.videos));
  });

  test('POST /api/stream/mode changes stream mode', async () => {
    const res = await fetch(`${baseUrl}/api/stream/mode`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ mode: 'horizontal' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'horizontal');
  });

  test('GET /api/videos/playlist?mode=horizontal returns mode playlist', async () => {
    const res = await fetch(`${baseUrl}/api/videos/playlist?mode=horizontal`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'horizontal');
    assert.ok(Array.isArray(body.playlist));
  });
});
