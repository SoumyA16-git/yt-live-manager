/**
 * test/unit/dual-youtube-broadcast-lifecycle.test.js
 *
 * Dedicated tests for Dual YouTube Broadcast Lifecycle:
 * - Resolving primary and secondary LiveStreams independently
 * - Resolving or creating dedicated LiveBroadcast resources for both
 * - Binding broadcastPrimary -> liveStreamPrimary and broadcastSecondary -> liveStreamSecondary
 * - Enforcing rejection of completed broadcasts (creating fresh)
 * - Independent dynamic title generation
 * - Applying template metadata to both broadcasts
 * - Transitioning both to LIVE and reporting dual broadcast status
 * - Atomic failure handling if secondary broadcast fails
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initYouTubeApi,
  isYouTubeApiConfigured,
  resolveOrCreateBroadcastForStream,
  resolveOrCreatePrimaryBroadcast,
  resolveOrCreateSecondaryBroadcast,
  manageBroadcastLifecycleOnStart,
  transitionBroadcast,
  getYouTubeLiveApiState,
  _resetStateForTest,
} from '../../src/youtube-api-manager.js';

describe('Dual YouTube Broadcast Lifecycle', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    _resetStateForTest();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    _resetStateForTest();
  });

  function setupMockYouTubeApi(customHandler) {
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    global.fetch = async (url, opts = {}) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          json: async () => ({ access_token: 'mock-token-xyz', expires_in: 3600 }),
        };
      }
      return customHandler(url, opts);
    };
  }

  it('rejects completed broadcast and creates fresh broadcast bound to horizontal stream', async () => {
    const horizontalStreamId = 'stream_horizontal_123';
    let insertedBroadcast = null;
    let boundBroadcastId = null;
    let boundStreamId = null;

    setupMockYouTubeApi(async (url, opts) => {
      // 1. liveBroadcasts.list - returns an existing broadcast that is 'complete'
      if (url.includes('liveBroadcasts') && (!opts.method || opts.method === 'GET')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'bcast_old_completed',
                snippet: { title: 'Old Chinese Street Food' },
                status: { lifeCycleStatus: 'complete' },
                contentDetails: { boundStreamId: horizontalStreamId },
              },
            ],
          }),
        };
      }

      // 2. liveBroadcasts.insert - create fresh broadcast
      if (url.includes('liveBroadcasts') && opts.method === 'POST' && !url.includes('/bind')) {
        insertedBroadcast = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            id: 'bcast_fresh_horizontal_999',
            snippet: insertedBroadcast.snippet,
            status: { lifeCycleStatus: 'created' },
            contentDetails: {},
          }),
        };
      }

      // 3. liveBroadcasts/bind
      if (url.includes('liveBroadcasts/bind') && opts.method === 'POST') {
        const u = new URL(url);
        boundBroadcastId = u.searchParams.get('id');
        boundStreamId = u.searchParams.get('streamId');
        return {
          ok: true,
          json: async () => ({
            id: boundBroadcastId,
            contentDetails: { boundStreamId },
            status: { lifeCycleStatus: 'ready' },
          }),
        };
      }

      // 4. videos.update (metadata)
      if (url.includes('videos?part=snippet') && opts.method === 'PUT') {
        return { ok: true, json: async () => ({ id: 'bcast_fresh_horizontal_999' }) };
      }

      throw new Error(`Unhandled mock URL: ${url} (${opts.method})`);
    });

    const result = await resolveOrCreateSecondaryBroadcast({
      streamId: horizontalStreamId,
      title: 'Chinese Street Food Live Streaming Mochi "05-10-2026" "04:15 AM"',
      metadata: {
        description: 'Test dual horizontal description',
        categoryId: '26',
        tags: ['mochi', 'streetfood'],
      },
    });

    assert.ok(result);
    assert.strictEqual(result.id, 'bcast_fresh_horizontal_999');
    assert.strictEqual(boundBroadcastId, 'bcast_fresh_horizontal_999');
    assert.strictEqual(boundStreamId, horizontalStreamId);
    assert.strictEqual(insertedBroadcast.snippet.title, 'Chinese Street Food Live Streaming Mochi "05-10-2026" "04:15 AM"');
  });

  it('reuses existing usable broadcast if already bound and in ready/live state', async () => {
    const horizontalStreamId = 'stream_horizontal_456';
    let insertCalled = false;

    setupMockYouTubeApi(async (url, opts) => {
      if (url.includes('liveBroadcasts') && (!opts.method || opts.method === 'GET')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'bcast_existing_ready',
                snippet: { title: 'Usable Broadcast' },
                status: { lifeCycleStatus: 'ready' },
                contentDetails: { boundStreamId: horizontalStreamId },
              },
            ],
          }),
        };
      }
      if (url.includes('videos?part=snippet') && opts.method === 'PUT') {
        return { ok: true, json: async () => ({ id: 'bcast_existing_ready' }) };
      }
      if (url.includes('liveBroadcasts') && opts.method === 'POST') {
        insertCalled = true;
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected mock URL: ${url}`);
    });

    const result = await resolveOrCreateSecondaryBroadcast({
      streamId: horizontalStreamId,
      title: 'New Title',
    });

    assert.strictEqual(result.id, 'bcast_existing_ready');
    assert.strictEqual(result.title, 'New Title', 'Should synchronize reused broadcast title to session title');
    assert.strictEqual(insertCalled, false, 'Should reuse existing ready broadcast instead of inserting new one');
  });

  it('manages complete dual broadcast lifecycle from stream resolution to LIVE transition', async () => {
    const primaryKey = 'vert-key-111';
    const secondaryKey = 'horiz-key-222';
    const primaryStreamId = 'stream_vert_id_1';
    const secondaryStreamId = 'stream_horiz_id_2';

    const transitions = [];
    const bindings = [];

    setupMockYouTubeApi(async (url, opts) => {
      // liveStreams.list
      if (url.includes('liveStreams') && (!opts.method || opts.method === 'GET')) {
        const u = new URL(url);
        const idParam = u.searchParams.get('id');

        if (idParam === primaryStreamId) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: primaryStreamId, status: { streamStatus: 'active', healthStatus: { status: 'good' } } }],
            }),
          };
        }
        if (idParam === secondaryStreamId) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: secondaryStreamId, status: { streamStatus: 'active', healthStatus: { status: 'good' } } }],
            }),
          };
        }

        // list mine
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: primaryStreamId,
                snippet: { title: 'Vertical Stream' },
                cdn: { ingestionInfo: { streamName: primaryKey } },
                status: { streamStatus: 'active', healthStatus: { status: 'good' } },
              },
              {
                id: secondaryStreamId,
                snippet: { title: 'Horizontal Stream' },
                cdn: { ingestionInfo: { streamName: secondaryKey } },
                status: { streamStatus: 'active', healthStatus: { status: 'good' } },
              },
            ],
          }),
        };
      }

      // liveBroadcasts.list
      if (url.includes('liveBroadcasts') && (!opts.method || opts.method === 'GET')) {
        const u = new URL(url);
        const idParam = u.searchParams.get('id');
        if (idParam === 'bcast_vert_100') {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: 'bcast_vert_100', status: { lifeCycleStatus: 'live' }, contentDetails: { boundStreamId: primaryStreamId } }],
            }),
          };
        }
        if (idParam === 'bcast_horiz_200') {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: 'bcast_horiz_200', status: { lifeCycleStatus: 'live' }, contentDetails: { boundStreamId: secondaryStreamId } }],
            }),
          };
        }
        // broadcast list mine — return empty to trigger creation of both
        return { ok: true, json: async () => ({ items: [] }) };
      }

      // liveBroadcasts.insert
      if (url.includes('liveBroadcasts') && opts.method === 'POST' && !url.includes('/bind') && !url.includes('/transition')) {
        const body = JSON.parse(opts.body);
        const bcastId = body.snippet.title.includes('Horizontal') || bindings.length > 0 ? 'bcast_horiz_200' : 'bcast_vert_100';
        return {
          ok: true,
          json: async () => ({
            id: bcastId,
            snippet: body.snippet,
            status: { lifeCycleStatus: 'created' },
            contentDetails: {},
          }),
        };
      }

      // liveBroadcasts/bind
      if (url.includes('liveBroadcasts/bind') && opts.method === 'POST') {
        const u = new URL(url);
        const bid = u.searchParams.get('id');
        const sid = u.searchParams.get('streamId');
        bindings.push({ broadcastId: bid, streamId: sid });
        return {
          ok: true,
          json: async () => ({
            id: bid,
            contentDetails: { boundStreamId: sid },
            status: { lifeCycleStatus: 'ready' },
          }),
        };
      }

      // liveBroadcasts/transition
      if (url.includes('liveBroadcasts/transition') && opts.method === 'POST') {
        const u = new URL(url);
        const bid = u.searchParams.get('id');
        const st = u.searchParams.get('broadcastStatus');
        transitions.push({ broadcastId: bid, status: st });
        return {
          ok: true,
          json: async () => ({
            id: bid,
            status: { lifeCycleStatus: st },
          }),
        };
      }

      // videos.update (metadata)
      if (url.includes('videos?part=snippet') && opts.method === 'PUT') {
        return { ok: true, json: async () => ({ id: 'mock_vid' }) };
      }

      throw new Error(`Unhandled mock URL: ${url} (${opts.method})`);
    });

    const result = await manageBroadcastLifecycleOnStart({
      streamKey: primaryKey,
      secondaryStreamKey: secondaryKey,
      isDual: true,
      title: 'Chinese Street Food Live Streaming Mochi',
      streamTimeoutSec: 5,
      liveTimeoutSec: 5,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.broadcastId, 'bcast_vert_100');
    // In single-broadcast model, secondary broadcast references point to the same broadcast ID
    assert.strictEqual(result.primaryBroadcastId, 'bcast_vert_100');
    assert.strictEqual(result.secondaryBroadcastId, 'bcast_vert_100');

    // Verify bindings: Only the single broadcast is bound to the primary stream
    assert.strictEqual(bindings.length, 1, 'Should bind exactly ONE broadcast to primary stream');
    assert.deepStrictEqual(bindings[0], { broadcastId: 'bcast_vert_100', streamId: primaryStreamId });

    // Verify transitions to live: Only the single broadcast is transitioned to live
    assert.strictEqual(transitions.length, 1, 'Should transition exactly ONE broadcast to LIVE');
    assert.deepStrictEqual(transitions[0], { broadcastId: 'bcast_vert_100', status: 'live' });

    // Verify state
    const apiState = getYouTubeLiveApiState();
    assert.strictEqual(apiState.isDualLive, true);
    assert.strictEqual(apiState.primaryBroadcastId, 'bcast_vert_100');
    assert.strictEqual(apiState.secondaryBroadcastId, null, 'No separate secondary broadcast resource');
    assert.strictEqual(apiState.primaryBroadcastStatus, 'live');
    assert.strictEqual(apiState.primaryStreamStatus, 'active');
    assert.strictEqual(apiState.secondaryStreamStatus, 'active');
    assert.strictEqual(apiState.primaryStreamId, primaryStreamId);
    assert.strictEqual(apiState.secondaryStreamId, secondaryStreamId);
  });

  it('fails cleanly and reports failure if secondary broadcast transition fails', async () => {
    const primaryKey = 'vert-key-111';
    const secondaryKey = 'horiz-key-222';
    const primaryStreamId = 'stream_vert_id_1';
    const secondaryStreamId = 'stream_horiz_id_2';

    setupMockYouTubeApi(async (url, opts) => {
      // liveStreams
      if (url.includes('liveStreams') && (!opts.method || opts.method === 'GET')) {
        const u = new URL(url);
        const idParam = u.searchParams.get('id');
        if (idParam) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: idParam, status: { streamStatus: 'active', healthStatus: { status: 'good' } } }],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: primaryStreamId, snippet: {}, cdn: { ingestionInfo: { streamName: primaryKey } }, status: { streamStatus: 'active' } },
              { id: secondaryStreamId, snippet: {}, cdn: { ingestionInfo: { streamName: secondaryKey } }, status: { streamStatus: 'active' } },
            ],
          }),
        };
      }

      // liveBroadcasts.list (no usable)
      if (url.includes('liveBroadcasts') && (!opts.method || opts.method === 'GET')) {
        const u = new URL(url);
        const idParam = u.searchParams.get('id');
        if (idParam === 'bcast_vert_1') {
          return { ok: true, json: async () => ({ items: [{ id: 'bcast_vert_1', status: { lifeCycleStatus: 'live' } }] }) };
        }
        return { ok: true, json: async () => ({ items: [] }) };
      }

      // liveBroadcasts.insert
      if (url.includes('liveBroadcasts') && opts.method === 'POST' && !url.includes('/bind') && !url.includes('/transition')) {
        return { ok: true, json: async () => ({ id: 'bcast_id_' + Math.random(), snippet: {}, status: { lifeCycleStatus: 'created' } }) };
      }

      // liveBroadcasts/bind
      if (url.includes('liveBroadcasts/bind')) {
        const u = new URL(url);
        return { ok: true, json: async () => ({ id: u.searchParams.get('id'), status: { lifeCycleStatus: 'ready' } }) };
      }

      // liveBroadcasts/transition
      if (url.includes('liveBroadcasts/transition')) {
        const u = new URL(url);
        const bid = u.searchParams.get('id');
        if (bid.includes('bcast_id_')) {
          // Simulate transition failure on secondary broadcast
          return {
            ok: false,
            status: 400,
            json: async () => ({
              error: { code: 400, message: 'Invalid broadcast transition', errors: [{ reason: 'invalidTransition' }] },
            }),
          };
        }
        return { ok: true, json: async () => ({ id: bid, status: { lifeCycleStatus: 'live' } }) };
      }

      if (url.includes('videos?part=snippet')) {
        return { ok: true, json: async () => ({}) };
      }

      throw new Error(`Unhandled mock URL: ${url}`);
    });

    const result = await manageBroadcastLifecycleOnStart({
      streamKey: primaryKey,
      secondaryStreamKey: secondaryKey,
      isDual: true,
      title: 'Chinese Street Food Live Streaming Mochi',
      streamTimeoutSec: 2,
      liveTimeoutSec: 2,
    });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /transition to live failed/i);

    const apiState = getYouTubeLiveApiState();
    assert.notStrictEqual(apiState.secondaryBroadcastStatus, 'live');
  });

  it('generates ONE session timestamp and identical dynamic title for both primary and secondary broadcasts in the same dual session', async () => {
    const primaryKey = 'vert-key-111';
    const secondaryKey = 'horiz-key-222';
    const primaryStreamId = 'stream_vert_id_1';
    const secondaryStreamId = 'stream_horiz_id_2';

    const createdTitles = [];

    setupMockYouTubeApi(async (url, opts) => {
      // liveStreams
      if (url.includes('liveStreams') && (!opts.method || opts.method === 'GET')) {
        const u = new URL(url);
        const idParam = u.searchParams.get('id');
        if (idParam) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: idParam, status: { streamStatus: 'active', healthStatus: { status: 'good' } } }],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: primaryStreamId, snippet: {}, cdn: { ingestionInfo: { streamName: primaryKey } }, status: { streamStatus: 'active' } },
              { id: secondaryStreamId, snippet: {}, cdn: { ingestionInfo: { streamName: secondaryKey } }, status: { streamStatus: 'active' } },
            ],
          }),
        };
      }

      // liveBroadcasts.list (no existing)
      if (url.includes('liveBroadcasts') && (!opts.method || opts.method === 'GET')) {
        const u = new URL(url);
        const idParam = u.searchParams.get('id');
        if (idParam) {
          return { ok: true, json: async () => ({ items: [{ id: idParam, status: { lifeCycleStatus: 'live' } }] }) };
        }
        return { ok: true, json: async () => ({ items: [] }) };
      }

      // liveBroadcasts.insert
      if (url.includes('liveBroadcasts') && opts.method === 'POST' && !url.includes('/bind') && !url.includes('/transition')) {
        const body = JSON.parse(opts.body);
        createdTitles.push(body.snippet.title);
        return {
          ok: true,
          json: async () => ({
            id: 'bcast_' + createdTitles.length,
            snippet: body.snippet,
            status: { lifeCycleStatus: 'created' },
            contentDetails: {},
          }),
        };
      }

      // liveBroadcasts/bind
      if (url.includes('liveBroadcasts/bind')) {
        return { ok: true, json: async () => ({ id: 'mock', status: { lifeCycleStatus: 'ready' } }) };
      }

      // liveBroadcasts/transition
      if (url.includes('liveBroadcasts/transition')) {
        return { ok: true, json: async () => ({ id: 'mock', status: { lifeCycleStatus: 'live' } }) };
      }

      if (url.includes('videos?part=snippet')) {
        return { ok: true, json: async () => ({}) };
      }

      throw new Error(`Unhandled mock URL: ${url}`);
    });

    const result = await manageBroadcastLifecycleOnStart({
      streamKey: primaryKey,
      secondaryStreamKey: secondaryKey,
      isDual: true,
      title: '', // Empty: trigger automatic dynamic title generation
      streamTimeoutSec: 2,
      liveTimeoutSec: 2,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(createdTitles.length, 1, 'Should create exactly ONE broadcast for Dual Stream session');
    assert.match(createdTitles[0], /^Chinese Street Food Live Streaming Mochi "\d{2}-\d{2}-\d{4}" "\d{2}:\d{2} (?:AM|PM)"$/);
  });
});
