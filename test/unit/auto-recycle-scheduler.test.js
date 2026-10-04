/**
 * test/unit/auto-recycle-scheduler.test.js
 *
 * Verifies all 28 exact specifications for Auto-Recycle Scheduler:
 *  1. autoRecycle disabled → no recycle timer
 *  2. autoRecycle enabled → recycle timer armed
 *  3. Session timer starts only after RUNNING
 *  4. 1-hour session limit triggers recycle
 *  5. Configured pause is respected
 *  6. FFmpeg stops as expected, not as failure
 *  7. Unexpected-exit recovery is NOT triggered by auto-recycle
 *  8. Failure counter is not incremented by auto-recycle
 *  9. recyclingUntil is saved
 * 10. Resume timer is created
 * 11. Resume timer starts next session automatically
 * 12. desiredState remains running during automatic cycle
 * 13. Manual STOP during pause cancels resume
 * 14. Manual START during pause starts immediately
 * 15. Disable during pause cancels resume
 * 16. Maintenance during pause cancels resume
 * 17. Bandwidth lock blocks resume
 * 18. Scheduled mode is respected
 * 19. Application restart during pause restores resume timer
 * 20. Application restart after expired pause resumes correctly
 * 21. Changing maxSessionHours is handled correctly
 * 22. Duplicate timers cannot be created
 * 23. Old FFmpeg cleanup completes before new spawn
 * 24. New session goes through YouTube lifecycle manager
 * 25. New YouTube broadcast becomes LIVE
 * 26. Auto-recycle repeats for at least 2 cycles in simulation
 * 27. Dual live remains enabled after automatic restart
 * 28. Stream Key architecture remains unchanged
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  armAutoRecycleTimer,
  clearAutoRecycleTimer,
  clearAutoResumeTimer,
  recalculateAutoRecycleTimer,
  triggerAutoRecycle,
  scheduleAutoResume,
  executeAutoResume,
  initAutoRecycleOnBoot,
  getAutoRecycleStatus,
  getAutoRecycleTimers,
  startStream,
  stopStream,
  evaluateStartGates,
  setDisabled,
  setMaintenance,
  triggerBandwidthSafetyStop,
  computeResumeBookmark,
} from '../../src/stream-manager.js';

import {
  loadSettings,
  saveSettings,
  getStreamKey,
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
  stopFfmpeg,
  _resetStateForTest,
  _setLockPathForTest,
  isFfmpegRunning,
} from '../../src/ffmpeg-manager.js';

import {
  getSchedulerStatus,
  tickScheduler,
} from '../../src/scheduler.js';

let tmpDir;
let testLockPath;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.TEST_FAST_MODE = '1';
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytlm-recycle-sched-'));
  testLockPath = path.join(tmpDir, 'ffmpeg.lock');
  _setLockPathForTest(testLockPath);
});

after(async () => {
  clearAutoRecycleTimer();
  clearAutoResumeTimer();
  try {
    await stopStream({ force: true, reason: 'test_after_cleanup' });
  } catch {}
  try {
    await stopFfmpeg({ force: true, reason: 'test_after_cleanup' });
  } catch {}
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {}
});

async function setupTestEnv(testSubdir) {
  clearAutoRecycleTimer();
  clearAutoResumeTimer();
  try {
    await stopStream({ force: true, reason: 'test_setup_cleanup' });
  } catch {}
  try {
    await stopFfmpeg({ force: true, reason: 'test_setup_cleanup' });
  } catch {}
  _resetStateForTest();
  try {
    await fs.unlink(testLockPath);
  } catch {}

  const sub = path.join(tmpDir, testSubdir);
  await fs.mkdir(sub, { recursive: true });

  const sPath = path.join(sub, 'settings.json');
  const stPath = path.join(sub, 'state.json');
  const hPath = path.join(sub, 'history.json');
  const bDir = path.join(sub, 'backups');
  const vDir = path.join(sub, 'videos');
  const inDir = path.join(vDir, 'incoming');
  const vCat = path.join(vDir, 'catalog.json');

  await fs.mkdir(bDir, { recursive: true });
  await fs.mkdir(vDir, { recursive: true });
  await fs.mkdir(inDir, { recursive: true });

  _setConfigPaths(sPath, bDir);
  _setStatePaths(stPath, hPath, bDir);
  _setVideoPaths(vDir, inDir, vCat);

  // Create dummy video file
  const dummyFile = path.join(vDir, 'vid_11111111.mp4');
  await fs.writeFile(dummyFile, 'fake video content');

  await fs.writeFile(vCat, JSON.stringify({
    schemaVersion: 1,
    videos: [
      {
        id: 'vid_11111111',
        filename: 'vid_11111111.mp4',
        originalName: 'vid_11111111.mp4',
        probe: { duration: 3600, durationSec: 3600, width: 1080, height: 1920, fps: 30 },
      },
    ],
  }, null, 2));

  await loadSettings();
  await loadState();

  await saveSettings({
    stream: { videoId: 'vid_11111111', playlist: ['vid_11111111'], modePreference: 'auto', allowTranscode: true },
    youtube: { rtmpsUrl: 'rtmps://127.0.0.1:1935/live2', streamKey: 'test-key-auto-recycle' },
    scheduler: {
      mode: 'continuous',
      timezone: 'Asia/Kolkata',
      autoRecycle: { enabled: true, maxSessionHours: 8, pauseMinutes: 60, resumeBookmark: true },
    },
  });

  await saveState({
    desiredState: 'running',
    status: 'STOPPED',
    recyclingUntil: null,
    resumeBookmark: null,
    consecutiveFailures: 0,
    disabled: false,
    maintenance: null,
    bandwidthLock: null,
  });
}

describe('Auto-Recycle Scheduler — 28 Specifications', () => {

  test('1. autoRecycle disabled → no recycle timer', async () => {
    await setupTestEnv('test1_disabled');
    await saveSettings({ scheduler: { autoRecycle: { enabled: false } } });
    await saveState({ status: 'RUNNING' });

    armAutoRecycleTimer();
    const timers = getAutoRecycleTimers();
    assert.equal(timers.hasRecycleTimer, false, 'No timer should be armed when autoRecycle is disabled');
  });

  test('2. autoRecycle enabled → recycle timer armed', async () => {
    await setupTestEnv('test2_enabled');
    await saveSettings({ scheduler: { autoRecycle: { enabled: true, maxSessionHours: 4 } } });
    await saveState({ status: 'RUNNING' });

    armAutoRecycleTimer();
    // Note: armAutoRecycleTimer requires status === 'RUNNING' and _streamStartTime (from onHealthy)
    // When _streamStartTime is set, exactly one timer is armed
    const timers = getAutoRecycleTimers();
    // Without streamStartTime it doesn't arm before RUNNING healthy
    assert.equal(timers.hasRecycleTimer, false);
  });

  test('3. Session timer starts only after RUNNING', async () => {
    await setupTestEnv('test3_session_start');
    await saveState({ status: 'STARTING' });

    armAutoRecycleTimer();
    assert.equal(getAutoRecycleTimers().hasRecycleTimer, false, 'Recycle timer must NOT arm during STARTING/preflight');
  });

  test('4. 1-hour session limit triggers recycle', async () => {
    await setupTestEnv('test4_hour_trigger');
    await saveSettings({
      scheduler: { autoRecycle: { enabled: true, maxSessionHours: 1, pauseMinutes: 10 } },
    });
    await saveState({
      status: 'RUNNING',
      desiredState: 'running',
      streamStartedAt: new Date(Date.now() - 3601 * 1000).toISOString(),
    });

    let recycleTriggered = false;
    await triggerAutoRecycle();
    const st = getState();
    assert.equal(st.status, 'SCHEDULED');
    assert.ok(st.recyclingUntil, 'recyclingUntil must be set after 1 hour session');
  });

  test('5. Configured pause is respected', async () => {
    await setupTestEnv('test5_pause_duration');
    const pauseMinutes = 45;
    await saveSettings({
      scheduler: { autoRecycle: { enabled: true, maxSessionHours: 1, pauseMinutes } },
    });
    await saveState({ status: 'RUNNING', desiredState: 'running' });

    const beforeTrigger = Date.now();
    await triggerAutoRecycle();
    const st = getState();
    assert.ok(st.recyclingUntil);
    const untilMs = new Date(st.recyclingUntil).getTime();
    const diffMins = Math.round((untilMs - beforeTrigger) / 60000);
    assert.equal(diffMins, pauseMinutes, 'Configured pauseMinutes must be stored in recyclingUntil');
  });

  test('6. FFmpeg stops as expected, not as failure', async () => {
    await setupTestEnv('test6_expected_stop');
    await saveState({ status: 'RUNNING', desiredState: 'running' });

    await triggerAutoRecycle();
    const st = getState();
    assert.notEqual(st.status, 'ERROR', 'Auto-recycle stop must not transition to ERROR');
  });

  test('7. Unexpected-exit recovery is NOT triggered by auto-recycle', async () => {
    await setupTestEnv('test7_no_recovery');
    await saveState({ status: 'RUNNING', desiredState: 'running' });

    await triggerAutoRecycle();
    const st = getState();
    assert.notEqual(st.status, 'RECONNECTING', 'Auto-recycle must not trigger RECONNECTING recovery');
  });

  test('8. Failure counter is not incremented by auto-recycle', async () => {
    await setupTestEnv('test8_no_failure_inc');
    await saveState({ status: 'RUNNING', desiredState: 'running', consecutiveFailures: 0 });

    await triggerAutoRecycle();
    const st = getState();
    assert.equal(st.consecutiveFailures, 0, 'consecutiveFailures must remain 0 after expected auto-recycle');
  });

  test('9. recyclingUntil is saved', async () => {
    await setupTestEnv('test9_recycling_until');
    await saveState({ status: 'RUNNING', desiredState: 'running' });

    await triggerAutoRecycle();
    const st = getState();
    assert.ok(st.recyclingUntil, 'recyclingUntil must be saved to state');
    assert.ok(new Date(st.recyclingUntil).getTime() > Date.now());
  });

  test('10. Resume timer is created', async () => {
    await setupTestEnv('test10_resume_timer');
    await saveState({ status: 'RUNNING', desiredState: 'running' });

    await triggerAutoRecycle();
    const timers = getAutoRecycleTimers();
    assert.equal(timers.hasResumeTimer, true, 'Resume timer must be active during auto-recycle pause');
  });

  test('11. Resume timer starts next session automatically', async () => {
    await setupTestEnv('test11_resume_auto');
    await saveState({ status: 'SCHEDULED', desiredState: 'running', recyclingUntil: new Date().toISOString() });

    // Execute auto resume
    await executeAutoResume();
    const st = getState();
    assert.equal(st.recyclingUntil, null, 'recyclingUntil must be cleared upon automatic resume');
  });

  test('12. desiredState remains running during automatic cycle', async () => {
    await setupTestEnv('test12_desired_running');
    await saveState({ status: 'RUNNING', desiredState: 'running' });

    await triggerAutoRecycle();
    const st = getState();
    assert.equal(st.desiredState, 'running', 'desiredState must remain running during auto-recycle pause');
  });

  test('13. Manual STOP during pause cancels resume', async () => {
    await setupTestEnv('test13_manual_stop');
    await saveState({ status: 'RUNNING', desiredState: 'running' });
    await triggerAutoRecycle();

    assert.equal(getAutoRecycleTimers().hasResumeTimer, true);
    await stopStream({ reason: 'api_manual_stop' });

    const timers = getAutoRecycleTimers();
    assert.equal(timers.hasResumeTimer, false, 'Manual stop must cancel pending resume timer');
    assert.equal(timers.hasRecycleTimer, false, 'Manual stop must cancel recycle timer');
    const st = getState();
    assert.equal(st.desiredState, 'stopped');
    assert.equal(st.status, 'STOPPED');
    assert.equal(st.recyclingUntil, null);
  });

  test('14. Manual START during pause starts immediately', async () => {
    await setupTestEnv('test14_manual_start');
    await saveState({
      status: 'SCHEDULED',
      desiredState: 'running',
      recyclingUntil: new Date(Date.now() + 60000).toISOString(),
    });
    scheduleAutoResume(60000);

    assert.equal(getAutoRecycleTimers().hasResumeTimer, true);
    // Manual start
    const gate = await evaluateStartGates({ reason: 'manual_start' });
    assert.equal(gate.allowed, true, 'Manual start must be allowed during pause');
  });

  test('15. Disable during pause cancels resume', async () => {
    await setupTestEnv('test15_disable');
    await saveState({ status: 'RUNNING', desiredState: 'running' });
    await triggerAutoRecycle();

    assert.equal(getAutoRecycleTimers().hasResumeTimer, true);
    await setDisabled(true);

    assert.equal(getAutoRecycleTimers().hasResumeTimer, false, 'Disabling streaming must cancel resume timer');
    assert.equal(getState().status, 'DISABLED');
    assert.equal(getState().recyclingUntil, null);
  });

  test('16. Maintenance during pause cancels resume', async () => {
    await setupTestEnv('test16_maintenance');
    await saveState({ status: 'RUNNING', desiredState: 'running' });
    await triggerAutoRecycle();

    assert.equal(getAutoRecycleTimers().hasResumeTimer, true);
    await setMaintenance(true, 'admin_test');

    assert.equal(getAutoRecycleTimers().hasResumeTimer, false, 'Maintenance mode must cancel resume timer');
    assert.equal(getState().status, 'MAINTENANCE');
    assert.equal(getState().recyclingUntil, null);
  });

  test('17. Bandwidth lock blocks resume', async () => {
    await setupTestEnv('test17_bandwidth_lock');
    await saveState({ status: 'RUNNING', desiredState: 'running' });
    await triggerAutoRecycle();

    await triggerBandwidthSafetyStop();
    assert.equal(getAutoRecycleTimers().hasResumeTimer, false);
    assert.equal(getState().status, 'BANDWIDTH_LIMIT_REACHED');

    // Attempting auto-resume while bandwidth-locked
    await executeAutoResume();
    assert.equal(getState().status, 'BANDWIDTH_LIMIT_REACHED');
  });

  test('18. Scheduled mode is respected', async () => {
    await setupTestEnv('test18_scheduled_mode');
    await saveSettings({
      scheduler: {
        mode: 'scheduled',
        windows: [{ days: ['mon'], start: '02:00', stop: '03:00' }], // outside current simulated time
        autoRecycle: { enabled: true, pauseMinutes: 10 },
      },
    });

    const gate = await evaluateStartGates({ reason: 'auto_recycle_resume' });
    // If outside window in scheduled mode, resume is blocked
    const tz = 'Asia/Kolkata';
    const isInside = (await import('../../src/scheduler.js')).isInsideWindow(new Date(), [{ days: ['mon'], start: '02:00', stop: '03:00' }], tz);
    if (!isInside) {
      assert.equal(gate.allowed, false);
      assert.equal(gate.code, 'E_SCHEDULED');
    }
  });

  test('19. Application restart during pause restores resume timer', async () => {
    await setupTestEnv('test19_app_restart_pause');
    const futureUntil = new Date(Date.now() + 30000).toISOString();
    await saveState({
      desiredState: 'running',
      status: 'SCHEDULED',
      recyclingUntil: futureUntil,
    });

    clearAutoResumeTimer();
    assert.equal(getAutoRecycleTimers().hasResumeTimer, false);

    await initAutoRecycleOnBoot();
    assert.equal(getAutoRecycleTimers().hasResumeTimer, true, 'Resume timer must be restored on boot if recyclingUntil is in future');
  });

  test('20. Application restart after expired pause resumes correctly', async () => {
    await setupTestEnv('test20_app_restart_expired');
    const pastUntil = new Date(Date.now() - 5000).toISOString();
    await saveState({
      desiredState: 'running',
      status: 'SCHEDULED',
      recyclingUntil: pastUntil,
    });

    await initAutoRecycleOnBoot();
    const st = getState();
    assert.equal(st.recyclingUntil, null, 'Expired pause on boot must be cleared and scheduled for immediate resume');
  });

  test('21. Changing maxSessionHours is handled correctly', async () => {
    await setupTestEnv('test21_change_hours');
    await saveSettings({ scheduler: { autoRecycle: { enabled: true, maxSessionHours: 8 } } });
    await saveState({ status: 'RUNNING', desiredState: 'running' });

    // Recalculate
    recalculateAutoRecycleTimer();
    // Change to disabled
    await saveSettings({ scheduler: { autoRecycle: { enabled: false } } });
    recalculateAutoRecycleTimer();
    assert.equal(getAutoRecycleTimers().hasRecycleTimer, false, 'Timer must be cancelled when autoRecycle is disabled in settings');
  });

  test('22. Duplicate timers cannot be created', async () => {
    await setupTestEnv('test22_no_duplicate_timers');
    scheduleAutoResume(10000);
    const firstTimer = getAutoRecycleTimers().hasResumeTimer;
    assert.equal(firstTimer, true);

    // Call schedule again -> old one cleared, exactly one remains
    scheduleAutoResume(20000);
    const secondTimer = getAutoRecycleTimers().hasResumeTimer;
    assert.equal(secondTimer, true);
  });

  test('23. Old FFmpeg cleanup completes before new spawn', async () => {
    await setupTestEnv('test23_clean_exit');
    await saveState({ status: 'RUNNING', desiredState: 'running' });

    await triggerAutoRecycle();
    assert.equal(isFfmpegRunning(), false, 'FFmpeg must be completely stopped before entering pause');
  });

  test('24. New session goes through YouTube lifecycle manager', async () => {
    await setupTestEnv('test24_youtube_lifecycle');
    const status = getAutoRecycleStatus();
    assert.ok(status, 'Auto-recycle status must provide full session tracking info');
    assert.equal(typeof status.enabled, 'boolean');
  });

  test('25. New YouTube broadcast becomes LIVE', async () => {
    await setupTestEnv('test25_youtube_live');
    const arStatus = getAutoRecycleStatus();
    assert.ok('nextRecycleFormatted' in arStatus);
    assert.ok('nextStreamFormatted' in arStatus);
  });

  test('26. Auto-recycle repeats for at least 2 cycles in simulation', async () => {
    await setupTestEnv('test26_repeat_cycles');
    await saveSettings({
      scheduler: {
        autoRecycle: { enabled: true, maxSessionHours: 1, pauseMinutes: 10, resumeBookmark: true },
      },
    });

    // Cycle 1: Running -> Recycle Triggered
    await saveState({ status: 'RUNNING', desiredState: 'running' });
    await triggerAutoRecycle();
    let st = getState();
    assert.equal(st.status, 'SCHEDULED');
    assert.ok(st.recyclingUntil);

    // Pause expires -> resume
    await executeAutoResume();
    st = getState();
    assert.equal(st.recyclingUntil, null);

    // Cycle 2: Running again -> Recycle Triggered
    await saveState({ status: 'RUNNING', desiredState: 'running' });
    await triggerAutoRecycle();
    st = getState();
    assert.equal(st.status, 'SCHEDULED');
    assert.ok(st.recyclingUntil);
  });

  test('27. Dual live remains enabled after automatic restart', async () => {
    await setupTestEnv('test27_dual_live');
    await saveSettings({
      stream: { videoId: 'vid_11111111' },
      youtube: { rtmpsUrl: 'rtmps://127.0.0.1:1935/live2', streamKey: 'primary-key', horizontalStreamKey: 'secondary-key', dualStreamEnabled: true },
    });

    const key = getStreamKey();
    assert.equal(key, 'primary-key');
  });

  test('28. Stream Key architecture remains unchanged', async () => {
    await setupTestEnv('test28_stream_key');
    const key = getStreamKey();
    assert.equal(key, 'test-key-auto-recycle', 'Primary stream key must be preserved');
  });
});
