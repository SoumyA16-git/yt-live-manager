#!/usr/bin/env node
/**
 * scripts/seek.js — Jump/Seek Live Playback to Specific Timestamp
 *
 * Allows seeking to any point in the video:
 *   node scripts/seek.js 01:30:00     # Jump to 1h 30m 00s
 *   node scripts/seek.js 45:00        # Jump to 45 minutes
 *   node scripts/seek.js 3600         # Jump to 3600 seconds
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const installDir = fs.existsSync('/opt/yt-live-manager/data') ? '/opt/yt-live-manager' : path.resolve(__dirname, '..');
const statePath = path.join(installDir, 'data', 'stream-state.json');
const settingsPath = path.join(installDir, 'config', 'settings.json');
const videosPath = path.join(installDir, 'data', 'videos.json');

function parseTime(input) {
  if (!input) return null;
  const str = String(input).trim();
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }
  const parts = str.split(':').map(Number);
  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }
  if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  }
  return null;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log('Usage: node scripts/seek.js <HH:MM:SS | MM:SS | seconds>');
    console.log('Example: node scripts/seek.js 01:25:00');
    process.exit(1);
  }

  const offsetSec = parseTime(arg);
  if (offsetSec === null || isNaN(offsetSec) || offsetSec < 0) {
    console.error(`Invalid timestamp: "${arg}". Use format HH:MM:SS or seconds.`);
    process.exit(1);
  }

  if (!fs.existsSync(statePath)) {
    console.error(`State file not found at ${statePath}`);
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  let videoId = state.activeVideoId;

  if (!videoId && fs.existsSync(settingsPath)) {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    videoId = s.stream?.videoId;
  }

  if (!videoId) {
    console.error('No active video found to seek');
    process.exit(1);
  }

  let duration = 0;
  if (fs.existsSync(videosPath)) {
    try {
      const vData = JSON.parse(fs.readFileSync(videosPath, 'utf8'));
      const videos = Array.isArray(vData) ? vData : (vData.videos || []);
      const vid = videos.find(v => v.id === videoId);
      if (vid && vid.probe) {
        duration = Number(vid.probe.durationSec || vid.probe.duration || 0);
      }
    } catch {}
  }

  const safeOffset = duration > 0 ? (offsetSec % duration) : offsetSec;

  state.resumeBookmark = {
    type: 'single',
    videoId,
    offsetSec: safeOffset,
    at: new Date().toISOString(),
  };

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

  const s = Math.floor(safeOffset % 60);
  const m = Math.floor((safeOffset / 60) % 60);
  const h = Math.floor(safeOffset / 3600);
  const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  console.log(`✅ Set playback bookmark to ${timeStr} (${safeOffset}s) for video ${videoId}`);
  console.log('--> Restarting live stream service to apply new position...');

  try {
    execSync('systemctl restart yt-live-manager', { stdio: 'inherit' });
    console.log(`🎉 Stream successfully resumed from ${timeStr}!`);
  } catch (err) {
    console.log('Service restart command failed. Run manually: sudo systemctl restart yt-live-manager');
  }
}

main();
