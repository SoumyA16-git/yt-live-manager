/**
 * test/unit/youtube-template.test.js — Exhaustive unit tests for YouTube Template Metadata feature.
 *
 * Tests all 20 required specifications:
 * 1. Template video sync.
 * 2. Description extraction.
 * 3. Category extraction.
 * 4. Category name resolution.
 * 5. Tags extraction.
 * 6. Thumbnail extraction.
 * 7. Dashboard save.
 * 8. Dashboard reload.
 * 9. Dynamic title generation.
 * 10. Asia/Kolkata timezone.
 * 11. New broadcast receives description.
 * 12. New broadcast receives category.
 * 13. New broadcast receives tags.
 * 14. New broadcast receives thumbnail.
 * 15. Source title is NOT copied.
 * 16. Auto-recycle gets the same metadata.
 * 17. Auto-recycle gets a NEW title.
 * 18. Existing source video is never modified.
 * 19. Invalid template video ID is rejected.
 * 20. Metadata API failure is reported correctly.
 */

import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  initYouTubeApi,
  getAccessToken,
  fetchTemplateVideoMetadata,
  fetchVideoCategories,
  resolveCategoryName,
  updateVideoMetadata,
  applyVideoThumbnail,
  createAndBindBroadcast,
  generateBroadcastTitle,
  getYouTubeLiveApiState,
  _resetStateForTest,
} from '../../src/youtube-api-manager.js';

import {
  loadSettings,
  saveSettings,
  getSettings,
  _setPathsForTest as _setConfigPaths,
} from '../../src/config-manager.js';

import { createApp } from '../../src/server.js';
import { hashPassword } from '../../src/auth.js';
import { _setPathsForTest as _setStatePaths, loadState } from '../../src/state-manager.js';
import { _setPathsForTest as _setUsagePaths, loadUsage } from '../../src/usage-manager.js';
import { _setPathsForTest as _setVideoPaths } from '../../src/video-manager.js';

