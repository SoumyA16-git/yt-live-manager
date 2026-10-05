/**
 * scripts/verify-single-stream-prod.js
 *
 * Production Acceptance Test for Single Stream Mode Architecture.
 * Strictly verifies:
 * 1. Horizontal 16:9 mode (1 publisher, horizontal key, 16:9 video, 0 secondary).
 * 2. Mode switch lock while running (409 / E_STREAM_RUNNING).
 * 3. Clean stop and transition to Vertical 9:16 mode.
 * 4. Vertical 9:16 mode (1 publisher, vertical key, 9:16 video, 0 secondary).
 * 5. Playlist independence per mode & orientation enforcement.
 */

import assert from 'node:assert/strict';
import { getState, loadState } from '../src/state-manager.js';
import { loadSettings, saveSettings, getSettings, getStreamMode, getModePlaylist } from '../src/config-manager.js';
import { listVideos, setPlaylist } from '../src/video-manager.js';
import {
  startStream,
  stopStream,
  setStreamMode,
  evaluateStartGates,
} from '../src/stream-manager.js';
import {
  getFfmpegPid,
  getSecondaryFfmpegPid,
  isFfmpegRunning,
  getLatestProgress,
  getOutputsStatus,
  cleanupStaleLockOnBoot,
} from '../src/ffmpeg-manager.js';

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('======================================================================');
  console.log('  SINGLE STREAM MODE — LIVE PRODUCTION ACCEPTANCE TEST');
  console.log('======================================================================\n');

  await cleanupStaleLockOnBoot();
  await loadSettings();
  await loadState();

  const videos = await listVideos();
  const horizVideos = videos.filter(v => v.probe?.orientation === 'horizontal' || (v.probe?.width && v.probe?.width >= v.probe?.height));
  const vertVideos = videos.filter(v => v.probe?.orientation === 'vertical' || (v.probe?.height && v.probe?.height > v.probe?.width));

  console.log(`✓ Library loaded: ${videos.length} videos (${horizVideos.length} horizontal, ${vertVideos.length} vertical)`);
  assert.ok(horizVideos.length > 0, 'Must have at least one horizontal video');
  assert.ok(vertVideos.length > 0, 'Must have at least one vertical video');

  // Ensure initial clean state
  console.log('Stopping any previous stream to ensure clean start...');
  await stopStream('test_prep');
  await wait(2000);

  // --------------------------------------------------------------------------
  // TEST 1: HORIZONTAL 16:9 MODE
  // --------------------------------------------------------------------------
  console.log('\n[TEST 1] Setting Mode to HORIZONTAL 16:9...');
  await setStreamMode('horizontal');
  assert.strictEqual(getStreamMode(), 'horizontal', 'Stream mode must be horizontal');

  // Set horizontal playlist
  const horizIds = horizVideos.map(v => v.id);
  await setPlaylist(horizIds, { mode: 'horizontal' });
  console.log(`✓ Horizontal playlist configured with: ${horizIds.join(', ')}`);

  console.log('Starting HORIZONTAL stream...');
  const startHRes = await startStream({ reason: 'prod_test_horizontal' });
  assert.strictEqual(startHRes.started, true, `Horizontal stream start failed: ${JSON.stringify(startHRes)}`);

  console.log('Waiting 6 seconds for encoder stabilization...');
  await wait(6000);

  const hPid = getFfmpegPid();
  const hSecPid = getSecondaryFfmpegPid();
  const hState = getState();
  const hProgress = getLatestProgress();
  const hOutputs = getOutputsStatus();

  console.log('--- Horizontal Stream Verification ---');
  console.log(`  Publisher PID: ${hPid} (alive: ${isFfmpegRunning()})`);
  console.log(`  Secondary PID: ${hSecPid} (MUST BE NULL)`);
  console.log(`  Stream Mode in State: ${hState.streamMode}`);
  console.log(`  Is Dual Stream: ${hState.isDualStream}`);
  console.log(`  Active Video ID: ${hState.activeVideoId}`);
  console.log(`  Encoding Speed: ${hProgress?.speedStr || 'N/A'}, FPS: ${hProgress?.fps || 'N/A'}`);
  console.log(`  Outputs: ${JSON.stringify(hOutputs)}`);

  assert.ok(hPid !== null && hPid > 0, 'Horizontal publisher PID must be running');
  assert.strictEqual(hSecPid, null, 'Secondary PID must be strictly null (zero dual stream)');
  assert.strictEqual(hState.streamMode, 'horizontal', 'State streamMode must be horizontal');
  assert.strictEqual(hState.isDualStream, false, 'isDualStream must be false');
  assert.strictEqual(hOutputs.mode, 'horizontal', 'Outputs mode must be horizontal');
  assert.strictEqual(hOutputs.horizontal.enabled, true, 'Horizontal output must be enabled');
  assert.strictEqual(hOutputs.vertical.enabled, false, 'Vertical output must be disabled');

  const activeHVideo = videos.find(v => v.id === hState.activeVideoId);
  console.log(`  Active video: ${activeHVideo.filename} (${activeHVideo.probe?.width}x${activeHVideo.probe?.height})`);
  assert.ok(activeHVideo.probe?.width >= activeHVideo.probe?.height, 'Active video must be 16:9 horizontal');
  console.log('✅ TEST 1 PASSED: Horizontal 16:9 streaming exclusively with 1 publisher.');

  // --------------------------------------------------------------------------
  // TEST 2: MODE SWITCH LOCK WHILE LIVE
  // --------------------------------------------------------------------------
  console.log('\n[TEST 2] Testing mode switch rejection while streaming...');
  try {
    await setStreamMode('vertical');
    assert.fail('Switching mode while streaming should have thrown E_STREAM_RUNNING');
  } catch (err) {
    console.log(`✓ Caught expected error: [${err.code}] ${err.message}`);
    assert.strictEqual(err.code, 'E_STREAM_RUNNING');
  }
  console.log('✅ TEST 2 PASSED: Mode switch locked while stream is active.');

  // --------------------------------------------------------------------------
  // TEST 3: CLEAN STOP
  // --------------------------------------------------------------------------
  console.log('\n[TEST 3] Stopping Horizontal stream cleanly...');
  const stopHRes = await stopStream('prod_test_switch');
  assert.strictEqual(stopHRes.stopped, true, 'Stop stream should succeed');
  await wait(3000);
  assert.strictEqual(isFfmpegRunning(), false, 'FFmpeg must be stopped');
  console.log('✅ TEST 3 PASSED: Clean stop successful.');

  // --------------------------------------------------------------------------
  // TEST 4: VERTICAL 9:16 MODE
  // --------------------------------------------------------------------------
  console.log('\n[TEST 4] Switching Mode to VERTICAL 9:16...');
  await setStreamMode('vertical');
  assert.strictEqual(getStreamMode(), 'vertical', 'Stream mode must be vertical');

  // Set vertical playlist
  const vertIds = vertVideos.map(v => v.id);
  await setPlaylist(vertIds, { mode: 'vertical' });
  console.log(`✓ Vertical playlist configured with: ${vertIds.join(', ')}`);

  console.log('Starting VERTICAL stream...');
  const startVRes = await startStream({ reason: 'prod_test_vertical' });
  assert.strictEqual(startVRes.started, true, `Vertical stream start failed: ${JSON.stringify(startVRes)}`);

  console.log('Waiting 6 seconds for encoder stabilization...');
  await wait(6000);

  const vPid = getFfmpegPid();
  const vSecPid = getSecondaryFfmpegPid();
  const vState = getState();
  const vProgress = getLatestProgress();
  const vOutputs = getOutputsStatus();

  console.log('--- Vertical Stream Verification ---');
  console.log(`  Publisher PID: ${vPid} (alive: ${isFfmpegRunning()})`);
  console.log(`  Secondary PID: ${vSecPid} (MUST BE NULL)`);
  console.log(`  Stream Mode in State: ${vState.streamMode}`);
  console.log(`  Is Dual Stream: ${vState.isDualStream}`);
  console.log(`  Active Video ID: ${vState.activeVideoId}`);
  console.log(`  Encoding Speed: ${vProgress?.speedStr || 'N/A'}, FPS: ${vProgress?.fps || 'N/A'}`);
  console.log(`  Outputs: ${JSON.stringify(vOutputs)}`);

  assert.ok(vPid !== null && vPid > 0, 'Vertical publisher PID must be running');
  assert.strictEqual(vSecPid, null, 'Secondary PID must be strictly null (zero dual stream)');
  assert.strictEqual(vState.streamMode, 'vertical', 'State streamMode must be vertical');
  assert.strictEqual(vState.isDualStream, false, 'isDualStream must be false');
  assert.strictEqual(vOutputs.mode, 'vertical', 'Outputs mode must be vertical');
  assert.strictEqual(vOutputs.vertical.enabled, true, 'Vertical output must be enabled');
  assert.strictEqual(vOutputs.horizontal.enabled, false, 'Horizontal output must be disabled');

  const activeVVideo = videos.find(v => v.id === vState.activeVideoId);
  console.log(`  Active video: ${activeVVideo.filename} (${activeVVideo.probe?.width}x${activeVVideo.probe?.height})`);
  assert.ok(activeVVideo.probe?.height >= activeVVideo.probe?.width, 'Active video must be 9:16 vertical');
  console.log('✅ TEST 4 PASSED: Vertical 9:16 streaming exclusively with 1 publisher.');

  // --------------------------------------------------------------------------
  // TEST 5: HOT PLAYLIST SYNC ON ACTIVE MODE
  // --------------------------------------------------------------------------
  console.log('\n[TEST 5] Hot Playlist Sync on Active Mode...');
  const newVertPlaylist = [vertVideos[0].id];
  await setPlaylist(newVertPlaylist, { mode: 'vertical' });
  const activeModePlaylist = getModePlaylist('vertical');
  assert.deepEqual(activeModePlaylist, newVertPlaylist, 'Vertical playlist should update immediately');
  assert.strictEqual(isFfmpegRunning(), true, 'Hot playlist update must NOT restart or kill running stream');
  console.log('✅ TEST 5 PASSED: Hot playlist update applied smoothly without stream interruption.');

  console.log('\n======================================================================');
  console.log('  ALL ACCEPTANCE CRITERIA VERIFIED SUCCESSFULLY IN PRODUCTION!');
  console.log('======================================================================');
}

run().catch(err => {
  console.error('\n❌ ACCEPTANCE TEST FAILED:', err);
  process.exit(1);
});
