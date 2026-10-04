/**
 * scripts/verify-template-prod.js — Verify YouTube template sync and channel ownership in production.
 */

import {
  initYouTubeApi,
  getAccessToken,
  fetchVideoCategories,
  fetchTemplateVideoMetadata,
} from '../src/youtube-api-manager.js';

async function main() {
  initYouTubeApi();

  console.log('1. Checking OAuth Token...');
  const token = await getAccessToken();
  console.log('   OAuth token obtained successfully! (length:', token.length, ')');

  console.log('\n2. Fetching YouTube Video Categories...');
  const cats = await fetchVideoCategories('IN');
  console.log(`   Found ${cats.length} categories:`);
  cats.slice(0, 8).forEach(c => console.log(`   - [${c.id}] ${c.title}`));

  console.log('\n3. Querying Channel & Existing Videos...');
  const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const chData = await chRes.json();
  const channel = chData.items?.[0];
  console.log('   Channel ID:', channel?.id);
  console.log('   Channel Title:', channel?.snippet?.title);

  // List recent broadcasts on channel
  const bRes = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,snippet,status&mine=true&maxResults=10', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bData = await bRes.json();
  console.log(`\n4. Found ${bData.items?.length || 0} existing live broadcasts on channel:`);
  for (const b of (bData.items || [])) {
    console.log(`   - ID: ${b.id}`);
    console.log(`     Title: ${b.snippet?.title}`);
    console.log(`     Status: ${b.status?.lifeCycleStatus}`);
    console.log(`     Description: ${(b.snippet?.description || '').slice(0, 60)}...`);
  }

  // If broadcasts exist, test template sync using the first one
  const sampleVideoId = bData.items?.[0]?.id;
  if (sampleVideoId) {
    console.log(`\n5. Testing fetchTemplateVideoMetadata with video ID ${sampleVideoId}...`);
    const meta = await fetchTemplateVideoMetadata(sampleVideoId);
    console.log('   Template Sync Succeeded:');
    console.log('   - Description:', meta.description.slice(0, 60), '...');
    console.log(`   - Category: [${meta.categoryId}] ${meta.categoryName}`);
    console.log('   - Tags count:', meta.tags.length, meta.tags);
    console.log('   - Thumbnail:', meta.thumbnail);
    console.log('   - Dynamic Title Template (Untouched):', meta.titleTemplate);
  }
}

main().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
