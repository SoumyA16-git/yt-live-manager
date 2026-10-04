/**
 * test/unit/youtube-api-manager.test.js — Unit tests for YouTube Data API v3 integration.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initYouTubeApi,
  isYouTubeApiConfigured,
  getAccessToken,
  resolveLiveStreamByStreamKey,
  getLiveStreamStatus,
  resolveBoundBroadcast,
  transitionBroadcast,
  manageBroadcastLifecycleOnStart,
  getYouTubeLiveApiState,
  _resetStateForTest,
} from '../../src/youtube-api-manager.js';

describe('youtube-api-manager', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    _resetStateForTest();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    _resetStateForTest();
  });

  it('reports isYouTubeApiConfigured correctly', () => {
    assert.strictEqual(isYouTubeApiConfigured(), false);

    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    assert.strictEqual(isYouTubeApiConfigured(), true);
  });

  it('obtains and caches OAuth2 access token', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    let fetchCount = 0;
    global.fetch = async (url, opts) => {
      fetchCount++;
      assert.strictEqual(url, 'https://oauth2.googleapis.com/token');
      assert.strictEqual(opts.method, 'POST');
      return {
        ok: true,
        json: async () => ({
          access_token: 'mock-access-token-12345',
          expires_in: 3600,
        }),
      };
    };

    const token1 = await getAccessToken();
    assert.strictEqual(token1, 'mock-access-token-12345');
    assert.strictEqual(fetchCount, 1);

    // Second call should return cached token without fetching
    const token2 = await getAccessToken();
    assert.strictEqual(token2, 'mock-access-token-12345');
    assert.strictEqual(fetchCount, 1);
  });

  it('resolves liveStream by matching stream key against streamName', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    global.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-token', expires_in: 3600 }) };
      }
      if (url.includes('liveStreams')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'stream_111',
                snippet: { title: 'Other Stream' },
                cdn: { ingestionInfo: { streamName: 'wrong-key-9999' } },
                status: { streamStatus: 'inactive' },
              },
              {
                id: 'stream_222',
                snippet: { title: 'Target Stream' },
                cdn: { ingestionInfo: { streamName: 'shot' } },
                status: { streamStatus: 'active', healthStatus: { status: 'good' } },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await resolveLiveStreamByStreamKey('shot');
    assert.ok(result);
    assert.strictEqual(result.id, 'stream_222');
    assert.strictEqual(result.streamStatus, 'active');
    assert.strictEqual(result.healthStatus, 'good');
  });

  it('resolves bound broadcast by matching streamId with priority', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    global.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-token', expires_in: 3600 }) };
      }
      if (url.includes('liveBroadcasts')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'bcast_old',
                snippet: { title: 'Old Broadcast' },
                contentDetails: { boundStreamId: 'stream_222', enableAutoStart: false },
                status: { lifeCycleStatus: 'complete' },
              },
              {
                id: 'bcast_active',
                snippet: { title: 'Active 24x7 Broadcast' },
                contentDetails: { boundStreamId: 'stream_222', enableAutoStart: true },
                status: { lifeCycleStatus: 'ready' },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const broadcast = await resolveBoundBroadcast('stream_222');
    assert.ok(broadcast);
    assert.strictEqual(broadcast.id, 'bcast_active');
    assert.strictEqual(broadcast.lifeCycleStatus, 'ready');
    assert.strictEqual(broadcast.enableAutoStart, true);
  });

  it('transitions broadcast to live', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    global.fetch = async (url, opts) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-token', expires_in: 3600 }) };
      }
      if (url.includes('liveBroadcasts/transition')) {
        assert.strictEqual(opts.method, 'POST');
        assert.ok(url.includes('broadcastStatus=live'));
        return {
          ok: true,
          json: async () => ({
            id: 'bcast_123',
            status: { lifeCycleStatus: 'live' },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const res = await transitionBroadcast('bcast_123', 'live');
    assert.strictEqual(res.id, 'bcast_123');
    assert.strictEqual(res.lifeCycleStatus, 'live');
  });

  it('autonomous lifecycle management transitions ready broadcast when autoStart is false', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    let transitionCalled = false;

    global.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-token', expires_in: 3600 }) };
      }
      if (url.includes('liveStreams?part=id,snippet,status,cdn')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'stream_999',
                cdn: { ingestionInfo: { streamName: 'test-key' } },
                status: { streamStatus: 'active' },
              },
            ],
          }),
        };
      }
      if (url.includes('liveStreams?part=id,status&id=stream_999')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'stream_999', status: { streamStatus: 'active' } }],
          }),
        };
      }
      if (url.includes('liveBroadcasts?part=id,snippet,status,contentDetails')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'bcast_555',
                contentDetails: { boundStreamId: 'stream_999', enableAutoStart: false },
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
            id: 'bcast_555',
            status: { lifeCycleStatus: 'live' },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const lifecycle = await manageBroadcastLifecycleOnStart({
      streamKey: 'test-key',
      streamTimeoutSec: 5,
      liveTimeoutSec: 5,
    });

    assert.strictEqual(lifecycle.success, true);
    assert.strictEqual(lifecycle.liveStreamId, 'stream_999');
    assert.strictEqual(lifecycle.broadcastId, 'bcast_555');
    assert.strictEqual(lifecycle.lifeCycleStatus, 'live');
    assert.strictEqual(transitionCalled, true);
  });

  it('paginates liveStreams to find stream key on second page', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    global.fetch = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-token', expires_in: 3600 }) };
      }
      if (url.includes('liveStreams') && !url.includes('pageToken')) {
        return {
          ok: true,
          json: async () => ({
            nextPageToken: 'page_2_token',
            items: [
              {
                id: 'stream_page1',
                snippet: { title: 'First Page Stream' },
                cdn: { ingestionInfo: { streamName: 'other-key' } },
                status: { streamStatus: 'inactive' },
              },
            ],
          }),
        };
      }
      if (url.includes('pageToken=page_2_token')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'stream_page2',
                snippet: { title: 'Second Page Stream' },
                cdn: { ingestionInfo: { streamName: 'shot' } },
                status: { streamStatus: 'active' },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const resolved = await resolveLiveStreamByStreamKey('shot');
    assert.ok(resolved);
    assert.strictEqual(resolved.id, 'stream_page2');
    assert.strictEqual(resolved.streamStatus, 'active');
  });

  it('creates and binds a fresh broadcast when previous broadcast is complete (auto-recycle)', async () => {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    let createCalled = false;
    let bindCalled = false;

    global.fetch = async (url, opts) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, json: async () => ({ access_token: 'mock-token', expires_in: 3600 }) };
      }
      if (url.includes('liveStreams?part=id,snippet,status,cdn')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'stream_reused',
                cdn: { ingestionInfo: { streamName: 'shot' } },
                status: { streamStatus: 'active' },
              },
            ],
          }),
        };
      }
      if (url.includes('liveStreams?part=id,status&id=stream_reused')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'stream_reused', status: { streamStatus: 'active' } }],
          }),
        };
      }
      if (url.includes('liveBroadcasts?part=id,snippet,status,contentDetails') && !opts?.method) {
        // Return completed broadcast bound to this stream
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'bcast_old_completed',
                contentDetails: { boundStreamId: 'stream_reused', enableAutoStart: true },
                status: { lifeCycleStatus: 'complete' },
              },
            ],
          }),
        };
      }
      if (url.includes('liveBroadcasts?part=snippet,status,contentDetails') && opts?.method === 'POST') {
        createCalled = true;
        return {
          ok: true,
          json: async () => ({
            id: 'bcast_fresh_new',
            status: { lifeCycleStatus: 'ready' },
          }),
        };
      }
      if (url.includes('liveBroadcasts/bind') && opts?.method === 'POST') {
        bindCalled = true;
        return {
          ok: true,
          json: async () => ({ id: 'bcast_fresh_new' }),
        };
      }
      if (url.includes('liveBroadcasts/transition')) {
        return {
          ok: true,
          json: async () => ({
            id: 'bcast_fresh_new',
            status: { lifeCycleStatus: 'live' },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const lifecycle = await manageBroadcastLifecycleOnStart({
      streamKey: 'shot',
      streamTimeoutSec: 5,
      liveTimeoutSec: 5,
    });

    assert.strictEqual(createCalled, true);
    assert.strictEqual(bindCalled, true);
    assert.strictEqual(lifecycle.success, true);
    assert.strictEqual(lifecycle.broadcastId, 'bcast_fresh_new');
    assert.strictEqual(lifecycle.lifeCycleStatus, 'live');
  });
});
