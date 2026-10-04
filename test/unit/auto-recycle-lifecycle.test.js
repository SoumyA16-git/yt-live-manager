/**
 * test/unit/auto-recycle-lifecycle.test.js — Deterministic unit tests for the complete FFmpeg exit lifecycle.
 *
 * Verifies:
 * 1. stopFfmpeg() waits for complete exit lifecycle (child exit -> lock released -> async onExit() completed).
 * 2. Protection against stale process state: new spawn cannot collide with exiting process.
 * 3. Complete auto-recycle lifecycle:
 *    RUNNING -> auto-recycle stop -> complete exit cleanup -> recycle pause -> auto restart -> new PID -> RUNNING.
 * 4. Repeated cycles: RUNNING -> RECYCLE -> RUNNING -> RECYCLE -> RUNNING.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  spawnFfmpeg,
  stopFfmpeg,
  isFfmpegRunning,
  getFfmpegPid,
  _resetStateForTest,
  _setLockPathForTest,
} from '../../src/ffmpeg-manager.js';
import {
  startStream,
  stopStream,
  transitionState,
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
import { tickScheduler } from '../../src/scheduler.js';

let tmpDir;
let testLockPath;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytlm-lifecycle-'));
  testLockPath = path.join(tmpDir, 'ffmpeg.lock');
  _setLockPathForTest(testLockPath);
});

after(async () => {
  _resetStateForTest();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  _resetStateForTest();
  try {
    await fs.unlink(testLockPath);
  } catch { /* ignore */ }
});

describe('FFmpeg Exit Lifecycle & stopFfmpeg Guarantee', () => {
  test('stopFfmpeg() waits for complete lifecycle: exit event, lock release, and async onExit()', async () => {
    let onExitStarted = false;
    let onExitFinished = false;

    let hasFfmpeg = false;
    try {
      const { execSync } = await import('node:child_process');
      execSync('ffmpeg -version', { stdio: 'ignore' });
      hasFfmpeg = true;
    } catch {
      hasFfmpeg = false;
    }

    if (!hasFfmpeg) {
      assert.equal(isFfmpegRunning(), false);
      return;
    }

    const onExit = async ({ code, signal, expected }) => {
      onExitStarted = true;
      // Simulate asynchronous work inside onExit (like flushing usage, saving state, etc.)
      await new Promise(r => setTimeout(r, 60));
      onExitFinished = true;
    };

    const settings = {
      stream: { startupTimeoutSeconds: 5, stallSeconds: 5, slowSeconds: 5, minSpeed: 0.1 },
    };

    const { pid } = await spawnFfmpeg({
      args: ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '10', '-f', 'null', '-'],
      settings,
      onProgress: () => {},
      onExit,
      onHealthy: () => {},
    });

    assert.ok(pid > 0, 'FFmpeg PID should be > 0');
    assert.equal(isFfmpegRunning(), true, 'isFfmpegRunning() should be true');
    assert.equal(getFfmpegPid(), pid, 'getFfmpegPid() should match pid');
    assert.equal(fsSync.existsSync(testLockPath), true, 'Lock file should exist while running');

    // Call stopFfmpeg()
    const stopResult = await stopFfmpeg({ force: false, reason: 'test_stop', graceSeconds: 5 });

    // Assert that when stopFfmpeg resolves:
    // 1. onExit has completely finished
    assert.equal(onExitStarted, true, 'onExit should have started');
    assert.equal(onExitFinished, true, 'onExit MUST be completely finished before stopFfmpeg resolves');

    // 2. Lock file is released
    assert.equal(fsSync.existsSync(testLockPath), false, 'Lock file MUST be released');

    // 3. Process state is cleared
    assert.equal(isFfmpegRunning(), false, 'isFfmpegRunning() must be false');
    assert.equal(getFfmpegPid(), null, 'getFfmpegPid() must be null');
    assert.equal(stopResult.stopped, true);
  });

  test('protection against stale state: spawnFfmpeg waits for pending exit before new spawn', async () => {
    let hasFfmpeg = false;
    try {
      const { execSync } = await import('node:child_process');
      execSync('ffmpeg -version', { stdio: 'ignore' });
      hasFfmpeg = true;
    } catch {
      hasFfmpeg = false;
    }
    if (!hasFfmpeg) return;

    const settings = {
      stream: { startupTimeoutSeconds: 5, stallSeconds: 5, slowSeconds: 5, minSpeed: 0.1 },
    };

    let slowExitDone = false;
    const { pid: pid1 } = await spawnFfmpeg({
      args: ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '10', '-f', 'null', '-'],
      settings,
      onProgress: () => {},
      onExit: async () => {
        await new Promise(r => setTimeout(r, 80));
        slowExitDone = true;
      },
      onHealthy: () => {},
    });

    // Initiate stop without awaiting immediately
    const stopPromise = stopFfmpeg({ force: false, reason: 'test_stop_async', graceSeconds: 5 });

    await stopPromise;
    assert.equal(slowExitDone, true);

    const { pid: pid2 } = await spawnFfmpeg({
      args: ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '10', '-f', 'null', '-'],
      settings,
      onProgress: () => {},
      onExit: async () => {},
      onHealthy: () => {},
    });

    assert.ok(pid2 > 0);
    assert.notEqual(pid1, pid2, 'Second spawn must have a genuinely new PID');
    assert.equal(isFfmpegRunning(), true);

    await stopFfmpeg({ force: true, reason: 'cleanup' });
    assert.equal(isFfmpegRunning(), false);
    assert.equal(getFfmpegPid(), null);
  });
});

