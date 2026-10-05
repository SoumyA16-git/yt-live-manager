/**
 * test/unit/youtube-template.test.js — Direct RTMPS mode validation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchVideoCategories,
  fetchTemplateVideoMetadata,
} from '../../src/youtube-api-manager.js';

describe('youtube-template (direct RTMPS mode)', () => {
  it('fetchVideoCategories returns empty array without YouTube API credentials', async () => {
    const cats = await fetchVideoCategories();
    assert.deepEqual(cats, []);
  });

  it('fetchTemplateVideoMetadata returns null without YouTube API credentials', async () => {
    const meta = await fetchTemplateVideoMetadata();
    assert.strictEqual(meta, null);
  });
});
