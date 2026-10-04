#!/usr/bin/env node
/**
 * scripts/status.js — Terminal CLI Dashboard for yt-live-manager
 *
 * Displays a live, formatted dashboard directly in your SSH terminal:
 * - Stream status, session uptime, and FFmpeg PID
 * - Active video title, duration, and playback position
 * - Monthly bandwidth usage and quota progress
 * - System RAM, CPU, Load average, and Disk space
 * - Auto-recycle and scheduler status
 *
 * Usage:
 *   node scripts/status.js            # Print once
 *   node scripts/status.js --watch    # Live interactive refresh (every 2s)
 *   node scripts/status.js --json     # Output raw JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve installation root
function resolveRoot() {
  const candidate = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : process.env.INSTALL_DIR;
  if (candidate && fs.existsSync(candidate)) return candidate;
  if (fs.existsSync('/opt/yt-live-manager/data')) return '/opt/yt-live-manager';
  return path.resolve(__dirname, '..');
}

const ROOT_DIR = resolveRoot();
const STATE_FILE = path.join(ROOT_DIR, 'data', 'stream-state.json');
const BW_FILE    = path.join(ROOT_DIR, 'data', 'bandwidth-usage.json');
const VIDEOS_FILE= path.join(ROOT_DIR, 'data', 'videos.json');
const CONF_FILE  = path.join(ROOT_DIR, 'config', 'settings.json');

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

function readJSONSafe(file, def = {}) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {}
  return def;
}

function getSystemMetrics() {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const usedRam = totalRam - freeRam;
  const ramPct = ((usedRam / totalRam) * 100).toFixed(1);

  let diskInfo = { freeGB: 'N/A', totalGB: 'N/A', pct: 'N/A' };
  try {
    if (process.platform !== 'win32') {
      const df = execSync(`df -h "${ROOT_DIR}" | tail -1`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim().split(/\s+/);
      if (df.length >= 5) {
        diskInfo = { totalGB: df[1], freeGB: df[3], pct: df[4] };
      }
    }
  } catch {}

  const loadAvg = os.loadavg().map(n => n.toFixed(2)).join(', ');

  return {
    totalRamMB: Math.round(totalRam / 1024 / 1024),
    usedRamMB: Math.round(usedRam / 1024 / 1024),
    freeRamMB: Math.round(freeRam / 1024 / 1024),
    ramPct,
    diskInfo,
    loadAvg,
    cpus: os.cpus().length,
  };
}

function getServiceStatus() {
  if (process.platform === 'win32') return 'N/A';
  try {
    const out = execSync('systemctl is-active yt-live-manager 2>/dev/null', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    return out || 'inactive';
  } catch {
    return 'inactive';
  }
}

function renderDashboard() {
  const state = readJSONSafe(STATE_FILE, {});
  const settings = readJSONSafe(CONF_FILE, {});
  const videosData = readJSONSafe(VIDEOS_FILE, []);
  const bw = readJSONSafe(BW_FILE, {});
  const videos = Array.isArray(videosData) ? videosData : (videosData.videos || []);
  const sys = getSystemMetrics();
  const svc = getServiceStatus();

  // Status color
  const statusStr = (state.status || 'STOPPED').toUpperCase();
  let statusBadge = `${C.yellow}⏸ STOPPED${C.reset}`;
  if (statusStr === 'RUNNING') {
    statusBadge = `${C.green}● RUNNING${C.reset}`;
  } else if (statusStr === 'ERROR' || statusStr === 'UNHEALTHY') {
    statusBadge = `${C.red}✖ ERROR${C.reset}`;
  } else if (statusStr === 'RECONNECTING' || statusStr === 'STARTING') {
    statusBadge = `${C.yellow}🔄 ${statusStr}${C.reset}`;
  }

  // Active Video
  const activeVidId = state.activeVideoId || settings.stream?.videoId;
  const activeVideo = videos.find(v => v.id === activeVidId) || null;
  const vidDuration = Number(activeVideo?.probe?.durationSec || activeVideo?.probe?.duration || 0);

  // Elapsed / Playback
  let elapsedSec = 0;
  let currentOffsetSec = 0;
  if (state.streamStartedAt && statusStr === 'RUNNING') {
    const startMs = new Date(state.streamStartedAt).getTime();
    if (startMs > 0) {
      elapsedSec = Math.max(0, (Date.now() - startMs) / 1000);
      currentOffsetSec = vidDuration > 0 ? (elapsedSec % vidDuration) : elapsedSec;
    }
  } else if (state.resumeBookmark?.offsetSec) {
    currentOffsetSec = state.resumeBookmark.offsetSec;
  }

  // Bandwidth
  const usedBw = bw.usedBytes || 0;
  const limitBw = (settings.bandwidth?.monthlyLimitGB || 900) * 1024 * 1024 * 1024;
  const bwPct = limitBw > 0 ? ((usedBw / limitBw) * 100).toFixed(1) : '0.0';

  // Auto-recycle info
  const autoRecycle = settings.scheduler?.autoRecycle || {};
  const recycleEnabled = autoRecycle.enabled !== false;
  const recycleHours = autoRecycle.intervalHours || 11.5;
  const recycleSec = recycleHours * 3600;
  const nextRecycleSec = statusStr === 'RUNNING' ? Math.max(0, recycleSec - elapsedSec) : 0;

  // Build Output
  const lines = [
    `${C.bold}${C.cyan}======================================================================${C.reset}`,
    `${C.bold}        📺  24×7 YOUTUBE LIVE MANAGER — TERMINAL DASHBOARD           ${C.reset}`,
    `${C.bold}${C.cyan}======================================================================${C.reset}`,
    '',
    `  ${C.bold}STREAM STATUS${C.reset}    : ${statusBadge} ${C.dim}(Mode: ${state.streamMode || 'copy'}, Desired: ${state.desiredState || 'stopped'})${C.reset}`,
    `  ${C.bold}SYSTEM SERVICE${C.reset}   : ${svc === 'active' ? `${C.green}active (systemd)${C.reset}` : `${C.yellow}${svc}${C.reset}`}`,
    `  ${C.bold}SESSION UPTIME${C.reset}   : ${C.bold}${formatDuration(elapsedSec)}${C.reset} ${state.streamStartedAt ? C.dim + '(Started: ' + new Date(state.streamStartedAt).toLocaleTimeString() + ')' + C.reset : ''}`,
    `  ${C.bold}FFMPEG PROCESS${C.reset}   : ${state.ffmpegPid ? `${C.green}PID ${state.ffmpegPid}${C.reset}` : C.dim + 'None' + C.reset}`,
    `  ${C.bold}DUAL STREAM${C.reset}      : ${state.isDualStream ? `${C.magenta}ACTIVE (Paired: ${state.pairedHorizontalVideoId || 'Auto'})${C.reset}` : C.dim + 'Inactive (Single Vertical 9:16)' + C.reset}`,
    '',
    `${C.bold}${C.blue}  [VIDEO & PLAYBACK]${C.reset}`,
    `  • Playing Video   : ${activeVideo ? `${C.bold}${activeVideo.originalName || activeVideo.filename}${C.reset} ${C.dim}(${activeVideo.id})${C.reset}` : C.dim + 'None' + C.reset}`,
    `  • Video Duration  : ${formatDuration(vidDuration)} ${activeVideo?.probe?.resolution ? C.dim + `[${activeVideo.probe.resolution}]` + C.reset : ''}`,
    `  • Playback Time   : ${C.cyan}${formatDuration(currentOffsetSec)}${C.reset} / ${formatDuration(vidDuration)} ${state.resumeBookmark ? C.dim + '(Bookmark saved)' + C.reset : ''}`,
    '',
    `${C.bold}${C.magenta}  [BANDWIDTH USAGE]${C.reset}`,
    `  • Current Month   : ${C.bold}${formatBytes(usedBw)}${C.reset} / ${formatBytes(limitBw)} (${C.bold}${bwPct}%${C.reset} used)`,
    `  • Safety Lock     : ${state.bandwidthLock?.active ? `${C.red}LOCKED (Limit exceeded)${C.reset}` : `${C.green}Normal (OK)${C.reset}`}`,
    '',
    `${C.bold}${C.yellow}  [AUTO-RECYCLE & SCHEDULER]${C.reset}`,
    `  • Auto-Recycle    : ${recycleEnabled ? `${C.green}ON${C.reset} (Every ${recycleHours}h)` : `${C.dim}OFF${C.reset}`}`,
    `  • Next Restart In : ${statusStr === 'RUNNING' && recycleEnabled ? `${C.bold}${formatDuration(nextRecycleSec)}${C.reset}` : C.dim + 'N/A' + C.reset}`,
    `  • Resume Bookmark : ${autoRecycle.resumeBookmark !== false ? `${C.green}ENABLED${C.reset}` : `${C.yellow}DISABLED${C.reset}`}`,
    '',
    `${C.bold}${C.green}  [SYSTEM RESOURCES]${C.reset}`,
    `  • RAM Usage       : ${C.bold}${sys.usedRamMB} MB${C.reset} / ${sys.totalRamMB} MB (${sys.ramPct}% system total)`,
    `  • Disk Space      : ${sys.diskInfo.freeGB} free / ${sys.diskInfo.totalGB} total (${sys.diskInfo.pct} used)`,
    `  • Load Average    : ${sys.loadAvg} (${sys.cpus} CPU cores)`,
    '',
  ];

  if (state.lastError) {
    lines.push(`  ${C.red}${C.bold}LAST ERROR${C.reset}       : ${state.lastError.message} (${state.lastError.code || 'ERR'})`);
    lines.push('');
  }

  lines.push(`${C.bold}${C.cyan}======================================================================${C.reset}`);
  return lines.join('\n');
}

// Handle flags
if (process.argv.includes('--json')) {
  const state = readJSONSafe(STATE_FILE, {});
  const settings = readJSONSafe(CONF_FILE, {});
  const bw = readJSONSafe(BW_FILE, {});
  const sys = getSystemMetrics();
  console.log(JSON.stringify({ state, settings, bandwidth: bw, system: sys }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--watch')) {
  const readline = (process.platform === 'win32') ? '\x1Bc' : '\x1B[2J\x1B[0;0H';
  const render = () => {
    process.stdout.write(readline);
    console.log(renderDashboard());
    console.log(`${C.dim}Refreshing every 2s. Press Ctrl+C to exit.${C.reset}`);
  };
  render();
  setInterval(render, 2000);
} else {
  console.log(renderDashboard());
}
