/**
 * ytdlp-manager.js — YouTube direct video downloader and vertical 1080x1920 encoder.
 *
 * Downloads videos directly from YouTube URLs via yt-dlp, automatically re-encodes
 * them into exact 1080x1920 30fps vertical format with 2s GOP, 4M bitrate, and registers
 * them into the video library for zero-CPU stream copy.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import PATHS from './lib/paths.js';
import { logger } from './logger.js';
import { importConvertedVideo } from './video-manager.js';
import { probeMedia } from './ffprobe-manager.js';

// Cookies file path — user exports browser cookies here for YouTube auth
const YT_COOKIES_PATH = path.join(PATHS.config, 'yt-cookies.txt');

// ─── Module State ─────────────────────────────────────────────────────────────

let _currentJob = null;

/**
 * Validate a YouTube URL.
 * Supports standard watch URLs, youtu.be, shorts, and live URLs.
 *
 * @param {string} urlStr
 * @returns {boolean}
 */
export function isValidYouTubeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const u = new URL(urlStr.trim());
    const validHosts = [
      'www.youtube.com',
      'youtube.com',
      'm.youtube.com',
      'youtu.be',
      'music.youtube.com',
    ];
    if (!validHosts.includes(u.hostname.toLowerCase())) return false;
    if (u.hostname.toLowerCase() === 'youtu.be') {
      return u.pathname.length > 1;
    }
    return (
      u.pathname === '/watch' ||
      u.pathname.startsWith('/shorts/') ||
      u.pathname.startsWith('/live/') ||
      u.searchParams.has('v')
    );
  } catch {
    return false;
  }
}

/**
 * Check if yt-dlp is installed and available in PATH.
 *
 * @returns {Promise<boolean>}
 */