describe('YouTube Live Template Metadata Feature (20 Specifications)', () => {
  const originalFetch = global.fetch;
  let tmpDir;
  let server;
  let baseUrl;
  let sessionCookie = '';
  let csrfToken = '';

  const TEST_USER = 'admin';
  const TEST_PASS = 'AdminTest123!';
  const TEST_SECRET = 'secret-for-youtube-template-test';
  const TEST_CHANNEL_ID = 'UC_CHANNEL_MINE_123';
  const TEST_TEMPLATE_ID = 'dQw4w9WgXcQ';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-template-test-'));
    const sPath = path.join(tmpDir, 'settings.json');
    const stPath = path.join(tmpDir, 'state.json');
    const hPath = path.join(tmpDir, 'history.json');
    const uPath = path.join(tmpDir, 'usage.json');
    const vDir = path.join(tmpDir, 'videos');
    const inDir = path.join(tmpDir, 'incoming');
    const vIndex = path.join(tmpDir, 'vindex.json');
    const bDir = path.join(tmpDir, 'backups');

    await fs.mkdir(vDir, { recursive: true });
    await fs.mkdir(inDir, { recursive: true });

    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);
    _setUsagePaths(uPath, bDir);
    _setVideoPaths(vDir, inDir, vIndex);

    await loadSettings();
    await loadState();
    await loadUsage();

    const hash = await hashPassword(TEST_PASS);
    const app = await createApp({
      ADMIN_USERNAME: TEST_USER,
      ADMIN_PASSWORD_HASH: hash,
      SESSION_SECRET: TEST_SECRET,
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // Obtain session cookie and CSRF token
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
    });
    const body = await res.json();
    csrfToken = body.csrfToken;
    sessionCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  });

  after(async () => {
    if (server) {
      await new Promise(r => server.close(r));
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetStateForTest();
    initYouTubeApi({
      YOUTUBE_CLIENT_ID: 'test-client-id',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    _resetStateForTest();
  });

  function mockYouTubeApi(handlers = {}) {
    global.fetch = async (url, opts = {}) => {
      const urlStr = String(url);

      if (urlStr === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          json: async () => ({ access_token: 'mock-access-token-xyz', expires_in: 3600 }),
        };
      }

      if (handlers.custom) {
        const customRes = await handlers.custom(urlStr, opts);
        if (customRes) return customRes;
      }

      if (urlStr.includes('channels?part=id&mine=true')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: handlers.channelId || TEST_CHANNEL_ID }],
          }),
        };
      }

      if (urlStr.includes('videoCategories?part=snippet')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: '22', snippet: { title: 'People & Blogs', assignable: true } },
              { id: '24', snippet: { title: 'Entertainment', assignable: true } },
              { id: '26', snippet: { title: 'Howto & Style', assignable: true } },
            ],
          }),
        };
      }

      if (urlStr.includes(`videos?part=snippet,status&id=${TEST_TEMPLATE_ID}`)) {
        return {
          ok: true,
          json: async () => ({
            items: [{
              id: TEST_TEMPLATE_ID,
              snippet: {
                title: 'Old Template Title That Must Not Be Copied',
                description: 'Authentic Chinese Street Food artisan master preparation stream',
                categoryId: '26',
                channelId: handlers.videoChannelId || TEST_CHANNEL_ID,
                tags: ['Chinese Street Food', 'Mochi', 'Street Food', 'Food Live'],
                thumbnails: {
                  default: { url: 'https://i.ytimg.com/vi/mock/default.jpg' },
                  medium: { url: 'https://i.ytimg.com/vi/mock/mqdefault.jpg' },
                  high: { url: 'https://i.ytimg.com/vi/mock/hqdefault.jpg' },
                  standard: { url: 'https://i.ytimg.com/vi/mock/sddefault.jpg' },
                  maxres: { url: 'https://i.ytimg.com/vi/mock/maxresdefault.jpg' },
                },
              },
            }],
          }),
        };
      }

      if (urlStr.startsWith('https://i.ytimg.com/')) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'image/jpeg' }),
          arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer,
        };
      }

      if (urlStr.includes('liveBroadcasts?part=snippet,status,contentDetails') && opts.method === 'POST') {
        const bodyObj = JSON.parse(opts.body);
        handlers.insertedBroadcast = bodyObj;
        return {
          ok: true,
          json: async () => ({ id: 'new_bcast_test_1', snippet: bodyObj.snippet }),
        };
      }

      if (urlStr.includes('liveBroadcasts/bind') && opts.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 'new_bcast_test_1', status: { lifeCycleStatus: 'ready' } }),
        };
      }

      if (urlStr.includes('videos?part=snippet') && opts.method === 'PUT') {
        const bodyObj = JSON.parse(opts.body);
        handlers.updatedVideo = bodyObj;
        return {
          ok: true,
          json: async () => ({ id: bodyObj.id, snippet: bodyObj.snippet }),
        };
      }

      if (urlStr.includes('thumbnails/set') && opts.method === 'POST') {
        handlers.thumbnailUploaded = true;
        handlers.thumbnailTargetUrl = urlStr;
        return {
          ok: true,
          json: async () => ({ items: [{ default: { url: 'https://i.ytimg.com/vi/new/default.jpg' } }] }),
        };
      }

      return {
        ok: true,
        json: async () => ({ items: [] }),
      };
    };
  }

  // ─── Test 1: Template video sync ──────────────────────────────────────────────
  test('1. Template video sync fetches video and returns metadata', async () => {
    mockYouTubeApi();
    const meta = await fetchTemplateVideoMetadata(TEST_TEMPLATE_ID);
    assert.ok(meta);
    assert.strictEqual(meta.templateVideoId, TEST_TEMPLATE_ID);
  });

  // ─── Test 2: Description extraction ───────────────────────────────────────────
  test('2. Description extraction extracts snippet.description from template', async () => {
    mockYouTubeApi();
    const meta = await fetchTemplateVideoMetadata(TEST_TEMPLATE_ID);
    assert.strictEqual(meta.description, 'Authentic Chinese Street Food artisan master preparation stream');
  });

  // ─── Test 3: Category extraction ──────────────────────────────────────────────
  test('3. Category extraction extracts snippet.categoryId from template', async () => {
    mockYouTubeApi();
    const meta = await fetchTemplateVideoMetadata(TEST_TEMPLATE_ID);
    assert.strictEqual(meta.categoryId, '26');
  });

  // ─── Test 4: Category name resolution ─────────────────────────────────────────
  test('4. Category name resolution resolves display name using videoCategories.list', async () => {
    mockYouTubeApi();
    const catName = await resolveCategoryName('26');
    assert.strictEqual(catName, 'Howto & Style');

    const meta = await fetchTemplateVideoMetadata(TEST_TEMPLATE_ID);
    assert.strictEqual(meta.categoryName, 'Howto & Style');
  });

  // ─── Test 5: Tags extraction ──────────────────────────────────────────────────
  test('5. Tags extraction extracts snippet.tags array from template', async () => {
    mockYouTubeApi();
    const meta = await fetchTemplateVideoMetadata(TEST_TEMPLATE_ID);
    assert.deepStrictEqual(meta.tags, ['Chinese Street Food', 'Mochi', 'Street Food', 'Food Live']);
  });

  // ─── Test 6: Thumbnail extraction ─────────────────────────────────────────────
  test('6. Thumbnail extraction extracts highest available resolution URL from snippet.thumbnails', async () => {
    mockYouTubeApi();
    const meta = await fetchTemplateVideoMetadata(TEST_TEMPLATE_ID);
    assert.strictEqual(meta.thumbnail.sourceVideoId, TEST_TEMPLATE_ID);
    assert.strictEqual(meta.thumbnail.sourceUrl, 'https://i.ytimg.com/vi/mock/maxresdefault.jpg');
    assert.strictEqual(meta.thumbnail.selectedResolution, 'maxres');
  });

  // ─── Test 7: Dashboard save ───────────────────────────────────────────────────
  test('7. Dashboard save persists metadata settings via PUT /api/youtube/template', async () => {
    const payload = {
      templateVideoId: TEST_TEMPLATE_ID,
      description: 'Saved test description',
      categoryId: '26',
      categoryName: 'Howto & Style',
      tags: ['Tag1', 'Tag2'],
      thumbnail: {
        sourceVideoId: TEST_TEMPLATE_ID,
        sourceUrl: 'https://i.ytimg.com/vi/mock/maxresdefault.jpg',
        selectedResolution: 'maxres',
        customDataUrl: '',
      },
    };

    const res = await fetch(`${baseUrl}/api/youtube/template`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(payload),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.metadata.description, 'Saved test description');
    assert.strictEqual(data.metadata.categoryId, '26');
    assert.deepStrictEqual(data.metadata.tags, ['Tag1', 'Tag2']);
  });

  // ─── Test 8: Dashboard reload ─────────────────────────────────────────────────
  test('8. Dashboard reload retrieves saved metadata via GET /api/youtube/template', async () => {
    const res = await fetch(`${baseUrl}/api/youtube/template`, {
      headers: {
        Cookie: sessionCookie,
      },
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.templateVideoId, TEST_TEMPLATE_ID);
    assert.strictEqual(data.description, 'Saved test description');
    assert.strictEqual(data.categoryId, '26');
    assert.deepStrictEqual(data.tags, ['Tag1', 'Tag2']);
    assert.strictEqual(data.titleTemplate, 'Chinese Street Food Live Streaming Mochi "{DATE}" "{TIME}"');
  });

  // ─── Test 9: Dynamic title generation ─────────────────────────────────────────
  test('9. Dynamic title generation formats title with prefix and quoted date and time', () => {
    const title = generateBroadcastTitle(new Date('2026-10-05T06:30:00.000Z'));
    assert.ok(title.startsWith('Chinese Street Food Live Streaming Mochi '));
    assert.match(title, /^Chinese Street Food Live Streaming Mochi "\d{2}-\d{2}-\d{4}" "\d{2}:\d{2} (AM|PM)"$/);
  });

  // ─── Test 10: Asia/Kolkata timezone ───────────────────────────────────────────
  test('10. Asia/Kolkata timezone converts UTC timestamp to IST (+5:30) correctly', () => {
    // 2026-10-05 18:12 UTC is 2026-10-05 23:42 IST
    const date = new Date('2026-10-05T18:12:00.000Z');
    const title = generateBroadcastTitle(date);
    assert.strictEqual(title, 'Chinese Street Food Live Streaming Mochi "05-10-2026" "11:42 PM"');

    // 2026-10-05 19:28 UTC is 2026-10-06 00:58 IST
    const dateRoll = new Date('2026-10-05T19:28:00.000Z');
    const titleRoll = generateBroadcastTitle(dateRoll);
    assert.strictEqual(titleRoll, 'Chinese Street Food Live Streaming Mochi "06-10-2026" "12:58 AM"');
  });

  // ─── Test 11: New broadcast receives description ──────────────────────────────
  test('11. New broadcast receives saved description in liveBroadcasts.insert', async () => {
    const handlers = {};
    mockYouTubeApi(handlers);

    await createAndBindBroadcast({
      streamId: 'stream_test_desc',
      title: '',
      metadata: {
        description: 'Target broadcast description',
        categoryId: '26',
        tags: ['TagA'],
      },
    });

    assert.ok(handlers.insertedBroadcast);
    assert.strictEqual(handlers.insertedBroadcast.snippet.description, 'Target broadcast description');
  });

  // ─── Test 12: New broadcast receives category ─────────────────────────────────
  test('12. New broadcast receives saved category in videos.update', async () => {
    const handlers = {};
    mockYouTubeApi(handlers);

    await createAndBindBroadcast({
      streamId: 'stream_test_cat',
      title: '',
      metadata: {
        description: 'Desc',
        categoryId: '24',
        tags: ['TagB'],
      },
    });

    assert.ok(handlers.updatedVideo);
    assert.strictEqual(handlers.updatedVideo.snippet.categoryId, '24');
  });

  // ─── Test 13: New broadcast receives tags ─────────────────────────────────────
  test('13. New broadcast receives saved tags via videos.update', async () => {
    const handlers = {};
    mockYouTubeApi(handlers);

    const expectedTags = ['Street Food', 'Mochi', 'Live 247'];
    await createAndBindBroadcast({
      streamId: 'stream_test_tags',
      title: '',
      metadata: {
        description: 'Desc',
        categoryId: '22',
        tags: expectedTags,
      },
    });

    assert.ok(handlers.updatedVideo);
    assert.deepStrictEqual(handlers.updatedVideo.snippet.tags, expectedTags);
  });

  // ─── Test 14: New broadcast receives thumbnail ────────────────────────────────
  test('14. New broadcast receives thumbnail via thumbnails.set upload', async () => {
    const handlers = {};
    mockYouTubeApi(handlers);

    await createAndBindBroadcast({
      streamId: 'stream_test_thumb',
      title: '',
      metadata: {
        description: 'Desc',
        categoryId: '22',
        tags: [],
        thumbnail: {
          sourceVideoId: TEST_TEMPLATE_ID,
          sourceUrl: 'https://i.ytimg.com/vi/mock/maxresdefault.jpg',
          selectedResolution: 'maxres',
        },
      },
    });

    assert.strictEqual(handlers.thumbnailUploaded, true);
    assert.ok(handlers.thumbnailTargetUrl.includes('videoId=new_bcast_test_1'));
  });

  // ─── Test 15: Source title is NOT copied ──────────────────────────────────────
  test('15. Source video title is NOT copied to newly created broadcast', async () => {
    const handlers = {};
    mockYouTubeApi(handlers);

    // Sync template
    const templateMeta = await fetchTemplateVideoMetadata(TEST_TEMPLATE_ID);

    // Create broadcast using template metadata
    await createAndBindBroadcast({
      streamId: 'stream_test_no_title_copy',
      title: '',
      metadata: templateMeta,
    });

    assert.ok(handlers.insertedBroadcast);
    // Source title was: 'Old Template Title That Must Not Be Copied'
    assert.notStrictEqual(handlers.insertedBroadcast.snippet.title, 'Old Template Title That Must Not Be Copied');
    assert.ok(handlers.insertedBroadcast.snippet.title.startsWith('Chinese Street Food Live Streaming Mochi '));
  });

  // ─── Test 16: Auto-recycle gets the same metadata ─────────────────────────────
  test('16. Auto-recycle session receives the same description, category, tags, and thumbnail', async () => {
    const handlers = {};
    mockYouTubeApi(handlers);

    const metadata = {
      description: 'Auto-recycle continuous stream description',
      categoryId: '26',
      tags: ['Mochi', 'Continuous'],
      thumbnail: {
        sourceVideoId: TEST_TEMPLATE_ID,
        sourceUrl: 'https://i.ytimg.com/vi/mock/maxresdefault.jpg',
      },
    };

    // First broadcast
    await createAndBindBroadcast({
      streamId: 'stream_reused',
      title: '',
      metadata,
    });
    const bcast1Desc = handlers.insertedBroadcast.snippet.description;
    const bcast1Tags = handlers.updatedVideo.snippet.tags;
    const bcast1Cat = handlers.updatedVideo.snippet.categoryId;

    // Reset handlers to simulate auto-recycle creating next broadcast
    handlers.insertedBroadcast = null;
    handlers.updatedVideo = null;
    handlers.thumbnailUploaded = false;

    // Auto-recycle broadcast
    await createAndBindBroadcast({
      streamId: 'stream_reused',
      title: '',
      metadata,
    });

    assert.strictEqual(handlers.insertedBroadcast.snippet.description, bcast1Desc);
    assert.deepStrictEqual(handlers.updatedVideo.snippet.tags, bcast1Tags);
    assert.strictEqual(handlers.updatedVideo.snippet.categoryId, bcast1Cat);
    assert.strictEqual(handlers.thumbnailUploaded, true);
  });

  // ─── Test 17: Auto-recycle gets a NEW title ───────────────────────────────────
  test('17. Auto-recycle session gets a NEW dynamic timestamped title', () => {
    const session1Time = new Date('2026-10-05T18:12:00.000Z'); // 11:42 PM IST
    const session2Time = new Date('2026-10-05T19:28:00.000Z'); // 12:58 AM IST (next day)

    const title1 = generateBroadcastTitle(session1Time);
    const title2 = generateBroadcastTitle(session2Time);

    assert.strictEqual(title1, 'Chinese Street Food Live Streaming Mochi "05-10-2026" "11:42 PM"');
    assert.strictEqual(title2, 'Chinese Street Food Live Streaming Mochi "06-10-2026" "12:58 AM"');
    assert.notStrictEqual(title1, title2);
  });

  // ─── Test 18: Existing source video is never modified ─────────────────────────
  test('18. Existing source video is never modified (READ-ONLY protection)', async () => {
    mockYouTubeApi();

    // Configure templateVideoId in settings
    await saveSettings({ youtube: { templateVideoId: TEST_TEMPLATE_ID } });

    // Attempting to call updateVideoMetadata on the template ID must be blocked!
    await assert.rejects(
      async () => {
        await updateVideoMetadata(TEST_TEMPLATE_ID, {
          title: 'Illegal modification attempt',
          description: 'Hacked',
          categoryId: '22',
        });
      },
      /CRITICAL SAFETY VIOLATION/
    );

    // Attempting to apply thumbnail to the template ID must also be blocked!
    await assert.rejects(
      async () => {
        await applyVideoThumbnail(TEST_TEMPLATE_ID, {
          sourceUrl: 'https://i.ytimg.com/vi/mock/maxresdefault.jpg',
        });
      },
      /CRITICAL SAFETY VIOLATION/
    );
  });

  // ─── Test 19: Invalid template video ID is rejected ───────────────────────────
  test('19. Invalid template video ID is rejected with explicit error', async () => {
    mockYouTubeApi();

    // Empty or malformed IDs
    await assert.rejects(
      async () => {
        await fetchTemplateVideoMetadata('');
      },
      { code: 'E_INVALID_VIDEO_ID' }
    );

    await assert.rejects(
      async () => {
        await fetchTemplateVideoMetadata('!!bad^^id!!');
      },
      { code: 'E_INVALID_VIDEO_ID' }
    );

    // Video belonging to a different channel
    const otherChannelHandler = {};
    mockYouTubeApi({
      channelId: 'MY_CHANNEL_ID',
      videoChannelId: 'DIFFERENT_CHANNEL_ID',
    });

    await assert.rejects(
      async () => {
        await fetchTemplateVideoMetadata(TEST_TEMPLATE_ID);
      },
      { code: 'E_CHANNEL_MISMATCH' }
    );
  });

  // ─── Test 20: Metadata API failure is reported correctly ──────────────────────
  test('20. Metadata API failure is reported correctly without crashing stream', async () => {
    // Mock API where videos.update fails with 403 quota exceeded
    global.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          json: async () => ({ access_token: 'mock-access-token-xyz', expires_in: 3600 }),
        };
      }
      if (urlStr.includes('liveBroadcasts?part=snippet') && opts.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 'bcast_resilient_1' }),
        };
      }
      if (urlStr.includes('liveBroadcasts/bind')) {
        return {
          ok: true,
          json: async () => ({ id: 'bcast_resilient_1', status: { lifeCycleStatus: 'ready' } }),
        };
      }
      if (urlStr.includes('videos?part=snippet') && opts.method === 'PUT') {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({
            error: {
              code: 403,
              message: 'Quota exceeded for videos.update',
              errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    // createAndBindBroadcast must succeed and keep broadcast alive despite metadata failure
    const broadcast = await createAndBindBroadcast({
      streamId: 'stream_resilient',
      title: 'Resilient Title',
      metadata: {
        description: 'Test',
        categoryId: '22',
        tags: ['TagX'],
      },
    });

    assert.ok(broadcast);
    assert.strictEqual(broadcast.id, 'bcast_resilient_1');
    assert.strictEqual(broadcast.tagsApplied, false);

    // Verify error is recorded in telemetry
    const state = getYouTubeLiveApiState();
    assert.ok(state.metadataStatus.lastMetadataError.includes('Quota exceeded'));
  });
});
