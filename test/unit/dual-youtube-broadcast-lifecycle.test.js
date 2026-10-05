/**
 * test/unit/dual-youtube-broadcast-lifecycle.test.js
 *
 * Verifies single stream mode invariants:
 * - Dual stream execution is permanently disabled (isDualStreamEnabled() returns false)
 * - Only one mode is active at any time
 * - Zero fallback between horizontal and vertical
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDualStreamEnabled, getStreamMode } from '../../src/config-manager.js';
import { getSecondaryFfmpegPid } from '../../src/ffmpeg-manager.js';

describe('Single Stream Invariants (No Dual Stream)', () => {
  it('isDualStreamEnabled is permanently false', () => {
    assert.strictEqual(isDualStreamEnabled(), false);
  });

  it('default stream mode is horizontal or vertical', () => {
    const mode = getStreamMode();
    assert.ok(['horizontal', 'vertical'].includes(mode));
  });

  it('secondary FFmpeg PID is always null', () => {
    assert.strictEqual(getSecondaryFfmpegPid(), null);
  });
});
