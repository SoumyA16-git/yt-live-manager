import puppeteer from 'puppeteer-core';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--user-data-dir=/home/ubuntu/.config/google-chrome-studio',
      '--window-size=1920,1080',
    ],
    env: { ...process.env, DISPLAY: ':10' },
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Check where https://studio.youtube.com/livestreaming redirects
  console.log('Navigating to https://studio.youtube.com/livestreaming...');
  await page.goto('https://studio.youtube.com/livestreaming', {
    waitUntil: 'networkidle2',
    timeout: 45000,
  });
  await new Promise(r => setTimeout(r, 4000));

  const streamTabUrl = page.url();
  console.log('STREAM_TAB_FINAL_URL:', streamTabUrl);
  await page.screenshot({ path: '/opt/yt-live-manager/logs/stream_tab.png' });

  // Get stream metadata from this page
  const streamInfo = await page.evaluate(() => {
    const card = document.querySelector('ytls-broadcast-metadata');
    const titleEl = document.querySelector('#stream-title, ytls-broadcast-metadata .title');
    const goLiveBtn = document.querySelector('#start-stream-button');
    const editBtn = document.querySelector('#edit-button');
    return {
      cardText: card ? card.innerText.replace(/\n+/g, ' | ') : 'NO_CARD',
      title: titleEl ? titleEl.innerText : 'NO_TITLE_EL',
      goLivePresent: !!goLiveBtn,
      editPresent: !!editBtn
    };
  });
  console.log('STREAM_TAB_INFO:', JSON.stringify(streamInfo, null, 2));

  // Also check /livestreaming/manage
  console.log('Navigating to https://studio.youtube.com/livestreaming/manage...');
  await page.goto('https://studio.youtube.com/livestreaming/manage', {
    waitUntil: 'networkidle2',
    timeout: 45000,
  });
  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ path: '/opt/yt-live-manager/logs/manage_tab.png' });

  const rows = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('ytcp-video-row, ytcp-live-broadcast-row, tr[role="row"]'));
    return list.map(el => ({
      text: el.innerText.replace(/\n+/g, ' | ').slice(0, 150),
      links: Array.from(el.querySelectorAll('a')).map(a => a.href)
    })).filter(x => x.text.length > 5);
  });
  console.log('MANAGE_TAB_ROWS:', JSON.stringify(rows.slice(0, 5), null, 2));

  await browser.close();
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