export async function isYtDlpAvailable() {
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Check if the YouTube cookies file exists.
 *
 * @returns {Promise<{exists: boolean, path: string, sizeBytes: number}>}
 */
export async function getCookiesStatus() {
  try {
    await fs.access(YT_COOKIES_PATH);
    const stat = await fs.stat(YT_COOKIES_PATH);
    return { exists: true, path: YT_COOKIES_PATH, sizeBytes: stat.size };
  } catch {
    return { exists: false, path: YT_COOKIES_PATH, sizeBytes: 0 };
  }
}

/**
 * Save cookies file content to config/yt-cookies.txt.
 *
 * @param {Buffer} content
 * @returns {Promise<void>}
 */
export async function saveCookiesFile(content) {
  await fs.mkdir(PATHS.config, { recursive: true });
  await fs.writeFile(YT_COOKIES_PATH, content, { mode: 0o600 });
}

/**
 * Build base yt-dlp args — includes cookies file if present.
 * Also spoofs browser User-Agent to avoid bot detection on server IPs.
 *
 * @returns {Promise<string[]>}
 */
async function _buildYtDlpBaseArgs() {
  const args = [
    '--no-playlist',
    '--no-warnings',
    // ios client has the most reliable format availability across all video types
    // including live streams, age-restricted, and region-locked content
    '--extractor-args', 'youtube:player_client=ios,web',
    '--compat-options', 'no-live-chat', // Skip live chat download for live streams
  ];

  // Use cookies file if it exists (required for most VPS/datacenter IPs)
  const cookiesStatus = await getCookiesStatus();
  if (cookiesStatus.exists && cookiesStatus.sizeBytes > 10) {
    args.push('--cookies', YT_COOKIES_PATH);
    logger.info('ytdlp.using_cookies', `Using YouTube cookies from ${YT_COOKIES_PATH}`);
  } else {
    logger.warn('ytdlp.no_cookies', 'No yt-cookies.txt found. YouTube may block download from server IP. See DEPLOYMENT.md.');
  }

  return args;
}

/**
 * Return the current download/conversion status.
 *
 * @returns {object}
 */
export function getDownloadStatus() {
  if (!_currentJob) {
    return {
      active: false,
      stage: 'idle',
      percent: 0,
      speed: '',
      eta: '',
      videoTitle: '',
      videoId: null,
      error: null,
    };
  }

  return {
    active: ['fetching_info', 'downloading', 'converting'].includes(_currentJob.stage),
    jobId: _currentJob.id,
    url: _currentJob.url,
    stage: _currentJob.stage,
    percent: _currentJob.percent,
    speed: _currentJob.speed,
    eta: _currentJob.eta,
    videoTitle: _currentJob.videoTitle,
    videoId: _currentJob.videoId,
    autoSetActive: _currentJob.autoSetActive,
    error: _currentJob.error,
    startedAt: _currentJob.startedAt,
    completedAt: _currentJob.completedAt,
  };
}

/**
 * Cancel the current download or conversion job if active.
 *
 * @returns {boolean} True if a job was cancelled
 */
export async function cancelDownload() {
  if (!_currentJob || !['fetching_info', 'downloading', 'converting'].includes(_currentJob.stage)) {
    return false;
  }

  logger.warn('ytdlp.job_cancelled', `Cancelling YouTube download job ${_currentJob.id}`);
  _currentJob.stage = 'cancelled';
  _currentJob.error = 'Cancelled by user';

  if (_currentJob.proc) {
    try {
      _currentJob.proc.kill('SIGKILL');
    } catch { /* ignore */ }
    _currentJob.proc = null;
  }

  // Cleanup temp files
  for (const f of _currentJob.tempFiles || []) {
    try { await fs.unlink(f); } catch { /* ignore */ }
  }

  return true;
}

/**
 * Start a YouTube download and vertical conversion pipeline in the background.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {boolean} [opts.autoSetActive=false]
 * @returns {Promise<object>} Status object
 */
export async function startYouTubeDownload(rawUrl, { autoSetActive = false } = {}) {
  const url = (rawUrl || '').trim();

  if (!isValidYouTubeUrl(url)) {
    throw Object.assign(new Error('Invalid YouTube URL. Please provide a valid YouTube video or shorts link.'), {
      code: 'E_INVALID_URL',
    });
  }

  if (_currentJob && ['fetching_info', 'downloading', 'converting'].includes(_currentJob.stage)) {
    throw Object.assign(new Error('A video download/conversion job is already in progress. Please wait for it to finish or cancel it.'), {
      code: 'E_JOB_RUNNING',
    });
  }

  const available = await isYtDlpAvailable();
  if (!available) {
    throw Object.assign(new Error('yt-dlp is not installed on the system. Please run update.sh on the server to install it.'), {
      code: 'E_YTDLP_MISSING',
    });
  }

  const jobId = crypto.randomBytes(4).toString('hex');
  const incomingDir = PATHS.videosIncoming;
  await fs.mkdir(incomingDir, { recursive: true, mode: 0o700 });

  _currentJob = {
    id: jobId,
    url,
    stage: 'fetching_info',
    percent: 0,
    speed: '',
    eta: '',
    videoTitle: 'Fetching video details...',
    videoId: null,
    autoSetActive,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    proc: null,
    tempFiles: [],
  };

  // Run async pipeline in background
  _executePipeline(jobId, url, autoSetActive).catch((err) => {
    logger.error('ytdlp.pipeline_error', `Pipeline failed for job ${jobId}: ${err.message}`, { error: err.message });
    if (_currentJob && _currentJob.id === jobId && _currentJob.stage !== 'cancelled') {
      _currentJob.stage = 'error';
      _currentJob.error = err.message || 'Download/conversion failed';
      _currentJob.completedAt = new Date().toISOString();
    }
  });

  return getDownloadStatus();
}

/**
 * Internal async executor for the download and conversion stages.
 */
async function _executePipeline(jobId, url, autoSetActive) {
  const incomingDir = PATHS.videosIncoming;
  const rawPath = path.join(incomingDir, `ytdl_${jobId}_raw.mp4`);
  const convertedPath = path.join(incomingDir, `ytdl_${jobId}_1080x1920.mp4`);

  if (!_currentJob || _currentJob.id !== jobId) return;
  _currentJob.tempFiles.push(rawPath, convertedPath);

  // ─── 1. Fetch Video Title ──────────────────────────────────────────────────
  logger.info('ytdlp.fetch_info', `Fetching video metadata for ${url}`);
  try {
    const title = await _getVideoTitle(url, jobId);
    if (_currentJob && _currentJob.id === jobId) {
      _currentJob.videoTitle = title || 'YouTube Video';
    }
  } catch (err) {
    logger.warn('ytdlp.title_warning', `Could not fetch video title: ${err.message}`);
    if (_currentJob && _currentJob.id === jobId) {
      _currentJob.videoTitle = 'YouTube Video';
    }
  }

  if (_currentJob.stage === 'cancelled') return;

  // ─── 2. Download raw video using yt-dlp ────────────────────────────────────
  _currentJob.stage = 'downloading';
  _currentJob.percent = 0;
  logger.info('ytdlp.start_download', `Downloading video from ${url} to ${rawPath}`);

  await _downloadVideo(url, rawPath, jobId);

  if (_currentJob.stage === 'cancelled') return;

  // Verify downloaded raw file
  const rawStat = await fs.stat(rawPath);
  if (rawStat.size === 0) {
    throw new Error('Downloaded file is empty (0 bytes).');
  }

  // ─── 3. Convert to 1080x1920 30fps vertical with user-specified format ────
  _currentJob.stage = 'converting';
  _currentJob.percent = 0;
  _currentJob.speed = '';
  _currentJob.eta = '';
  logger.info('ytdlp.start_convert', `Converting ${rawPath} to vertical 1080x1920 at ${convertedPath}`);

  // Probe raw video to determine total duration and video bitrate for accurate progress and bitrate matching
  let rawDuration = 60; // fallback duration in seconds
  let rawBitrate = 0;
  try {
    const rawProbe = await probeMedia(rawPath);
    if (rawProbe?.durationSec && !isNaN(rawProbe.durationSec)) {
      rawDuration = Math.max(1, rawProbe.durationSec);
    }
    if (rawProbe?.videoBitrate && rawProbe.videoBitrate > 0) {
      rawBitrate = rawProbe.videoBitrate;
    }
  } catch { /* use fallback */ }

  await _convertVideo(rawPath, convertedPath, rawDuration, jobId, rawBitrate);

  if (_currentJob.stage === 'cancelled') return;

  // ─── 4. Register Converted Video into Library ──────────────────────────────
  logger.info('ytdlp.register_video', `Registering converted video ${convertedPath} into library`);
  const safeTitle = (_currentJob.videoTitle || 'YouTube_Video')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .slice(0, 100);

  const videoMeta = await importConvertedVideo(convertedPath, `${safeTitle}.mp4`, {
    autoSetActive,
  });

  // Clean up raw temp file
  try { await fs.unlink(rawPath); } catch { /* ignore */ }

  _currentJob.stage = 'completed';
  _currentJob.percent = 100;
  _currentJob.videoId = videoMeta.id;
  _currentJob.completedAt = new Date().toISOString();

  logger.info('ytdlp.job_completed', `Successfully imported YouTube video ${videoMeta.id} (${safeTitle})`);
}

/**
 * Fetch YouTube video title using yt-dlp --print.
 */
async function _getVideoTitle(url, jobId) {
  const baseArgs = await _buildYtDlpBaseArgs();
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [...baseArgs, '--print', '%(title)s', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (_currentJob && _currentJob.id === jobId) {
      _currentJob.proc = proc;
    }

    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString('utf8'); });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(out.trim().split('\n')[0] || 'YouTube Video');
      } else {
        resolve('YouTube Video');
      }
    });
  });
}

