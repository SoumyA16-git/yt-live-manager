import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublisherArgs, buildFeederArgs } from '../../src/ffmpeg-manager.js';

describe('Stream Smoothness & Low Latency Pacing Configuration', () => {
  test('buildPublisherArgs does not include -re (prevents double pacing on pipe)', () => {
    const args = buildPublisherArgs({}, 'rtmps://a.rtmps.youtube.com/live2/key');
    assert.ok(!args.includes('-re'), 'Publisher reading from pipe:0 must NEVER have -re flag');
  });

  test('buildPublisherArgs does not include +igndts (preserves B-frame decode order)', () => {
    const args = buildPublisherArgs({}, 'rtmps://a.rtmps.youtube.com/live2/key');
    const fflagsIdx = args.indexOf('-fflags');
    assert.ok(fflagsIdx !== -1, '-fflags must be present');
    assert.ok(!args[fflagsIdx + 1].includes('igndts'), '+igndts must be omitted to prevent frame jitter');
    assert.ok(args[fflagsIdx + 1].includes('genpts'), '+genpts must be retained');
  });

  test('buildPublisherArgs has adequate muxing queue size (4096)', () => {
    const args = buildPublisherArgs({}, 'rtmps://a.rtmps.youtube.com/live2/key');
    const qIdx = args.indexOf('-max_muxing_queue_size');
    assert.ok(qIdx !== -1);
    assert.strictEqual(args[qIdx + 1], '4096');
  });

  test('buildFeederArgs allows direct stream copy for videos up to 8.5s GOP even with active bandwidth cap', () => {
    const settings = {
      stream: {
        videoBitrateMbps: 4,
        keyframeMaxSeconds: 8.5,
        allowTranscode: true,
      },
    };
    const videoMeta = {
      filePath: '/videos/test.mp4',
      hasAudio: true,
      probe: {
        videoCodec: 'h264',
        pixFmt: 'yuv420p',
        maxKeyframeIntervalSec: 5.7,
        videoBitrate: 2_500_000,
        audioCodec: 'aac',
      },
    };

    const args = buildFeederArgs(settings, videoMeta, 'copy');
    // Must be direct copy mode (-c:v copy), NOT transcode (libx264)
    assert.ok(args.includes('-c:v'), 'Must have -c:v');
    const cvIdx = args.indexOf('-c:v');
    assert.strictEqual(args[cvIdx + 1], 'copy', 'H.264 video with 5.7s GOP must use direct copy (-c:v copy)');
    assert.ok(!args.includes('libx264'), 'Must not transcode to libx264');
  });

  test('buildFeederArgs includes low muxdelay and muxpreload to prevent pipe burstiness', () => {
    const settings = { stream: {} };
    const videoMeta = {
      filePath: '/videos/test.mp4',
      hasAudio: true,
      probe: { videoCodec: 'h264', pixFmt: 'yuv420p', maxKeyframeIntervalSec: 2.0 },
    };

    const args = buildFeederArgs(settings, videoMeta, 'copy');
    assert.ok(args.includes('-muxdelay'), 'Must configure -muxdelay');
    assert.ok(args.includes('-muxpreload'), 'Must configure -muxpreload');
  });

  test('buildFeederArgs transcode mode uses zerolatency tuning and constant framerate', () => {
    const settings = {
      stream: {
        videoBitrateMbps: 4,
        fps: 30,
        x264Preset: 'ultrafast',
      },
    };
    const videoMeta = {
      filePath: '/videos/test.mp4',
      hasAudio: true,
      probe: {
        videoCodec: 'hevc', // non-h264 forces transcode
        pixFmt: 'yuv420p',
        fps: 30,
      },
    };

    const args = buildFeederArgs(settings, videoMeta, 'transcode');
    assert.ok(args.includes('-tune'), 'Must specify -tune');
    const tuneIdx = args.indexOf('-tune');
    assert.strictEqual(args[tuneIdx + 1], 'zerolatency', 'Must use zerolatency tuning');
    assert.ok(args.includes('-r'), 'Must specify -r for CFR');
  });
});
