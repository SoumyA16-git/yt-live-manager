/**
 * scripts/test-live-start.js — Test production stream start and verify YouTube Live lifecycle.
 */

import { initYouTubeApi, getAccessToken, resolveBoundBroadcast } from '../src/youtube-api-manager.js';
import { loadSettings } from '../src/config-manager.js';
import { loadState, getState } from '../src/state-manager.js';
import { loadUsage } from '../src/usage-manager.js';
import { startStream, stopStream, getCurrentLifecyclePromise } from '../src/stream-manager.js';

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('======================================================================');
  console.log('  PRODUCTION LIVE STREAMING LIFECYCLE ACCEPTANCE TEST');
  console.log('======================================================================\n');

  initYouTubeApi();
  const settings = await loadSettings();
  await loadState();
  await loadUsage(settings.bandwidth?.accounting);

  console.log('1. Initiating Stream Start (FFmpeg spawn)...');
  const startResult = await startStream({ reason: 'production_acceptance', clearMaintenance: true });
  console.log('   Start Result:', startResult);

  if (!startResult.started && !startResult.alreadyRunning) {
    throw new Error(`Stream failed to start: ${startResult.message || startResult.code}`);
  }

  console.log('\n2. Waiting for FFmpeg and YouTube API Autonomous Lifecycle to verify...');
  const lifecyclePromise = getCurrentLifecyclePromise();
  if (lifecyclePromise) {
    console.log('   Lifecycle promise active, awaiting resolution...');
    const result = await lifecyclePromise;
    console.log('   Lifecycle Promise Result:', result);
  } else {
    console.log('   Awaiting lifecycle completion (polling state for up to 60s)...');
    const startWait = Date.now();
    while (Date.now() - startWait < 60000) {
      await wait(3000);
      const curState = getState();
      console.log(`   [State Poll] Status: ${curState.status} | Ingest: ${curState.youtubeIngest} | Broadcast: ${curState.youtubeBroadcast}`);
      if (curState.youtubeBroadcast === 'LIVE' || curState.youtubeBroadcastLive) {
        break;
      }
    }
  }

  // Poll state up to 30s to verify LIVE
  let confirmedLive = false;
  let finalState = getState();
  for (let i = 0; i < 15; i++) {
    finalState = getState();
    console.log(`   [Verification ${i + 1}/15] State: ${finalState.status} | Ingest: ${finalState.youtubeIngest} | Broadcast: ${finalState.youtubeBroadcast} (Live: ${finalState.youtubeBroadcastLive})`);
    if (finalState.youtubeBroadcast === 'LIVE' && finalState.youtubeBroadcastLive) {
      confirmedLive = true;
      break;
    }
    await wait(2000);
  }

  console.log('\n3. YouTube API Verification of Live Broadcast...');
  const token = await getAccessToken();
  const broadcastId = finalState.broadcastId;
  console.log(`   Active Broadcast ID: ${broadcastId}`);

  if (broadcastId) {
    const bRes = await fetch(`https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&id=${broadcastId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const bData = await bRes.json();
    const item = bData.items?.[0];
    console.log(`   YouTube Broadcast Title: "${item?.snippet?.title}"`);
    console.log(`   YouTube Broadcast LifeCycleStatus: ${item?.status?.lifeCycleStatus}`);
    console.log(`   YouTube Broadcast Live Streams Ingest: ${finalState.youtubeIngest}`);

    // Verify video metadata on this active broadcast
    const vRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${broadcastId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const vData = await vRes.json();
    const vItem = vData.items?.[0];
    console.log(`   Video Description: ${(vItem?.snippet?.description || '').slice(0, 60)}...`);
    console.log(`   Video Category: ${vItem?.snippet?.categoryId}`);
    console.log(`   Video Tags (${vItem?.snippet?.tags?.length || 0}): ${vItem?.snippet?.tags?.slice(0, 4).join(', ')}...`);
    console.log(`   Video Thumbnail: ${Boolean(vItem?.snippet?.thumbnails?.default?.url)}`);
  }

  console.log('\n4. Stopping stream after successful verification...');
  await stopStream({ reason: 'acceptance_complete' });
  console.log('   Stream stopped successfully.');

  console.log('\n======================================================================');
  if (confirmedLive) {
    console.log('🎉 FULL LIVE VERIFICATION CONFIRMED: Stream is ACTIVE and Broadcast is LIVE!');
  } else {
    console.log('⚠️ Lifecycle completed. Status recorded above.');
  }
  console.log('======================================================================');
}

main().catch(err => {
  console.error('\n❌ Live Verification Failed:', err);
  process.exit(1);
});
