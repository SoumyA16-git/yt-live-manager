import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  triggerRandomPlaylistSelection,
  _setPathsForTest as _setVideoPaths,
} from '../../src/video-manager.js';
import {
  _setPathsForTest as _setConfigPaths,
  loadSettings,
  getSettings,
} from '../../src/config-manager.js';
import {
  _setPathsForTest as _setStatePaths,
  loadState,
} from '../../src/state-manager.js';

describe('triggerRandomPlaylistSelection — Newest as #1 and randomized remainder', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ytlm-rnd-test-'));
    const sPath = path.join(tmpDir, 'settings.json');
    const bDir = path.join(tmpDir, 'backups');
    const vDir = path.join(tmpDir, 'videos');
    const vFile = path.join(tmpDir, 'videos.json');
    const stPath = path.join(tmpDir, 'stream-state.json');
    const hPath = path.join(tmpDir, 'stream-history.json');

    const inDir = path.join(tmpDir, 'incoming');
    await fs.mkdir(bDir, { recursive: true });
    await fs.mkdir(vDir, { recursive: true });
    await fs.mkdir(inDir, { recursive: true });

    _setConfigPaths(sPath, bDir);
    _setVideoPaths(vDir, inDir, vFile);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    await loadState();

    await (await import('../../src/config-manager.js')).saveSettings({
      stream: { mode: 'vertical' },
    });

    // Create 4 test vertical videos with different upload timestamps
    const now = Date.now();
    const testVideos = [
      {
        id: 'vid_older001',
        filename: 'vid_older001.mp4',
        uploadedAt: new Date(now - 300000).toISOString(), // 5m ago
        probe: { width: 1080, height: 1920, durationSec: 60 },
      },
      {
        id: 'vid_newest99',
        filename: 'vid_newest99.mp4',
        uploadedAt: new Date(now - 1000).toISOString(), // 1s ago (NEWEST)
        probe: { width: 1080, height: 1920, durationSec: 60 },
      },
      {
        id: 'vid_middle02',
        filename: 'vid_middle02.mp4',
        uploadedAt: new Date(now - 120000).toISOString(), // 2m ago
        probe: { width: 1080, height: 1920, durationSec: 60 },
      },
      {
        id: 'vid_oldest03',
        filename: 'vid_oldest03.mp4',
        uploadedAt: new Date(now - 900000).toISOString(), // 15m ago
        probe: { width: 1080, height: 1920, durationSec: 60 },
      },
    ];

    // Create mock files on disk
    for (const v of testVideos) {
      await fs.writeFile(path.join(vDir, v.filename), 'mock video content');
    }

    await fs.writeFile(vFile, JSON.stringify({ schemaVersion: 1, videos: testVideos }), 'utf8');
  });

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('always selects newest video as #1 and includes all remaining videos in vertical mode', async () => {
    const res = await triggerRandomPlaylistSelection('vertical');
    assert.ok(res, 'Result must be returned');
    assert.equal(res.mode, 'vertical');
    assert.equal(res.newestId, 'vid_newest99', 'Position #1 must be the newest video');
    assert.equal(res.count, 4, 'All 4 vertical videos must be in playlist');
    assert.equal(res.playlist[0], 'vid_newest99', 'First item in playlist must be newest video');

    const remaining = res.playlist.slice(1);
    assert.equal(remaining.length, 3);
    assert.ok(remaining.includes('vid_older001'));
    assert.ok(remaining.includes('vid_middle02'));
    assert.ok(remaining.includes('vid_oldest03'));

    // Check settings persisted
    const cfg = getSettings();
    assert.equal(cfg.stream.videoId, 'vid_newest99');
    assert.deepEqual(cfg.stream.playlists.vertical, res.playlist);
  });

  test('returns null gracefully if no compatible videos exist for requested mode', async () => {
    const res = await triggerRandomPlaylistSelection('horizontal');
    assert.equal(res, null);
  });
});
