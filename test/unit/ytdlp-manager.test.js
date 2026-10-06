import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeYouTubeUrl, isValidYouTubeUrl, parseYtDlpProgressLine } from '../../src/ytdlp-manager.js';

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

