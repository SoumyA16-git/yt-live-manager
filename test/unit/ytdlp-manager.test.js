import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeYouTubeUrl, isValidYouTubeUrl } from '../../src/ytdlp-manager.js';

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
