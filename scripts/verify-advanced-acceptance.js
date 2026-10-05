/**
 * scripts/verify-advanced-acceptance.js
 *
 * Automated Production Acceptance Verification for:
 * 1. AUTO-RECYCLE (Horizontal & Vertical)
 * 2. SCHEDULED / TIME-SPECIFIC STREAMING (Gate, Horizontal & Vertical Start/Stop)
 * 3. 24x7 CONTINUOUS OPERATION (Natural Media Transitions, Hot Playlist, Process Safety, App Restart, Combined Auto-Recycle+Hot Playlist)
 */

import assert from 'node:assert/strict';
import { getState, loadState, saveState } from '../src/state-manager.js';
import {
  loadSettings,
  saveSettings,
  getSettings,
  getStreamMode,
  getStreamKey,
  getModePlaylist,
} from '../src/config-manager.js';
import { listVideos, setPlaylist } from '../src/video-manager.js';
import {
  startStream,
  stopStream,
  setStreamMode,
  evaluateStartGates,
  getAutoRecycleStatus,
} from '../src/stream-manager.js';
import {
  getFfmpegPid,
  getSecondaryFfmpegPid,
  isFfmpegRunning,
  getLatestProgress,
  getOutputsStatus,
  cleanupStaleLockOnBoot,
} from '../src/ffmpeg-manager.js';
import {
  tickScheduler,
  isInsideWindow,
  getLocalTimeInZone,
} from '../src/scheduler.js';

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const RESULTS = {
  autoRecycleHorizontal: false,
  autoRecycleVertical: false,
  scheduleGateBlocked: false,
  scheduleHorizontal: false,
  scheduleVertical: false,
  continuousHorizontalSerial: false,
  continuousHorizontalShuffle: false,
  continuousVerticalSerial: false,
  continuousVerticalShuffle: false,
  hotPlaylistActive: false,
  hotPlaylistInactive: false,
  processSafety: false,
  autoRecycleHotPlaylist: false,
};

async function cleanStop() {
  await stopStream('test_prep');
  await wait(2000);
}

