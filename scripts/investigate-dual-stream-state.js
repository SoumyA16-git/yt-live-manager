/**
 * scripts/investigate-dual-stream-state.js
 *
 * Investigates:
 * 1. The two broadcasts visible in screenshots (9kID9BHrr1Y and DNDYLWeAOHQ)
 * 2. All liveStreams on the channel — which keys are bound to which broadcast
 * 3. Which broadcast actually owns the current stream keys
 * 4. Whether either broadcast has dual-stream configuration
 * 5. What the Public YouTube Data API v3 exposes for dual-stream configuration
 *
 * NO CODE CHANGES. READ-ONLY API INSPECTION.
 */

import { initYouTubeApi, getAccessToken } from '../src/youtube-api-manager.js';
import { loadSettings, getSettings, getStreamKey, getHorizontalStreamKey } from '../src/config-manager.js';

async function ytFetch(token, endpoint) {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://www.googleapis.com/youtube/v3/${endpoint}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

function banner(text) {
  const line = '='.repeat(60);
  console.log(`\n${line}`);
  console.log(text);
  console.log(line);
}

async function main() {
  await loadSettings();
  initYouTubeApi();

  const settings = getSettings();
  const primaryKey = getStreamKey();
  const secondaryKey = getHorizontalStreamKey();

  banner('STREAM KEYS IN APPLICATION CONFIG');
  console.log('Primary (Vertical) stream key:  ', primaryKey ? primaryKey.slice(0, 8) + '...' : 'NOT SET');
  console.log('Secondary (Horizontal) stream key:', secondaryKey ? secondaryKey.slice(0, 8) + '...' : 'NOT SET');
  console.log('Dual stream enabled in config:  ', settings?.stream?.dualStream || false);

  let token;
  try {
    token = await getAccessToken();
    console.log('\nOAuth2 token obtained successfully.');
  } catch (err) {
    console.error('FATAL: Cannot get OAuth2 token:', err.message);
    process.exit(1);
  }

  // ─── 1. List ALL liveStreams on the channel ────────────────────────────────
  banner('ALL LIVE STREAMS ON CHANNEL');
  let allStreams = [];
  let pageToken = '';
  let page = 0;
  do {
    page++;
    const pp = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const data = await ytFetch(token, `liveStreams?part=id,snippet,status,cdn&mine=true&maxResults=50${pp}`);
    allStreams = allStreams.concat(data.items || []);
    pageToken = data.nextPageToken || '';
  } while (pageToken && page < 10);

  console.log(`Total liveStreams found: ${allStreams.length}`);
  for (const s of allStreams) {
    const keyName = s.cdn?.ingestionInfo?.streamName || '';
    const matchesPrimary = primaryKey && keyName === primaryKey.trim() ? ' ← PRIMARY KEY' : '';
    const matchesSecondary = secondaryKey && keyName === secondaryKey.trim() ? ' ← SECONDARY KEY' : '';
    console.log(`\n  Stream ID:      ${s.id}`);
    console.log(`  Title:          ${s.snippet?.title || ''}`);
    console.log(`  streamStatus:   ${s.status?.streamStatus || 'unknown'}`);
    console.log(`  healthStatus:   ${s.status?.healthStatus?.status || 'unknown'}`);
    console.log(`  ingestionType:  ${s.cdn?.ingestionType || 'unknown'}`);
    console.log(`  streamName/key: ${keyName ? keyName.slice(0, 12) + '...' : 'NOT AVAILABLE'}${matchesPrimary}${matchesSecondary}`);
  }

  // ─── 2. Inspect specific broadcasts from screenshots ──────────────────────
  const broadcastsToCheck = [
    { id: '9kID9BHrr1Y', label: 'SCREENSHOT 1 (Dual stream toggle ON, "Preparing stream")' },
    { id: 'DNDYLWeAOHQ', label: 'SCREENSHOT 2 (Actually LIVE, "Change dashboard" target)' },
  ];

  banner('SPECIFIC BROADCAST INSPECTION (FROM SCREENSHOTS)');
  for (const { id, label } of broadcastsToCheck) {
    console.log(`\n--- ${label} ---`);
    console.log(`Broadcast ID: ${id}`);
    try {
      const data = await ytFetch(token, `liveBroadcasts?part=id,snippet,status,contentDetails&id=${id}`);
      const b = data.items?.[0];
      if (!b) {
        console.log('  ⚠ NOT FOUND on this channel (may belong to a different channel or be deleted)');
        continue;
      }
      console.log(`  Title:                ${b.snippet?.title || ''}`);
      console.log(`  scheduledStartTime:   ${b.snippet?.scheduledStartTime || ''}`);
      console.log(`  lifeCycleStatus:      ${b.status?.lifeCycleStatus || 'unknown'}`);
      console.log(`  privacyStatus:        ${b.status?.privacyStatus || 'unknown'}`);
      console.log(`  boundStreamId:        ${b.contentDetails?.boundStreamId || 'NONE'}`);
      console.log(`  enableAutoStart:      ${b.contentDetails?.enableAutoStart}`);
      console.log(`  enableAutoStop:       ${b.contentDetails?.enableAutoStop}`);
      console.log(`  monitorStream:        ${b.contentDetails?.monitorStream?.enableMonitorStream}`);
      console.log(`  recordFromStart:      ${b.contentDetails?.recordFromStart}`);
      console.log(`  Watch URL:            https://www.youtube.com/watch?v=${id}`);

      const streamId = b.contentDetails?.boundStreamId;
      if (streamId) {
        const sd = await ytFetch(token, `liveStreams?part=id,snippet,status,cdn&id=${streamId}`);
        const st = sd.items?.[0];
        if (st) {
          const keyName = st.cdn?.ingestionInfo?.streamName || '';
          const matchesPrimary = primaryKey && keyName === primaryKey.trim() ? ' ← PRIMARY KEY' : '';
          const matchesSecondary = secondaryKey && keyName === secondaryKey.trim() ? ' ← SECONDARY KEY' : '';
          console.log(`  Bound stream status:  ${st.status?.streamStatus || 'unknown'}`);
          console.log(`  Bound stream health:  ${st.status?.healthStatus?.status || 'unknown'}`);
          console.log(`  Bound stream key:     ${keyName ? keyName.slice(0, 12) + '...' : 'REDACTED'}${matchesPrimary}${matchesSecondary}`);
        } else {
          console.log(`  Bound stream:         ID ${streamId} (not visible in this API response)`);
        }
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  // ─── 3. List ALL recent broadcasts ────────────────────────────────────────
  banner('ALL BROADCASTS (RECENT) — FULL LIST');
  let allBcasts = [];
  pageToken = '';
  page = 0;
  do {
    page++;
    const pp = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const data = await ytFetch(token, `liveBroadcasts?part=id,snippet,status,contentDetails&broadcastType=all&mine=true&maxResults=50${pp}`);
    allBcasts = allBcasts.concat(data.items || []);
    pageToken = data.nextPageToken || '';
  } while (pageToken && page < 5);

  console.log(`Total broadcasts found: ${allBcasts.length}`);
  for (const b of allBcasts) {
    const status = b.status?.lifeCycleStatus || 'unknown';
    if (['complete', 'revoked'].includes(status)) continue; // skip old completed ones for brevity
    console.log(`\n  Broadcast ID:     ${b.id}`);
    console.log(`  Title:            ${(b.snippet?.title || '').slice(0, 60)}`);
    console.log(`  lifeCycleStatus:  ${status}`);
    console.log(`  boundStreamId:    ${b.contentDetails?.boundStreamId || 'NONE'}`);
    console.log(`  Watch URL:        https://www.youtube.com/watch?v=${b.id}`);
  }

  // ─── 4. Public API Dual Stream capability report ──────────────────────────
  banner('PUBLIC API DUAL STREAM CAPABILITY REPORT');
  console.log(`
The YouTube Data API v3 exposes these live-related resources:
  - liveBroadcasts: insert, list, update, transition, bind, delete
  - liveStreams: insert, list, update, delete

OFFICIAL DUAL STREAM FEATURE:
  YouTube's Dual Stream feature (Horizontal 16:9 + Vertical 9:16 in ONE broadcast)
  is enabled via YouTube Studio → Stream Settings → "Dual stream" toggle.

  When enabled, YouTube internally associates TWO ingestion endpoints
  with the SAME liveBroadcast resource — one for horizontal, one for vertical.

  The YouTube Data API v3 does NOT expose:
  ✗ liveBroadcasts.enableDualStream — no such endpoint
  ✗ liveBroadcasts.setVerticalStream — no such endpoint
  ✗ liveBroadcasts.bindSecondaryStream — no such endpoint
  ✗ Any field in liveBroadcasts.contentDetails for dual-stream vertical binding

  The liveBroadcasts.bind endpoint signature is:
    POST liveBroadcasts/bind?id={broadcastId}&streamId={streamId}&part=...
  This binds ONE liveStream to ONE liveBroadcast.
  There is NO second streamId parameter for the vertical feed.

CONCLUSION:
  "Official YouTube Dual Stream association requires the YouTube
  Live Control Room configuration and is not exposed as a public
  YouTube Data API operation."

  The one-time prerequisite is:
  1. YouTube Studio → Go Live → Stream Settings → Enable "Dual stream" (toggle)
  2. Set vertical source → "Encoder"
  3. Note the two stream keys YouTube assigns (horizontal + vertical)
  4. Both stream keys are ALREADY associated with the SAME broadcast by YouTube

  After this setup:
  - The application MUST manage only ONE broadcast (the one YouTube created)
  - The application MUST NOT create a second broadcast for the vertical stream
  - Both FFmpeg publishers push to their respective stream keys
  - YouTube internally routes horizontal viewers and Shorts feed viewers
`);

  banner('INVESTIGATION COMPLETE');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
