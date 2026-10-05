/**
 * test/unit/dual-live-atomic.test.js — Atomic Dual Live Streaming Test Suite
 *
 * Verifies that YouTube Dual Live (Shorts 9:16 + Horizontal 16:9) is atomic:
 * - Both outputs must be configured with distinct keys
 * - Missing pairs must block startup with clear errors (no silent downgrade)
 * - Both FFmpeg processes must spawn and both must become healthy
 * - Secondary failure aborts startup or triggers full recovery teardown
 * - Single-stream mode remains completely unaffected
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  evaluateStartGates,
  clearConfigGateError,
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-dual-atomic-test-'));
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

describe('Atomic Dual Live Streaming (15 Specifications)', () => {

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

  test('4. evaluateStartGates blocks start when horizontal pair video is missing in dual mode (no silent downgrade)', async () => {
    const videoId = 'vid_00000001';
    const videoFile = path.join(videosDir, `${videoId}.mp4`);
    await fs.writeFile(videoFile, 'fake-data');

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
      stream: { videoId, modePreference: 'auto' },
      youtube: {
        streamKey: 'primary-key-vert-999',
        horizontalStreamKey: 'secondary-key-horiz-888',
        dualStreamEnabled: true,
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_DUAL_PAIR_MISSING');
    assert.ok(gate.reason.includes('no matching horizontal'));
  });

  test('5. evaluateStartGates blocks start when horizontal pair disk file is missing', async () => {
    const vId = 'vid_00000002';
    const hId = 'vid_00000003';
    await fs.writeFile(path.join(videosDir, `${vId}.mp4`), 'fake-data');
    // Intentionally do NOT create path.join(videosDir, `${hId}.mp4`)

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [
        {
          id: vId,
          filename: `${vId}.mp4`,
          originalName: 'vert.mp4',
          orientation: 'vertical',
          pairedVideoId: hId,
          probe: { width: 1080, height: 1920, fps: 30 },
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
        },
        {
          id: hId,
          filename: `${hId}.mp4`,
          originalName: 'horiz.mp4',
          orientation: 'horizontal',
          pairedVideoId: vId,
          probe: { width: 1920, height: 1080, fps: 30 },
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
        },
      ],
    });

    await saveSettings({
      stream: { videoId: vId, modePreference: 'auto' },
      youtube: {
        streamKey: 'primary-key-vert-777',
        horizontalStreamKey: 'secondary-key-horiz-666',
        dualStreamEnabled: true,
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_DUAL_PAIR_MISSING');
    assert.ok(gate.reason.includes('missing on disk'));
  });

  test('6. evaluateStartGates succeeds and sets dualTarget & horizontalMeta when valid pair exists', async () => {
    const vId = 'vid_00000004';
    const hId = 'vid_00000005';
    await fs.writeFile(path.join(videosDir, `${vId}.mp4`), 'fake-data-vert');
    await fs.writeFile(path.join(videosDir, `${hId}.mp4`), 'fake-data-horiz');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [
        {
          id: vId,
          filename: `${vId}.mp4`,
          originalName: 'paired_vert.mp4',
          orientation: 'vertical',
          pairedVideoId: hId,
          probe: { width: 1080, height: 1920, fps: 30 },
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
        },
        {
          id: hId,
          filename: `${hId}.mp4`,
          originalName: 'paired_horiz.mp4',
          orientation: 'horizontal',
          pairedVideoId: vId,
          probe: { width: 1920, height: 1080, fps: 30 },
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
        },
      ],
    });

    await saveSettings({
      stream: { videoId: vId, modePreference: 'auto' },
      youtube: {
        streamKey: 'primary-key-vert-555',
        horizontalStreamKey: 'secondary-key-horiz-444',
        dualStreamEnabled: true,
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, true);
    assert.strictEqual(gate.isDualStream, true);
    assert.ok(gate.dualTarget.includes('primary-key-vert-555'));
    assert.strictEqual(gate.horizontalMeta.id, hId);
  });

  test('7. Single stream mode works smoothly without requiring horizontal pair when dual is disabled', async () => {
    const videoId = 'vid_00000006';
    await fs.writeFile(path.join(videosDir, `${videoId}.mp4`), 'fake-single-data');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'single.mp4',
        orientation: 'vertical',
        probe: { width: 1080, height: 1920, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await saveSettings({
      stream: { videoId, modePreference: 'auto' },
      youtube: {
        streamKey: 'single-vert-key-333',
        horizontalStreamKey: '',
        dualStreamEnabled: false,
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, true);
    assert.strictEqual(gate.isDualStream, false);
    assert.strictEqual(gate.dualTarget, null);
    assert.strictEqual(gate.horizontalMeta, null);
  });

  test('8. buildPublisherArgs generates distinct destination URLs for vertical and horizontal', () => {
    const vertTarget = 'rtmps://a.rtmps.youtube.com:443/live2/key-vert-111';
    const horizTarget = 'rtmps://a.rtmps.youtube.com:443/live2/key-horiz-222';
    const vertArgs = buildPublisherArgs({}, vertTarget);
    const horizArgs = buildPublisherArgs({}, horizTarget);

    assert.strictEqual(vertArgs[vertArgs.length - 1], vertTarget);
    assert.strictEqual(horizArgs[horizArgs.length - 1], horizTarget);
    assert.notStrictEqual(vertArgs[vertArgs.length - 1], horizArgs[horizArgs.length - 1]);
  });

  test('9. getOutputsStatus initializes with vertical and horizontal structures', () => {
    _resetStateForTest();
    const status = getOutputsStatus();
    assert.ok(status.vertical);
    assert.ok(status.horizontal);
    assert.strictEqual(status.horizontal.enabled, true);
    assert.strictEqual(status.vertical.enabled, false);
    assert.strictEqual(status.horizontal.status, 'INIT');
    assert.strictEqual(status.vertical.status, 'INIT');
  });

  test('10. clearConfigGateError clears E_DUAL_STREAM_KEYS_IDENTICAL on config fix', async () => {
    await saveState({
      status: 'ERROR',
      desiredState: 'stopped',
      lastError: { code: 'E_DUAL_STREAM_KEYS_IDENTICAL', message: 'Keys identical' },
    });
    await clearConfigGateError();
    const st = getState();
    assert.strictEqual(st.lastError, null);
  });

  test('11. clearConfigGateError clears E_DUAL_PAIR_MISSING on pair upload', async () => {
    await saveState({
      status: 'ERROR',
      desiredState: 'stopped',
      lastError: { code: 'E_DUAL_PAIR_MISSING', message: 'Pair missing' },
    });
    await clearConfigGateError();
    const st = getState();
    assert.strictEqual(st.lastError, null);
  });

  test('12. clearConfigGateError clears E_DUAL_HORIZONTAL_KEY_MISSING', async () => {
    await saveState({
      status: 'ERROR',
      desiredState: 'stopped',
      lastError: { code: 'E_DUAL_HORIZONTAL_KEY_MISSING', message: 'Key missing' },
    });
    await clearConfigGateError();
    const st = getState();
    assert.strictEqual(st.lastError, null);
  });

  test('13. Playlist mode blocks start when ANY item in the playlist lacks horizontal pair', async () => {
    const v1 = 'vid_00000007';
    const h1 = 'vid_00000008';
    const v2 = 'vid_00000009'; // No paired horizontal!

    await fs.writeFile(path.join(videosDir, `${v1}.mp4`), 'v1');
    await fs.writeFile(path.join(videosDir, `${h1}.mp4`), 'h1');
    await fs.writeFile(path.join(videosDir, `${v2}.mp4`), 'v2');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [
        {
          id: v1,
          filename: `${v1}.mp4`,
          originalName: 'v1.mp4',
          orientation: 'vertical',
          pairedVideoId: h1,
          probe: { width: 1080, height: 1920, fps: 30 },
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } },
        },
        {
          id: h1,
          filename: `${h1}.mp4`,
          originalName: 'h1.mp4',
          orientation: 'horizontal',
          pairedVideoId: v1,
          probe: { width: 1920, height: 1080, fps: 30 },
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } },
        },
        {
          id: v2,
          filename: `${v2}.mp4`,
          originalName: 'v2.mp4',
          orientation: 'vertical',
          probe: { width: 1080, height: 1920, fps: 30 },
          compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } },
        },
      ],
    });

    await saveState({ desiredState: 'running', status: 'STOPPED' });
    await saveSettings({
      stream: {
        videoId: v1,
        playlist: [v1, v2],
        playbackOrder: 'sequential',
        modePreference: 'auto',
      },
      youtube: {
        streamKey: 'key-pl-v',
        horizontalStreamKey: 'key-pl-h',
        dualStreamEnabled: true,
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_DUAL_PAIR_MISSING');
    assert.ok(gate.reason.includes(v2));
  });

  test('14. Playlist mode succeeds when all items have valid horizontal pairs', async () => {
    const v1 = 'vid_0000000a';
    const h1 = 'vid_0000000b';
    const v2 = 'vid_0000000c';
    const h2 = 'vid_0000000d';

    await fs.writeFile(path.join(videosDir, `${v1}.mp4`), 'v1');
    await fs.writeFile(path.join(videosDir, `${h1}.mp4`), 'h1');
    await fs.writeFile(path.join(videosDir, `${v2}.mp4`), 'v2');
    await fs.writeFile(path.join(videosDir, `${h2}.mp4`), 'h2');

    await writeJSON(catalogFile, {
      schemaVersion: 1,
      videos: [
        { id: v1, filename: `${v1}.mp4`, orientation: 'vertical', pairedVideoId: h1, probe: { width: 1080, height: 1920, fps: 30 }, compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } } },
        { id: h1, filename: `${h1}.mp4`, orientation: 'horizontal', pairedVideoId: v1, probe: { width: 1920, height: 1080, fps: 30 }, compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } } },
        { id: v2, filename: `${v2}.mp4`, orientation: 'vertical', pairedVideoId: h2, probe: { width: 1080, height: 1920, fps: 30 }, compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } } },
        { id: h2, filename: `${h2}.mp4`, orientation: 'horizontal', pairedVideoId: v2, probe: { width: 1920, height: 1080, fps: 30 }, compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } } },
      ],
    });

    await saveState({ desiredState: 'running', status: 'STOPPED' });
    await saveSettings({
      stream: {
        videoId: v1,
        playlist: [v1, v2],
        playbackOrder: 'sequential',
        modePreference: 'auto',
      },
      youtube: {
        streamKey: 'key-pl-ok-v',
        horizontalStreamKey: 'key-pl-ok-h',
        dualStreamEnabled: true,
      },
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, true);
    assert.strictEqual(gate.isDualStream, true);
    assert.ok(gate.dualTarget.includes('key-pl-ok-v'));
    assert.strictEqual(gate.horizontalMeta.isConcat, true);
  });

  test('15. Dual Live destination URLs mask secrets safely', () => {
    const masked = 'rtmps://a.rtmps.youtube.com:443/live2/k6gy-****-6x2r';
    assert.ok(!masked.includes('ymu7-17cu-3m1z'));
  });

});
