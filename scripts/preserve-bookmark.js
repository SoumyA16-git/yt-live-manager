#!/usr/bin/env node
/**
 * scripts/preserve-bookmark.js
 *
 * Captures current stream playback position during updates or restarts
 * and writes a resume bookmark to data/stream-state.json before the service restarts.
 */

import fs from 'node:fs';
import path from 'node:path';

const installDir = process.argv[2] || process.env.INSTALL_DIR || '/opt/yt-live-manager';
const statePath = path.join(installDir, 'data', 'stream-state.json');
const settingsPath = path.join(installDir, 'config', 'settings.json');
const videosPath = path.join(installDir, 'data', 'videos.json');

function main() {
  if (!fs.existsSync(statePath)) {
    return;
  }

  try {
    const stateRaw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(stateRaw);

    // Only compute bookmark if stream was desired running and had a start time
    if (state.desiredState !== 'running' || !state.streamStartedAt) {
      return;
    }

    // If bookmark is already saved, don't overwrite with a stale or reset value
    if (state.resumeBookmark && typeof state.resumeBookmark.offsetSec === 'number' && state.resumeBookmark.offsetSec > 0) {
      console.log(`[preserve-bookmark] Existing bookmark already present at ${state.resumeBookmark.offsetSec}s for video ${state.resumeBookmark.videoId}`);
      return;
    }

    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {}
    }

    // Check if bookmarks are disabled in settings
    if (settings.scheduler?.autoRecycle?.resumeBookmark === false) {
      return;
    }

    let videos = [];
    if (fs.existsSync(videosPath)) {
      try {
        const vd = JSON.parse(fs.readFileSync(videosPath, 'utf8'));
        videos = Array.isArray(vd) ? vd : (vd.videos || []);
      } catch {}
    }
    const videoMap = new Map(videos.map(v => [v.id, v]));

    const startMs = new Date(state.streamStartedAt).getTime();
    if (!startMs || isNaN(startMs) || startMs > Date.now()) {
      return;
    }

    const elapsedSec = Math.max(0, (Date.now() - startMs) / 1000);
    const playlist = settings.stream?.playlist || [];
    const primaryId = state.activeVideoId || settings.stream?.videoId || playlist[0];

    if (!primaryId && playlist.length === 0) {
      return;
    }

    let bookmark = null;

    if (playlist.length <= 1) {
      const vidId = primaryId || playlist[0];
      const video = videoMap.get(vidId);
      const duration = Number(video?.probe?.durationSec || video?.probe?.duration || 0);
      const offsetSec = duration > 0 ? Math.floor(elapsedSec % duration) : Math.floor(elapsedSec);

      bookmark = {
        type: 'single',
        videoId: vidId,
        offsetSec: Math.max(0, offsetSec),
        at: new Date().toISOString(),
      };
    } else {
      // Multi-video playlist
      const metas = playlist.map(id => {
        const v = videoMap.get(id);
        return { id, duration: Number(v?.probe?.durationSec || v?.probe?.duration || 0) };
      });

      let totalCycle = 0;
      for (const item of metas) totalCycle += (item.duration || 0);

      if (totalCycle <= 0) {
        bookmark = {
          type: 'playlist',
          videoId: metas[0]?.id || primaryId,
          offsetSec: 0,
          at: new Date().toISOString(),
        };
      } else {
        const cyclePos = elapsedSec % totalCycle;
        let cum = 0;
        let activeItem = metas[0];
        let itemOffset = 0;

        for (const item of metas) {
          const dur = item.duration || 0;
          if (cyclePos >= cum && cyclePos < cum + dur) {
            activeItem = item;
            itemOffset = cyclePos - cum;
            break;
          }
          cum += dur;
        }

        bookmark = {
          type: 'playlist',
          videoId: activeItem.id,
          offsetSec: Math.max(0, Math.floor(itemOffset)),
          at: new Date().toISOString(),
        };
      }
    }

    if (bookmark && bookmark.videoId) {
      state.resumeBookmark = bookmark;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
      console.log(`[preserve-bookmark] Successfully preserved bookmark at ${bookmark.offsetSec}s (video: ${bookmark.videoId})`);
    }
  } catch (err) {
    console.warn(`[preserve-bookmark] Could not preserve bookmark: ${err.message}`);
  }
}

main();
