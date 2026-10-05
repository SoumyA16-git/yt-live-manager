/**
 * test/unit/youtube-studio-gate-integration.test.js
 *
 * Tests that stream-manager.startStream strictly gates FFmpeg spawning behind
 * YouTubeStudioAutomationService.prepareNextLiveSession:
 * 1. If YouTube Studio reports YOUTUBE_AUTH_REQUIRED, FFmpeg is NOT started and state is ERROR / YOUTUBE_AUTH_REQUIRED.
 * 2. If YouTube Studio preview times out, FFmpeg is terminated and state is ERROR / YOUTUBE_PREVIEW_TIMEOUT.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startStream, stopStream } from '../../src/stream-manager.js';
import { loadSettings, saveSettings, _setPathsForTest as _setConfigPaths } from '../../src/config-manager.js';
import { loadState, saveState, getState, _setPathsForTest as _setStatePaths } from '../../src/state-manager.js';
import { _setPathsForTest as _setVideoPaths } from '../../src/video-manager.js';
import { writeJSON } from '../../src/lib/atomic-json.js';
import { YouTubeStudioAutomationService, YOUTUBE_STATES } from '../../src/youtube-studio-service.js';

let tmpDir;
let videoId = 'vid_deadbeef';

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-gate-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('stream-manager — YouTube Studio Automation Gate Integration', () => {
  let originalPrepare;

  beforeEach(async () => {
    const sPath = path.join(tmpDir, 'settings.json');
    const stPath = path.join(tmpDir, 'state.json');
    const hPath  = path.join(tmpDir, 'hist.json');
    const vDir   = path.join(tmpDir, 'videos');
    const inDir  = path.join(tmpDir, 'incoming');
    const vIndex = path.join(tmpDir, 'vindex.json');
    const bDir   = path.join(tmpDir, 'backups');

    await fs.mkdir(vDir, { recursive: true });
    await fs.mkdir(bDir, { recursive: true });

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setVideoPaths(vDir, inDir, vIndex);

    const videoFile = path.join(vDir, `${videoId}.mp4`);
    await fs.writeFile(videoFile, 'mock-video-content');

    await writeJSON(vIndex, {
      schemaVersion: 1,
      videos: [{
        id: videoId,
        filename: `${videoId}.mp4`,
        originalName: 'source.mp4',
        probe: { width: 1920, height: 1080, fps: 30, durationSec: 60 },
        compatibility: { status: 'COMPATIBLE', modeAllowed: { copy: true, hybrid: true } },
      }],
    });

    await loadSettings();
    await loadState();

    await saveSettings({
      stream: {
        mode: 'horizontal',
        videoId,
        playlist: [videoId],
        playlists: { horizontal: [videoId], vertical: [] },
        rtmpSettleSeconds: 0,
      },
      youtube: {
        streamKey: 'test-key-gate-1234',
        studioAutomation: { enabled: true, bypassInTest: false },
      },
    });

    originalPrepare = YouTubeStudioAutomationService.prepareNextLiveSession;
  });

  afterEach(async () => {
    YouTubeStudioAutomationService.prepareNextLiveSession = originalPrepare;
    await stopStream({ reason: 'test_cleanup' });
  });

  test('1. startStream fails and blocks FFmpeg spawn when YouTube auth is required', async () => {
    // Mock YouTubeStudioAutomationService to throw YOUTUBE_AUTH_REQUIRED
    YouTubeStudioAutomationService.prepareNextLiveSession = async () => {
      const err = new Error('YOUTUBE_AUTH_REQUIRED: Login needed');
      err.code = 'YOUTUBE_AUTH_REQUIRED';
      throw err;
    };

    const result = await startStream({ reason: 'manual_start' });
    assert.equal(result.started, false);
    assert.equal(result.code, 'YOUTUBE_AUTH_REQUIRED');

    const state = getState();
    assert.equal(state.status, 'ERROR');
    assert.equal(state.youtubeStatus, 'YOUTUBE_AUTH_REQUIRED');
    assert.equal(state.ffmpegPid, null, 'FFmpeg PID must remain null');
  });

  test('2. startStream stops FFmpeg if YouTube preview confirmation times out', async () => {
    // Mock YouTubeStudioAutomationService to succeed in phase 1, but fail in phase 2 (preview confirmation)
    YouTubeStudioAutomationService.prepareNextLiveSession = async () => {
      return {
        sessionState: YOUTUBE_STATES.YOUTUBE_FRESH_STREAM_READY,
        confirmIngestAndClose: async () => {
          const err = new Error('YOUTUBE_PREVIEW_TIMEOUT: Preview timed out');
          err.code = 'YOUTUBE_PREVIEW_TIMEOUT';
          throw err;
        },
        abort: async () => {},
      };
    };

    const result = await startStream({ reason: 'manual_start' });
    assert.equal(result.started, false);
    assert.equal(result.code, 'YOUTUBE_PREVIEW_TIMEOUT');

    const state = getState();
    assert.equal(state.status, 'ERROR');
    assert.equal(state.youtubeStatus, 'YOUTUBE_PREVIEW_TIMEOUT');
  });
});
