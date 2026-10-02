/**
 * test/unit/ffprobe-manager.test.js — Unit tests for ffprobe-manager.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKeyframeScan,
  parseProbeOutput,
  evaluateCompatibility,
} from '../../src/ffprobe-manager.js';

describe('ffprobe-manager — parseKeyframeScan', () => {
  test('computes maximum interval from PTS CSV', () => {
    const csv = `0.000000\n2.000000\n4.000000\n6.500000\n8.500000\n`;
    const max = parseKeyframeScan(csv);
    assert.equal(max, 2.5);
  });

  test('returns null if fewer than 2 keyframes', () => {
    assert.equal(parseKeyframeScan(''), null);
    assert.equal(parseKeyframeScan('1.2345\n'), null);
  });
});

describe('ffprobe-manager — parseProbeOutput', () => {
  test('extracts all required stream and format fields', () => {
    const mockJson = {
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '60.500',
        size: '45000000',
        bit_rate: '6000000',
      },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          profile: 'High',
          width: 1080,
          height: 1920,
          pix_fmt: 'yuv420p',
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          bit_rate: '5800000',
          field_order: 'progressive',
          color_primaries: 'bt709',
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          profile: 'LC',
          channels: 2,
          sample_rate: '44100',
          bit_rate: '128000',
        },
      ],
    };

    const kfCsv = '0.00\n2.00\n4.00\n';
    const parsed = parseProbeOutput(mockJson, kfCsv);

    assert.equal(parsed.width, 1080);
    assert.equal(parsed.height, 1920);
    assert.equal(parsed.aspectRatio, '1080:1920');
    assert.equal(parsed.fps, 30);
    assert.equal(parsed.isVFR, false);
    assert.equal(parsed.videoCodec, 'h264');
    assert.equal(parsed.videoProfile, 'high');
    assert.equal(parsed.pixFmt, 'yuv420p');
    assert.equal(parsed.videoBitrate, 5800000);
    assert.equal(parsed.maxKeyframeIntervalSec, 2.0);
    assert.equal(parsed.hasAudio, true);
    assert.equal(parsed.audioCodec, 'aac');
    assert.equal(parsed.audioChannels, 2);
    assert.equal(parsed.audioSampleRate, 44100);
  });

  test('detects Variable Frame Rate (VFR)', () => {
    const mockJson = {
      format: { duration: '10.0', size: '1000' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1080,
          height: 1920,
          r_frame_rate: '60/1',
          avg_frame_rate: '29.97/1', // large discrepancy
        },
      ],
    };

    const parsed = parseProbeOutput(mockJson);
    assert.equal(parsed.isVFR, true);
  });

  test('throws error when no video stream is present', () => {
    const mockJson = {
      format: {},
      streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
    };
    assert.throws(() => parseProbeOutput(mockJson), /No video stream found/);
  });
});

describe('ffprobe-manager — evaluateCompatibility matrix', () => {
  const defaultSettings = {
    stream: {
      resolution: '1080x1920',
      fps: 30,
      copyMinMbps: 2,
      copyMaxMbps: 12,
      keyframeMaxSeconds: 4.0,
    },
  };

  const idealMeta = {
    width: 1080,
    height: 1920,
    fps: 30,
    isVFR: false,
    videoCodec: 'h264',
    videoProfile: 'high',
    pixFmt: 'yuv420p',
    fieldOrder: 'progressive',
    videoBitrate: 6_000_000,
    maxKeyframeIntervalSec: 2.0,
    hasAudio: true,
    audioCodec: 'aac',
    audioChannels: 2,
    audioSampleRate: 44100,
    colorPrimaries: 'bt709',
    durationSec: 60,
  };

  test('COMPATIBLE for compliant 1080x1920 H.264 AAC source', () => {
    const res = evaluateCompatibility(idealMeta, defaultSettings);
    assert.equal(res.status, 'COMPATIBLE');
    assert.equal(res.reasons.length, 0);
    assert.equal(res.modeAllowed.copy, true);
    assert.equal(res.modeAllowed.hybrid, true);
  });

  test('REQUIRES_TRANSCODING when resolution is landscape 1920x1080', () => {
    const landscapeMeta = { ...idealMeta, width: 1920, height: 1080 };
    const res = evaluateCompatibility(landscapeMeta, defaultSettings);
    assert.equal(res.status, 'REQUIRES_TRANSCODING');
    assert.ok(res.reasons.includes('RES_MISMATCH'));
    assert.equal(res.modeAllowed.copy, false);
    assert.ok(res.explanations.some(e => e.includes('landscape')));
  });

  test('REQUIRES_TRANSCODING when video codec is HEVC', () => {
    const hevcMeta = { ...idealMeta, videoCodec: 'hevc' };
    const res = evaluateCompatibility(hevcMeta, defaultSettings);
    assert.equal(res.status, 'REQUIRES_TRANSCODING');
    assert.ok(res.reasons.includes('CODEC_NOT_H264'));
    assert.ok(res.explanations.some(e => e.includes('YouTube live needs H.264')));
  });

  test('REQUIRES_TRANSCODING when pixel format is not yuv420p', () => {
    const p422Meta = { ...idealMeta, pixFmt: 'yuv422p' };
    const res = evaluateCompatibility(p422Meta, defaultSettings);
    assert.equal(res.status, 'REQUIRES_TRANSCODING');
    assert.ok(res.reasons.includes('PIX_FMT_NOT_YUV420P'));
  });

  test('REQUIRES_TRANSCODING when keyframe interval exceeds limit', () => {
    const longGopMeta = { ...idealMeta, maxKeyframeIntervalSec: 6.0 };
    const res = evaluateCompatibility(longGopMeta, defaultSettings);
    assert.equal(res.status, 'REQUIRES_TRANSCODING');
    assert.ok(res.reasons.includes('KEYFRAME_INTERVAL_HIGH'));
  });

  test('Hybrid mode when video is compliant but audio is absent', () => {
    const silentMeta = { ...idealMeta, hasAudio: false, audioCodec: null };
    const res = evaluateCompatibility(silentMeta, defaultSettings);
    assert.equal(res.status, 'COMPATIBLE');
    assert.equal(res.modeAllowed.copy, false); // direct copy requires audio
    assert.equal(res.modeAllowed.hybrid, true); // hybrid can generate silent audio
    assert.ok(res.warnings.includes('NO_AUDIO'));
  });

  test('Hybrid mode when video is compliant but audio is MP3', () => {
    const mp3Meta = { ...idealMeta, audioCodec: 'mp3' };
    const res = evaluateCompatibility(mp3Meta, defaultSettings);
    assert.equal(res.status, 'COMPATIBLE');
    assert.equal(res.modeAllowed.copy, false);
    assert.equal(res.modeAllowed.hybrid, true);
    assert.ok(res.warnings.includes('AUDIO_NEEDS_TRANSCODE'));
  });

  test('REQUIRES_TRANSCODING when video bitrate is below copyMinMbps', () => {
    const lowBitrateMeta = { ...idealMeta, videoBitrate: 1_000_000 }; // 1 Mbps < 2 Mbps
    const res = evaluateCompatibility(lowBitrateMeta, defaultSettings);
    assert.equal(res.status, 'REQUIRES_TRANSCODING');
    assert.ok(res.reasons.includes('BITRATE_TOO_LOW'));
  });

  test('accepts lower bitrate (1.2 Mbps) with default settings (copyMinMbps: 0.1)', () => {
    const sourceMeta = { ...idealMeta, videoBitrate: 1_200_000 }; // 1.2 Mbps
    const res = evaluateCompatibility(sourceMeta, {});
    assert.equal(res.status, 'COMPATIBLE');
    assert.equal(res.modeAllowed.copy, true);
  });

  test('flags BITRATE_TOO_HIGH when video bitrate (10 Mbps) exceeds 4 Mbps gate ceiling', () => {
    const highBitrateMeta = { ...idealMeta, videoBitrate: 10_000_000 }; // 10 Mbps > 4.0 Mbps
    const res = evaluateCompatibility(highBitrateMeta, {});
    assert.equal(res.status, 'REQUIRES_TRANSCODING');
    assert.ok(res.reasons.includes('BITRATE_TOO_HIGH'));
  });
});
