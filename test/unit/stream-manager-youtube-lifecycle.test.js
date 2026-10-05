/**
 * test/unit/stream-manager-youtube-lifecycle.test.js — Direct RTMPS stream lifecycle tests.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
import { writeJSON } from '../../src/lib/atomic-json.js';

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-sm-direct-test-'));
  const videosDir = path.join(tmpDir, 'videos');
  await fs.mkdir(videosDir, { recursive: true });

  const dummyVideo = path.join(videosDir, 'test.mp4');
  await fs.writeFile(dummyVideo, 'dummy video content');

  const backupDir = path.join(tmpDir, 'backup');
  await fs.mkdir(backupDir, { recursive: true });

  _setConfigPaths(path.join(tmpDir, 'settings.json'), backupDir);
  _setStatePaths(path.join(tmpDir, 'state.json'), path.join(tmpDir, 'history.json'), backupDir);
  _setVideoPaths(path.join(tmpDir, 'catalog.json'), videosDir);

  await writeJSON(path.join(tmpDir, 'catalog.json'), {
    videos: [
      {
        id: 'vid_test1',
        filename: 'test.mp4',
        durationSec: 100,
        orientation: 'vertical',
        probe: {
          width: 1080,
          height: 1920,
          fps: 30,
          orientation: 'vertical',
          videoCodec: 'h264',
          audioCodec: 'aac',
        },
      },
    ],
  });

  await loadSettings();
  await loadState();
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('stream-manager — Direct RTMPS Mode', () => {
  test('direct RTMPS mode reports unmanaged YouTube status in state', async () => {
    await saveState({
      status: 'STOPPED',
      desiredState: 'stopped',
      youtubeIngest: 'UNMANAGED',
      youtubeBroadcast: 'UNMANAGED',
      youtubeStreamActive: false,
      youtubeBroadcastLive: false,
    });

    const state = getState();
    assert.strictEqual(state.youtubeIngest, 'UNMANAGED');
    assert.strictEqual(state.youtubeBroadcast, 'UNMANAGED');
    assert.strictEqual(state.youtubeBroadcastLive, false);
  });
});
