/**
 * scripts/verify-dual-broadcast-prod.js
 *
 * Direct verification of Dual YouTube Broadcast Lifecycle in production:
 * - Fetches LiveStream details for Vertical & Horizontal streams
 * - Fetches LiveBroadcast details for Vertical & Horizontal broadcasts
 * - Confirms streamStatus, healthStatus, lifeCycleStatus, and boundStreamId for both
 */

import {
  initYouTubeApi,
  getAccessToken,
} from '../src/youtube-api-manager.js';
import { getState, loadState } from '../src/state-manager.js';

async function main() {
  initYouTubeApi();
  await loadState();

  const state = getState();
  console.log('============================================================');
  console.log('APPLICATION DUAL STATE:');
  console.log('============================================================');
  console.log('Stream Status:', state.status);
  console.log('Dual Stream Enabled:', state.isDualStream);
  console.log('Primary Broadcast ID:', state.primaryBroadcastId);
  console.log('Secondary Broadcast ID:', state.secondaryBroadcastId);
  console.log('Primary Broadcast Status:', state.primaryBroadcastStatus);
  console.log('Secondary Broadcast Status:', state.secondaryBroadcastStatus);
  console.log('YouTube Ingest:', state.youtubeIngest);
  console.log('YouTube Broadcast:', state.youtubeBroadcast);

  const token = await getAccessToken();

  async function getStream(id) {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,status,cdn&id=${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await res.json();
    return d.items?.[0];
  }

  async function getBroadcast(id) {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails&id=${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await res.json();
    return d.items?.[0];
  }

  const verticalStreamId = 'flh3lFKq31CkHYP-39JyKA1791149609382063';
  const horizontalStreamId = 'flh3lFKq31CkHYP-39JyKA1791149563701610';

  const verticalBcastId = state.primaryBroadcastId;
  const horizontalBcastId = state.secondaryBroadcastId;

  console.log('\n============================================================');
  console.log('YOUTUBE DATA API v3 VERIFICATION:');
  console.log('============================================================');

  const vs = await getStream(verticalStreamId);
  const hs = await getStream(horizontalStreamId);
  const vb = verticalBcastId ? await getBroadcast(verticalBcastId) : null;
  const hb = horizontalBcastId ? await getBroadcast(horizontalBcastId) : null;

  console.log('\nPRIMARY (VERTICAL 9:16):');
  console.log('  LiveStream ID:              ', vs?.id);
  console.log('  streamStatus:               ', vs?.status?.streamStatus);
  console.log('  healthStatus:               ', vs?.status?.healthStatus?.status);
  console.log('  Broadcast ID:               ', vb?.id);
  console.log('  broadcast.title:            ', vb?.snippet?.title);
  console.log('  broadcast.lifeCycleStatus:  ', vb?.status?.lifeCycleStatus);
  console.log('  broadcast.boundStreamId:    ', vb?.contentDetails?.boundStreamId);
  console.log('  Binding correct:            ', vb?.contentDetails?.boundStreamId === verticalStreamId ? 'YES' : 'NO');

  console.log('\nSECONDARY (HORIZONTAL 16:9):');
  console.log('  LiveStream ID:              ', hs?.id);
  console.log('  streamStatus:               ', hs?.status?.streamStatus);
  console.log('  healthStatus:               ', hs?.status?.healthStatus?.status);
  console.log('  Broadcast ID:               ', hb?.id);
  console.log('  broadcast.title:            ', hb?.snippet?.title);
  console.log('  broadcast.lifeCycleStatus:  ', hb?.status?.lifeCycleStatus);
  console.log('  broadcast.boundStreamId:    ', hb?.contentDetails?.boundStreamId);
  console.log('  Binding correct:            ', hb?.contentDetails?.boundStreamId === horizontalStreamId ? 'YES' : 'NO');

  const titlesMatch = vb?.snippet?.title === hb?.snippet?.title;
  console.log('\nSESSION TITLE VERIFICATION:');
  console.log('  Primary Title:              ', vb?.snippet?.title);
  console.log('  Secondary Title:            ', hb?.snippet?.title);
  console.log('  Titles Identical:           ', titlesMatch ? 'YES (Identical timestamp)' : 'NO (Mismatch)');

  console.log('\n============================================================');
  const dualHealthy =
    vs?.status?.streamStatus === 'active' &&
    hs?.status?.streamStatus === 'active' &&
    vb?.status?.lifeCycleStatus === 'live' &&
    hb?.status?.lifeCycleStatus === 'live' &&
    vb?.contentDetails?.boundStreamId === verticalStreamId &&
    hb?.contentDetails?.boundStreamId === horizontalStreamId &&
    titlesMatch;

  console.log('DUAL LIVE BROADCAST ACCEPTANCE:', dualHealthy ? 'PASSED (BOTH LIVE, BOUND & IDENTICAL TITLE)' : 'FAILED');
  console.log('============================================================');
}

main().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
