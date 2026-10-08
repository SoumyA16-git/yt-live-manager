/**
 * system-monitor.js — System metrics, process stats, directory sizes, and TLS reachability.
 *
 * PRD §17.1, §12, §19.2:
 * - CPU: /proc/stat deltas (cached previous sample; D-012).
 * - RAM: /proc/meminfo or os built-ins.
 * - Disk: fs.statfs on videos/ storage path.
 * - Directory sizes: config, data, videos, logs, backups (cached 60 s).
 * - FFmpeg stats: PID status and memory usage.
 * - Destination reachability: TLS probe to ingest host:443 (cached 60 s, timeout 5 s).
 */

import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { getFfmpegPid } from './ffmpeg-manager.js';
import { getSettings } from './config-manager.js';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

// ─── CPU Sampling (/proc/stat deltas) ────────────────────────────────────────

let _prevCpuSample = null;
let _smoothedCpuPercent = null;

function readProcStat() {
  try {
    const raw = fsSync.readFileSync('/proc/stat', 'utf8');
    const firstLine = raw.split('\n')[0]; // "cpu  user nice system idle iowait irq softirq ..."
    const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle  = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((acc, n) => acc + n, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

/**
 * Get current system CPU usage percentage.
 */
export function getCpuPercent() {
  const current = readProcStat();
  if (!current) {
    // Non-Linux or container fallback using os.loadavg()
    const load = os.loadavg()[0];
    const cpus = os.cpus().length || 1;
    return Number(Math.min(100, (load / cpus) * 100).toFixed(1));
  }

  if (!_prevCpuSample) {
    _prevCpuSample = current;
    return 0; // First call returns 0 (D-012)
  }

  const idleDelta  = current.idle - _prevCpuSample.idle;
  const totalDelta = current.total - _prevCpuSample.total;
  _prevCpuSample   = current;

  if (totalDelta <= 0) return _smoothedCpuPercent !== null ? Number(_smoothedCpuPercent.toFixed(1)) : 0;
  const rawUsed = (1 - idleDelta / totalDelta) * 100;
  const bounded = Math.max(0, Math.min(100, rawUsed));

  // Exponential moving average (EMA) smoothing (60% previous, 40% current sample)
  // to prevent rapid jitter from instantaneous 2-second I-frame encode bursts
  if (_smoothedCpuPercent === null) {
    _smoothedCpuPercent = bounded;
  } else {
    _smoothedCpuPercent = _smoothedCpuPercent * 0.6 + bounded * 0.4;
  }

  return Number(_smoothedCpuPercent.toFixed(1));
}

// ─── Memory (RAM) ─────────────────────────────────────────────────────────────

export function getRamMetrics() {
  let total = os.totalmem();
  let free  = os.freemem();

  try {
    const raw = fsSync.readFileSync('/proc/meminfo', 'utf8');
    let memTotal = 0;
    let memAvail = 0;
    for (const line of raw.split('\n')) {
      if (line.startsWith('MemTotal:')) memTotal = parseInt(line.split(/\s+/)[1], 10) * 1024;
      if (line.startsWith('MemAvailable:')) memAvail = parseInt(line.split(/\s+/)[1], 10) * 1024;
    }
    if (memTotal > 0 && memAvail > 0) {
      total = memTotal;
      free  = memAvail;
    }
  } catch { /* use os fallback */ }

  const used = total - free;
  const usedPercent = total > 0 ? (used / total) * 100 : 0;

  return {
    totalBytes:  total,
    freeBytes:   free,
    usedBytes:   used,
    usedPercent: Number(usedPercent.toFixed(1)),
  };
}

/**
 * Report Node.js process resident memory and heap allocation.
 */
export function getProcessMemory() {
  const mem = process.memoryUsage();
  return {
    rssBytes: mem.rss,
    rssMB: Number((mem.rss / (1024 * 1024)).toFixed(1)),
    heapUsedMB: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
    heapTotalMB: Number((mem.heapTotal / (1024 * 1024)).toFixed(1)),
  };
}

// ─── Disk Space ───────────────────────────────────────────────────────────────

export async function getDiskMetrics() {
  if (typeof fs.statfs !== 'function') {
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPercent: 0 };
  }

  try {
    const stats = await fs.statfs(PATHS.videos);
    const total = stats.blocks * stats.bsize;
    const free  = stats.bavail * stats.bsize;
    const used  = total - free;
    const usedPercent = total > 0 ? (used / total) * 100 : 0;

    return {
      totalBytes:  total,
      freeBytes:   free,
      usedBytes:   used,
      usedPercent: Number(usedPercent.toFixed(1)),
    };
  } catch (err) {
    logger.debug('system.statfs_error', err.message);
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPercent: 0 };
  }
}

// ─── Directory Sizes (Cached 60s) ─────────────────────────────────────────────

let _cachedDirSizes = null;
let _dirSizesCachedAt = 0;

async function computeDirSize(dirPath) {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dirPath, ent.name);
      if (ent.isFile()) {
        const s = await fs.stat(full);
        total += s.size;
      } else if (ent.isDirectory() && ent.name !== '.incoming') {
        total += await computeDirSize(full);
      }
    }
  } catch { /* ignore missing dirs */ }
  return total;
}