/**
 * Download raw video stream using yt-dlp with real-time progress parsing.
 */
async function _downloadVideo(url, outputPath, jobId) {
  const baseArgs = await _buildYtDlpBaseArgs();
  return new Promise((resolve, reject) => {
    const args = [
      ...baseArgs,
      // Best quality up to 1080p — wide fallback chain handles live streams,
      // pre-muxed streams, and formats where separate video+audio aren’t available
      '-f', [
        'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]',
        'bestvideo[height<=1080]+bestaudio[ext=m4a]',
        'bestvideo[height<=1080]+bestaudio',
        'best[height<=1080][ext=mp4]',
        'best[height<=1080]',
        'best',
      ].join('/'),
      '--merge-output-format', 'mp4',
      '--newline',
      '--no-part',                   // No .part temp files — cleaner on failure/cancel
      '--concurrent-fragments', '4', // Parallel chunk downloads — 2-4x faster on VPS
      '-o', outputPath,
      url,
    ];

    const proc = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (_currentJob && _currentJob.id === jobId) {
      _currentJob.proc = proc;
    }

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep last incomplete line

      for (const line of lines) {
        // Example output: [download]  45.2% of ~ 150.00MiB at  5.20MiB/s ETA 00:15
        const match = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)/);
        if (match && _currentJob && _currentJob.id === jobId) {
          _currentJob.percent = Math.min(99.9, parseFloat(match[1]));
          _currentJob.speed = match[3];
          _currentJob.eta = match[4];
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (_currentJob && _currentJob.id === jobId && _currentJob.stage === 'cancelled') {
        return resolve();
      }
      if (code === 0) {
        if (_currentJob && _currentJob.id === jobId) _currentJob.percent = 100;
        resolve();
      } else {
        reject(new Error(`yt-dlp download failed (exit code ${code}): ${stderr.slice(-300)}`));
      }
    });
  });
}

