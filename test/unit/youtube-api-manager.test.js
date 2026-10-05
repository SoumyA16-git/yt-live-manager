/**
 * test/unit/youtube-api-manager.test.js — Unit tests for stubbed youtube-api-manager.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  initYouTubeApi,
  isYouTubeApiConfigured,
  getYouTubeLiveApiState,
  manageBroadcastLifecycleOnStart,
  transitionBroadcast,
} from '../../src/youtube-api-manager.js';

describe('youtube-api-manager (direct RTMPS mode)', () => {
  it('reports isYouTubeApiConfigured as false', () => {
    assert.strictEqual(isYouTubeApiConfigured(), false);
  });

  it('initYouTubeApi returns false', () => {
    assert.strictEqual(initYouTubeApi(), false);
  });

  it('getYouTubeLiveApiState returns unmanaged state', () => {
    const state = getYouTubeLiveApiState();
    assert.strictEqual(state.configured, false);
    assert.strictEqual(state.unmanaged, true);
  });

  it('manageBroadcastLifecycleOnStart returns unmanaged', async () => {
    const res = await manageBroadcastLifecycleOnStart();
    assert.strictEqual(res.unmanaged, true);
  });

  it('transitionBroadcast returns unmanaged', async () => {
    const res = await transitionBroadcast();
    assert.strictEqual(res.unmanaged, true);
  });
});
