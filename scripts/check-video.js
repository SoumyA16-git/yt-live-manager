import { initYouTubeApi, getAccessToken } from '../src/youtube-api-manager.js';

const videoId = process.argv[2] || 'HvWR9sk6w2c';

async function main() {
  initYouTubeApi();
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const item = data.items?.[0];
  console.log('Video ID:', item?.id);
  console.log('Title:', item?.snippet?.title);
  console.log('Description:', item?.snippet?.description);
  console.log('Category ID:', item?.snippet?.categoryId);
  console.log('Tags:', item?.snippet?.tags);
  console.log('Thumbnails:', Object.keys(item?.snippet?.thumbnails || {}));
}

main().catch(console.error);