/**
 * Convert raw downloaded video into vertical 1080x1920 30fps 2s GOP H.264/AAC.
 * Bitrate matches source video bitrate capped at 4 Mbps ceiling.
 */
function _convertVideo(inputPath, outputPath, totalDurationSec, jobId, rawBitrate = 0) {
  return new Promise((resolve, reject) => {
    // Preserve source video bitrate up to 4Mbps max; never blow up file size
    const maxBitrateBps = 4_000_000;
    const targetBitrateBps = rawBitrate > 0 ? Math.min(rawBitrate, maxBitrateBps) : maxBitrateBps;
    const targetKbps = Math.round(targetBitrateBps / 1000);
    const bufSizeKbps = Math.min(targetKbps * 2, 8000);

    const args = [
      '-i', inputPath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-keyint_min', '60',
      '-b:v', `${targetKbps}k`,
      '-maxrate', `${targetKbps}k`,
      '-bufsize', `${bufSizeKbps}k`,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-y',
      outputPath,
    ];

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (_currentJob && _currentJob.id === jobId) {
      _currentJob.proc = proc;
    }

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const parts = line.split('=');
        if (parts.length === 2) {
          const key = parts[0].trim();
          const val = parts[1].trim();

          if (key === 'out_time_us') {
            const timeSec = parseInt(val, 10) / 1000000;
            if (totalDurationSec > 0 && !isNaN(timeSec) && _currentJob && _currentJob.id === jobId) {
              const pct = Math.min(99.9, Math.max(0, (timeSec / totalDurationSec) * 100));
              _currentJob.percent = parseFloat(pct.toFixed(1));
            }
          } else if (key === 'speed' && _currentJob && _currentJob.id === jobId) {
            _currentJob.speed = val;
          }
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (_currentJob && _currentJob.id === jobId && _currentJob.stage === 'cancelled') {
        return resolve();
      }
      if (code === 0) {
        if (_currentJob && _currentJob.id === jobId) _currentJob.percent = 100;
        resolve();
      } else {
        reject(new Error(`FFmpeg 1080x1920 conversion failed (exit code ${code}): ${stderr.slice(-300)}`));
      }
    });
  });
}
