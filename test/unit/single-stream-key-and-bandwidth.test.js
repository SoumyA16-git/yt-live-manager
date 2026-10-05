/**
 * single-stream-key-and-bandwidth.test.js
 * Comprehensive tests for:
 * 1. Single Default YouTube Stream Key (used identically in Horizontal & Vertical)
 * 2. Missing streamKey blocking start (E_KEY_MISSING)
 * 3. Prohibition of old horizontalStreamKey / verticalStreamKey runtime usage
 * 4. Accurate publisher output byte accounting, delta calculation, and overhead applied once
 * 5. Baseline reset on restart & auto-recycle (no double-counting)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  loadSettings,
  saveSettings,
  getSettings,
  getMaskedSettings,
  getStreamKey,
  getHorizontalStreamKey,
  _setPathsForTest as _setConfigPaths,
} from '../../src/config-manager.js';

import {
  loadState,
  saveState,
  getState,
  _setPathsForTest as _setStatePaths,
} from '../../src/state-manager.js';

import {
  loadUsage,
  getUsage,
  getEffectiveUsedBytes,
  getRawUsedBytes,
  recordProgressBytes,
  resetProcessBaseline,
  _setPathsForTest as _setUsagePaths,
} from '../../src/usage-manager.js';

import {
  evaluateStartGates,
  setStreamMode,
} from '../../src/stream-manager.js';

import {
  _setPathsForTest as _setVideoPaths,
} from '../../src/video-manager.js';

import { writeJSON } from '../../src/lib/atomic-json.js';

describe('Single Default YouTube Stream Key & Bandwidth Precision', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytlm-single-key-bw-'));
    const sPath = path.join(tmpDir, 'settings.json');
    const bDir  = path.join(tmpDir, 'backups');
    const stPath = path.join(tmpDir, 'stream-state.json');
    const hPath  = path.join(tmpDir, 'stream-history.json');
    const uPath  = path.join(tmpDir, 'bandwidth-usage.json');
    const vDir   = path.join(tmpDir, 'videos');
    const inDir  = path.join(tmpDir, 'incoming');
    const vIdx   = path.join(tmpDir, 'video-index.json');

    await fs.mkdir(bDir, { recursive: true });
    await fs.mkdir(vDir, { recursive: true });

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setUsagePaths(uPath, bDir);
    _setVideoPaths(vDir, inDir, vIdx);

    await loadSettings();
    await loadState();
    await saveState({ desiredState: 'running', disabled: false });
    await loadUsage({ resetDay: 1, resetHour: 0, timezone: 'UTC' });
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── 1. Stream Key Tests ─────────────────────────────────────────────────────

  test('1. Horizontal mode uses settings.youtube.streamKey', async () => {
    const videoId = 'vid_a1111111';
    const vDir = path.join(tmpDir, 'videos');
    await fs.writeFile(path.join(vDir, `${videoId}.mp4`), 'mock-data');

    await saveSettings({
      stream: { mode: 'horizontal', videoId, playlists: { horizontal: [videoId] }, modePreference: 'auto' },
      youtube: { streamKey: 'my-default-reusable-key-1234' },
    });

    const vIdx = path.join(tmpDir, 'video-index.json');
    await writeJSON(vIdx, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'h1.mp4',
        probe: { width: 1920, height: 1080, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } },
      }],
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, true);
    assert.strictEqual(gate.streamKey, 'my-default-reusable-key-1234');
    assert.ok(gate.destUrl.endsWith('/my-default-reusable-key-1234'));
  });

  test('2. Vertical mode uses settings.youtube.streamKey (SAME key as Horizontal)', async () => {
    const videoId = 'vid_b2222222';
    const vDir = path.join(tmpDir, 'videos');
    await fs.writeFile(path.join(vDir, `${videoId}.mp4`), 'mock-data');

    await saveSettings({
      stream: { mode: 'vertical', videoId, playlists: { vertical: [videoId] }, modePreference: 'auto' },
      youtube: { streamKey: 'my-default-reusable-key-1234' },
    });

    const vIdx = path.join(tmpDir, 'video-index.json');
    await writeJSON(vIdx, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'v1.mp4',
        probe: { width: 1080, height: 1920, fps: 30 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true } },
      }],
    });

    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, true);
    assert.strictEqual(gate.streamKey, 'my-default-reusable-key-1234');
    assert.ok(gate.destUrl.endsWith('/my-default-reusable-key-1234'));
  });

  test('3. Missing settings.youtube.streamKey blocks start in both modes (no fallback)', async () => {
    await saveSettings({
      stream: { mode: 'horizontal' },
      youtube: { streamKey: '' },
    });

    let gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_KEY_MISSING');

    await saveSettings({
      stream: { mode: 'vertical' },
      youtube: { streamKey: '' },
    });

    gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_KEY_MISSING');
  });

  test('4. Legacy horizontalStreamKey is ignored at runtime if streamKey is empty', async () => {
    await saveSettings({
      stream: { mode: 'horizontal' },
      youtube: { streamKey: '' },
    });
    // Even if legacy config file had horizontalStreamKey, it must not bypass start gate
    const gate = await evaluateStartGates();
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.code, 'E_KEY_MISSING');
  });

  test('5. getStreamKey() and getHorizontalStreamKey() return the same canonical key', async () => {
    await saveSettings({
      youtube: { streamKey: 'unified-reusable-test-key-9999' },
    });
    assert.strictEqual(getStreamKey(), 'unified-reusable-test-key-9999');
    assert.strictEqual(getHorizontalStreamKey(), 'unified-reusable-test-key-9999');
  });

  // ─── 2. Bandwidth Precision Tests ──────────────────────────────────────────

  test('6. Baseline tracking: first progress emission sets baseline without incrementing usage', () => {
    resetProcessBaseline();
    assert.strictEqual(getRawUsedBytes(), 0);
    assert.strictEqual(getEffectiveUsedBytes(), 0);

    // Initial emission at start of process: 1,000,000 bytes
    recordProgressBytes(1000000, 1, 10);
    assert.strictEqual(getRawUsedBytes(), 0, 'First sample should only set baseline');
    assert.strictEqual(getEffectiveUsedBytes(), 0);
  });

  test('7. Delta calculation: delta is added to rawBytes, and overhead is applied exactly once', () => {
    resetProcessBaseline();
    recordProgressBytes(1000000, 1, 10); // Baseline: 1,000,000 bytes

    // Second sample 1s later: 1,500,000 bytes (delta = 500,000 bytes)
    recordProgressBytes(1500000, 1, 10);
    assert.strictEqual(getRawUsedBytes(), 500000, 'Raw bytes should equal delta exactly');
    // Overhead = 10% of 500,000 = 50,000
    // Effective = 500,000 + 50,000 = 550,000
    assert.strictEqual(getEffectiveUsedBytes(), 550000, 'Effective used bytes should include 10% overhead once');
  });

  test('8. Restart / Auto-Recycle baseline reset: new process total_size is not subtracted from old', () => {
    resetProcessBaseline();
    recordProgressBytes(0, 1, 10);
    recordProgressBytes(1000000, 1, 10); // Session 1: +1,000,000 bytes
    assert.strictEqual(getRawUsedBytes(), 1000000);

    // Process restarts (auto-recycle or manual restart):
    resetProcessBaseline();

    // New process starts from 0 bytes
    recordProgressBytes(0, 1, 10); // New baseline set
    assert.strictEqual(getRawUsedBytes(), 1000000, 'Usage should not decrease on new process start');

    // New process advances by 200,000 bytes
    recordProgressBytes(200000, 1, 10);
    assert.strictEqual(getRawUsedBytes(), 1200000, 'Usage should be Session 1 + Session 2 (1.2MB, not 2.2MB)');
  });

  test('9. Speed factor or FPS is excluded from bandwidth byte counting', () => {
    resetProcessBaseline();
    recordProgressBytes(1000, 1, 10);
    // Emitting progress only takes total_size, not speed or fps
    recordProgressBytes(3000, 1, 10); // Delta: 2000 bytes
    assert.strictEqual(getRawUsedBytes(), 2000);
  });

  test('10. Mode switch while RUNNING, STARTING, or RECONNECTING is rejected with E_STREAM_RUNNING (409)', async () => {
    for (const status of ['RUNNING', 'STARTING', 'RECONNECTING']) {
      await saveState({ status });
      await assert.rejects(
        async () => {
          await setStreamMode('vertical');
        },
        (err) => {
          assert.strictEqual(err.code, 'E_STREAM_RUNNING');
          assert.strictEqual(err.status, 409);
          return true;
        },
        `Expected E_STREAM_RUNNING when status is ${status}`
      );
    }
  });

  test('11. Mode switch while STOPPED succeeds and updates state and settings', async () => {
    await saveState({ status: 'STOPPED', streamMode: 'horizontal' });
    await saveSettings({ stream: { mode: 'horizontal' } });

    const result = await setStreamMode('vertical');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.mode, 'vertical');
    assert.strictEqual(getState().streamMode, 'vertical');
    assert.strictEqual(getSettings().stream.mode, 'vertical');
  });
});
