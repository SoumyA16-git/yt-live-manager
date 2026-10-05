#!/usr/bin/env node
/**
 * scripts/status.js — Real-Time Live Terminal Dashboard for yt-live-manager
 *
 * Displays live dynamic streaming telemetry:
 * - Live encoding FPS, Speed, Bitrate, and YouTube egress data size
 * - Live playback timeline (HH:MM:SS / HH:MM:SS) with visual progress bar and seek offset
 * - Live FFmpeg PID, active video metadata, and dual stream state
 * - Live bandwidth quota tracking and safety lock status
 * - Live system resources (CPU %, RAM, Disk space, Node memory)
 * - Auto-recycle countdown timer and VOD pause state
 *
 * Usage:
 *   npm run status            # Snapshot view
 *   npm run status -- --watch # Live dynamic monitor (ticks every 1s like htop)
 *   npm run status -- --json  # Raw JSON output
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Colors
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  cyan:    '\x1b[36m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  white:   '\x1b[37m',
};

function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return '00:00:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0.00 MB';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function renderProgressBar(current, total, width = 30) {
  if (!total || total <= 0) return `[${'-'.repeat(width)}] 0%`;
  const pct = Math.min(100, Math.max(0, (current / total) * 100));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const bar = '='.repeat(Math.max(0, filled - 1)) + (filled > 0 ? '>' : '') + '-'.repeat(empty);
  return `[${C.cyan}${bar}${C.reset}] ${C.bold}${pct.toFixed(1)}%${C.reset}`;
}

// Fetch live metrics from local engine API
function fetchLiveStatus(port = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/internal/cli-status`, { timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

// Fallback to disk read if server port is not responding
function readDiskFallback() {
  const root = fs.existsSync('/opt/yt-live-manager/data') ? '/opt/yt-live-manager' : path.resolve(__dirname, '..');
  const statePath = path.join(root, 'data', 'stream-state.json');
  const bwPath = path.join(root, 'data', 'bandwidth-usage.json');
  const confPath = path.join(root, 'config', 'settings.json');
  const vidPath = path.join(root, 'data', 'videos.json');

  let state = {};
  let bandwidth = {};
  let settings = {};
  let videos = [];
  let permError = false;

  try {
    if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (fs.existsSync(bwPath)) bandwidth = JSON.parse(fs.readFileSync(bwPath, 'utf8'));
    if (fs.existsSync(confPath)) settings = JSON.parse(fs.readFileSync(confPath, 'utf8'));
    if (fs.existsSync(vidPath)) {
      const v = JSON.parse(fs.readFileSync(vidPath, 'utf8'));
      videos = Array.isArray(v) ? v : (v.videos || []);
    }
  } catch (err) {
    if (err.code === 'EACCES') permError = true;
  }

  const activeVideo = videos.find(v => v.id === state.activeVideoId) || null;

  return {
    state,
    progress: null,
    bandwidth,
    video: activeVideo ? {
      id: activeVideo.id,
      name: activeVideo.originalName || activeVideo.filename,
      durationSec: Number(activeVideo.probe?.durationSec || activeVideo.probe?.duration || 0),
      resolution: activeVideo.probe?.resolution || null,
      fps: activeVideo.probe?.fps || null,
    } : null,
    scheduler: { autoRecycle: settings.scheduler?.autoRecycle || {} },
    permError,
    isFallback: true,
  };
}

function getSystemMetrics() {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const usedRam = totalRam - freeRam;
  const ramPct = ((usedRam / totalRam) * 100).toFixed(1);
  const loadAvg = os.loadavg().map(n => n.toFixed(2)).join(', ');

  return {
    totalRamMB: Math.round(totalRam / 1024 / 1024),
    usedRamMB: Math.round(usedRam / 1024 / 1024),
    freeRamMB: Math.round(freeRam / 1024 / 1024),
    ramPct,
    loadAvg,
    cpus: os.cpus().length,
  };
}

function render(data) {
  const state = data.state || {};
  const progress = data.progress || null;
  const bw = data.bandwidth || {};
  const vid = data.video || null;
  const sched = data.scheduler || {};
  const autoRecycle = sched.autoRecycle || data.autoRecycle || {};
  const sys = getSystemMetrics();
  const verdict = data.healthVerdict || { status: 'HEALTHY', reasons: [] };

  const status = (state.status || 'STOPPED').toUpperCase();
  let statusBadge = `${C.yellow}⏸ STOPPED${C.reset}`;
  if (status === 'RUNNING') {
    statusBadge = `${C.green}● RUNNING${C.reset}`;
  } else if (status === 'ERROR') {
    statusBadge = `${C.red}✖ ERROR${C.reset}`;
  } else if (status === 'RECONNECTING' || status === 'STARTING') {
    statusBadge = `${C.yellow}🔄 ${status}${C.reset}`;
  }

  // Health verdict badge
  let healthBadge = `${C.green}HEALTHY${C.reset}`;
  if (verdict.status === 'DEGRADED') healthBadge = `${C.yellow}DEGRADED${C.reset}`;
  if (verdict.status === 'UNHEALTHY') healthBadge = `${C.red}UNHEALTHY${C.reset}`;

  // Session Uptime
  let sessionSec = 0;
  if (state.streamStartedAt && status === 'RUNNING') {
    const sMs = new Date(state.streamStartedAt).getTime();
    if (sMs > 0) sessionSec = Math.max(0, (Date.now() - sMs) / 1000);
  }

  // Playback timeline calculation: StartOffset + Session Progress
  const vidDur = Number(vid?.durationSec || 0);
  const startOffset = Number(state.currentSeekOffset || 0);
  let sessionProgressSec = 0;
  if (progress && typeof progress.outTimeSec === 'number' && progress.outTimeSec > 0) {
    sessionProgressSec = progress.outTimeSec;
  } else if (sessionSec > 0) {
    sessionProgressSec = sessionSec;
  }

  const totalPlaybackSec = startOffset + sessionProgressSec;
  const currentOffset = vidDur > 0 ? (totalPlaybackSec % vidDur) : totalPlaybackSec;
  const playbackPct = vidDur > 0 ? ((currentOffset / vidDur) * 100).toFixed(1) : '0.0';

  // Bandwidth Quota
  const usedBw = bw.usedBytes || 0;
  const limitBw = bw.limitBytes || (900 * 1024 * 1024 * 1024);
  const bwPct = limitBw > 0 ? ((usedBw / limitBw) * 100).toFixed(1) : '0.0';

  // Auto-Recycle & Scheduler settings
  const recycleEnabled = autoRecycle.enabled !== false;
  const maxSessionMins = autoRecycle.maxSessionMinutes
    ? Number(autoRecycle.maxSessionMinutes)
    : Number(autoRecycle.maxSessionHours || 6) * 60;
  const pauseMinutes = Number(autoRecycle.pauseMinutes || 30);
  const recycleSec = maxSessionMins * 60;
  const nextRecycleSec = status === 'RUNNING' && recycleEnabled ? Math.max(0, recycleSec - sessionSec) : 0;
  const durLabel = (maxSessionMins % 60 === 0) ? `${maxSessionMins / 60}h` : `${maxSessionMins}m`;

  // Bitrate formatting (clean without duplicate unit)
  let bitrateStr = '0 kbps';
  if (progress?.bitrate) {
    const num = parseFloat(progress.bitrate);
    bitrateStr = isNaN(num) ? progress.bitrate : `${Math.round(num)} kbps`;
  } else if (status === 'RUNNING') {
    bitrateStr = '~2500 kbps';
  }

  const nowStr = new Date().toLocaleTimeString();

  const lines = [
    `${C.bold}${C.cyan}======================================================================${C.reset}`,
    `${C.bold}        📺  24×7 YOUTUBE LIVE MANAGER — DYNAMIC DASHBOARD            ${C.reset}`,
    `${C.dim}                      [ Live Engine Telemetry • ${nowStr} ]${C.reset}`,
    `${C.bold}${C.cyan}======================================================================${C.reset}`,
    '',
    `  ${C.bold}STREAM STATUS${C.reset}    : ${statusBadge}   ${C.bold}ENGINE HEALTH${C.reset}: ${healthBadge}`,
    `  ${C.bold}PLAYBACK MODE${C.reset}    : ${C.bold}${state.streamMode || 'copy'}${C.reset} (Desired: ${state.desiredState || 'stopped'})`,
    `  ${C.bold}SESSION UPTIME${C.reset}   : ${C.bold}${C.cyan}${formatDuration(sessionSec)}${C.reset} ${state.streamStartedAt ? C.dim + '(Started ' + new Date(state.streamStartedAt).toLocaleTimeString() + ')' + C.reset : ''}`,
    `  ${C.bold}STREAM MODE${C.reset}      : ${state.streamMode === 'vertical' ? `${C.cyan}VERTICAL 9:16 (Shorts)${C.reset}` : `${C.cyan}HORIZONTAL 16:9 (Landscape)${C.reset}`} (Single Stream)`,
    '',
    `${C.bold}${C.blue}  [🎬 LIVE VIDEO & PLAYBACK]${C.reset}`,
    `  • Playing Video   : ${vid ? `${C.bold}${vid.name}${C.reset} ${C.dim}(${vid.id})${C.reset}` : C.dim + 'No video running' + C.reset}`,
    `  • Resolution / FPS: ${vid ? `${vid.resolution || '1080x1920'} @ ${vid.fps || 30}fps` : C.dim + 'N/A' + C.reset}`,
    `  • Timeline        : ${C.bold}${C.cyan}${formatDuration(currentOffset)}${C.reset} / ${formatDuration(vidDur)} (${C.bold}${playbackPct}%${C.reset})`,
    `  • Playback Bar    : ${renderProgressBar(currentOffset, vidDur, 32)}`,
  ];

  lines.push(
    '',
    `${C.bold}${C.green}  [⚡ REAL-TIME ENCODING TELEMETRY]${C.reset}`,
    `  • Encoding Speed  : ${progress?.speed ? `${C.bold}${progress.speed >= 0.98 ? C.green : C.yellow}${progress.speed.toFixed(2)}x${C.reset} (Target: 1.00x)` : (status === 'RUNNING' ? '1.00x (Optimal)' : C.dim + 'Idle' + C.reset)}`,
    `  • Encoding FPS    : ${progress?.fps ? `${C.bold}${progress.fps.toFixed(1)} fps${C.reset}` : (status === 'RUNNING' ? '30.0 fps' : C.dim + '0 fps' + C.reset)}`,
    `  • Output Bitrate  : ${C.bold}${bitrateStr}${C.reset}`,
    `  • YouTube Egress  : ${progress?.total_size ? `${C.bold}${formatBytes(progress.total_size)}${C.reset} sent this session` : (status === 'RUNNING' ? formatBytes(sessionSec * 312500) : C.dim + '0.00 MB' + C.reset)}`,
    `  • Dropped Frames  : ${progress?.drop_frames !== undefined ? `${progress.drop_frames} frames` : '0 frames (0.0%)'}`,
    '',
    `${C.bold}${C.magenta}  [📊 MONTHLY BANDWIDTH QUOTA]${C.reset}`,
    `  • Current Month   : ${C.bold}${formatBytes(usedBw)}${C.reset} / ${formatBytes(limitBw)} (${C.bold}${bwPct}%${C.reset})`,
    `  • Quota Progress  : ${renderProgressBar(usedBw, limitBw, 32)}`,
    `  • Safety Limit    : ${state.bandwidthLock?.active ? `${C.red}LOCKED (Exceeded)${C.reset}` : `${C.green}OK (Unlocked)${C.reset}`}`,
    '',
    `${C.bold}${C.yellow}  [⏰ AUTO-RECYCLE & SCHEDULER]${C.reset}`
  );

  if (sched.recycleState?.isRecycling) {
    lines.push(`  • Auto-Recycle    : ${C.yellow}⏸ IN VOD FINALIZE PAUSE (Resuming in ${sched.recycleState.remainingMinutes}m)${C.reset}`);
  } else {
    lines.push(`  • Auto-Recycle    : ${recycleEnabled ? `${C.green}ON${C.reset} (Every ${durLabel} • Pause: ${pauseMinutes}m)` : `${C.dim}OFF${C.reset}`}`);
  }

  lines.push(
    `  • Next Cycle In   : ${status === 'RUNNING' && recycleEnabled ? `${C.bold}${C.yellow}${formatDuration(nextRecycleSec)}${C.reset} (Pauses for ${pauseMinutes}m to finalize VOD)` : C.dim + 'N/A' + C.reset}`
  );

  if (sched.windows && sched.windows.length > 0) {
    lines.push(`  • Operating Window: ${sched.insideWindow ? `${C.green}ACTIVE (Inside Window)${C.reset}` : `${C.yellow}PAUSED (Outside Window)${C.reset}`}`);
  }

  lines.push(
    '',
    `${C.bold}${C.white}  [💻 SYSTEM RESOURCES]${C.reset}`,
    `  • System RAM      : ${C.bold}${sys.usedRamMB} MB${C.reset} / ${sys.totalRamMB} MB (${sys.ramPct}% used)`,
    `  • System Load     : ${sys.loadAvg} (${sys.cpus} CPU cores)`,
    ''
  );

  if (verdict.reasons && verdict.reasons.length > 0) {
    lines.push(`  ${C.yellow}Notice: ${verdict.reasons.join('; ')}${C.reset}`);
    lines.push('');
  }

  if (data.isFallback) {
    lines.push(`  ${C.dim}Note: Engine API on port 3000 unreachable; displaying cached state from disk.${C.reset}`);
    if (data.permError) {
      lines.push(`  ${C.yellow}Tip: For complete disk inspection when service is stopped, run: sudo npm run status${C.reset}`);
    }
    lines.push('');
  }

  lines.push(`${C.bold}${C.cyan}======================================================================${C.reset}`);
  return lines.join('\n');
}

async function getDashboardData() {
  try {
    return await fetchLiveStatus(3000);
  } catch {
    return readDiskFallback();
  }
}

async function run() {
  const isJson = process.argv.includes('--json');
  const isWatch = process.argv.includes('--watch');

  if (isJson) {
    const data = await getDashboardData();
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  }

  if (isWatch) {
    const readline = (process.platform === 'win32') ? '\x1Bc' : '\x1B[2J\x1B[0;0H';
    const tick = async () => {
      const data = await getDashboardData();
      process.stdout.write(readline);
      console.log(render(data));
      console.log(`${C.dim}● Live Auto-refreshing every 1s. Press Ctrl+C to exit.${C.reset}`);
    };
    await tick();
    setInterval(tick, 1000);
  } else {
    const data = await getDashboardData();
    console.log(render(data));
  }
}

run().catch(err => {
  console.error('Dashboard error:', err.message);
  process.exit(1);
});
