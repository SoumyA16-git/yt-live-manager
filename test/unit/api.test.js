/**
 * test/unit/api.test.js — End-to-end HTTP API tests using built-in fetch.
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
const TEST_SECRET = 'super-secret-session-key-for-api-tests';

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-api-test-'));

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

describe('REST API Endpoints', () => {
  let sessionCookie = '';
  let csrfToken = '';

  test('GET /api/health is publicly reachable', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.uptime === 'number');
  });

  test('POST /api/auth/login fails on invalid credentials', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: 'WrongPassword' }),
    });

    assert.equal(res.status, 401);
  });

  test('POST /api/auth/login succeeds and sets session cookie', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.username, TEST_USER);
    assert.ok(body.csrfToken);

    csrfToken = body.csrfToken;
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie);
    sessionCookie = setCookie.split(';')[0];
    assert.ok(sessionCookie.includes('ytlm_sid='));
  });

  test('GET /api/auth/me returns session info when authenticated', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: sessionCookie },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.username, TEST_USER);
  });

  test('GET /api/settings rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/api/settings`);
    assert.equal(res.status, 401);
  });

  test('GET /api/settings returns masked settings without leaking streamKey', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { Cookie: sessionCookie },
    });

    assert.equal(res.status, 200);
    const settings = await res.json();
    assert.equal(settings.youtube.streamKey, undefined);
    assert.equal(typeof settings.youtube.streamKeySet, 'boolean');
    assert.ok(settings.stream);
  });

  test('PUT /api/settings enforces CSRF protection', async () => {
    // Missing CSRF token
    const res1 = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ stream: { videoBitrateMbps: 7 } }),
    });
    assert.equal(res1.status, 403);

    // With valid CSRF token
    const res2 = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ stream: { videoBitrateMbps: 7 } }),
    });
    assert.equal(res2.status, 200);
    const body = await res2.json();
    assert.equal(body.success, true);
    assert.equal(body.settings.stream.videoBitrateMbps, 7);
  });

  test('GET /api/stream/status and GET /api/status return status and health verdict', async () => {
    const res1 = await fetch(`${baseUrl}/api/stream/status`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res1.status, 200);
    const s1 = await res1.json();
    assert.ok(s1.status);
    assert.ok(s1.healthVerdict);

    const res2 = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res2.status, 200);
    const s2 = await res2.json();
    assert.equal(s2.status, s1.status);
    assert.equal(s2.healthVerdict.status, s1.healthVerdict.status);
  });

  test('GET /api/logs returns application logs', async () => {
    const res = await fetch(`${baseUrl}/api/logs?limit=10`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.lines));
  });

  test('POST /api/maintenance toggles maintenance mode', async () => {
    const res = await fetch(`${baseUrl}/api/maintenance`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.maintenance.active, true);

    // Disable maintenance
    const res2 = await fetch(`${baseUrl}/api/maintenance`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res2.status, 200);
  });

  test('GET /api/bandwidth returns bandwidth summary and forecasting', async () => {
    const res = await fetch(`${baseUrl}/api/bandwidth`, {
      headers: { Cookie: sessionCookie },
    });

    assert.equal(res.status, 200);
    const bw = await res.json();
    assert.ok(bw.periodId);
    assert.ok(bw.forecast);
    assert.ok(typeof bw.pctOfSafety === 'number');
  });

  test('GET /api/system returns system metrics', async () => {
    const res = await fetch(`${baseUrl}/api/system`, {
      headers: { Cookie: sessionCookie },
    });

    assert.equal(res.status, 200);
    const sys = await res.json();
    assert.ok(sys.ram);
    assert.ok(sys.disk);
    assert.ok(typeof sys.uptimeSec === 'number');
  });

  test('GET & POST /api/videos/playlist manages playlist and playbackOrder', async () => {
    // GET initial playlist
    const res1 = await fetch(`${baseUrl}/api/videos/playlist`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.ok(Array.isArray(body1.playlist));
    assert.ok(['sequential', 'shuffle'].includes(body1.playbackOrder));

    // POST updated playlist
    const res2 = await fetch(`${baseUrl}/api/videos/playlist`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ playlist: [], playbackOrder: 'shuffle' }),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.success, true);
    assert.equal(body2.playbackOrder, 'shuffle');
  });

  test('POST /api/auth/logout invalidates session', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
    });

    assert.equal(res.status, 200);

    // Subsequent authenticated request fails
    const res2 = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(res2.status, 401);
  });
});