export async function getDirectorySizes() {
  const now = Date.now();
  if (_cachedDirSizes && (now - _dirSizesCachedAt < 300000)) {
    return { ..._cachedDirSizes };
  }

  const [config, data, videos, logs, backups] = await Promise.all([
    computeDirSize(PATHS.config),
    computeDirSize(PATHS.data),
    computeDirSize(PATHS.videos),
    computeDirSize(PATHS.logs),
    computeDirSize(PATHS.backups),
  ]);

  _cachedDirSizes = {
    configBytes:  config,
    dataBytes:    data,
    videosBytes:  videos,
    logsBytes:    logs,
    backupsBytes: backups,
    totalBytes:   config + data + videos + logs + backups,
  };
  _dirSizesCachedAt = now;

  return { ..._cachedDirSizes };
}

// ─── FFmpeg Process Stats ─────────────────────────────────────────────────────

export function getFfmpegProcessStats() {
  const pid = getFfmpegPid();
  if (!pid) return null;

  let rssBytes = 0;

  // On Linux read /proc/<pid>/status
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/status`, 'utf8');
    for (const line of raw.split('\n')) {
      if (line.startsWith('VmRSS:')) {
        rssBytes = parseInt(line.split(/\s+/)[1], 10) * 1024;
        break;
      }
    }
  } catch { /* ignore */ }

  return {
    pid,
    rssBytes,
    alive: true,
  };
}

// ─── Destination Reachability (Real TCP Latency Probe) ─────────────────────────

let _reachabilityCache = null;
let _reachabilityCacheTime = 0;
const REACHABILITY_CACHE_TTL_MS = 20_000; // Cache for 20s to avoid frequent socket spam

export async function probeDestinationReachability(defaultHost = 'a.rtmps.youtube.com', defaultPort = 443) {
  let host = defaultHost;
  let port = defaultPort;

  try {
    const settings = getSettings();
    if (settings?.youtube?.rtmpsUrl) {
      try {
        const u = new URL(settings.youtube.rtmpsUrl.replace(/^rtmps?:\/\//, 'https://'));
        if (u.hostname) host = u.hostname;
        if (u.port) port = parseInt(u.port, 10);
      } catch { /* use default */ }
    }
  } catch { /* ignore */ }

  const now = Date.now();
  if (_reachabilityCache && (now - _reachabilityCacheTime < REACHABILITY_CACHE_TTL_MS)) {
    return _reachabilityCache;
  }

  return new Promise((resolve) => {
    const startTime = Date.now();
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(4000);

    socket.connect(port, host, () => {
      if (resolved) return;
      resolved = true;
      const latencyMs = Math.max(1, Date.now() - startTime);
      cleanup();
      _reachabilityCache = {
        reachable: true,
        latencyMs,
        host,
        port,
        checkedAt: new Date().toISOString(),
      };
      _reachabilityCacheTime = Date.now();
      resolve(_reachabilityCache);
    });

    socket.on('timeout', () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      _reachabilityCache = {
        reachable: false,
        latencyMs: 0,
        host,
        port,
        checkedAt: new Date().toISOString(),
        error: 'Connection timed out (4s)',
      };
      _reachabilityCacheTime = Date.now();
      resolve(_reachabilityCache);
    });

    socket.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      _reachabilityCache = {
        reachable: false,
        latencyMs: 0,
        host,
        port,
        checkedAt: new Date().toISOString(),
        error: err.message,
      };
      _reachabilityCacheTime = Date.now();
      resolve(_reachabilityCache);
    });
  });
}

// ─── Combined System Snapshot ─────────────────────────────────────────────────

export async function getSystemSnapshot() {
  const [disk, dirSizes, reachability] = await Promise.all([
    getDiskMetrics(),
    getDirectorySizes(),
    probeDestinationReachability(),
  ]);

  return {
    cpuPercent:  getCpuPercent(),
    ram:         getRamMetrics(),
    appRam:      getProcessMemory(),
    disk,
    dirSizes,
    ffmpeg:      getFfmpegProcessStats(),
    reachability,
    nodeVersion: process.version,
    uptimeSec:   Math.round(process.uptime()),
  };
}
