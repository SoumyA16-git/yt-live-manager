/**
 * scripts/verify-service-restart.js
 *
 * Verifies application restart recovery in Single Stream Mode:
 * - When running Horizontal, service restart automatically recovers into Horizontal.
 * - When running Vertical, service restart automatically recovers into Vertical.
 */

import assert from 'node:assert/strict';
import { getState, loadState } from '../src/state-manager.js';
import { loadSettings, saveSettings, getStreamMode } from '../src/config-manager.js';
import { startStream, stopStream, setStreamMode } from '../src/stream-manager.js';
import { getFfmpegPid, isFfmpegRunning, getSecondaryFfmpegPid } from '../src/ffmpeg-manager.js';
import { listVideos, setPlaylist } from '../src/video-manager.js';

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const step = process.argv[2];

  await loadSettings();
  const rawS = (await import('../src/config-manager.js')).getSettings();
  if (rawS.scheduler?.autoRecycle?.maxSessionMinutes !== undefined) {
    delete rawS.scheduler.autoRecycle.maxSessionMinutes;
    rawS.scheduler.autoRecycle.maxSessionHours = 1;
    await (await import('../src/config-manager.js')).saveSettings(rawS);
  }
  await loadState();

  const videos = await listVideos();
  const horiz = videos.filter(v => v.probe?.width >= v.probe?.height);
  const vert = videos.filter(v => v.probe?.height > v.probe?.width);

  if (step === 'prep-horizontal') {
    await stopStream('prep');
    await wait(2000);
    await setStreamMode('horizontal');
    await setPlaylist([horiz[0].id], { mode: 'horizontal' });
    await saveSettings({
      stream: { autoResume: true },
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
    const res = await startStream({ reason: 'restart_test_h' });
    assert.strictEqual(res.started, true);
    await wait(4000);
    console.log(`✓ Horizontal running before restart: PID ${getFfmpegPid()}, Mode: ${getState().streamMode}`);
    process.exit(0);
  }

  if (step === 'verify-horizontal') {
    await wait(4000);
    await loadState();
    await loadSettings();
    const pid = getFfmpegPid();
    const st = getState();
    console.log(`✓ Horizontal recovery: PID ${pid}, Desired: ${st.desiredState}, Status: ${st.status}, Mode: ${st.streamMode}`);
    assert.ok(pid > 0, 'Publisher PID must be active after restart');
    assert.strictEqual(st.streamMode, 'horizontal', 'Stream mode must be horizontal');
    assert.strictEqual(getSecondaryFfmpegPid(), null, 'Secondary PID must be null');
    await stopStream('verify_h_done');
    await wait(2000);
    console.log('✅ HORIZONTAL SERVICE RESTART RECOVERY VERIFIED!');
    process.exit(0);
  }

  if (step === 'prep-vertical') {
    await stopStream('prep');
    await wait(2000);
    await setStreamMode('vertical');
    await setPlaylist([vert[0].id], { mode: 'vertical' });
    await saveSettings({
      stream: { autoResume: true },
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
    const res = await startStream({ reason: 'restart_test_v' });
    assert.strictEqual(res.started, true);
    await wait(4000);
    console.log(`✓ Vertical running before restart: PID ${getFfmpegPid()}, Mode: ${getState().streamMode}`);
    process.exit(0);
  }

  if (step === 'verify-vertical') {
    await wait(4000);
    await loadState();
    await loadSettings();
    const pid = getFfmpegPid();
    const st = getState();
    console.log(`✓ Vertical recovery: PID ${pid}, Desired: ${st.desiredState}, Status: ${st.status}, Mode: ${st.streamMode}`);
    assert.ok(pid > 0, 'Publisher PID must be active after restart');
    assert.strictEqual(st.streamMode, 'vertical', 'Stream mode must be vertical');
    assert.strictEqual(getSecondaryFfmpegPid(), null, 'Secondary PID must be null');
    await stopStream('verify_v_done');
    await wait(2000);
    console.log('✅ VERTICAL SERVICE RESTART RECOVERY VERIFIED!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('❌ Service restart verification failed:', err);
  process.exit(1);
});
