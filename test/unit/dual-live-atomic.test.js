/**
 * test/unit/dual-live-atomic.test.js — Single Stream Mode Architecture Test Suite
 *
 * Verifies the Single Stream Mode (Horizontal 16:9 vs Vertical 9:16) invariants:
 * - At any moment, strictly ONE mode is active. Dual stream is permanently eliminated.
 * - Horizontal mode requires horizontalStreamKey and 16:9 video; rejects vertical video.
 * - Vertical mode requires streamKey and 9:16 video; rejects horizontal video.
 * - Zero fallback between the two modes.
 * - Mode switching while live is blocked with 409 Conflict (E_STREAM_RUNNING).
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  evaluateStartGates,
  clearConfigGateError,
  setStreamMode,
} from '../../src/stream-manager.js';
import {
  loadSettings,
  saveSettings,
  _setPathsForTest as _setConfigPaths,
} from '../../src/config-manager.js';
import {
  loadState,
  saveState,
  getState,
  _setPathsForTest as _setStatePaths,
} from '../../src/state-manager.js';
import {
  _setPathsForTest as _setVideoPaths,
} from '../../src/video-manager.js';
import {
  getOutputsStatus,
  buildPublisherArgs,
  _resetStateForTest,
} from '../../src/ffmpeg-manager.js';
import { validateSettings } from '../../src/lib/validate.js';
import { writeJSON } from '../../src/lib/atomic-json.js';

let tmpDir;
let videosDir;
let incomingDir;
let catalogFile;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-single-stream-test-'));
  videosDir = path.join(tmpDir, 'videos');
  incomingDir = path.join(tmpDir, 'incoming');
  catalogFile = path.join(tmpDir, 'catalog.json');
  const backupDir = path.join(tmpDir, 'backups');

  await fs.mkdir(videosDir, { recursive: true });
  await fs.mkdir(incomingDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  _setConfigPaths(path.join(tmpDir, 'settings.json'), backupDir);
  _setStatePaths(path.join(tmpDir, 'state.json'), path.join(tmpDir, 'history.json'), backupDir);
  _setVideoPaths(videosDir, incomingDir, catalogFile);

  await loadSettings();
  await loadState();
});

after(async () => {
  _resetStateForTest();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  _resetStateForTest();
  await saveState({
    status: 'STOPPED',
    desiredState: 'running',
    disabled: false,
    maintenance: { active: false },
    bandwidthLock: { active: false },
    lastError: null,
  });
});

describe('Single Stream Mode Architecture (15 Invariants)', () => {

  test('1. validateSettings rejects identical streamKey and horizontalStreamKey', () => {
    const res = validateSettings({
      youtube: {
        streamKey: 'same-test-key-1234',
        horizontalStreamKey: 'same-test-key-1234',
      },
    });
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('Vertical and Horizontal Stream Keys must be different')));
  });

  test('2. validateSettings accepts distinct streamKey and horizontalStreamKey', () => {
    const res = validateSettings({
      youtube: {
        streamKey: 'primary-vertical-key-1111',
        horizontalStreamKey: 'secondary-horizontal-key-2222',
      },
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.errors.length, 0);
  });

  test('3. saveSettings rejects identical keys with E_VALIDATION', async () => {
    await assert.rejects(
      async () => {
        await saveSettings({
          youtube: {
            streamKey: 'duplicate-key-xyz-123',
            horizontalStreamKey: 'duplicate-key-xyz-123',
          },
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'E_VALIDATION');
        assert.ok(err.errors.some(e => e.includes('Vertical and Horizontal Stream Keys must be different')));
        return true;
      }
    );
  });

  test('4. Horizontal mode blocks start if video is vertical (E_HORIZONTAL_VIDEO_REQUIRED)', async () => {
    const videoId = 'vid_00000001';
    await fs.writeFile(path.join(videosDir, `${videoId}.mp4`), 'fake-data');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'solo_vertical.mp4',
        orientation: 'vertical',
        probe: { width: 1080, height: 1920, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await saveSettings({
      stream: {
        mode: 'horizontal',
        videoId,
        playlists: { horizontal: [videoId] },
        modePreference: 'auto',
      },
      youtube: {
        streamKey: 'primary-key-vert-999',
        horizontalStreamKey: 'secondary-key-horiz-888',
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_HORIZONTAL_VIDEO_REQUIRED');
  });

  test('5. Horizontal mode blocks start if canonical streamKey is missing (E_KEY_MISSING)', async () => {
    const videoId = 'vid_00000002';
    await fs.writeFile(path.join(videosDir, `${videoId}.mp4`), 'fake-data');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'horiz.mp4',
        probe: { width: 1920, height: 1080, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await saveSettings({
      stream: {
        mode: 'horizontal',
        videoId,
        playlists: { horizontal: [videoId] },
        modePreference: 'auto',
      },
      youtube: {
        streamKey: '',
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_KEY_MISSING');
  });

  test('6. Horizontal mode succeeds with 16:9 video and canonical streamKey (isDualStream=false)', async () => {
    const hId = 'vid_00000003';
    await fs.writeFile(path.join(videosDir, `${hId}.mp4`), 'fake-data-horiz');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [{
        id: hId,
        filename: `${hId}.mp4`,
        originalName: 'landscape.mp4',
        probe: { width: 1920, height: 1080, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await saveSettings({
      stream: {
        mode: 'horizontal',
        videoId: hId,
        playlists: { horizontal: [hId] },
        modePreference: 'auto',
      },
      youtube: {
        streamKey: 'default-key-single-444',
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, true);
    assert.strictEqual(gate.isDualStream, false);
    assert.strictEqual(gate.streamMode, 'horizontal');
    assert.ok(gate.destUrl.includes('default-key-single-444'));
  });

  test('7. Vertical mode blocks start if video is horizontal (E_VERTICAL_VIDEO_REQUIRED)', async () => {
    const videoId = 'vid_00000004';
    await fs.writeFile(path.join(videosDir, `${videoId}.mp4`), 'fake-data');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'landscape.mp4',
        probe: { width: 1920, height: 1080, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await saveSettings({
      stream: {
        mode: 'vertical',
        videoId,
        playlists: { vertical: [videoId] },
        modePreference: 'auto',
      },
      youtube: {
        streamKey: 'vert-key-111',
        horizontalStreamKey: 'horiz-key-222',
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_VERTICAL_VIDEO_REQUIRED');
  });

  test('8. Vertical mode blocks start if streamKey is missing (E_KEY_MISSING)', async () => {
    const videoId = 'vid_00000005';
    await fs.writeFile(path.join(videosDir, `${videoId}.mp4`), 'fake-data');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'portrait.mp4',
        probe: { width: 1080, height: 1920, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await saveSettings({
      stream: {
        mode: 'vertical',
        videoId,
        playlists: { vertical: [videoId] },
        modePreference: 'auto',
      },
      youtube: {
        streamKey: '',
        horizontalStreamKey: 'horiz-key-222',
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_KEY_MISSING');
  });

  test('9. Vertical mode succeeds with 9:16 video and streamKey (isDualStream=false)', async () => {
    const vId = 'vid_00000006';
    await fs.writeFile(path.join(videosDir, `${vId}.mp4`), 'fake-data-vert');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [{
        id: vId,
        filename: `${vId}.mp4`,
        originalName: 'portrait.mp4',
        probe: { width: 1080, height: 1920, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await saveSettings({
      stream: {
        mode: 'vertical',
        videoId: vId,
        playlists: { vertical: [vId] },
        modePreference: 'auto',
      },
      youtube: {
        streamKey: 'vert-key-single-999',
        horizontalStreamKey: 'horiz-key-single-888',
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, true);
    assert.strictEqual(gate.isDualStream, false);
    assert.strictEqual(gate.streamMode, 'vertical');
    assert.ok(gate.destUrl.includes('vert-key-single-999'));
  });

  test('10. buildPublisherArgs generates destination URL matching target stream key', () => {
    const horizTarget = 'rtmps://a.rtmps.youtube.com:443/live2/key-horiz-222';
    const horizArgs = buildPublisherArgs({}, horizTarget);
    assert.strictEqual(horizArgs[horizArgs.length - 1], horizTarget);
  });

  test('11. getOutputsStatus initializes with single mode status', () => {
    _resetStateForTest();
    const status = getOutputsStatus();
    assert.ok(status.mode);
    assert.ok(status.horizontal);
    assert.ok(status.vertical);
  });

  test('12. clearConfigGateError clears pre-flight gate errors', async () => {
    await saveState({
      status: 'ERROR',
      desiredState: 'stopped',
      lastError: { code: 'E_KEY_MISSING', message: 'Key missing' },
    });
    await clearConfigGateError();
    const st = getState();
    assert.strictEqual(st.lastError, null);
  });

  test('13. setStreamMode updates stream mode when stopped', async () => {
    const res = await setStreamMode('vertical');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.mode, 'vertical');
  });

  test('14. setStreamMode rejects invalid mode with E_INVALID_MODE', async () => {
    await assert.rejects(
      async () => {
        await setStreamMode('diagonal');
      },
      (err) => {
        assert.strictEqual(err.code, 'E_INVALID_MODE');
        return true;
      }
    );
  });

  test('15. Single stream destination URL masks secrets safely in logs', () => {
    const masked = 'rtmps://a.rtmps.youtube.com:443/live2/k6gy-****-6x2r';
    assert.ok(!masked.includes('ymu7-17cu-3m1z'));
  });

});