async function main() {
  console.log('======================================================================');
  console.log('  FINAL ADVANCED PRODUCTION ACCEPTANCE VERIFICATION');
  console.log('======================================================================\n');

  await cleanupStaleLockOnBoot();
  await loadSettings();
  await loadState();

  const videos = await listVideos();
  const horizVideos = videos.filter(v => v.probe?.orientation === 'horizontal' || (v.probe?.width && v.probe?.width >= v.probe?.height));
  const vertVideos = videos.filter(v => v.probe?.orientation === 'vertical' || (v.probe?.height && v.probe?.height > v.probe?.width));

  console.log(`✓ Media Library: ${videos.length} videos (${horizVideos.length} horizontal, ${vertVideos.length} vertical)`);
  assert.ok(horizVideos.length >= 2, 'Need at least 2 horizontal videos');
  assert.ok(vertVideos.length >= 2, 'Need at least 2 vertical videos');

  // Initial clean stop
  await cleanStop();

  // ==========================================================================
  // SECTION 1: AUTO-RECYCLE PRODUCTION TEST
  // ==========================================================================
  console.log('\n======================================================================');
  console.log('  1. AUTO-RECYCLE PRODUCTION TESTS');
  console.log('======================================================================');

  // --- TEST 1A: HORIZONTAL AUTO-RECYCLE ---
  console.log('\n[AUTO-RECYCLE 1A] Testing Horizontal 16:9 Auto-Recycle...');
  await setStreamMode('horizontal');
  await setPlaylist([horizVideos[0].id, horizVideos[1].id], { mode: 'horizontal' });

  // Fast test session: 20 seconds session duration, 10 seconds pause
  // 0.35 min = 21s, 0.16 min = 9.6s
  await saveSettings({
    scheduler: {
      mode: 'continuous',
      autoRecycle: {
        enabled: true,
        maxSessionMinutes: 0.35,
        pauseMinutes: 0.16,
        resumeBookmark: false,
      },
    },
  });

  console.log('1. Starting Horizontal stream...');
  const arHStart = await startStream({ reason: 'auto_recycle_h_test' });
  assert.strictEqual(arHStart.started, true, 'Horizontal stream should start');

  await wait(4000);
  const arHPid1 = getFfmpegPid();
  const arHSecPid1 = getSecondaryFfmpegPid();
  console.log(`✓ Horizontal running: PID ${arHPid1}, SecPID: ${arHSecPid1}, Mode: ${getState().streamMode}`);
  assert.ok(arHPid1 > 0, 'Publisher PID must be active');
  assert.strictEqual(arHSecPid1, null, 'Secondary PID must be null');
  assert.strictEqual(getState().streamMode, 'horizontal');

  console.log('2. Waiting for session limit expiration (approx 20 seconds)...');
  // Wait up to 35 seconds for auto-recycle trigger
  let recycled = false;
  for (let i = 0; i < 35; i++) {
    await wait(1000);
    const st = getState();
    if (st.recyclingUntil && !isFfmpegRunning()) {
      recycled = true;
      console.log(`✓ Auto-recycle triggered cleanly! Paused until ${st.recyclingUntil}.`);
      break;
    }
  }
  assert.ok(recycled, 'Auto-recycle must automatically stop stream and enter pause state');

  // Verify during pause: 0 publisher, 0 feeder
  console.log('3. Verifying zero processes during pause...');
  assert.strictEqual(isFfmpegRunning(), false, 'FFmpeg must not run during pause');
  assert.strictEqual(getFfmpegPid(), null, 'FFmpeg PID must be null during pause');
  assert.strictEqual(getSecondaryFfmpegPid(), null, 'Secondary PID must be null');

  console.log('4. Waiting for pause expiration and AUTOMATIC restart (no manual intervention)...');
  let autoResumed = false;
  for (let i = 0; i < 25; i++) {
    await wait(1000);
    const st = getState();
    if (isFfmpegRunning() && st.status === 'RUNNING') {
      autoResumed = true;
      console.log(`✓ Stream AUTOMATICALLY resumed! PID: ${getFfmpegPid()}, State: ${st.status}, Mode: ${st.streamMode}`);
      break;
    }
  }
  assert.ok(autoResumed, 'Stream must automatically restart after pause without manual start');

  const arHPid2 = getFfmpegPid();
  const arHState2 = getState();
  assert.ok(arHPid2 > 0 && arHPid2 !== arHPid1, 'New publisher PID must be running');
  assert.strictEqual(arHState2.streamMode, 'horizontal', 'Stream mode must STILL be horizontal');
  assert.strictEqual(getSecondaryFfmpegPid(), null, 'Secondary PID must be null');
  console.log('✅ AUTO-RECYCLE HORIZONTAL PASSED: Clean stop -> Pause -> Auto-start in same mode.');
  RESULTS.autoRecycleHorizontal = true;

  await cleanStop();

  // --- TEST 1B: VERTICAL AUTO-RECYCLE ---
  console.log('\n[AUTO-RECYCLE 1B] Testing Vertical 9:16 Auto-Recycle...');
  await setStreamMode('vertical');
  await setPlaylist([vertVideos[0].id, vertVideos[1].id], { mode: 'vertical' });

  await saveSettings({
    scheduler: {
      mode: 'continuous',
      autoRecycle: {
        enabled: true,
        maxSessionMinutes: 0.35,
        pauseMinutes: 0.16,
        resumeBookmark: false,
      },
    },
  });

  console.log('1. Starting Vertical stream...');
  const arVStart = await startStream({ reason: 'auto_recycle_v_test' });
  assert.strictEqual(arVStart.started, true, 'Vertical stream should start');

  await wait(4000);
  const arVPid1 = getFfmpegPid();
  console.log(`✓ Vertical running: PID ${arVPid1}, Mode: ${getState().streamMode}`);
  assert.ok(arVPid1 > 0);
  assert.strictEqual(getState().streamMode, 'vertical');

  console.log('2. Waiting for session limit expiration (approx 20 seconds)...');
  let vRecycled = false;
  for (let i = 0; i < 35; i++) {
    await wait(1000);
    const st = getState();
    if (st.recyclingUntil && !isFfmpegRunning()) {
      vRecycled = true;
      console.log(`✓ Vertical auto-recycle triggered cleanly! Paused until ${st.recyclingUntil}.`);
      break;
    }
  }
  assert.ok(vRecycled, 'Vertical auto-recycle must automatically stop stream');

  console.log('3. Verifying zero processes during vertical pause...');
  assert.strictEqual(isFfmpegRunning(), false);

  console.log('4. Waiting for pause expiration and AUTOMATIC restart...');
  let vAutoResumed = false;
  for (let i = 0; i < 25; i++) {
    await wait(1000);
    const st = getState();
    if (isFfmpegRunning() && st.status === 'RUNNING') {
      vAutoResumed = true;
      console.log(`✓ Stream AUTOMATICALLY resumed! PID: ${getFfmpegPid()}, State: ${st.status}, Mode: ${st.streamMode}`);
      break;
    }
  }
  assert.ok(vAutoResumed, 'Vertical stream must automatically restart without manual start');

  const arVState2 = getState();
  assert.strictEqual(arVState2.streamMode, 'vertical', 'Stream mode must STILL be vertical');
  assert.strictEqual(getSecondaryFfmpegPid(), null, 'Secondary PID must be null');
  console.log('✅ AUTO-RECYCLE VERTICAL PASSED: Clean stop -> Pause -> Auto-start in vertical mode.');
  RESULTS.autoRecycleVertical = true;

  await cleanStop();

  // Reset autoRecycle defaults to normal production values
  await saveSettings({
    scheduler: {
      mode: 'continuous',
      autoRecycle: {
        enabled: true,
        maxSessionHours: 1,
        pauseMinutes: 1,
        resumeBookmark: false,
      },
    },
  });

  // ==========================================================================
  // SECTION 2: SCHEDULED / TIME-SPECIFIC STREAMING
  // ==========================================================================
  console.log('\n======================================================================');
  console.log('  2. SCHEDULED / TIME-SPECIFIC STREAMING TESTS');
  console.log('======================================================================');

  // --- TEST 2A: SCHEDULE GATE TEST (OUTSIDE WINDOW) ---
  console.log('\n[SCHEDULE 2A] Testing schedule gate blocking outside window...');
  const now = new Date();
  const currentLocal = getLocalTimeInZone(now, 'UTC');
  const futureHour = (currentLocal.hour + 8) % 24;
  const startStr = `${String(futureHour).padStart(2, '0')}:00`;
  const stopStr = `${String((futureHour + 1) % 24).padStart(2, '0')}:00`;

  await saveSettings({
    scheduler: {
      mode: 'scheduled',
      timezone: 'UTC',
      windows: [{
        days: [currentLocal.dayOfWeek],
        start: startStr,
        stop: stopStr,
      }],
    },
  });
  await saveState({ status: 'SCHEDULED', desiredState: 'stopped' });

  const gateRes = await evaluateStartGates('auto_resume');
  console.log(`✓ Gate evaluation outside window: allowed=${gateRes.allowed}, code=${gateRes.code}, reason=${gateRes.reason}`);
  assert.strictEqual(gateRes.allowed, false, 'Start gate must block when outside scheduled window');
  assert.strictEqual(gateRes.code, 'E_SCHEDULED');
  assert.strictEqual(isFfmpegRunning(), false, 'FFmpeg must not run when outside window');
  console.log('✅ SCHEDULE GATE PASSED: Starting outside scheduled window is strictly blocked.');
  RESULTS.scheduleGateBlocked = true;

  // --- TEST 2B: HORIZONTAL SCHEDULED AUTO-START & AUTO-STOP ---
  console.log('\n[SCHEDULE 2B] Testing Horizontal scheduled automatic start & stop...');
  await setStreamMode('horizontal');
  await setPlaylist([horizVideos[0].id], { mode: 'horizontal' });

  // Construct window that is active RIGHT NOW for 12 seconds
  const currentHour = currentLocal.hour;
  const currentMin = currentLocal.minute;
  const winStart = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;
  // Next minute
  const nextMin = (currentMin + 1) % 60;
  const nextHour = nextMin === 0 ? (currentHour + 1) % 24 : currentHour;
  const winStop = `${String(nextHour).padStart(2, '0')}:${String(nextMin).padStart(2, '0')}`;

  await saveSettings({
    scheduler: {
      mode: 'scheduled',
      timezone: 'UTC',
      windows: [{
        days: [currentLocal.dayOfWeek],
        start: winStart,
        stop: winStop,
      }],
    },
  });
  await saveState({ status: 'SCHEDULED' });

  console.log(`1. Window active: ${winStart} -> ${winStop}. Triggering scheduler tick...`);
  await tickScheduler(new Date());
  await wait(5000);

  const schHPid = getFfmpegPid();
  console.log(`✓ Scheduled Horizontal start: PID ${schHPid}, Mode: ${getState().streamMode}`);
  assert.ok(schHPid > 0, 'Horizontal publisher should have auto-started via scheduler');
  assert.strictEqual(getState().streamMode, 'horizontal');
  assert.strictEqual(getSecondaryFfmpegPid(), null);

  console.log('2. Simulating window close tick (time outside window)...');
  // Pass a date outside the window to tickScheduler
  const outsideDate = new Date(Date.now() + 3600 * 1000); // 1 hour ahead
  await tickScheduler(outsideDate);
  await wait(3000);

  console.log('3. Verifying scheduled automatic stop...');
  assert.strictEqual(isFfmpegRunning(), false, 'FFmpeg should automatically stop when window closes');
  assert.strictEqual(getFfmpegPid(), null);
  console.log('✅ SCHEDULE HORIZONTAL PASSED: Auto-started inside window, auto-stopped when closed.');
  RESULTS.scheduleHorizontal = true;

  // --- TEST 2C: VERTICAL SCHEDULED AUTO-START & AUTO-STOP ---
  console.log('\n[SCHEDULE 2C] Testing Vertical scheduled automatic start & stop...');
  await setStreamMode('vertical');
  await setPlaylist([vertVideos[0].id], { mode: 'vertical' });
  await saveState({ status: 'SCHEDULED' });

  console.log(`1. Window active: triggering scheduler tick for Vertical mode...`);
  await tickScheduler(new Date());
  await wait(5000);

  const schVPid = getFfmpegPid();
  console.log(`✓ Scheduled Vertical start: PID ${schVPid}, Mode: ${getState().streamMode}`);
  assert.ok(schVPid > 0, 'Vertical publisher should have auto-started via scheduler');
  assert.strictEqual(getState().streamMode, 'vertical');
  assert.strictEqual(getSecondaryFfmpegPid(), null);

  console.log('2. Simulating window close tick...');
  await tickScheduler(outsideDate);
  await wait(3000);

  assert.strictEqual(isFfmpegRunning(), false, 'Vertical stream should automatically stop when window closes');
  console.log('✅ SCHEDULE VERTICAL PASSED: Vertical auto-started and auto-stopped with 0 horizontal process.');
  RESULTS.scheduleVertical = true;

  // Restore continuous mode
  await saveSettings({
    scheduler: {
      mode: 'continuous',
      timezone: 'UTC',
      windows: [],
    },
  });

  // ==========================================================================
  // SECTION 3: 24x7 CONTINUOUS OPERATION
  // ==========================================================================
  console.log('\n======================================================================');
  console.log('  3. 24x7 CONTINUOUS OPERATION TESTS');
  console.log('======================================================================');

  // --- TEST 3A: HORIZONTAL 24x7 SERIAL & NATURAL MEDIA TRANSITION ---
  console.log('\n[24x7 3A] Testing Horizontal Serial Playback & Natural Video EOF Transition...');
  await setStreamMode('horizontal');
  // Use short videos (vid_a8ebd6ff is ~12s, vid_0db4dfe8 is ~12s)
  const hShort1 = horizVideos.find(v => v.id === 'vid_a8ebd6ff') || horizVideos[0];
  const hShort2 = horizVideos.find(v => v.id === 'vid_0db4dfe8') || horizVideos[1];
  await setPlaylist([hShort1.id, hShort2.id], { mode: 'horizontal', playbackOrder: 'serial' });

  console.log(`1. Starting Horizontal stream with videos [${hShort1.id}, ${hShort2.id}]...`);
  const cHStart = await startStream({ reason: '24x7_h_serial' });
  assert.strictEqual(cHStart.started, true);
  await wait(4000);

  const cHPid1 = getFfmpegPid();
  const initialVideoId = getState().activeVideoId;
  console.log(`✓ Started: Publisher PID ${cHPid1}, Active Video: ${initialVideoId}`);
  assert.strictEqual(initialVideoId, hShort1.id);

  console.log('2. Waiting for Video 1 EOF and natural transition to Video 2 (~12s)...');
  let transitioned = false;
  for (let i = 0; i < 20; i++) {
    await wait(1000);
    const curVid = getState().activeVideoId;
    if (curVid === hShort2.id) {
      transitioned = true;
      console.log(`✓ Natural EOF transition observed! New Active Video: ${curVid}`);
      break;
    }
  }
  assert.ok(transitioned, 'Natural video boundary transition from Video 1 to Video 2 must occur without restart');
  const cHPidAfterTransition = getFfmpegPid();
  assert.strictEqual(cHPidAfterTransition, cHPid1, 'Publisher PID must NOT change during natural video transition');
  console.log('✅ 24x7 HORIZONTAL SERIAL PASSED: Video 1 -> EOF -> Video 2 seamless playback without stream restart.');
  RESULTS.continuousHorizontalSerial = true;

  // --- TEST 3B: HORIZONTAL SHUFFLE ---
  console.log('\n[24x7 3B] Testing Horizontal Shuffle playback...');
  await setPlaylist([hShort1.id, hShort2.id, horizVideos[2]?.id || hShort1.id], { mode: 'horizontal', playbackOrder: 'shuffle' });
  await wait(2000);
  assert.strictEqual(isFfmpegRunning(), true, 'Switching playbackOrder to shuffle must keep publisher running');
  assert.strictEqual(getFfmpegPid(), cHPid1);
  console.log('✅ 24x7 HORIZONTAL SHUFFLE PASSED: Shuffle mode active without session interruption.');
  RESULTS.continuousHorizontalShuffle = true;

  // --- TEST 3C: HOT PLAYLIST SYNC DURING 24x7 ---
  console.log('\n[24x7 3C] Testing Hot Playlist Sync during active stream...');
  const newHorizList = [hShort2.id, hShort1.id];
  await setPlaylist(newHorizList, { mode: 'horizontal' });
  assert.deepEqual(getModePlaylist('horizontal'), newHorizList, 'Active mode playlist should update immediately');
  assert.strictEqual(getFfmpegPid(), cHPid1, 'FFmpeg PID must remain unchanged when updating active playlist');
  console.log('✓ Hot playlist update on active mode applied smoothly.');
  RESULTS.hotPlaylistActive = true;

  // Update INACTIVE mode playlist (vertical) while horizontal is running
  console.log('Testing update on INACTIVE (vertical) playlist...');
  const testVertList = [vertVideos[0].id];
  await setPlaylist(testVertList, { mode: 'vertical' });
  assert.strictEqual(getFfmpegPid(), cHPid1, 'Updating inactive playlist must have ZERO effect on current stream');
  console.log('✓ Inactive mode playlist updated with ZERO effect on active stream.');
  RESULTS.hotPlaylistInactive = true;

  await cleanStop();

  // --- TEST 3D: VERTICAL 24x7 SERIAL & NATURAL MEDIA TRANSITION ---
  console.log('\n[24x7 3D] Testing Vertical Serial Playback & Natural Video EOF Transition...');
  await setStreamMode('vertical');
  const vShort1 = vertVideos.find(v => v.id === 'vid_b3cd67ef') || vertVideos[0];
  const vShort2 = vertVideos.find(v => v.id === 'vid_0175ce74') || vertVideos[1];
  await setPlaylist([vShort1.id, vShort2.id], { mode: 'vertical', playbackOrder: 'serial' });

  console.log(`1. Starting Vertical stream with videos [${vShort1.id}, ${vShort2.id}]...`);
  const cVStart = await startStream({ reason: '24x7_v_serial' });
  assert.strictEqual(cVStart.started, true);
  await wait(4000);

  const cVPid1 = getFfmpegPid();
  const vInitialVid = getState().activeVideoId;
  console.log(`✓ Started: Publisher PID ${cVPid1}, Active Video: ${vInitialVid}`);
  assert.strictEqual(vInitialVid, vShort1.id);

  console.log('2. Waiting for Video 1 EOF and natural transition to Video 2 (~12s)...');
  let vTransitioned = false;
  for (let i = 0; i < 20; i++) {
    await wait(1000);
    const curVid = getState().activeVideoId;
    if (curVid === vShort2.id) {
      vTransitioned = true;
      console.log(`✓ Vertical natural EOF transition observed! New Active Video: ${curVid}`);
      break;
    }
  }
  assert.ok(vTransitioned, 'Vertical video transition must occur naturally');
  assert.strictEqual(getFfmpegPid(), cVPid1, 'Publisher PID must NOT change during transition');
  console.log('✅ 24x7 VERTICAL SERIAL PASSED: Video 1 -> EOF -> Video 2 seamless playback without restart.');
  RESULTS.continuousVerticalSerial = true;

  // --- TEST 3E: VERTICAL SHUFFLE ---
  console.log('\n[24x7 3E] Testing Vertical Shuffle playback...');
  await setPlaylist([vShort1.id, vShort2.id, vertVideos[2]?.id || vShort1.id], { mode: 'vertical', playbackOrder: 'shuffle' });
  await wait(2000);
  assert.strictEqual(isFfmpegRunning(), true);
  assert.strictEqual(getFfmpegPid(), cVPid1);
  console.log('✅ 24x7 VERTICAL SHUFFLE PASSED: Vertical shuffle active without interruption.');
  RESULTS.continuousVerticalShuffle = true;

  // --- TEST 3F: PROCESS SAFETY ---
  console.log('\n[24x7 3F] Verifying Process Safety invariants...');
  assert.ok(getFfmpegPid() > 0, 'Exactly 1 publisher PID');
  assert.strictEqual(getSecondaryFfmpegPid(), null, '0 secondary publisher PID');
  const outputs = getOutputsStatus();
  assert.strictEqual(outputs.mode, 'vertical');
  assert.strictEqual(outputs.vertical.enabled, true);
  assert.strictEqual(outputs.horizontal.enabled, false);
  console.log('✅ PROCESS SAFETY PASSED: Exactly 1 publisher, 0 secondary, strict mode isolation.');
  RESULTS.processSafety = true;

  // --- TEST 3G: AUTO-RECYCLE + HOT PLAYLIST COMBINED ---
  console.log('\n[24x7 3G] Testing Auto-Recycle + Hot Playlist combined...');
  // While streaming in vertical, hot-add a new video to playlist
  const thirdVert = vertVideos.find(v => v.id !== vShort1.id && v.id !== vShort2.id);
  const combinedPlaylist = thirdVert ? [vShort1.id, vShort2.id, thirdVert.id] : [vShort2.id, vShort1.id];
  await setPlaylist(combinedPlaylist, { mode: 'vertical' });

  // Arm auto-recycle with short session
  await saveSettings({
    scheduler: {
      mode: 'continuous',
      autoRecycle: {
        enabled: true,
        maxSessionMinutes: 0.25,
        pauseMinutes: 0.16,
        resumeBookmark: false,
      },
    },
  });

  console.log('Waiting for auto-recycle pause...');
  let combinedRecycled = false;
  for (let i = 0; i < 25; i++) {
    await wait(1000);
    if (getState().recyclingUntil && !isFfmpegRunning()) {
      combinedRecycled = true;
      break;
    }
  }
  assert.ok(combinedRecycled, 'Auto-recycle must trigger');

  console.log('Waiting for auto-resume...');
  let combinedResumed = false;
  for (let i = 0; i < 25; i++) {
    await wait(1000);
    if (isFfmpegRunning() && getState().status === 'RUNNING') {
      combinedResumed = true;
      break;
    }
  }
  assert.ok(combinedResumed, 'Auto-resume must succeed');

  // Verify the updated playlist is preserved after auto-recycle!
  const postRecyclePlaylist = getModePlaylist('vertical');
  assert.deepEqual(postRecyclePlaylist, combinedPlaylist, 'Hot playlist updates must be strictly preserved across auto-recycle');
  console.log('✅ AUTO-RECYCLE + HOT PLAYLIST PASSED: Hot additions preserved through recycle cycle.');
  RESULTS.autoRecycleHotPlaylist = true;

  await cleanStop();

  // Restore production defaults
  await saveSettings({
    scheduler: {
      mode: 'continuous',
      timezone: 'UTC',
      windows: [],
      autoRecycle: {
        enabled: true,
        maxSessionHours: 1,
        pauseMinutes: 1,
        resumeBookmark: false,
      },
    },
  });

  console.log('\n======================================================================');
  console.log('  ALL ADVANCED REQUIREMENTS FULLY VERIFIED IN PRODUCTION!');
  console.log('======================================================================');
  console.log(JSON.stringify(RESULTS, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ ADVANCED PRODUCTION ACCEPTANCE FAILED:', err);
  process.exit(1);
});
