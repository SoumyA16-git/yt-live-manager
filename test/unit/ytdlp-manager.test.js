import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  normalizeYouTubeUrl,
  isValidYouTubeUrl,
  parseYtDlpProgressLine,
  getYtDlpFormatAndSort,
  checkDuplicateYouTubeVideo,
  stripVideoMetadata,
  normalizeVideoGop,
} from '../../src/ytdlp-manager.js';

describe('ytdlp-manager — URL normalization and validation', () => {
  it('normalizes live URLs with query params to canonical watch URL', () => {
    const raw = 'https://www.youtube.com/live/M9fx7S9NXyo?si=pw5XzZsAabMve0tz';
    const normalized = normalizeYouTubeUrl(raw);
    assert.equal(normalized, 'https://www.youtube.com/watch?v=M9fx7S9NXyo');
    assert.equal(isValidYouTubeUrl(raw), true);
    assert.equal(isValidYouTubeUrl(normalized), true);
  });

  it('normalizes youtu.be short URLs with query params', () => {
    const raw = 'https://youtu.be/M9fx7S9NXyo?si=pw5XzZsAabMve0tz';
    const normalized = normalizeYouTubeUrl(raw);
    assert.equal(normalized, 'https://www.youtube.com/watch?v=M9fx7S9NXyo');
    assert.equal(isValidYouTubeUrl(raw), true);
  });

  it('normalizes shorts URLs with extra paths/params', () => {
    const raw = 'https://www.youtube.com/shorts/M9fx7S9NXyo?feature=share';
    const normalized = normalizeYouTubeUrl(raw);
    assert.equal(normalized, 'https://www.youtube.com/watch?v=M9fx7S9NXyo');
    assert.equal(isValidYouTubeUrl(raw), true);
  });

  it('normalizes mobile youtube URLs', () => {
    const raw = 'https://m.youtube.com/watch?v=M9fx7S9NXyo&feature=share';
    const normalized = normalizeYouTubeUrl(raw);
    assert.equal(normalized, 'https://www.youtube.com/watch?v=M9fx7S9NXyo');
    assert.equal(isValidYouTubeUrl(raw), true);
  });

  it('rejects invalid or non-YouTube URLs', () => {
    assert.equal(isValidYouTubeUrl(''), false);
    assert.equal(isValidYouTubeUrl('not-a-url'), false);
    assert.equal(isValidYouTubeUrl('https://vimeo.com/123456'), false);
    assert.equal(isValidYouTubeUrl('https://google.com'), false);
  });
});

describe('ytdlp-manager — progress parsing', () => {
  it('extracts title when title: line received', () => {
    const job = { stage: 'fetching_info' };
    parseYtDlpProgressLine('title:Epic 24/7 Street Food Video', job);
    assert.equal(job.videoTitle, 'Epic 24/7 Street Food Video');
    assert.equal(job.stage, 'downloading');
  });

  it('parses prefixed yt_progress line with full size info', () => {
    const job = { percent: 0 };
    parseYtDlpProgressLine('yt_progress:  24.5%|  15.30MiB/s|02:15|   2.50GiB|  10.20GiB|       N/A', job);
    assert.equal(job.percent, 24.5);
    assert.equal(job.speed, '15.30MiB/s');
    assert.equal(job.eta, '02:15');
    assert.equal(job.downloaded, '2.50GiB');
    assert.equal(job.totalSize, '10.20GiB');
    assert.equal(job.stage, 'downloading');
  });

  it('parses unprefixed pipe-delimited progress line', () => {
    const job = { percent: 0 };
    parseYtDlpProgressLine('  38.2%|  18.45MiB/s|01:10|   3.80GiB|  10.00GiB', job);
    assert.equal(job.percent, 38.2);
    assert.equal(job.speed, '18.45MiB/s');
    assert.equal(job.eta, '01:10');
    assert.equal(job.downloaded, '3.80GiB');
    assert.equal(job.totalSize, '10.00GiB');
  });

  it('falls back to estimated total if exact total is N/A', () => {
    const job = { percent: 0 };
    parseYtDlpProgressLine('yt_progress:  12.0%|   8.20MiB/s|05:00|   1.20GiB|       N/A|  10.50GiB', job);
    assert.equal(job.percent, 12);
    assert.equal(job.totalSize, '10.50GiB');
  });

  it('switches to merging stage on postprocess and remux indicators', () => {
    const job = { stage: 'downloading', speed: '10MiB/s', eta: '00:01' };
    parseYtDlpProgressLine('postprocess:postprocess:finished', job);
    assert.equal(job.stage, 'merging');
    assert.equal(job.speed, '');
    assert.equal(job.eta, '');

    parseYtDlpProgressLine('[Merger] Merging formats into "video.mp4"', job);
    assert.equal(job.stage, 'merging');
  });

  it('parses fallback standard [download] lines', () => {
    const job = { percent: 0 };
    parseYtDlpProgressLine('[download]  55.5% of ~8.00GiB at 12.00MiB/s ETA 03:20', job);
    assert.equal(job.percent, 55.5);
    assert.equal(job.totalSize, '8.00GiB');
    assert.equal(job.speed, '12.00MiB/s');
    assert.equal(job.eta, '03:20');
  });
});

