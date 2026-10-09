/**
 * test/unit/validate.test.js — Unit tests for lib/validate.js
 *
 * PRD §26.1: "path-traversal rejection" (videoId), stream key, settings validation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSettings,
  validateStreamKey,
  validateVideoId,
  validateRtmpsUrl,
} from '../../src/lib/validate.js';

// ─── validateStreamKey ────────────────────────────────────────────────────────

describe('validateStreamKey', () => {
  test('accepts a valid YouTube-style key', () => {
    const { valid } = validateStreamKey('abcd-EFGH_1234-5678');
    assert.ok(valid);
  });

  test('rejects key shorter than 8 chars', () => {
    const { valid, errors } = validateStreamKey('short');
    assert.ok(!valid);
    assert.ok(errors.some(e => e.includes('short')));
  });

  test('rejects key longer than 128 chars', () => {
    const { valid } = validateStreamKey('A'.repeat(129));
    assert.ok(!valid);
  });

  test('rejects key with whitespace', () => {
    const { valid } = validateStreamKey('valid key with space');
    assert.ok(!valid);
  });

  test('rejects key with special chars (!, @, etc.)', () => {
    const { valid } = validateStreamKey('validKEY!@#$%^&*()');
    assert.ok(!valid);
  });

  test('accepts exactly 8-char key', () => {
    const { valid } = validateStreamKey('ABCD1234');
    assert.ok(valid);
  });
});

// ─── validateVideoId ─────────────────────────────────────────────────────────

describe('validateVideoId — path-traversal safety', () => {
  test('accepts valid video IDs', () => {
    assert.ok(validateVideoId('vid_a1b2c3d4').valid);
    assert.ok(validateVideoId('vid_00000000').valid);
    assert.ok(validateVideoId('vid_ffffffff').valid);
  });

  test('rejects path-traversal attempts', () => {
    assert.ok(!validateVideoId('../../../etc/passwd').valid);
    assert.ok(!validateVideoId('vid_gg000000').valid);   // g is not hex
    assert.ok(!validateVideoId('vid_a1b2c3d4extra').valid);
    assert.ok(!validateVideoId('VID_a1b2c3d4').valid);   // uppercase vid_
    assert.ok(!validateVideoId('vid_a1b2c3d').valid);    // 7 hex chars
    assert.ok(!validateVideoId('vid_a1b2c3d45').valid);  // 9 hex chars
  });

  test('rejects empty string and non-string', () => {
    assert.ok(!validateVideoId('').valid);
    assert.ok(!validateVideoId(null).valid);
    assert.ok(!validateVideoId(123).valid);
  });
});

// ─── validateRtmpsUrl ────────────────────────────────────────────────────────

describe('validateRtmpsUrl', () => {
  test('accepts rtmps:// URLs', () => {
    assert.ok(validateRtmpsUrl('rtmps://a.rtmps.youtube.com:443/live2').valid);
  });

  test('rejects http:// URLs', () => {
    assert.ok(!validateRtmpsUrl('http://example.com/stream').valid);
  });

  test('rejects rtmp:// in production mode', () => {
    assert.ok(!validateRtmpsUrl('rtmp://127.0.0.1:1935/live/test', false).valid);
  });

  test('accepts rtmp://127.0.0.1 in test mode', () => {
    assert.ok(validateRtmpsUrl('rtmp://127.0.0.1:1935/live/test', true).valid);
  });

  test('rejects rtmp://0.0.0.0 even in test mode', () => {
    assert.ok(!validateRtmpsUrl('rtmp://0.0.0.0:1935/live/test', true).valid);
  });
});

// ─── validateSettings — partial mode ─────────────────────────────────────────

describe('validateSettings — partial mode (API patch)', () => {
  test('passes an empty patch', () => {
    const { valid } = validateSettings({});
    assert.ok(valid);
  });

  test('passes a valid stream section patch', () => {
    const { valid, errors } = validateSettings({ stream: { videoBitrateMbps: 6 } });
    assert.ok(valid, errors.join(', '));
  });

  test('rejects unknown top-level section is fine (lenient in partial)', () => {
    // validateSettings only checks sections it knows about
    const { valid } = validateSettings({ unknownSection: { x: 1 } });
    // No explicit unknown-section rejection at top level in partial mode
    assert.ok(valid);
  });

  test('rejects unknown field inside a known section', () => {
    const { valid, errors } = validateSettings({ stream: { nonexistentField: 'x' } });
    assert.ok(!valid);
    assert.ok(errors.some(e => e.includes('unknown field')));
  });

  test('rejects invalid enum value for fps', () => {
    const { valid, errors } = validateSettings({ stream: { fps: 29 } });
    assert.ok(!valid);
    assert.ok(errors.some(e => e.includes('fps')));
  });

  test('rejects videoBitrateMbps out of range', () => {
    const { valid } = validateSettings({ stream: { videoBitrateMbps: -1 } });
    assert.ok(!valid);
    const { valid: v0 } = validateSettings({ stream: { videoBitrateMbps: 0 } });
    assert.ok(v0);
    const { valid: v2 } = validateSettings({ stream: { videoBitrateMbps: 51 } });
    assert.ok(!v2);
  });

  test('rejects invalid x264Preset', () => {
    const { valid } = validateSettings({ stream: { x264Preset: 'slow' } });
    assert.ok(!valid);
  });

  test('accepts valid youtube section', () => {
    const { valid, errors } = validateSettings({
      youtube: { rtmpsUrl: 'rtmps://a.rtmps.youtube.com:443/live2', title: 'My Stream' },
    });
    assert.ok(valid, errors.join(', '));
  });

  test('rejects rtmpsUrl without rtmps:// prefix', () => {
    const { valid } = validateSettings({ youtube: { rtmpsUrl: 'rtmp://youtube.com/live2' } });
    assert.ok(!valid);
  });

  test('marks requiresRestart for bitrate changes', () => {
    const { requiresRestart } = validateSettings({ stream: { videoBitrateMbps: 10 } });
    assert.ok(requiresRestart);
  });

  test('does NOT mark requiresRestart for log level change', () => {
    const { requiresRestart } = validateSettings({ logs: { level: 'debug' } });
    assert.ok(!requiresRestart);
  });

  test('accepts valid horizontalStreamKey and dualStreamEnabled in youtube section', () => {
    const { valid, errors, requiresRestart } = validateSettings({
      youtube: {
        horizontalStreamKey: 'abcd-1234-efgh-5678-ijkl',
        dualStreamEnabled: true,
      },
    });
    assert.ok(valid, errors.join(', '));
    assert.ok(requiresRestart);
  });

  test('rejects invalid horizontalStreamKey', () => {
    const { valid, errors } = validateSettings({
      youtube: { horizontalStreamKey: 'short' },
    });
    assert.ok(!valid);
    assert.ok(errors.some(e => e.includes('horizontalStreamKey')));
  });
});

describe('validateSettings — bandwidth section', () => {
  test('accepts valid warningThresholds', () => {
    const { valid, errors } = validateSettings({
      bandwidth: { warningThresholds: [70, 80, 90, 95] },
    });
    assert.ok(valid, errors.join(', '));
  });

  test('rejects non-ascending warningThresholds', () => {
    const { valid } = validateSettings({
      bandwidth: { warningThresholds: [90, 70, 80] },
    });
    assert.ok(!valid);
  });

  test('rejects warningThresholds > 8 entries', () => {
    const { valid } = validateSettings({
      bandwidth: { warningThresholds: [10,20,30,40,50,60,70,80,90] },
    });
    assert.ok(!valid);
  });

  test('accepts valid accounting timezone', () => {
    const { valid, errors } = validateSettings({
      bandwidth: { accounting: { timezone: 'Asia/Kolkata' } },
    });
    assert.ok(valid, errors.join(', '));
  });

  test('rejects invalid IANA timezone', () => {
    const { valid } = validateSettings({
      bandwidth: { accounting: { timezone: 'Mars/Olympus' } },
    });
    assert.ok(!valid);
  });
});

describe('validateSettings — YouTube Studio target', () => {
  test('accepts the configured YouTube Studio broadcast URL', () => {
    const { valid, errors } = validateSettings({
      studioAutomation: {
        url: 'https://studio.youtube.com/video/uJyJyeNDoMM/livestreaming',
      },
    });
    assert.ok(valid, errors.join(', '));
  });

  test('rejects a Studio URL that is not a broadcast control room', () => {
    const { valid, errors } = validateSettings({
      studioAutomation: { url: 'https://studio.youtube.com/livestreaming' },
    });
    assert.ok(!valid);
    assert.ok(errors.some(error => error.includes('studioAutomation.url')));
  });

  test('rejects URLs outside YouTube Studio', () => {
    const { valid, errors } = validateSettings({
      studioAutomation: { url: 'https://example.com/video/uJyJyeNDoMM/livestreaming' },
    });
    assert.ok(!valid);
    assert.ok(errors.some(error => error.includes('studioAutomation.url')));
  });
});

describe('validateSettings — scheduler section', () => {
  test('accepts valid scheduled window', () => {
    const { valid, errors } = validateSettings({
      scheduler: {
        mode: 'scheduled',
        timezone: 'Asia/Kolkata',
        windows: [{ days: ['mon','tue'], start: '06:00', stop: '23:30' }],
      },
    });
    assert.ok(valid, errors.join(', '));
  });

  test('rejects invalid day name', () => {
    const { valid } = validateSettings({
      scheduler: { windows: [{ days: ['monday'], start: '06:00', stop: '23:30' }] },
    });
    assert.ok(!valid);
  });

  test('rejects malformed time (missing leading zero)', () => {
    const { valid } = validateSettings({
      scheduler: { windows: [{ days: ['mon'], start: '6:00', stop: '23:30' }] },
    });
    assert.ok(!valid);
  });

  test('rejects unknown field in window', () => {
    const { valid } = validateSettings({
      scheduler: { windows: [{ days: ['mon'], start: '06:00', stop: '23:30', extra: 1 }] },
    });
    assert.ok(!valid);
  });

  test('accepts valid autoRecycle settings', () => {
    const { valid, errors } = validateSettings({
      scheduler: {
        autoRecycle: { enabled: true, maxSessionHours: 8, pauseMinutes: 60 },
      },
    });
    assert.ok(valid, errors.join(', '));
  });

  test('accepts valid autoRecycle settings with resumeBookmark', () => {
    const { valid, errors } = validateSettings({
      scheduler: {
        autoRecycle: { enabled: true, maxSessionHours: 8, pauseMinutes: 60, resumeBookmark: true },
      },
    });
    assert.ok(valid, errors.join(', '));
  });

  test('rejects invalid autoRecycle resumeBookmark (non-boolean)', () => {
    const { valid } = validateSettings({
      scheduler: {
        autoRecycle: { enabled: true, maxSessionHours: 8, pauseMinutes: 60, resumeBookmark: 'yes' },
      },
    });
    assert.ok(!valid);
  });

  test('accepts valid autoRecycle settings with maxSessionMinutes', () => {
    const { valid, errors } = validateSettings({
      scheduler: {
        autoRecycle: { enabled: true, maxSessionMinutes: 30, pauseMinutes: 10, resumeBookmark: true },
      },
    });
    assert.ok(valid, errors.join(', '));
  });
});


describe('validateSettings — disk ascending check', () => {
  test('rejects critical <= warn', () => {
    const { valid } = validateSettings({ disk: { warnPercent: 85, criticalPercent: 80 } });
    assert.ok(!valid);
  });

  test('rejects emergency <= critical', () => {
    const { valid } = validateSettings({ disk: { criticalPercent: 90, emergencyPercent: 90 } });
    assert.ok(!valid);
  });
});
