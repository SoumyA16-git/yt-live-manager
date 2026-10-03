/**
 * test/unit/ffmpeg-manager.test.js — Unit tests for ffmpeg-manager.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFfmpegArgs } from '../../src/ffmpeg-manager.js';

describe('ffmpeg-manager — buildFfmpegArgs', () => {
  const dummySettings = {
    stream: {
      resolution: '1080x1920',
      fps: 30,
      videoBitrateMbps: 8,
      audioBitrateKbps: 128,
      audioSampleRate: 44100,
      keyframeSeconds: 2,
      x264Preset: 'veryfast',
      loopStrategy: 'stream_loop',
    },
  };

  const dummyMeta = {
    filePath: '/var/videos/vid_12345678.mp4',
    hasAudio: true,
  };

  const secretTarget = 'rtmps://a.rtmps.youtube.com:443/live2/my-secret-key-123';

  test('Copy Mode args structure', () => {
    const args = buildFfmpegArgs(dummySettings, dummyMeta, secretTarget, 'copy');

    assert.ok(args.includes('-re'));
    assert.ok(args.includes('-stream_loop'));
    assert.ok(args.includes('-i'));
    assert.ok(args.includes('/var/videos/vid_12345678.mp4'));
    assert.ok(args.includes('-c'));
    assert.ok(args.includes('copy'));
    assert.ok(args.includes('no_duration_filesize'));
    assert.equal(args[args.length - 1], secretTarget);
  });

  test('Hybrid Mode args structure with audio', () => {
    const args = buildFfmpegArgs(dummySettings, dummyMeta, secretTarget, 'hybrid');

    assert.ok(args.includes('-c:v'));
    assert.ok(args.includes('copy'));
    assert.ok(args.includes('-c:a'));
    assert.ok(args.includes('aac'));
    assert.ok(args.includes('128k'));
    assert.ok(args.includes('44100'));
    assert.equal(args[args.length - 1], secretTarget);
  });

  test('Hybrid Mode args with missing audio (anullsrc generated)', () => {
    const silentMeta = { filePath: '/var/videos/silent.mp4', hasAudio: false };
    const args = buildFfmpegArgs(dummySettings, silentMeta, secretTarget, 'hybrid');

    assert.ok(args.includes('anullsrc=channel_layout=stereo:sample_rate=44100'));
    assert.ok(args.includes('-c:a'));
    assert.ok(args.includes('aac'));
    assert.equal(args[args.length - 1], secretTarget);
  });

  test('Transcode Mode args structure with video filters and CBR flags', () => {
    const args = buildFfmpegArgs(dummySettings, dummyMeta, secretTarget, 'transcode');

    assert.ok(args.includes('-vf'));
    const vf = args[args.indexOf('-vf') + 1];
    assert.ok(vf.includes('scale=1080:1920'));
    assert.ok(vf.includes('fps=30'));
    assert.ok(vf.includes('format=yuv420p'));

    assert.ok(args.includes('-c:v'));
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('-preset'));
    assert.ok(args.includes('veryfast'));
    assert.ok(args.includes('-b:v'));
    assert.ok(args.includes('8000k'));
    assert.ok(args.includes('-g'));
    assert.ok(args.includes('60')); // 30 fps * 2 sec keyframe = 60

    assert.ok(args.includes('-x264-params'));
    assert.ok(args[args.indexOf('-x264-params') + 1].includes('nal-hrd=cbr'));

    assert.equal(args[args.length - 1], secretTarget);
  });

  test('Transcode Mode adapts to source video bitrate and caps at ceiling', () => {
    // 1. Source with 1.5 Mbps bitrate preserves 1500k target
    const lowMeta = { ...dummyMeta, videoBitrate: 1_500_000 };
    const lowArgs = buildFfmpegArgs({ stream: { videoBitrateMbps: 4 } }, lowMeta, secretTarget, 'transcode');
    const lowBIndex = lowArgs.indexOf('-b:v');
    assert.equal(lowArgs[lowBIndex + 1], '1500k');

    // 2. Source with 10 Mbps bitrate caps at 4000k
    const highMeta = { ...dummyMeta, videoBitrate: 10_000_000 };
    const highArgs = buildFfmpegArgs({ stream: { videoBitrateMbps: 4 } }, highMeta, secretTarget, 'transcode');
    const highBIndex = highArgs.indexOf('-b:v');
    assert.equal(highArgs[highBIndex + 1], '4000k');
  });

  test('Concat Mode args structure for multi-video playlist', () => {
    const concatMeta = { ...dummyMeta, isConcat: true };
    const args = buildFfmpegArgs(dummySettings, concatMeta, secretTarget, 'copy');

    assert.ok(args.includes('-f'));
    assert.ok(args.includes('concat'));
    assert.ok(args.includes('-stream_loop'));
    assert.ok(args.includes('-safe'));
    assert.ok(args.includes('0'));
    assert.ok(args.includes('-c'));
    assert.ok(args.includes('copy'));
    assert.equal(args[args.length - 1], secretTarget);
  });
});
