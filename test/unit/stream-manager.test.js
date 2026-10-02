/**
 * test/unit/stream-manager.test.js — Unit tests for stream-manager.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  calculateBackoffDelay,
  evaluateStartGates,
  setDisabled,
  setMaintenance,
} from '../../src/stream-manager.js';
import {
  loadSettings,
  saveSettings,
  _setPathsForTest as _setConfigPaths,
} from '../../src/config-manager.js';
import {
  loadState,
  saveState,
  _setPathsForTest as _setStatePaths,
} from '../../src/state-manager.js';
import {
  _setPathsForTest as _setVideoPaths,
} from '../../src/video-manager.js';
import { writeJSON } from '../../src/lib/atomic-json.js';

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-sm-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('stream-manager — calculateBackoffDelay', () => {
  test('computes exponential delays bounded by min and max', () => {
    const cfg = {
      strategy: 'exponential',
      baseDelaySeconds: 10,
      factor: 2,
      maxDelaySeconds: 300,
      jitterPercent: 0, // disable jitter for deterministic math
    };

    assert.equal(calculateBackoffDelay(1, cfg), 10);
    assert.equal(calculateBackoffDelay(2, cfg), 20);
    assert.equal(calculateBackoffDelay(3, cfg), 40);
    assert.equal(calculateBackoffDelay(4, cfg), 80);
    assert.equal(calculateBackoffDelay(5, cfg), 160);
    assert.equal(calculateBackoffDelay(6, cfg), 300); // capped at 300
    assert.equal(calculateBackoffDelay(10, cfg), 300);
  });

  test('enforces minimum 5s cooldown even if delay computes lower', () => {
    const cfg = { baseDelaySeconds: 1, jitterPercent: 0 };
    assert.ok(calculateBackoffDelay(1, cfg) >= 5);
  });
});

describe('stream-manager — evaluateStartGates', () => {
  test('blocks when master kill switch (disabled) is true', async () => {
    const sPath = path.join(tmpDir, 'settings-1.json');
    const stPath = path.join(tmpDir, 'state-1.json');
    const hPath  = path.join(tmpDir, 'hist-1.json');
    const bDir   = path.join(tmpDir, 'backups-1');

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    await loadState();
    await setDisabled(true);

    const gate = await evaluateStartGates();
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'E_DISABLED');
  });

  test('blocks when maintenance is active', async () => {
    const sPath = path.join(tmpDir, 'settings-2.json');
    const stPath = path.join(tmpDir, 'state-2.json');
    const hPath  = path.join(tmpDir, 'hist-2.json');
    const bDir   = path.join(tmpDir, 'backups-2');

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    await loadState();
    await setDisabled(false);
    await setMaintenance(true, 'update');

    const gate = await evaluateStartGates();
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'E_MAINTENANCE');
  });

  test('blocks when bandwidth safety lock is engaged', async () => {
    const sPath = path.join(tmpDir, 'settings-3.json');
    const stPath = path.join(tmpDir, 'state-3.json');
    const hPath  = path.join(tmpDir, 'hist-3.json');
    const bDir   = path.join(tmpDir, 'backups-3');

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    await loadState();
    await setDisabled(false);
    await setMaintenance(false);
    await saveState({ bandwidthLock: { active: true } });

    const gate = await evaluateStartGates();
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'E_BW_LIMIT');
  });

  test('blocks when stream key is missing', async () => {
    const sPath = path.join(tmpDir, 'settings-4.json');
    const stPath = path.join(tmpDir, 'state-4.json');
    const hPath  = path.join(tmpDir, 'hist-4.json');
    const bDir   = path.join(tmpDir, 'backups-4');

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    await loadState();
    await setDisabled(false);
    await setMaintenance(false);
    await saveState({ bandwidthLock: { active: false } });
    await saveSettings({ youtube: { streamKey: '' } });

    const gate = await evaluateStartGates();
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'E_KEY_MISSING');
  });

  test('passes and resolves mode when all prerequisites are met', async () => {
    const sPath = path.join(tmpDir, 'settings-5.json');
    const stPath = path.join(tmpDir, 'state-5.json');
    const hPath  = path.join(tmpDir, 'hist-5.json');
    const vDir   = path.join(tmpDir, 'videos-5');
    const inDir  = path.join(tmpDir, 'incoming-5');
    const vIndex = path.join(tmpDir, 'vindex-5.json');
    const bDir   = path.join(tmpDir, 'backups-5');

    await fs.mkdir(vDir, { recursive: true });

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setVideoPaths(vDir, inDir, vIndex);

    await loadSettings();
    await loadState();
    await setDisabled(false);
    await setMaintenance(false);
    await saveState({ bandwidthLock: { active: false }, desiredState: 'running' });

    const videoId = 'vid_55555555';
    const videoFile = path.join(vDir, `${videoId}.mp4`);
    await fs.writeFile(videoFile, 'mock-video-data');

    await writeJSON(vIndex, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'source.mp4',
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await saveSettings({
      youtube: { streamKey: 'valid-test-key-5555' },
      stream: { videoId, modePreference: 'auto' },
    });

    const gate = await evaluateStartGates();
    assert.equal(gate.allowed, true);
    assert.equal(gate.mode, 'copy');
    assert.equal(gate.videoMeta.id, videoId);
  });
});