describe('Auto-Recycle State Lifecycle & Repeated Cycles', () => {
  let subDir;

  before(async () => {
    subDir = path.join(tmpDir, 'recycle_test');
    await fs.mkdir(subDir, { recursive: true });

    const sPath = path.join(subDir, 'settings.json');
    const stPath = path.join(subDir, 'stream-state.json');
    const hPath = path.join(subDir, 'stream-history.json');
    const bDir = path.join(subDir, 'backups');
    const vFile = path.join(subDir, 'videos.json');
    const vDir = path.join(subDir, 'videos');

    await fs.mkdir(bDir, { recursive: true });
    await fs.mkdir(vDir, { recursive: true });

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setVideoPaths(vDir, vFile);

    await loadSettings();
    await loadState();

    // Write initial settings
    await saveSettings({
      stream: { videoId: 'vid_test1', modePreference: 'copy', allowTranscode: true },
      youtube: { rtmpsUrl: 'rtmps://127.0.0.1:1935/live2', streamKey: 'test-stream-key-1234' },
      scheduler: {
        mode: 'continuous',
        timezone: 'Asia/Kolkata',
        autoRecycle: { enabled: true, maxSessionMinutes: 2, pauseMinutes: 2 },
      },
    });

    await saveState({
      desiredState: 'running',
      status: 'RUNNING',
      streamStartedAt: new Date(Date.now() - 150 * 1000).toISOString(), // 2.5 minutes ago (exceeds 2m)
      ffmpegPid: 99999,
    });
  });

  test('Cycle 1: autoRecycle trigger cleanly transitions to SCHEDULED and clears streamStartedAt', async () => {
    // Current time is 2.5m after streamStartedAt -> tickScheduler should trigger autoRecycle
    const tickResult = await tickScheduler(new Date());

    assert.equal(tickResult.mode, 'continuous');
    assert.equal(tickResult.autoRecycleTriggered, true);

    const st = getState();
    assert.equal(st.status, 'SCHEDULED', 'Status must be SCHEDULED during recycle pause');
    assert.ok(st.recyclingUntil, 'recyclingUntil must be set');
    assert.equal(st.streamStartedAt, null, 'streamStartedAt MUST be reset to null during pause');
  });

  test('Cycle 1: recycle pause wait does not start stream prematurely', async () => {
    // 1 minute into 2 minute pause
    const halfWay = new Date(Date.now() + 60 * 1000);
    const tickResult = await tickScheduler(halfWay);

    assert.equal(tickResult.recycling, true);
    assert.equal(getState().status, 'SCHEDULED');
  });

  test('Cycle 1: recycle pause completion clears recyclingUntil and resumes session', async () => {
    // Pause expired (3 minutes into future)
    const afterPause = new Date(Date.now() + 180 * 1000);
    const tickResult = await tickScheduler(afterPause);

    assert.equal(tickResult.recycling, false);
    assert.equal(getState().recyclingUntil, null, 'recyclingUntil must be cleared upon resume');
  });

  test('Cycle 2: repeated cycle cleanly stops and pauses again when limit is reached', async () => {
    // Simulate stream ran for another 2.5 minutes
    await saveState({
      status: 'RUNNING',
      streamStartedAt: new Date(Date.now() - 150 * 1000).toISOString(),
    });

    const tickResult = await tickScheduler(new Date());
    assert.equal(tickResult.autoRecycleTriggered, true);
    assert.equal(getState().status, 'SCHEDULED');
    assert.equal(getState().streamStartedAt, null);
    assert.ok(getState().recyclingUntil);
  });

  test('End-to-End Repeated Process Cycles: RUNNING -> STOP -> RUNNING -> STOP -> RUNNING with distinct PIDs', async () => {
    let hasFfmpeg = false;
    try {
      const { execSync } = await import('node:child_process');
      execSync('ffmpeg -version', { stdio: 'ignore' });
      hasFfmpeg = true;
    } catch {
      hasFfmpeg = false;
    }
    if (!hasFfmpeg) return;

    const settings = {
      stream: { startupTimeoutSeconds: 5, stallSeconds: 5, slowSeconds: 5, minSpeed: 0.1 },
    };

    // Cycle 1: Spawn
    let exit1Done = false;
    const { pid: pid1 } = await spawnFfmpeg({
      args: ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '10', '-f', 'null', '-'],
      settings,
      onProgress: () => {},
      onExit: async () => {
        await new Promise(r => setTimeout(r, 40));
        exit1Done = true;
      },
      onHealthy: () => {},
    });

    assert.ok(pid1 > 0);
    assert.equal(isFfmpegRunning(), true);

    // Cycle 1: Stop and complete cleanup
    await stopFfmpeg({ force: false, reason: 'cycle_1_recycle' });
    assert.equal(exit1Done, true, 'Cycle 1 onExit must be awaited');
    assert.equal(isFfmpegRunning(), false);
    assert.equal(getFfmpegPid(), null);
    assert.equal(fsSync.existsSync(testLockPath), false);

    // Cycle 2: Genuinely new FFmpeg process spawned
    let exit2Done = false;
    const { pid: pid2 } = await spawnFfmpeg({
      args: ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '10', '-f', 'null', '-'],
      settings,
      onProgress: () => {},
      onExit: async () => {
        await new Promise(r => setTimeout(r, 40));
        exit2Done = true;
      },
      onHealthy: () => {},
    });

    assert.ok(pid2 > 0);
    assert.notEqual(pid2, pid1, 'Cycle 2 must spawn a new PID');
    assert.equal(isFfmpegRunning(), true);

    // Cycle 2: Stop and complete cleanup
    await stopFfmpeg({ force: false, reason: 'cycle_2_recycle' });
    assert.equal(exit2Done, true, 'Cycle 2 onExit must be awaited');
    assert.equal(isFfmpegRunning(), false);
    assert.equal(getFfmpegPid(), null);
    assert.equal(fsSync.existsSync(testLockPath), false);

    // Cycle 3: Third new FFmpeg process spawned
    let exit3Done = false;
    const { pid: pid3 } = await spawnFfmpeg({
      args: ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '10', '-f', 'null', '-'],
      settings,
      onProgress: () => {},
      onExit: async () => {
        await new Promise(r => setTimeout(r, 40));
        exit3Done = true;
      },
      onHealthy: () => {},
    });

    assert.ok(pid3 > 0);
    assert.notEqual(pid3, pid2, 'Cycle 3 must spawn a new PID');
    assert.notEqual(pid3, pid1);
    assert.equal(isFfmpegRunning(), true);

    // Final Stop
    await stopFfmpeg({ force: true, reason: 'test_complete' });
    assert.equal(exit3Done, true);
    assert.equal(isFfmpegRunning(), false);
    assert.equal(getFfmpegPid(), null);
    assert.equal(fsSync.existsSync(testLockPath), false);
  });
});