describe('ytdlp-manager — quality format selection', () => {
  it('defaults to 720p format and sort to save storage', () => {
    const res = getYtDlpFormatAndSort();
    assert.ok(res.format.includes('1280'));
    assert.ok(res.sort.includes('res:720'));
    assert.ok(res.sort.includes('vcodec:h264'));
  });

  it('selects 1080p format and sort when requested', () => {
    const res = getYtDlpFormatAndSort('1080p');
    assert.ok(res.format.includes('1920'));
    assert.ok(res.sort.includes('res:1080'));
  });

  it('selects 480p ultra saver format and sort when requested', () => {
    const res = getYtDlpFormatAndSort('480p');
    assert.ok(res.format.includes('854'));
    assert.ok(res.sort.includes('res:480'));
  });
});

describe('ytdlp-manager — duplicate video detection', () => {
  it('returns null for empty or non-string input', async () => {
    assert.equal(await checkDuplicateYouTubeVideo(''), null);
    assert.equal(await checkDuplicateYouTubeVideo(null), null);
  });

  it('returns null when URL is not in library', async () => {
    const res = await checkDuplicateYouTubeVideo('https://www.youtube.com/watch?v=nonexistent1');
    assert.equal(res, null);
  });
});

describe('ytdlp-manager — metadata stripping', () => {
  it('strips metadata, title, artist, and comments from video', async () => {
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `meta_in_${Date.now()}.mp4`);
    const outputPath = path.join(tmpDir, `meta_out_${Date.now()}.mp4`);

    try {
      const gen = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=160x120:rate=10',
        '-metadata', 'title=Secret Video Title',
        '-metadata', 'artist=Secret Uploader',
        '-metadata', 'comment=https://youtube.com/watch?v=12345',
        '-metadata', 'date=2026-10-01',
        '-c:v', 'libx264',
        '-y', inputPath,
      ]);

      if (gen.status !== 0) {
        return;
      }

      await stripVideoMetadata(inputPath, outputPath);

      const probe = spawnSync('ffprobe', [
        '-hide_banner', '-show_format', outputPath,
      ]);

      const probeOut = probe.stdout?.toString('utf8') || '';
      assert.ok(!probeOut.includes('Secret Video Title'), 'Should strip title');
      assert.ok(!probeOut.includes('Secret Uploader'), 'Should strip artist/uploader');
      assert.ok(!probeOut.includes('12345'), 'Should strip comment/url');
    } finally {
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    }
  });
});

describe('ytdlp-manager — GOP normalization', () => {
  it('re-encodes video with 2s keyframes and strips metadata', async () => {
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `gop_in_${Date.now()}.mp4`);
    const outputPath = path.join(tmpDir, `gop_out_${Date.now()}.mp4`);

    try {
      const gen = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
        '-metadata', 'title=Test Title',
        '-c:v', 'libx264',
        '-g', '50',
        '-y', inputPath,
      ]);

      if (gen.status !== 0) return;

      await normalizeVideoGop(inputPath, outputPath, null, { fps: 10, videoBitrate: 500000 });

      const stat = await fs.stat(outputPath);
      assert.ok(stat.size > 0, 'Normalized file should exist');

      const probe = spawnSync('ffprobe', [
        '-hide_banner', '-show_format', outputPath,
      ]);
      const probeOut = probe.stdout?.toString('utf8') || '';
      assert.ok(!probeOut.includes('Test Title'), 'Should strip title during normalization');
    } finally {
      await fs.unlink(inputPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    }
  });
});

