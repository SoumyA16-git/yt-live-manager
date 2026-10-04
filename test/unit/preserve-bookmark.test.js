/**
 * test/unit/preserve-bookmark.test.js
 *
 * Verifies that scripts/preserve-bookmark.js preserves playback bookmark
 * when called before/during service updates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, '../../scripts/preserve-bookmark.js');

describe('scripts/preserve-bookmark.js', () => {
  it('preserves single video bookmark accurately based on elapsed time', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytlm-bk-test-'));
    try {
      const dataDir = path.join(tmpDir, 'data');
      const configDir = path.join(tmpDir, 'config');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });

      // Video duration = 60s
      const videos = [{ id: 'vid_test1', probe: { durationSec: 60 } }];
      fs.writeFileSync(path.join(dataDir, 'videos.json'), JSON.stringify(videos));

      // Stream started 150 seconds ago (150 % 60 = 30s expected offset)
      const startedAt = new Date(Date.now() - 150 * 1000).toISOString();
      const state = {
        desiredState: 'running',
        streamStartedAt: startedAt,
        activeVideoId: 'vid_test1',
        resumeBookmark: null,
      };
      fs.writeFileSync(path.join(dataDir, 'stream-state.json'), JSON.stringify(state));
      fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
        stream: { videoId: 'vid_test1', playlist: ['vid_test1'] },
      }));

      // Run preserve-bookmark.js
      execFileSync(process.execPath, [scriptPath, tmpDir], { stdio: 'pipe' });

      // Read back state
      const updatedState = JSON.parse(fs.readFileSync(path.join(dataDir, 'stream-state.json'), 'utf8'));
      assert.ok(updatedState.resumeBookmark, 'resumeBookmark should be created');
      assert.equal(updatedState.resumeBookmark.videoId, 'vid_test1');
      assert.equal(updatedState.resumeBookmark.type, 'single');
      // Offset should be ~30s (allow +-2s for test execution time)
      assert.ok(updatedState.resumeBookmark.offsetSec >= 29 && updatedState.resumeBookmark.offsetSec <= 32);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite existing valid bookmark', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytlm-bk-test2-'));
    try {
      const dataDir = path.join(tmpDir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });

      const state = {
        desiredState: 'running',
        streamStartedAt: new Date(Date.now() - 100000).toISOString(),
        activeVideoId: 'vid_test1',
        resumeBookmark: {
          type: 'single',
          videoId: 'vid_test1',
          offsetSec: 42,
          at: new Date().toISOString(),
        },
      };
      fs.writeFileSync(path.join(dataDir, 'stream-state.json'), JSON.stringify(state));

      execFileSync(process.execPath, [scriptPath, tmpDir], { stdio: 'pipe' });

      const updatedState = JSON.parse(fs.readFileSync(path.join(dataDir, 'stream-state.json'), 'utf8'));
      assert.equal(updatedState.resumeBookmark.offsetSec, 42, 'Existing bookmark should not be overwritten');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
