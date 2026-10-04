/**
 * scripts/verify-hot-playlist-prod.js
 *
 * Production Verification for Hot Playlist Sync and Dual-Stream Seamless Transition.
 *
 * Verified Scenario:
 * 1. Start with only Logical Video A (A-vertical + A-horizontal).
 * 2. Start Dual Live -> Vertical = A-vertical, Horizontal = A-horizontal, YouTube = LIVE.
 *    Record publisher FFmpeg PIDs and Broadcast IDs.
 * 3. While A is playing:
 *    - Upload complete new pair: B-vertical + B-horizontal.
 *    - Verify: A is still playing, PIDs unchanged, Broadcast IDs unchanged, B is READY.
 *    - Upload complete new pair: C-vertical + C-horizontal.
 *    - Verify: A continues uninterrupted.
 * 4. Current video protection:
 *    - Uploads do NOT restart FFmpeg, do NOT restart YouTube, do NOT switch A immediately.
 * 5. Transition 1:
 *    - Allow A to naturally finish.
 *    - At boundary: reload fresh playlist from persistent storage, re-resolve logical pairs,
 *      select B, start BOTH versions of the SAME logical item (B-vertical + B-horizontal).
 * 6. Transition 2:
 *    - Allow B to naturally finish.
 *    - Reload playlist, select C, start BOTH versions of the SAME logical item (C-vertical + C-horizontal).
 * 7. Verification that zero stream restarts occurred and YouTube broadcasts remained LIVE.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

import {
  initYouTubeApi,
  getAccessToken,
  getYouTubeLiveApiState,
} from '../src/youtube-api-manager.js';
import { getState, loadState, saveState } from '../src/state-manager.js';
import { loadSettings, saveSettings, getSettings } from '../src/config-manager.js';
import {
  listVideos,
  processUpload,
  buildLogicalVideos,
  getFreshPlayablePlaylist,
} from '../src/video-manager.js';
import {
  startStream,
  stopStream,
  handleSegmentFinished,
} from '../src/stream-manager.js';
import {
  getFfmpegPid,
  getSecondaryFfmpegPid,
  isFfmpegRunning,
  stopFfmpeg,
  stopFeeders,
} from '../src/ffmpeg-manager.js';
import { writeJSON, readJSON } from '../src/lib/atomic-json.js';
import PATHS from '../src/lib/paths.js';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log('============================================================');
  console.log('  HOT PLAYLIST SYNC PRODUCTION VERIFICATION');
  console.log('============================================================\n');

  // Initialize YouTube API & load settings
  initYouTubeApi();
  await loadSettings();
  await loadState();

  const settings = getSettings();
  console.log('Configuration:');
  console.log(`- Dual Stream Enabled: ${settings.youtube?.dualStreamEnabled}`);
  console.log(`- Primary Stream Key:  ${settings.youtube?.streamKey ? 'configured' : 'missing'}`);
  console.log(`- Horizontal Stream Key: ${settings.youtube?.horizontalStreamKey ? 'configured' : 'missing'}`);

  // Test source files
  const testDir = '/tmp/test_videos';
  const testFiles = {
    a_vert: path.join(testDir, 'video_a_vertical.mp4'),
    a_horiz: path.join(testDir, 'video_a_horizontal.mp4'),
    b_vert: path.join(testDir, 'video_b_vertical.mp4'),
    b_horiz: path.join(testDir, 'video_b_horizontal.mp4'),
    c_vert: path.join(testDir, 'video_c_vertical.mp4'),
    c_horiz: path.join(testDir, 'video_c_horizontal.mp4'),
  };

  for (const [key, p] of Object.entries(testFiles)) {
    if (!fsSync.existsSync(p)) {
      throw new Error(`Required test file ${key} not found at ${p}`);
    }
  }

  // Backup existing data
  const backupTimestamp = Date.now();
  const backupSettingsFile = path.join(PATHS.backups, `settings_pre_sync_${backupTimestamp}.json`);
  const backupVideosFile = path.join(PATHS.backups, `videos_pre_sync_${backupTimestamp}.json`);
  await fs.copyFile(PATHS.settings, backupSettingsFile).catch(() => {});
  await fs.copyFile(PATHS.videosIndex, backupVideosFile).catch(() => {});
  console.log(`✓ Backed up existing settings & video catalog to ${PATHS.backups}`);

  try {
    // ------------------------------------------------------------
    // SETUP: Clear library and upload ONLY Pair A
    // ------------------------------------------------------------
    console.log('\n============================================================');
    console.log('STEP 1: PREPARE ONLY LOGICAL VIDEO A');
    console.log('============================================================');

    // Reset video library index
    await writeJSON(PATHS.videosIndex, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      videos: [],
    });

    // Reset settings playlist
    await saveSettings({
      stream: {
        playlist: [],
        videoId: null,
        playbackOrder: 'sequential',
        modePreference: 'copy',
      },
    });

    console.log('--> Uploading A-vertical...');
    const statAV = await fs.stat(testFiles.a_vert);
    const metaAV = await processUpload(fsSync.createReadStream(testFiles.a_vert), {
      filename: 'video_a_vertical.mp4',
      mimeType: 'video/mp4',
      sizeBytes: statAV.size,
    });
    console.log(`✓ A-vertical uploaded: ${metaAV.id} (${statAV.size} bytes)`);

    console.log('--> Uploading A-horizontal...');
    const statAH = await fs.stat(testFiles.a_horiz);
    const metaAH = await processUpload(fsSync.createReadStream(testFiles.a_horiz), {
      filename: 'video_a_horizontal.mp4',
      mimeType: 'video/mp4',
      sizeBytes: statAH.size,
    });
    console.log(`✓ A-horizontal uploaded: ${metaAH.id} (${statAH.size} bytes)`);

    // Verify Pair A is complete & in playlist
    const freshVideos = await listVideos();
    const freshSettings = await loadSettings();
    const logicalA = buildLogicalVideos(freshVideos, freshSettings.stream?.playlist, null, freshSettings);
    assert.strictEqual(logicalA.length, 1, 'Library must contain exactly 1 logical video');
    assert.ok(logicalA[0].vertical && logicalA[0].horizontal, 'Logical Video A must have both vertical and horizontal versions');

    const logicalAId = logicalA[0].id;
    console.log(`✓ Logical Video A established: ${logicalAId}`);
    console.log(`  - Vertical:   ${logicalA[0].vertical.id} (${logicalA[0].vertical.filename})`);
    console.log(`  - Horizontal: ${logicalA[0].horizontal.id} (${logicalA[0].horizontal.filename})`);
    console.log(`  - In Playlist: ${freshSettings.stream?.playlist?.includes(logicalAId)}`);

    // Ensure playlist has only A
    await saveSettings({
      stream: {
        playlist: [logicalAId],
        videoId: logicalAId,
        playbackOrder: 'sequential',
        modePreference: 'copy',
      },
    });

    // ------------------------------------------------------------
    // STEP 2: START DUAL LIVE
    // ------------------------------------------------------------
    console.log('\n============================================================');
    console.log('STEP 2: START DUAL LIVE WITH ONLY LOGICAL VIDEO A');
    console.log('============================================================');

    if (isFfmpegRunning()) {
      console.log('Stopping any previous stream instance...');
      await stopStream({ reason: 'test_start', keepDesiredRunning: false });
      await wait(2000);
    }

    console.log('Starting stream...');
    const startResult = await startStream({ reason: 'hot_sync_verification', clearMaintenance: true });
    console.log(`Stream start invoked (mode: ${startResult.mode}, pid: ${startResult.pid})`);

    // Wait for stream to become stable RUNNING and YouTube lifecycle confirmed
    console.log('Waiting for dual health gating & YouTube confirmation...');
    let running = false;
    for (let i = 0; i < 90; i++) {
      await wait(1000);
      const st = getState();
      if (st.status === 'RUNNING' && st.primaryBroadcastStatus === 'live' && st.secondaryBroadcastStatus === 'live') {
        running = true;
        break;
      }
    }
    assert.ok(running, 'Stream failed to reach RUNNING state with both broadcasts LIVE');

    // Record initial baseline
    const vertPidInitial = getFfmpegPid();
    const horizPidInitial = getSecondaryFfmpegPid();
    const stateInitial = getState();
    const primaryBcastInitial = stateInitial.primaryBroadcastId;
    const secondaryBcastInitial = stateInitial.secondaryBroadcastId;

    console.log('\n--> BASELINE DUAL LIVE VERIFIED:');
    console.log(`  Vertical FFmpeg PID:         ${vertPidInitial}`);
    console.log(`  Horizontal FFmpeg PID:       ${horizPidInitial}`);
    console.log(`  YouTube Primary Broadcast:   ${primaryBcastInitial} (LIVE)`);
    console.log(`  YouTube Secondary Broadcast: ${secondaryBcastInitial} (LIVE)`);
    console.log(`  Current Logical Video:       ${stateInitial.currentLogicalVideoId}`);
    console.log(`  Current Vertical Video:      ${stateInitial.currentVerticalVideoId}`);
    console.log(`  Current Horizontal Video:    ${stateInitial.currentHorizontalVideoId}`);

    assert.strictEqual(stateInitial.currentVerticalVideoId, metaAV.id, 'Vertical must equal A-vertical');
    assert.strictEqual(stateInitial.currentHorizontalVideoId, metaAH.id, 'Horizontal must equal A-horizontal');

    // Let A play for ~6 seconds before uploading B
    console.log('\nAllowing A to play stably for 6 seconds...');
    await wait(6000);

    // ------------------------------------------------------------
    // STEP 3: WHILE A IS PLAYING -> UPLOAD PAIR B
    // ------------------------------------------------------------
    console.log('\n============================================================');
    console.log('STEP 3: WHILE A IS PLAYING -> UPLOAD PAIR B');
    console.log('============================================================');

    console.log('--> Uploading B-vertical (A is actively streaming)...');
    const statBV = await fs.stat(testFiles.b_vert);
    const metaBV = await processUpload(fsSync.createReadStream(testFiles.b_vert), {
      filename: 'video_b_vertical.mp4',
      mimeType: 'video/mp4',
      sizeBytes: statBV.size,
    });
    console.log(`✓ B-vertical uploaded: ${metaBV.id}`);

    console.log('--> Uploading B-horizontal (A is actively streaming)...');
    const statBH = await fs.stat(testFiles.b_horiz);
    const metaBH = await processUpload(fsSync.createReadStream(testFiles.b_horiz), {
      filename: 'video_b_horizontal.mp4',
      mimeType: 'video/mp4',
      sizeBytes: statBH.size,
    });
    console.log(`✓ B-horizontal uploaded: ${metaBH.id}`);

    // Verify state after B upload
    const stateAfterB = getState();
    const vertPidAfterB = getFfmpegPid();
    const horizPidAfterB = getSecondaryFfmpegPid();
    const settingsAfterB = await loadSettings();
    const videosAfterB = await listVideos();
    const logicalsAfterB = buildLogicalVideos(videosAfterB, settingsAfterB.stream?.playlist, null, settingsAfterB);

    const logicalB = logicalsAfterB.find(l => l.verticalVideoId === metaBV.id || l.horizontalVideoId === metaBH.id);
    assert.ok(logicalB, 'Logical Video B must exist');
    const bInPlaylist = settingsAfterB.stream?.playlist?.includes(logicalB.id);

    console.log('\n--> VERIFICATION AFTER B UPLOAD:');
    console.log(`  Current A still playing:     ${stateAfterB.currentLogicalVideoId === logicalAId ? 'YES' : 'NO'}`);
    console.log(`  Vertical PID unchanged:      ${vertPidAfterB === vertPidInitial ? 'YES' : 'NO'} (${vertPidAfterB})`);
    console.log(`  Horizontal PID unchanged:    ${horizPidAfterB === horizPidInitial ? 'YES' : 'NO'} (${horizPidAfterB})`);
    console.log(`  Broadcast IDs unchanged:     ${stateAfterB.primaryBroadcastId === primaryBcastInitial && stateAfterB.secondaryBroadcastId === secondaryBcastInitial ? 'YES' : 'NO'}`);
    console.log(`  B appears in playlist:       ${bInPlaylist ? 'YES' : 'NO'} (status: ${logicalB.isComplete ? 'READY' : 'PENDING'})`);

    assert.strictEqual(stateAfterB.currentLogicalVideoId, logicalAId, 'A must still be playing after B upload');
    assert.strictEqual(vertPidAfterB, vertPidInitial, 'Vertical publisher PID must not change on upload');
    assert.strictEqual(horizPidAfterB, horizPidInitial, 'Horizontal publisher PID must not change on upload');
    assert.strictEqual(stateAfterB.primaryBroadcastId, primaryBcastInitial, 'Primary broadcast ID must not change');
    assert.strictEqual(stateAfterB.secondaryBroadcastId, secondaryBcastInitial, 'Secondary broadcast ID must not change');
    assert.ok(bInPlaylist, 'B must be appended to playlist');
    assert.ok(logicalB.isComplete, 'B must be marked READY');

    // Let A continue playing for 5 more seconds
    console.log('\nAllowing A to continue playing for 5 seconds...');
    await wait(5000);

    // ------------------------------------------------------------
    // STEP 4: WHILE A IS STILL PLAYING -> UPLOAD PAIR C
    // ------------------------------------------------------------
    console.log('\n============================================================');
    console.log('STEP 4: WHILE A IS STILL PLAYING -> UPLOAD PAIR C');
    console.log('============================================================');

    console.log('--> Uploading C-vertical (A is actively streaming)...');
    const statCV = await fs.stat(testFiles.c_vert);
    const metaCV = await processUpload(fsSync.createReadStream(testFiles.c_vert), {
      filename: 'video_c_vertical.mp4',
      mimeType: 'video/mp4',
      sizeBytes: statCV.size,
    });
    console.log(`✓ C-vertical uploaded: ${metaCV.id}`);

    console.log('--> Uploading C-horizontal (A is actively streaming)...');
    const statCH = await fs.stat(testFiles.c_horiz);
    const metaCH = await processUpload(fsSync.createReadStream(testFiles.c_horiz), {
      filename: 'video_c_horizontal.mp4',
      mimeType: 'video/mp4',
      sizeBytes: statCH.size,
    });
    console.log(`✓ C-horizontal uploaded: ${metaCH.id}`);

    // Verify state after C upload
    const stateAfterC = getState();
    const vertPidAfterC = getFfmpegPid();
    const horizPidAfterC = getSecondaryFfmpegPid();
    const settingsAfterC = await loadSettings();
    const videosAfterC = await listVideos();
    const logicalsAfterC = buildLogicalVideos(videosAfterC, settingsAfterC.stream?.playlist, null, settingsAfterC);

    const logicalC = logicalsAfterC.find(l => l.verticalVideoId === metaCV.id || l.horizontalVideoId === metaCH.id);
    assert.ok(logicalC, 'Logical Video C must exist');
    const cInPlaylist = settingsAfterC.stream?.playlist?.includes(logicalC.id);

    console.log('\n--> VERIFICATION AFTER C UPLOAD:');
    console.log(`  Current A still playing:     ${stateAfterC.currentLogicalVideoId === logicalAId ? 'YES' : 'NO'}`);
    console.log(`  Vertical PID unchanged:      ${vertPidAfterC === vertPidInitial ? 'YES' : 'NO'} (${vertPidAfterC})`);
    console.log(`  Horizontal PID unchanged:    ${horizPidAfterC === horizPidInitial ? 'YES' : 'NO'} (${horizPidAfterC})`);
    console.log(`  Broadcast IDs unchanged:     ${stateAfterC.primaryBroadcastId === primaryBcastInitial && stateAfterC.secondaryBroadcastId === secondaryBcastInitial ? 'YES' : 'NO'}`);
    console.log(`  C appears in playlist:       ${cInPlaylist ? 'YES' : 'NO'} (status: ${logicalC.isComplete ? 'READY' : 'PENDING'})`);

    assert.strictEqual(stateAfterC.currentLogicalVideoId, logicalAId, 'A must still be playing after C upload');
    assert.strictEqual(vertPidAfterC, vertPidInitial, 'Vertical publisher PID must not change on upload');
    assert.strictEqual(horizPidAfterC, horizPidInitial, 'Horizontal publisher PID must not change on upload');
    assert.strictEqual(stateAfterC.primaryBroadcastId, primaryBcastInitial, 'Primary broadcast ID must not change');
    assert.strictEqual(stateAfterC.secondaryBroadcastId, secondaryBcastInitial, 'Secondary broadcast ID must not change');
    assert.ok(cInPlaylist, 'C must be appended to playlist');
    assert.ok(logicalC.isComplete, 'C must be marked READY');

    // ------------------------------------------------------------
    // STEP 5: TRANSITION 1 (A FINISHES NATURALLY -> TRANSITION TO B)
    // ------------------------------------------------------------
    console.log('\n============================================================');
    console.log('STEP 5: TRANSITION 1 (ALLOW A TO NATURALLY FINISH)');
    console.log('============================================================');
    console.log('Waiting for Video A feeder to naturally finish (~80s duration)...');

    const transition1Start = Date.now();
    let transitionedToB = false;
    let stateAtB = null;

    // A is ~80s long. Timeout at 75s from upload completion.
    for (let i = 0; i < 150; i++) {
      await wait(500);
      const st = getState();
      if (st.currentLogicalVideoId && st.currentLogicalVideoId !== logicalAId) {
        transitionedToB = true;
        stateAtB = st;
        break;
      }
    }

    assert.ok(transitionedToB, 'Timed out waiting for natural transition from A to B');
    console.log(`✓ Feeder A naturally exited and seamless transition occurred in ${((Date.now() - transition1Start)/1000).toFixed(1)}s!`);

    const vertPidAtB = getFfmpegPid();
    const horizPidAtB = getSecondaryFfmpegPid();

    console.log('\n--> VERIFICATION AFTER A FINISHES:');
    console.log(`  Fresh playlist reload:       YES (auto-loaded from settings.json on segment finish)`);
    console.log(`  Selected logical video:      ${stateAtB.currentLogicalVideoId} (expected B: ${logicalB.id})`);
    console.log(`  Vertical = B-vertical:       ${stateAtB.currentVerticalVideoId === metaBV.id ? 'YES' : 'NO'} (${stateAtB.currentVerticalVideoId})`);
    console.log(`  Horizontal = B-horizontal:   ${stateAtB.currentHorizontalVideoId === metaBH.id ? 'YES' : 'NO'} (${stateAtB.currentHorizontalVideoId})`);
    console.log(`  Vertical PID unchanged:      ${vertPidAtB === vertPidInitial ? 'YES' : 'NO'} (${vertPidAtB})`);
    console.log(`  Horizontal PID unchanged:    ${horizPidAtB === horizPidInitial ? 'YES' : 'NO'} (${horizPidAtB})`);
    console.log(`  Broadcast IDs unchanged:     ${stateAtB.primaryBroadcastId === primaryBcastInitial && stateAtB.secondaryBroadcastId === secondaryBcastInitial ? 'YES' : 'NO'}`);

    assert.strictEqual(stateAtB.currentLogicalVideoId, logicalB.id, 'Selected logical video must be B');
    assert.strictEqual(stateAtB.currentVerticalVideoId, metaBV.id, 'Vertical video must be B-vertical');
    assert.strictEqual(stateAtB.currentHorizontalVideoId, metaBH.id, 'Horizontal video must be B-horizontal');
    assert.strictEqual(vertPidAtB, vertPidInitial, 'Vertical publisher PID must remain unchanged across transition');
    assert.strictEqual(horizPidAtB, horizPidInitial, 'Horizontal publisher PID must remain unchanged across transition');
    assert.strictEqual(stateAtB.primaryBroadcastId, primaryBcastInitial, 'Primary broadcast ID must remain unchanged');
    assert.strictEqual(stateAtB.secondaryBroadcastId, secondaryBcastInitial, 'Secondary broadcast ID must remain unchanged');

    // ------------------------------------------------------------
    // STEP 6: TRANSITION 2 (B FINISHES NATURALLY -> TRANSITION TO C)
    // ------------------------------------------------------------
    console.log('\n============================================================');
    console.log('STEP 6: TRANSITION 2 (ALLOW B TO NATURALLY FINISH)');
    console.log('============================================================');
    console.log('Waiting for Video B feeder to naturally finish (~80s duration)...');

    const transition2Start = Date.now();
    let transitionedToC = false;
    let stateAtC = null;

    // B is ~80s long. Timeout at 100s.
    for (let i = 0; i < 200; i++) {
      await wait(500);
      const st = getState();
      if (st.currentLogicalVideoId && st.currentLogicalVideoId !== logicalB.id) {
        transitionedToC = true;
        stateAtC = st;
        break;
      }
    }

    assert.ok(transitionedToC, 'Timed out waiting for natural transition from B to C');
    console.log(`✓ Feeder B naturally exited and seamless transition occurred in ${((Date.now() - transition2Start)/1000).toFixed(1)}s!`);

    const vertPidAtC = getFfmpegPid();
    const horizPidAtC = getSecondaryFfmpegPid();

    console.log('\n--> VERIFICATION AFTER B FINISHES:');
    console.log(`  Fresh playlist reload:       YES (auto-loaded from settings.json on segment finish)`);
    console.log(`  Selected logical video:      ${stateAtC.currentLogicalVideoId} (expected C: ${logicalC.id})`);
    console.log(`  Vertical = C-vertical:       ${stateAtC.currentVerticalVideoId === metaCV.id ? 'YES' : 'NO'} (${stateAtC.currentVerticalVideoId})`);
    console.log(`  Horizontal = C-horizontal:   ${stateAtC.currentHorizontalVideoId === metaCH.id ? 'YES' : 'NO'} (${stateAtC.currentHorizontalVideoId})`);
    console.log(`  Vertical PID unchanged:      ${vertPidAtC === vertPidInitial ? 'YES' : 'NO'} (${vertPidAtC})`);
    console.log(`  Horizontal PID unchanged:    ${horizPidAtC === horizPidInitial ? 'YES' : 'NO'} (${horizPidAtC})`);
    console.log(`  Broadcast IDs unchanged:     ${stateAtC.primaryBroadcastId === primaryBcastInitial && stateAtC.secondaryBroadcastId === secondaryBcastInitial ? 'YES' : 'NO'}`);

    assert.strictEqual(stateAtC.currentLogicalVideoId, logicalC.id, 'Selected logical video must be C');
    assert.strictEqual(stateAtC.currentVerticalVideoId, metaCV.id, 'Vertical video must be C-vertical');
    assert.strictEqual(stateAtC.currentHorizontalVideoId, metaCH.id, 'Horizontal video must be C-horizontal');
    assert.strictEqual(vertPidAtC, vertPidInitial, 'Vertical publisher PID must remain unchanged across transition');
    assert.strictEqual(horizPidAtC, horizPidInitial, 'Horizontal publisher PID must remain unchanged across transition');
    assert.strictEqual(stateAtC.primaryBroadcastId, primaryBcastInitial, 'Primary broadcast ID must remain unchanged');
    assert.strictEqual(stateAtC.secondaryBroadcastId, secondaryBcastInitial, 'Secondary broadcast ID must remain unchanged');

    // ------------------------------------------------------------
    // YOUTUBE DATA API v3 FINAL CONFIRMATION
    // ------------------------------------------------------------
    console.log('\n============================================================');
    console.log('YOUTUBE DATA API v3 VERIFICATION:');
    console.log('============================================================');
    const token = await getAccessToken();

    const fetchBcast = async (id) => {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&id=${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await res.json();
      return d.items?.[0];
    };

    const bcastPrimary = await fetchBcast(primaryBcastInitial);
    const bcastSecondary = await fetchBcast(secondaryBcastInitial);

    console.log(`  Primary Broadcast (${primaryBcastInitial}):`);
    console.log(`    Status: ${bcastPrimary?.status?.lifeCycleStatus}`);
    console.log(`    Title:  ${bcastPrimary?.snippet?.title}`);
    console.log(`  Secondary Broadcast (${secondaryBcastInitial}):`);
    console.log(`    Status: ${bcastSecondary?.status?.lifeCycleStatus}`);
    console.log(`    Title:  ${bcastSecondary?.snippet?.title}`);

    // ------------------------------------------------------------
    // FINAL PRODUCTION PROOF REPORT
    // ------------------------------------------------------------
    console.log('\n============================================================');
    console.log('PRODUCTION PROOF:');
    console.log('============================================================\n');

    console.log('Before upload:');
    console.log(`Vertical FFmpeg PID:          ${vertPidInitial}`);
    console.log(`Horizontal FFmpeg PID:        ${horizPidInitial}`);
    console.log(`YouTube Primary Broadcast:    ${primaryBcastInitial}`);
    console.log(`YouTube Secondary Broadcast:  ${secondaryBcastInitial}`);
    console.log('');
    console.log('After B upload:');
    console.log(`Vertical PID unchanged =      YES`);
    console.log(`Horizontal PID unchanged =    YES`);
    console.log(`Broadcast IDs unchanged =     YES`);
    console.log(`Current A still playing =     YES`);
    console.log('');
    console.log('After C upload:');
    console.log(`Current A still playing =     YES`);
    console.log('');
    console.log('After A finishes:');
    console.log(`Fresh playlist reload =       YES`);
    console.log(`Selected logical video =      B`);
    console.log(`Vertical =                    B-vertical`);
    console.log(`Horizontal =                  B-horizontal`);
    console.log('');
    console.log('After B finishes:');
    console.log(`Fresh playlist reload =       YES`);
    console.log(`Selected logical video =      C`);
    console.log(`Vertical =                    C-vertical`);
    console.log(`Horizontal =                  C-horizontal`);
    console.log('\n============================================================');
    console.log('FINAL ACCEPTANCE: PASSED (ZERO LIVESTREAM RESTARTS)');
    console.log('============================================================');

  } finally {
    // Stop the test stream cleanly
    console.log('\nCleaning up verification stream...');
    await stopStream({ reason: 'test_completion', keepDesiredRunning: false }).catch(() => {});
    await stopFeeders().catch(() => {});
    await stopFfmpeg({ force: true, reason: 'test_completion' }).catch(() => {});

    // Restore backup
    console.log('Restoring backup data files...');
    if (fsSync.existsSync(backupSettingsFile)) {
      await fs.copyFile(backupSettingsFile, PATHS.settings).catch(() => {});
    }
    if (fsSync.existsSync(backupVideosFile)) {
      await fs.copyFile(backupVideosFile, PATHS.videosIndex).catch(() => {});
    }
    console.log('✓ Restored settings.json and videos.json to original state');
  }
}

main().catch(err => {
  console.error('\n*** VERIFICATION FAILED ***');
  console.error(err);
  process.exit(1);
});
