/**
 * test/unit/state-manager.test.js — Unit tests for state-manager.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadState,
  saveState,
  getState,
  getDesiredState,
  getStatus,
  appendHistory,
  _setPathsForTest,
} from '../../src/state-manager.js';
import { readJSON } from '../../src/lib/atomic-json.js';

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-state-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('state-manager — loadState', () => {
  test('returns default state when file does not exist', async () => {
    const sPath = path.join(tmpDir, 'absent-state.json');
    const hPath = path.join(tmpDir, 'absent-history.json');
    const bDir  = path.join(tmpDir, 'backups-1');
    _setPathsForTest(sPath, hPath, bDir);

    const st = await loadState();
    assert.equal(st.desiredState, 'stopped');
    assert.equal(st.status, 'STOPPED');
    assert.equal(st.restartCountSession, 0);
    assert.equal(st.ffmpegPid, null);
    assert.ok(st.lastSeenAt);
  });

  test('resets session-only fields upon reload from disk', async () => {
    const sPath = path.join(tmpDir, 'existing-state.json');
    const hPath = path.join(tmpDir, 'history-2.json');
    const bDir  = path.join(tmpDir, 'backups-2');
    _setPathsForTest(sPath, hPath, bDir);

    await fs.writeFile(sPath, JSON.stringify({
      desiredState: 'running',
      status: 'STREAMING',
      restartCountSession: 14,
      restartCountTotal: 42,
      ffmpegPid: 12345,
      activeVideoId: 'vid_test123',
    }), 'utf8');

    const st = await loadState();
    assert.equal(st.desiredState, 'running');
    assert.equal(st.status, 'STREAMING');
    assert.equal(st.restartCountTotal, 42);
    assert.equal(st.activeVideoId, 'vid_test123');
    // Session-only fields MUST be reset:
    assert.equal(st.restartCountSession, 0);
    assert.equal(st.ffmpegPid, null);
  });
});

describe('state-manager — saveState & getters', () => {
  test('patches and persists state, updating lastSeenAt', async () => {
    const sPath = path.join(tmpDir, 'save-state.json');
    const hPath = path.join(tmpDir, 'history-3.json');
    const bDir  = path.join(tmpDir, 'backups-3');
    _setPathsForTest(sPath, hPath, bDir);

    await loadState();
    await saveState({
      desiredState: 'running',
      status: 'STREAMING',
      ffmpegPid: 54321,
    });

    assert.equal(getDesiredState(), 'running');
    assert.equal(getStatus(), 'STREAMING');
    assert.equal(getState().ffmpegPid, 54321);

    // Verify it was written to disk
    const disk = await readJSON(sPath);
    assert.equal(disk.data.desiredState, 'running');
    assert.equal(disk.data.status, 'STREAMING');
  });
});

describe('state-manager — appendHistory', () => {
  test('records entries and caps history at 500', async () => {
    const sPath = path.join(tmpDir, 'hist-state.json');
    const hPath = path.join(tmpDir, 'hist-history.json');
    const bDir  = path.join(tmpDir, 'backups-4');
    _setPathsForTest(sPath, hPath, bDir);

    await appendHistory({ event: 'start', videoId: 'vid_1' });
    await appendHistory({ event: 'stop',  videoId: 'vid_1' });

    let { data } = await readJSON(hPath);
    assert.equal(data.sessions.length, 2);
    assert.equal(data.sessions[0].event, 'start');
    assert.equal(data.sessions[1].event, 'stop');

    // Simulate capping at 500
    const many = [];
    for (let i = 0; i < 505; i++) {
      many.push({ event: `event_${i}`, at: new Date().toISOString() });
    }
    await fs.writeFile(hPath, JSON.stringify({ schemaVersion: 1, sessions: many }), 'utf8');

    await appendHistory({ event: 'overflow_test' });
    const back = await readJSON(hPath);
    assert.equal(back.data.sessions.length, 500);
    assert.equal(back.data.sessions[499].event, 'overflow_test');
  });
});
