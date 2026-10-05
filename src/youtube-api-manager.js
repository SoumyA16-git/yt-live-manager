/**
 * youtube-api-manager.js — No-op stub.
 * YouTube Data API and OAuth2 dependencies have been permanently removed.
 * Streaming operates purely via direct YouTube RTMPS and Stream Keys.
 */

export function initYouTubeApi() {
  return false;
}

export function isYouTubeApiConfigured() {
  return false;
}

export function getYouTubeLiveApiState() {
  return {
    configured: false,
    unmanaged: true,
  };
}

export async function manageBroadcastLifecycleOnStart() {
  return { unmanaged: true };
}

export async function transitionBroadcast() {
  return { unmanaged: true };
}

export async function getAccessToken() {
  return null;
}

export async function resolveBoundBroadcast() {
  return { unmanaged: true };
}

export async function fetchVideoCategories() {
  return [];
}

export async function resolveCategoryName() {
  return '';
}

export async function fetchTemplateVideoMetadata() {
  return null;
}

export function _resetStateForTest() {}
export async function resolveLiveStreamByStreamKey() { return null; }
export async function getLiveStreamStatus() { return null; }
export async function createAndBindBroadcast() { return null; }
export function generateBroadcastTitle() { return 'Live Stream'; }
