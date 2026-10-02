/**
 * test/unit/video-manager.test.js — Unit tests for video-manager.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  generateVideoId,
  resolveVideoPath,
  listVideos,
  getVideo,
  deleteVideo,
  setActiveVideo,
  _setPathsForTest as _setVideoPaths,
} from '../../src/video-manager.js';
import {
  loadSettings,
  getSettings,
  _setPathsForTest as _setConfigPaths,
} from '../../src/config-manager.js';
import {
  loadState,
  saveState,
  getState,
  _setPathsForTest as _setStatePaths,
} from '../../src/state-manager.js';
import { writeJSON } from '../../src/lib/atomic-json.js';

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-video-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('video-manager — ID generation and Path Traversal Safety', () => {
  test('generates valid 8-hex video IDs', () => {
    const id = generateVideoId();
    assert.match(id, /^vid_[a-f0-9]{8}$/);
  });

  test('resolves valid video ID within videos directory', () => {
    const id = 'vid_a1b2c3d4';
    const resolved = resolveVideoPath(id, '.mp4');
    assert.ok(resolved.endsWith(`${id}.mp4`));
  });

  test('rejects path-traversal attempts', () => {
    assert.throws(() => resolveVideoPath('../../etc/passwd'), { code: 'E_INVALID_ID' });
    assert.throws(() => resolveVideoPath('vid_1234..'), { code: 'E_INVALID_ID' });
    assert.throws(() => resolveVideoPath('vid_00000000/subdir'), { code: 'E_INVALID_ID' });
  });
});

describe('video-manager — library operations', () => {
  test('lists and finds videos from catalog', async () => {
    const vDir   = path.join(tmpDir, 'videos-1');
    const inDir  = path.join(tmpDir, 'incoming-1');
    const vIndex = path.join(tmpDir, 'videos-index-1.json');
    const bDir   = path.join(tmpDir, 'backups-1');

    await fs.mkdir(vDir, { recursive: true });
    _setVideoPaths(vDir, inDir, vIndex);

    const mockVideos = [
      { id: 'vid_11111111', originalName: 'video1.mp4', sizeBytes: 1000 },
      { id: 'vid_22222222', originalName: 'video2.mp4', sizeBytes: 2000 },
    ];
    await writeJSON(vIndex, { schemaVersion: 1, videos: mockVideos });

    const list = await listVideos();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'vid_11111111');

    const found = await getVideo('vid_22222222');
    assert.equal(found.originalName, 'video2.mp4');

    const notFound = await getVideo('vid_99999999');
    assert.equal(notFound, null);
  });

  test('setActiveVideo updates settings and state', async () => {
    const vDir   = path.join(tmpDir, 'videos-2');
    const inDir  = path.join(tmpDir, 'incoming-2');
    const vIndex = path.join(tmpDir, 'videos-index-2.json');
    const sPath  = path.join(tmpDir, 'settings-2.json');
    const stPath = path.join(tmpDir, 'state-2.json');
    const hPath  = path.join(tmpDir, 'hist-2.json');
    const bDir   = path.join(tmpDir, 'backups-2');

    await fs.mkdir(vDir, { recursive: true });
    _setVideoPaths(vDir, inDir, vIndex);
    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    await loadState();

    const videoId = 'vid_33333333';
    await writeJSON(vIndex, {
      schemaVersion: 1,
      videos: [{ id: videoId, originalName: 'stream_source.mp4' }],
    });

    await setActiveVideo(videoId);

    assert.equal(getSettings().stream.videoId, videoId);
    assert.equal(getState().activeVideoId, videoId);
  });

  test('deleteVideo removes file and catalog entry, but refuses if actively streaming', async () => {
    const vDir   = path.join(tmpDir, 'videos-3');
    const inDir  = path.join(tmpDir, 'incoming-3');
    const vIndex = path.join(tmpDir, 'videos-index-3.json');
    const sPath  = path.join(tmpDir, 'settings-3.json');
    const stPath = path.join(tmpDir, 'state-3.json');
    const hPath  = path.join(tmpDir, 'hist-3.json');
    const bDir   = path.join(tmpDir, 'backups-3');

    await fs.mkdir(vDir, { recursive: true });
    _setVideoPaths(vDir, inDir, vIndex);
    _setConfigPaths(sPath, bDir);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    await loadState();

    const videoId = 'vid_44444444';
    await writeJSON(vIndex, {
      schemaVersion: 1,
      videos: [{ id: videoId, originalName: 'live.mp4', filename: `${videoId}.mp4` }],
    });

    // Case 1: Video is currently live and streaming -> MUST refuse with E_VIDEO_IN_USE
    await saveState({ status: 'RUNNING', activeVideoId: videoId });
    await assert.rejects(
      async () => { await deleteVideo(videoId); },
      (err) => {
        assert.equal(err.code, 'E_VIDEO_IN_USE');
        return true;
      }
    );

    // Case 2: Stopped -> Deletion succeeds
    await saveState({ status: 'STOPPED' });
    const res = await deleteVideo(videoId);
    assert.equal(res.deleted, true);

    const remaining = await listVideos();
    assert.equal(remaining.length, 0);
  });
});
