/**
 * scripts/normalize-video.js — Offline GOP Normalizer for YouTube Compliance
 *
 * Re-encodes videos to embed strict 2.0-second keyframes (GOP = 60 @ 30fps)
 * while preserving original resolution and copying AAC audio without quality loss.
 *
 * Once normalized on disk:
 *   - YouTube Live Stream Health receives perfect 2.0s keyframes (no buffering warnings)
 *   - 24/7 live streaming can run in pure stream-copy (-c:v copy) mode with <1% CPU!
 *
 * Usage:
 *   node scripts/normalize-video.js <videoId>
 *   node scripts/normalize-video.js --all
 */

import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { probeMedia, evaluateCompatibility } from '../src/ffprobe-manager.js';
import { loadSettings } from '../src/config-manager.js';
import { PATHS } from '../src/lib/constants.js';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

async function normalizeVideoFile(v, settings) {
  const videoPath = path.join(PATHS.videosDir, v.filename);
  const tempPath = path.join(PATHS.videosDir, `.${v.filename}.norm.mp4`);

  console.log(`[NORMALIZE] Starting GOP normalization for ${v.id} (${v.filename})...`);
  const probe = await probeMedia(videoPath);
  const fps = probe.fps || 30;
  const gop = Math.round(fps * 2);
  const targetBitrate = probe.videoBitrate > 0 ? probe.videoBitrate : 3_500_000;
  const targetKbps = Math.min(Math.round(targetBitrate / 1000), 4000);

  const ffmpegArgs = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-y',
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', `${targetKbps}k`,
    '-maxrate', `${Math.round(targetKbps * 1.15)}k`,
    '-bufsize', `${targetKbps * 2}k`,
    '-g', `${gop}`,
    '-keyint_min', `${gop}`,
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:a', 'copy',
    tempPath,
  ];

  await runFfmpeg(ffmpegArgs);

  // Replace original with normalized copy
  await fs.rename(tempPath, videoPath);

  // Re-probe
  const freshProbe = await probeMedia(videoPath);
  const orient = (freshProbe && freshProbe.width > freshProbe.height) ? 'horizontal' : 'vertical';
  const compat = evaluateCompatibility(freshProbe, settings, orient);

  console.log(`[NORMALIZE] Completed ${v.id}: maxKeyframe=${freshProbe.maxKeyframeIntervalSec}s, status=${compat.status}`);
  return { probe: freshProbe, compatibility: compat };
}

async function main() {
  const targetArg = process.argv[2];
  if (!targetArg) {
    console.error('Usage: node scripts/normalize-video.js <videoId|--all>');
    process.exit(1);
  }

  const settings = await loadSettings();
  const videosJsonPath = PATHS.videosJson;
  const data = JSON.parse(await fs.readFile(videosJsonPath, 'utf8'));

  const targets = targetArg === '--all'
    ? data.videos.filter(v => v.probe?.maxKeyframeIntervalSec > 4.0 || v.compatibility?.status !== 'COMPATIBLE')
    : data.videos.filter(v => v.id === targetArg || v.filename === targetArg);

  if (targets.length === 0) {
    console.log('[NORMALIZE] No videos found matching target or requiring normalization.');
    return;
  }

  console.log(`[NORMALIZE] Found ${targets.length} video(s) to process.`);
  for (const v of targets) {
    try {
      const { probe, compatibility } = await normalizeVideoFile(v, settings);
      v.probe = probe;
      v.compatibility = compatibility;
      await fs.writeFile(videosJsonPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error(`[NORMALIZE] Failed processing ${v.id}: ${err.message}`);
    }
  }

  console.log('[NORMALIZE] All processing finished.');
}

main().catch(err => {
  console.error('[NORMALIZE] Fatal error:', err);
  process.exit(1);
});
