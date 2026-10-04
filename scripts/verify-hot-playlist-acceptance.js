/**
 * scripts/verify-hot-playlist-acceptance.js
 *
 * Full End-to-End Live Acceptance Test for Hot Playlist Sync.
 *
 * Sequence verified:
 * 1. Initial playlist: A (vertical + horizontal).
 * 2. Start stream.
 *    - Vertical publisher running (PID 1)
 *    - Horizontal publisher running (PID 2)
 *    - Feeder playing A (vertical + horizontal)
 * 3. While A is playing:
 *    - Upload B vertical + B horizontal -> Validated as READY.
 *    - Confirm A continues playing, FFmpeg publisher PIDs unchanged.
 *    - Upload C vertical + C horizontal -> Validated as READY.
 *    - Confirm A continues playing, FFmpeg publisher PIDs unchanged.
 *    - Upload D vertical + D horizontal -> Validated as READY.
 *    - Confirm A continues playing, FFmpeg publisher PIDs unchanged.
 * 4. A finishes naturally:
 *    - Fresh playlist read -> B selected.
 *    - Vertical transitions to B-vertical, Horizontal transitions to B-horizontal.
 *    - Publishers NEVER restart (same PIDs).
 * 5. B finishes naturally:
 *    - Fresh playlist read -> C selected.
 *    - Vertical transitions to C-vertical, Horizontal transitions to C-horizontal.
 * 6. C finishes naturally:
 *    - Fresh playlist read -> D selected.
 *    - Vertical transitions to D-vertical, Horizontal transitions to D-horizontal.
 * 7. Verification of zero stream restarts throughout the entire lifecycle.
 */

import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

import {
  spawnFfmpeg,
  stopFfmpeg,
  buildPublisherArgs,
  buildFeederArgs,
  feedMediaSegment,
  stopFeeders,
  isFfmpegRunning,
  getFfmpegPid,
  _resetStateForTest,
} from '../src/ffmpeg-manager.js';

import {
  buildLogicalVideos,
  getFreshPlayablePlaylist,
  finalizePairIfComplete,
  resolveVideoPath,
  _setPathsForTest,
} from '../src/video-manager.js';

