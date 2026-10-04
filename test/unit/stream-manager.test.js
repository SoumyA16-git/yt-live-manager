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
  clearConfigGateError,
  computeResumeBookmark,
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

  test('auto mode resolves to transcode when source requires transcoding', async () => {
    const sPath = path.join(tmpDir, 'settings-6.json');
    const stPath = path.join(tmpDir, 'state-6.json');
    const hPath  = path.join(tmpDir, 'hist-6.json');
    const vDir   = path.join(tmpDir, 'videos-6');
    const inDir  = path.join(tmpDir, 'incoming-6');
    const vIndex = path.join(tmpDir, 'vindex-6.json');
    const bDir   = path.join(tmpDir, 'backups-6');

    await fs.mkdir(vDir, { recursive: true });

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setVideoPaths(vDir, inDir, vIndex);

    await loadSettings();
    await loadState();
    await setDisabled(false);
    await setMaintenance(false);
    await saveState({ bandwidthLock: { active: false }, desiredState: 'running' });

    const videoId = 'vid_66666666';
    const videoFile = path.join(vDir, `${videoId}.mp4`);
    await fs.writeFile(videoFile, 'mock-video-data');

    await writeJSON(vIndex, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: '720p_source.mp4',
        compatibility: { status: 'REQUIRES_TRANSCODING', reasons: ['RES_MISMATCH'], modeAllowed: { copy: false, hybrid: false, transcode: true } },
      }],
    });

    await saveSettings({
      youtube: { streamKey: 'valid-test-key-6666' },
      stream: { videoId, modePreference: 'auto', allowTranscode: true },
    });

    const gate = await evaluateStartGates();
    assert.equal(gate.allowed, true);
    assert.equal(gate.mode, 'transcode');
    assert.equal(gate.videoMeta.id, videoId);

    // Now test with modePreference: 'copy' — should block with E_NEEDS_TRANSCODE
    await saveSettings({
      stream: { modePreference: 'copy' },
    });
    const copyGate = await evaluateStartGates();
    assert.equal(copyGate.allowed, false);
    assert.equal(copyGate.code, 'E_NEEDS_TRANSCODE');

    // Test clearConfigGateError
    await saveState({ status: 'ERROR', lastError: { code: 'E_NEEDS_TRANSCODE', message: copyGate.reason } });
    await clearConfigGateError();
    const { getState } = await import('../../src/state-manager.js');
    assert.equal(getState().status, 'STOPPED');
    assert.equal(getState().lastError, null);
  });

  test('multi-video playlist generates concat file and resolves copy mode when compatible', async () => {
    const sPath = path.join(tmpDir, 'settings-7.json');
    const stPath = path.join(tmpDir, 'state-7.json');
    const hPath  = path.join(tmpDir, 'hist-7.json');
    const vDir   = path.join(tmpDir, 'videos-7');
    const inDir  = path.join(tmpDir, 'incoming-7');
    const vIndex = path.join(tmpDir, 'vindex-7.json');
    const bDir   = path.join(tmpDir, 'backups-7');

    await fs.mkdir(vDir, { recursive: true });

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setVideoPaths(vDir, inDir, vIndex);

    await loadSettings();
    await loadState();
    await setDisabled(false);
    await setMaintenance(false);
    await saveState({ bandwidthLock: { active: false }, desiredState: 'running' });

    const vid1 = 'vid_77771111';
    const vid2 = 'vid_77772222';
    await fs.writeFile(path.join(vDir, `${vid1}.mp4`), 'mock-data-1');
    await fs.writeFile(path.join(vDir, `${vid2}.mp4`), 'mock-data-2');

    await writeJSON(vIndex, {
      schemaVersion: 1,
      videos: [
        {
          id: vid1,
          filename: `${vid1}.mp4`,
          originalName: 'clip1.mp4',
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
        },
        {
          id: vid2,
          filename: `${vid2}.mp4`,
          originalName: 'clip2.mp4',
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
        },
      ],
    });

    await saveSettings({
      youtube: { streamKey: 'valid-test-key-7777' },
      stream: {
        playlist: [vid1, vid2],
        playbackOrder: 'sequential',
        modePreference: 'copy',
      },
    });

    const gate = await evaluateStartGates();
    assert.equal(gate.allowed, true);
    assert.equal(gate.mode, 'copy');
    assert.equal(gate.videoMeta.isConcat, true);
    assert.equal(gate.videoMeta.playlistCount, 2);

    // Verify concat file was written
    const { default: PATHS } = await import('../../src/lib/paths.js');
    const concatContent = await fs.readFile(PATHS.loopConcat, 'utf8');
    assert.ok(concatContent.includes('ffconcat version 1.0'));
    assert.ok(concatContent.includes(`${vid1}.mp4`));
    assert.ok(concatContent.includes(`${vid2}.mp4`));
  });
});

describe('stream-manager — computeResumeBookmark', () => {
  test('calculates correct single video resume offset with modulo', async () => {
    const sPath = path.join(tmpDir, 'settings-bm1.json');
    const stPath = path.join(tmpDir, 'state-bm1.json');
    const hPath  = path.join(tmpDir, 'hist-bm1.json');
    const bDir   = path.join(tmpDir, 'backups-bm1');
    const vDir   = path.join(tmpDir, 'videos-bm1');
    const catPath = path.join(vDir, 'catalog.json');

    const inDir = path.join(vDir, 'incoming');
    await fs.mkdir(vDir, { recursive: true });
    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setVideoPaths(vDir, inDir, catPath);

    await loadSettings();
    await loadState();

    const vidId = 'vid_bm01';
    await writeJSON(catPath, {
      schemaVersion: 1,
      videos: [
        {
          id: vidId,
          filename: `${vidId}.mp4`,
          originalName: 'single.mp4',
          probe: { duration: 3600 },
        },
      ],
    });

    await saveSettings({
      stream: {
        videoId: vidId,
        playlist: [],
      },
    });

    // 4000s elapsed, duration 3600s => offset 400s
    const bm = await computeResumeBookmark(4000);
    assert.ok(bm);
    assert.equal(bm.type, 'single');
    assert.equal(bm.videoId, vidId);
    assert.equal(bm.offsetSec, 400);
  });

  test('calculates correct playlist video and offset in cycle', async () => {
    const sPath = path.join(tmpDir, 'settings-bm2.json');
    const stPath = path.join(tmpDir, 'state-bm2.json');
    const hPath  = path.join(tmpDir, 'hist-bm2.json');
    const bDir   = path.join(tmpDir, 'backups-bm2');
    const vDir   = path.join(tmpDir, 'videos-bm2');
    const inDir  = path.join(vDir, 'incoming');
    const catPath = path.join(vDir, 'catalog.json');

    await fs.mkdir(vDir, { recursive: true });
    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setVideoPaths(vDir, inDir, catPath);

    await loadSettings();
    await loadState();

    const vidA = 'vid_p111';
    const vidB = 'vid_p222';
    await writeJSON(catPath, {
      schemaVersion: 1,
      videos: [
        { id: vidA, filename: `${vidA}.mp4`, probe: { duration: 1000 } },
        { id: vidB, filename: `${vidB}.mp4`, probe: { duration: 2000 } },
      ],
    });

    await saveSettings({
      stream: {
        playlist: [vidA, vidB],
        playbackOrder: 'sequential',
      },
    });

    // 1500s elapsed in cycle of 3000s => lands in vidB at offset 500s
    const bm = await computeResumeBookmark(1500);
    assert.ok(bm);
    assert.equal(bm.type, 'playlist');
    assert.equal(bm.videoId, vidB);
    assert.equal(bm.offsetSec, 500);
  });
});
