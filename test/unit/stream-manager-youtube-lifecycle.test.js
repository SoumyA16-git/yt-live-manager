/**
 * test/unit/stream-manager-youtube-lifecycle.test.js — Tests YouTube API lifecycle integration in stream-manager.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  initYouTubeApi,
  _resetStateForTest as resetYouTubeApi,
} from '../../src/youtube-api-manager.js';
import {
  startStream,
  stopStream,
  getCurrentLifecyclePromise,
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
import { writeJSON } from '../../src/lib/atomic-json.js';

let tmpDir;
const originalFetch = global.fetch;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-sm-ytapi-test-'));
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
  await saveSettings({
    activeVideoId: 'vid_test1',
    youtube: {
      rtmpsUrl: 'rtmps://127.0.0.1/live2',
      title: 'Automated 24/7 Test Stream',
    },
  });

  await fs.writeFile(path.join(tmpDir, 'stream.key'), 'shot', { mode: 0o600 });
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetYouTubeApi();
});

afterEach(() => {
  global.fetch = originalFetch;
  resetYouTubeApi();
});

describe('stream-manager — YouTube lifecycle integration', () => {
  test('without YouTube API credentials: runs in unmanaged RTMPS mode', async () => {
    // Ensure API is not configured
    resetYouTubeApi();

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

  test('with YouTube API credentials: tracks stream activation and broadcast LIVE transition', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'client_123',
      YOUTUBE_CLIENT_SECRET: 'secret_456',
      YOUTUBE_REFRESH_TOKEN: 'refresh_789',
    });

    let transitionCalled = false;

    global.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-access-token', expires_in: 3600 }) };
      }
      if (url.includes('liveStreams?part=id,snippet,status,cdn')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'stream_shot_id',
                cdn: { ingestionInfo: { streamName: 'shot' } },
                status: { streamStatus: 'active' },
              },
            ],
          }),
        };
      }
      if (url.includes('liveStreams?part=id,status&id=stream_shot_id')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'stream_shot_id', status: { streamStatus: 'active' } }],
          }),
        };
      }
      if (url.includes('liveBroadcasts?part=id,snippet,status,contentDetails')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'broadcast_target_id',
                contentDetails: { boundStreamId: 'stream_shot_id', enableAutoStart: false },
                status: { lifeCycleStatus: transitionCalled ? 'live' : 'ready' },
              },
            ],
          }),
        };
      }
      if (url.includes('liveBroadcasts/transition')) {
        transitionCalled = true;
        return {
          ok: true,
          json: async () => ({
            id: 'broadcast_target_id',
            status: { lifeCycleStatus: 'live' },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    // Test the lifecycle manager directly using the same config
    const { manageBroadcastLifecycleOnStart } = await import('../../src/youtube-api-manager.js');
    const result = await manageBroadcastLifecycleOnStart({
      streamKey: 'shot',
      title: 'Automated 24/7 Test Stream',
      streamTimeoutSec: 5,
      liveTimeoutSec: 5,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.streamStatus, 'active');
    assert.strictEqual(result.lifeCycleStatus, 'live');
    assert.strictEqual(result.liveStreamId, 'stream_shot_id');
    assert.strictEqual(result.broadcastId, 'broadcast_target_id');
    assert.strictEqual(transitionCalled, true);

    // Save state as onHealthy does
    await saveState({
      youtubeStreamActive: true,
      youtubeBroadcastLive: true,
      youtubeIngest: 'ACTIVE',
      youtubeBroadcast: 'LIVE',
      liveStreamId: result.liveStreamId,
      broadcastId: result.broadcastId,
    });

    const st = getState();
    assert.strictEqual(st.youtubeStreamActive, true);
    assert.strictEqual(st.youtubeBroadcastLive, true);
    assert.strictEqual(st.youtubeIngest, 'ACTIVE');
    assert.strictEqual(st.youtubeBroadcast, 'LIVE');
  });

  test('reports failure when stream key cannot be resolved across pages', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'client_123',
      YOUTUBE_CLIENT_SECRET: 'secret_456',
      YOUTUBE_REFRESH_TOKEN: 'refresh_789',
    });

    global.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-access-token', expires_in: 3600 }) };
      }
      if (url.includes('liveStreams')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'stream_unrelated',
                cdn: { ingestionInfo: { streamName: 'different_key' } },
                status: { streamStatus: 'inactive' },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { manageBroadcastLifecycleOnStart } = await import('../../src/youtube-api-manager.js');
    const result = await manageBroadcastLifecycleOnStart({
      streamKey: 'shot',
      streamTimeoutSec: 2,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'STREAM_KEY_NOT_MATCHED');
  });

  test('when enableAutoStart is true and broadcast auto-transitions to live, explicit transition API is skipped', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'client_123',
      YOUTUBE_CLIENT_SECRET: 'secret_456',
      YOUTUBE_REFRESH_TOKEN: 'refresh_789',
    });

    let transitionCalled = false;
    let pollCount = 0;

    global.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-access-token', expires_in: 3600 }) };
      }
      if (url.includes('liveStreams?part=id,snippet,status,cdn')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'stream_autostart_id',
                cdn: { ingestionInfo: { streamName: 'shot' } },
                status: { streamStatus: 'active' },
              },
            ],
          }),
        };
      }
      if (url.includes('liveStreams?part=id,status&id=stream_autostart_id')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'stream_autostart_id', status: { streamStatus: 'active' } }],
          }),
        };
      }
      if (url.includes('liveBroadcasts?part=id,snippet,status,contentDetails')) {
        pollCount++;
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'broadcast_autostart_id',
                contentDetails: { boundStreamId: 'stream_autostart_id', enableAutoStart: true },
                // Simulates YouTube auto-transitioning from ready -> live
                status: { lifeCycleStatus: pollCount > 1 ? 'live' : 'ready' },
              },
            ],
          }),
        };
      }
      if (url.includes('liveBroadcasts/transition')) {
        transitionCalled = true;
        throw new Error('Transition should not be called when enableAutoStart succeeds');
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { manageBroadcastLifecycleOnStart } = await import('../../src/youtube-api-manager.js');
    const result = await manageBroadcastLifecycleOnStart({
      streamKey: 'shot',
      streamTimeoutSec: 5,
      liveTimeoutSec: 5,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.lifeCycleStatus, 'live');
    assert.strictEqual(result.broadcastId, 'broadcast_autostart_id');
    assert.strictEqual(transitionCalled, false, 'Explicit transition must NOT be called when YouTube auto-starts');
  });
});