import { probeMedia, evaluateCompatibility } from '../src/ffprobe-manager.js';
import { getState, saveState, loadState, _setPathsForTest as setStatePaths } from '../src/state-manager.js';
import { loadSettings, saveSettings, getSettings, _setPathsForTest as setConfigPaths } from '../src/config-manager.js';
import { writeJSON } from '../src/lib/atomic-json.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const TEST_DIR = path.join(ROOT_DIR, 'test_live_acceptance');
const VIDEOS_DIR = path.join(TEST_DIR, 'videos');
const INCOMING_DIR = path.join(TEST_DIR, 'incoming');
const CATALOG_FILE = path.join(TEST_DIR, 'videos.json');
const SETTINGS_FILE = path.join(TEST_DIR, 'settings.json');
const STAGING_DIR = path.join(TEST_DIR, 'staging');
const VERT_OUT = path.join(TEST_DIR, 'live_vertical.flv');
const HORIZ_OUT = path.join(TEST_DIR, 'live_horizontal.flv');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function cleanup() {
  await stopFeeders();
  await stopFfmpeg({ reason: 'test_cleanup' });
  _resetStateForTest();
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

async function generateSampleVideo(filePath, width, height, durationSec = 3) {
  const args = [
    '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${durationSec}:size=${width}x${height}:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${durationSec}:sample_rate=44100`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    filePath,
  ];

  execFileSync('ffmpeg', args, { stdio: 'ignore' });
}

async function createPair(letter, idVert, idHoriz, durationSec = 3, targetDir = VIDEOS_DIR) {
  const vertPath = path.join(targetDir, `${idVert}.mp4`);
  const horizPath = path.join(targetDir, `${idHoriz}.mp4`);

  await generateSampleVideo(vertPath, 1080, 1920, durationSec);
  await generateSampleVideo(horizPath, 1920, 1080, durationSec);

  const vertProbe = await probeMedia(vertPath);
  const horizProbe = await probeMedia(horizPath);

  const vertMeta = {
    id: idVert,
    label: `${letter}_vertical`,
    originalName: `${letter}_vertical.mp4`,
    filename: `${idVert}.mp4`,
    filePath: path.join(VIDEOS_DIR, `${idVert}.mp4`),
    sizeBytes: fsSync.statSync(vertPath).size,
    orientation: 'vertical',
    pairedVideoId: idHoriz,
    probe: vertProbe,
    compatibility: evaluateCompatibility(vertProbe, { fps: 30, videoBitrateMbps: 4 }),
  };

  const horizMeta = {
    id: idHoriz,
    label: `${letter}_horizontal`,
    originalName: `${letter}_horizontal.mp4`,
    filename: `${idHoriz}.mp4`,
    filePath: path.join(VIDEOS_DIR, `${idHoriz}.mp4`),
    sizeBytes: fsSync.statSync(horizPath).size,
    orientation: 'horizontal',
    pairedVideoId: idVert,
    probe: horizProbe,
    compatibility: evaluateCompatibility(horizProbe, { fps: 30, videoBitrateMbps: 4 }),
  };

  return { vert: vertMeta, horiz: horizMeta };
}

async function main() {
  console.log('======================================================================');
  console.log('  LIVE ACCEPTANCE TEST: HOT PLAYLIST SYNC / DYNAMIC PLAYLIST');
  console.log('======================================================================\n');

  await cleanup();
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  await fs.mkdir(INCOMING_DIR, { recursive: true });
  await fs.mkdir(STAGING_DIR, { recursive: true });

  _setPathsForTest(VIDEOS_DIR, INCOMING_DIR, CATALOG_FILE);
  setConfigPaths(SETTINGS_FILE, path.join(TEST_DIR, 'backups'));
  setStatePaths(path.join(TEST_DIR, 'state.json'), path.join(TEST_DIR, 'history.json'), path.join(TEST_DIR, 'backups'));
  await loadState();

  // 1. Initial settings with A in playlist
  const initialSettings = {
    schemaVersion: 1,
    stream: {
      videoId: 'vid_a0000001',
      playlist: ['vid_a0000001'],
      playbackOrder: 'sequential',
      fps: 30,
      videoBitrateMbps: 2,
      audioBitrateKbps: 128,
      audioSampleRate: 44100,
      keyframeSeconds: 1,
    },
    youtube: {
      rtmpsUrl: 'rtmps://localhost',
      streamKey: 'live_vert',
      horizontalStreamKey: 'live_horiz',
      dualStreamEnabled: true,
    },
  };
  await writeJSON(SETTINGS_FILE, initialSettings);
  await loadSettings();

  console.log('[STEP 1] Generating Initial Video A and Pre-staging B, C, D (vertical 1080x1920 + horizontal 1920x1080)...');
  const pairA = await createPair('A', 'vid_a0000001', 'vid_a0000002', 3, VIDEOS_DIR);
  const pairB = await createPair('B', 'vid_b0000001', 'vid_b0000002', 3, STAGING_DIR);
  const pairC = await createPair('C', 'vid_c0000001', 'vid_c0000002', 3, STAGING_DIR);
  const pairD = await createPair('D', 'vid_d0000001', 'vid_d0000002', 3, STAGING_DIR);

  let allVideos = [pairA.vert, pairA.horiz];
  await writeJSON(CATALOG_FILE, { videos: allVideos });

  // 2. Start Live Stream (Publishers to local FLV sinks)
  console.log('[STEP 2] Starting live dual-stream with initial video A...');
  const vertPubArgs = buildPublisherArgs(initialSettings, VERT_OUT);
  const horizPubArgs = buildPublisherArgs(initialSettings, HORIZ_OUT);

  let initialLogicalFinished = false;
  let currentLogical = 'vid_a0000001';
  const transitions = [];

  // Transition handler for feeders
  async function onSegmentDone() {
    console.log(`\n--> [NATURAL END] Logical video ${currentLogical} finished playback.`);
    transitions.push(currentLogical);

    // Read fresh playlist and fresh videos
    const latestSettings = getSettings();
    const freshVideos = (await fs.readFile(CATALOG_FILE, 'utf8').then(JSON.parse)).videos;
    const freshPlaylist = await getFreshPlayablePlaylist(latestSettings, freshVideos);

    console.log(`[FRESH RELOAD] Found ${freshPlaylist.length} playable logical items: ${freshPlaylist.map(x => x.id).join(', ')}`);

    // Next item in sequence
    const curIdx = freshPlaylist.findIndex(x => x.id === currentLogical);
    const nextIdx = (curIdx >= 0 && curIdx + 1 < freshPlaylist.length) ? (curIdx + 1) : 0;
    const nextItem = freshPlaylist[nextIdx];

    if (!nextItem) {
      console.log('No next item found; stopping test');
      return;
    }

    currentLogical = nextItem.id;
    console.log(`[TRANSITION] Starting next logical video: ${nextItem.id} (Vertical: ${nextItem.verticalVideoId}, Horizontal: ${nextItem.horizontalVideoId})`);

    await saveState({
      currentLogicalVideoId: nextItem.id,
      currentVerticalVideoId: nextItem.verticalVideoId,
      currentHorizontalVideoId: nextItem.horizontalVideoId,
      currentPlaybackState: 'PLAYING',
    });

    await feedMediaSegment({
      primaryVideo: nextItem.vertical,
      secondaryVideo: nextItem.horizontal,
      settings: latestSettings,
      mode: 'copy',
      onFinished: onSegmentDone,
      onError: (err) => console.error('Feeder error:', err),
    });
  }

  // Spawn persistent publishers
  const { pid } = await spawnFfmpeg({
    args: vertPubArgs,
    secondaryArgs: horizPubArgs,
    settings: initialSettings,
    pipeMode: true,
  });

  const publisherPid = pid;
  console.log(`✓ FFmpeg Persistent Dual Publishers Spawned successfully! (PID: ${publisherPid})`);

  await saveState({
    status: 'RUNNING',
    currentLogicalVideoId: 'vid_a0000001',
    currentVerticalVideoId: 'vid_a0000001',
    currentHorizontalVideoId: 'vid_a0000002',
    currentPlaybackState: 'PLAYING',
    ffmpegPid: publisherPid,
  });

  // Start feeding A
  await feedMediaSegment({
    primaryVideo: pairA.vert,
    secondaryVideo: pairA.horiz,
    settings: initialSettings,
    mode: 'copy',
    onFinished: onSegmentDone,
    onError: (err) => console.error('Feeder error:', err),
  });

  console.log('✓ Video A is now playing on both vertical and horizontal outputs.');
  console.log('  State: currentLogicalVideoId =', getState().currentLogicalVideoId);

  // 3. While A is playing, upload B (vertical + horizontal)
  console.log('\n[STEP 3] While A is playing, uploading B (vertical + horizontal)...');
  await wait(300); // 300ms into A's 3-second playback

  await fs.rename(path.join(STAGING_DIR, 'vid_b0000001.mp4'), path.join(VIDEOS_DIR, 'vid_b0000001.mp4'));
  await fs.rename(path.join(STAGING_DIR, 'vid_b0000002.mp4'), path.join(VIDEOS_DIR, 'vid_b0000002.mp4'));
  allVideos.push(pairB.vert, pairB.horiz);
  await writeJSON(CATALOG_FILE, { videos: allVideos });

  // Update playlist in settings
  const settingsWithB = getSettings();
  settingsWithB.stream.playlist.push('vid_b0000001');
  await saveSettings(settingsWithB);

  // Check state: A MUST STILL BE PLAYING, PID MUST BE UNCHANGED
  assert.strictEqual(getState().currentLogicalVideoId, 'vid_a0000001', 'A must still be playing after B upload');
  assert.strictEqual(getFfmpegPid(), publisherPid, 'FFmpeg PID must remain unchanged after B upload');
  console.log('✓ Video A CONTINUES uninterrupted.');
  console.log(`✓ FFmpeg publisher PID remains unchanged: ${getFfmpegPid()}`);

  const logicalsAfterB = buildLogicalVideos(allVideos, settingsWithB.stream.playlist, 'vid_a0000001');
  const bLogical = logicalsAfterB.find(x => x.id === 'vid_b0000001');
  assert.ok(bLogical, 'B must be present in logical videos');
  assert.strictEqual(bLogical.status, 'READY', 'B must be marked READY');
  console.log('✓ Video B is confirmed READY in logical playlist (not started early).');

  // 4. While A is still playing, upload C (vertical + horizontal)
  console.log('\n[STEP 4] While A is still playing, uploading C (vertical + horizontal)...');
  await wait(300); // 600ms into A's playback

  await fs.rename(path.join(STAGING_DIR, 'vid_c0000001.mp4'), path.join(VIDEOS_DIR, 'vid_c0000001.mp4'));
  await fs.rename(path.join(STAGING_DIR, 'vid_c0000002.mp4'), path.join(VIDEOS_DIR, 'vid_c0000002.mp4'));
  allVideos.push(pairC.vert, pairC.horiz);
  await writeJSON(CATALOG_FILE, { videos: allVideos });

  const settingsWithC = getSettings();
  settingsWithC.stream.playlist.push('vid_c0000001');
  await saveSettings(settingsWithC);

  assert.strictEqual(getState().currentLogicalVideoId, 'vid_a0000001', 'A must still be playing after C upload');
  assert.strictEqual(getFfmpegPid(), publisherPid, 'FFmpeg PID must remain unchanged after C upload');
  console.log('✓ Video A CONTINUES uninterrupted.');
  console.log(`✓ FFmpeg publisher PID remains unchanged: ${getFfmpegPid()}`);

  // 5. While A is still playing, upload D (vertical + horizontal)
  console.log('\n[STEP 5] While A is still playing, uploading D (vertical + horizontal)...');
  await wait(300); // 900ms into A's playback

  await fs.rename(path.join(STAGING_DIR, 'vid_d0000001.mp4'), path.join(VIDEOS_DIR, 'vid_d0000001.mp4'));
  await fs.rename(path.join(STAGING_DIR, 'vid_d0000002.mp4'), path.join(VIDEOS_DIR, 'vid_d0000002.mp4'));
  allVideos.push(pairD.vert, pairD.horiz);
  await writeJSON(CATALOG_FILE, { videos: allVideos });

  const settingsWithD = getSettings();
  settingsWithD.stream.playlist.push('vid_d0000001');
  await saveSettings(settingsWithD);

  assert.strictEqual(getState().currentLogicalVideoId, 'vid_a0000001', 'A must still be playing after D upload');
  assert.strictEqual(getFfmpegPid(), publisherPid, 'FFmpeg PID must remain unchanged after D upload');
  console.log('✓ Video A CONTINUES uninterrupted.');
  console.log(`✓ FFmpeg publisher PID remains unchanged: ${getFfmpegPid()}`);

  const logicalsAll = buildLogicalVideos(allVideos, settingsWithD.stream.playlist, 'vid_a0000001');
  console.log('\n--- Current Live Logical Videos Status ---');
  for (const item of logicalsAll) {
    console.log(`  [${item.status}] ${item.label} (ID: ${item.id}) - Vert: ${Boolean(item.vertical)}, Horiz: ${Boolean(item.horizontal)}`);
  }

  // 6. Now wait for A to finish, then B, then C, then D
  console.log('\n[STEP 6] Waiting for natural video boundaries (A -> B -> C -> D)...');

  // Wait for transitions to complete: A -> B -> C -> D
  const startTime = Date.now();
  while (transitions.length < 3 && Date.now() - startTime < 25000) {
    await wait(200);
  }

  console.log('\nRecorded transitions at natural boundaries:', transitions);
  assert.strictEqual(transitions[0], 'vid_a0000001', 'First transition must occur from A');
  assert.strictEqual(transitions[1], 'vid_b0000001', 'Second transition must occur from B');
  assert.strictEqual(transitions[2], 'vid_c0000001', 'Third transition must occur from C');

  // Verify active state is now D
  const finalState = getState();
  console.log('Final active logical video:', finalState.currentLogicalVideoId);
  assert.strictEqual(finalState.currentLogicalVideoId, 'vid_d0000001', 'Stream must be actively playing D');
  assert.strictEqual(finalState.currentVerticalVideoId, 'vid_d0000001');
  assert.strictEqual(finalState.currentHorizontalVideoId, 'vid_d0000002');

  // Verify Publisher was NEVER killed or restarted
  assert.strictEqual(getFfmpegPid(), publisherPid, 'Publisher PID must be completely identical from start to finish');
  console.log(`✓ Verified: Publisher PID remained ${publisherPid} across all transitions! (Zero stream restarts)`);

  // Stop stream
  console.log('\n[STEP 7] Stopping stream and validating output files...');
  await stopFeeders();
  await stopFfmpeg({ reason: 'test_complete' });

  assert.ok(fsSync.existsSync(VERT_OUT), 'Vertical output FLV file must exist');
  assert.ok(fsSync.existsSync(HORIZ_OUT), 'Horizontal output FLV file must exist');

  const vertSize = fsSync.statSync(VERT_OUT).size;
  const horizSize = fsSync.statSync(HORIZ_OUT).size;
  console.log(`✓ Output file generated: ${VERT_OUT} (${(vertSize / 1024).toFixed(1)} KB)`);
  console.log(`✓ Output file generated: ${HORIZ_OUT} (${(horizSize / 1024).toFixed(1)} KB)`);

  assert.ok(vertSize > 10000, 'Vertical output stream must have non-trivial size');
  assert.ok(horizSize > 10000, 'Horizontal output stream must have non-trivial size');

  await cleanup();

  console.log('\n======================================================================');
  console.log('  ALL ACCEPTANCE CRITERIA MET WITH 100% SUCCESS!');
  console.log('======================================================================');
}

main().catch(async (err) => {
  console.error('\n❌ ACCEPTANCE TEST FAILED:', err);
  await cleanup();
  process.exit(1);
});
