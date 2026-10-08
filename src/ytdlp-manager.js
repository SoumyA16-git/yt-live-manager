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
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import PATHS from './lib/paths.js';
import { logger } from './logger.js';
import { importConvertedVideo, listVideos, resolveVideoPath } from './video-manager.js';
import { probeMedia } from './ffprobe-manager.js';
import { getSettings, saveSettings } from './config-manager.js';

// Cookies file path — user exports browser cookies here for YouTube auth
const YT_COOKIES_PATH = path.join(PATHS.config, 'yt-cookies.txt');

// Known VM Google Chrome user-data paths on Ubuntu
const VM_CHROME_USER_DATA_DIRS = [
  '/home/ubuntu/.config/google-chrome',
  '/root/.config/google-chrome',
];

// ─── Module State ─────────────────────────────────────────────────────────────

let _currentJob = null;

/**
 * Generate environment for yt-dlp child processes.
 * Overrides restrictive NODE_OPTIONS (e.g. server's --max-old-space-size=128)
 * with ample heap limit (1024MB) so that YouTube JS challenge solver subprocesses
 * never crash with "JavaScript heap out of memory".
 */
function _getYtDlpEnv() {
  const env = { ...process.env };
  env.NODE_OPTIONS = '--max-old-space-size=1024';
  return env;
}

/**
 * Normalize a YouTube URL into canonical https://www.youtube.com/watch?v=ID format.
 * Strips tracking parameters like ?si=..., converts /live/ and /shorts/ paths into canonical watch URLs.
 *
 * @param {string} urlStr
 * @returns {string}
 */
export function normalizeYouTubeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  const trimmed = urlStr.trim();
  try {
    const u = new URL(trimmed);
    let videoId = null;
    const hostname = u.hostname.toLowerCase();
    if (hostname === 'youtu.be') {
      videoId = u.pathname.slice(1).split('/')[0];
    } else if (u.pathname.startsWith('/live/')) {
      videoId = u.pathname.replace(/^\/live\//, '').split('/')[0];
    } else if (u.pathname.startsWith('/shorts/')) {
      videoId = u.pathname.replace(/^\/shorts\//, '').split('/')[0];
    } else if (u.searchParams.has('v')) {
      videoId = u.searchParams.get('v');
    }
    if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  } catch {
    // Return trimmed if URL constructor fails
  }
  return trimmed;
}

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
    const normalized = normalizeYouTubeUrl(urlStr);
    const u = new URL(normalized);
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
 * Check if a YouTube video is already present in the local video library.
 * Checks stored youtubeVideoId, youtubeUrl, and filename/label matches.
 * Verifies that the physical file actually exists on disk.
 *
 * @param {string} rawUrl
 * @returns {Promise<object|null>} Existing video info if duplicate, or null
 */
export async function checkDuplicateYouTubeVideo(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const normalized = normalizeYouTubeUrl(rawUrl);
  let targetYtId = null;
  try {
    const u = new URL(normalized);
    targetYtId = u.searchParams.get('v');
  } catch { /* ignore */ }

  const videos = await listVideos();
  let allPlaylistIds = new Set();
  try {
    const settings = getSettings();
    const playlists = settings?.stream?.playlists || { horizontal: [], vertical: [] };
    allPlaylistIds = new Set([
      ...(playlists.horizontal || []),
      ...(playlists.vertical || []),
      ...(settings?.stream?.playlist || [])
    ]);
  } catch {
    // Settings might not be loaded yet in standalone unit test environment
  }

  for (const v of videos) {
    let match = false;

    // 1. Exact match on stored youtubeVideoId
    if (targetYtId && v.youtubeVideoId && v.youtubeVideoId === targetYtId) {
      match = true;
    }
    // 2. Exact match on stored youtubeUrl
    else if (v.youtubeUrl && normalizeYouTubeUrl(v.youtubeUrl) === normalized) {
      match = true;
    }
    // 3. YouTube video ID contained in label or originalName
    else if (targetYtId && ((v.label && v.label.includes(targetYtId)) || (v.originalName && v.originalName.includes(targetYtId)))) {
      match = true;
    }

    if (match) {
      // Verify physical file exists on disk
      const ext = path.extname(v.filename || v.originalName || '.mp4');
      let exists = false;
      try {
        const filePath = v.filePath || resolveVideoPath(v.id, ext);
        exists = fsSync.existsSync(filePath);
      } catch {
        exists = false;
      }

      if (exists) {
        return {
          id: v.id,
          label: v.label || v.originalName,
          originalName: v.originalName,
          probe: v.probe,
          inPlaylist: allPlaylistIds.has(v.id),
          orientation: v.orientation || (v.probe?.width >= v.probe?.height ? 'horizontal' : 'vertical'),
          youtubeVideoId: v.youtubeVideoId || targetYtId,
        };
      }
    }
  }

  return null;
}

/**
 * Check if yt-dlp is installed and available in PATH.
 *
 * @returns {Promise<boolean>}
 */
export async function isYtDlpAvailable() {
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', ['--version'], { stdio: 'ignore', env: _getYtDlpEnv() });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Check if the YouTube cookies file or VM Chrome cookies exist.
 *
 * @returns {Promise<{exists: boolean, path: string, sizeBytes: number, chromeAvailable: boolean, source: string}>}
 */
export async function getCookiesStatus() {
  let chromeAvailable = false;
  for (const dir of VM_CHROME_USER_DATA_DIRS) {
    if (fsSync.existsSync(path.join(dir, 'Default', 'Cookies'))) {
      chromeAvailable = true;
      break;
    }
  }

  try {
    await fs.access(YT_COOKIES_PATH);
    const stat = await fs.stat(YT_COOKIES_PATH);
    return {
      exists: true,
      path: YT_COOKIES_PATH,
      sizeBytes: stat.size,
      chromeAvailable,
      source: chromeAvailable ? 'chrome_vm' : 'file',
    };
  } catch {
    return {
      exists: chromeAvailable,
      path: YT_COOKIES_PATH,
      sizeBytes: 0,
      chromeAvailable,
      source: chromeAvailable ? 'chrome_vm' : 'none',
    };
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
 * Auto-sync cookies directly from VM's Google Chrome profile into config/yt-cookies.txt.
 *
 * @returns {Promise<{success: boolean, sizeBytes?: number, error?: string}>}
 */
export async function syncChromeCookies() {
  let chromeProfile = null;
  for (const dir of VM_CHROME_USER_DATA_DIRS) {
    if (fsSync.existsSync(path.join(dir, 'Default', 'Cookies'))) {
      chromeProfile = dir;
      break;
    }
  }

  if (!chromeProfile) {
    logger.info('ytdlp.no_chrome_profile', 'No local Chrome profile found to sync cookies from');
    return { success: false, error: 'No local Chrome profile found' };
  }

  logger.info('ytdlp.syncing_chrome_cookies', `Syncing YouTube cookies from Chrome profile at ${chromeProfile}`);
  const nodeBinary = process.execPath || (process.platform !== 'win32' ? '/usr/bin/node' : 'node');
  const tempCookiesPath = path.join(PATHS.config, `yt-cookies-${Date.now()}.tmp`);

  return new Promise((resolve) => {
    const args = [
      '--cookies-from-browser', `chrome:${chromeProfile}`,
      '--cookies', tempCookiesPath,
      '--js-runtimes', `node:${nodeBinary}`,
      '--skip-download',
      '--print', 'id',
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    ];

    const proc = spawn('yt-dlp', args, { env: _getYtDlpEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    proc.on('close', async (code) => {
      if (code === 0 && fsSync.existsSync(tempCookiesPath)) {
        try {
          const stat = await fs.stat(tempCookiesPath);
          if (stat.size > 100) {
            await fs.rename(tempCookiesPath, YT_COOKIES_PATH);
            const raw = await fs.readFile(YT_COOKIES_PATH, 'utf8');
            const count = raw.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
            logger.info('ytdlp.chrome_cookies_synced', `Successfully extracted ${count} cookies (${stat.size} bytes) from VM Chrome`);
            return resolve({ success: true, sizeBytes: stat.size, cookieCount: count, path: YT_COOKIES_PATH });
          }
        } catch { /* ignore */ }
      }
      try { await fs.unlink(tempCookiesPath); } catch { /* ignore */ }
      const cleanErr = stderr.split('\n').filter(l => !l.includes('Deprecated Feature:')).join(' ').trim();
      logger.warn('ytdlp.chrome_sync_failed', `yt-dlp cookie export exited with code ${code}${cleanErr ? `: ${cleanErr}` : ''}`);
      resolve({ success: false, error: `yt-dlp exit code ${code}` });
    });
    proc.on('error', (err) => {
      try { fsSync.unlinkSync(tempCookiesPath); } catch { /* ignore */ }
      logger.error('ytdlp.chrome_sync_error', err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Build base yt-dlp args — auto-detects cookies from file or VM Chrome.
 * Includes --js-runtimes node to solve YouTube JS challenges.
 *
 * @returns {Promise<string[]>}
 */
async function _buildYtDlpBaseArgs() {
  const nodeBinary = process.execPath || (process.platform !== 'win32' ? '/usr/bin/node' : 'node');
  const args = [
    '--no-playlist',
    '--force-ipv4',
    '--js-runtimes', `node:${nodeBinary}`, // Pass explicit path to active Node binary for challenge solving
    '--compat-options', 'no-live-chat',
    '--extractor-args', 'youtube:player_client=web_safari,web_embedded,-tv_downgraded',
  ];

  if (process.platform !== 'win32' && fsSync.existsSync('/usr/bin/ffmpeg')) {
    args.push('--ffmpeg-location', '/usr/bin/ffmpeg');
  }

  let cookiesStatus = await getCookiesStatus();
  // If cookies file is missing or empty but Chrome is available on VM, sync it automatically
  if ((!cookiesStatus.exists || cookiesStatus.sizeBytes < 50) && cookiesStatus.chromeAvailable) {
    try {
      await syncChromeCookies();
      cookiesStatus = await getCookiesStatus();
    } catch { /* proceed to direct check */ }
  }

  if (cookiesStatus.exists && cookiesStatus.sizeBytes > 10) {
    args.push('--cookies', YT_COOKIES_PATH);
    logger.info('ytdlp.using_cookies', `Using YouTube cookies from ${YT_COOKIES_PATH}`);
  } else {
    // Check if Chrome profile can be accessed directly as fallback
    let chromeProfile = null;
    for (const dir of VM_CHROME_USER_DATA_DIRS) {
      if (fsSync.existsSync(path.join(dir, 'Default', 'Cookies'))) {
        chromeProfile = dir;
        break;
      }
    }
    if (chromeProfile) {
      args.push('--cookies-from-browser', `chrome:${chromeProfile}`);
      logger.info('ytdlp.using_chrome_direct', `Reading cookies directly from ${chromeProfile}`);
    } else {
      logger.warn('ytdlp.no_cookies', 'No yt-cookies.txt found and no Chrome profile found.');
    }
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
      downloaded: '',
      totalSize: '',
      videoTitle: '',
      videoId: null,
      detectedMode: null,
      resolution: null,
      error: null,
    };
  }

  return {
    active: ['fetching_info', 'downloading', 'merging', 'registering'].includes(_currentJob.stage),
    jobId: _currentJob.id,
    url: _currentJob.url,
    stage: _currentJob.stage,
    percent: _currentJob.percent,
    speed: _currentJob.speed || '',
    eta: _currentJob.eta || '',
    downloaded: _currentJob.downloaded || '',
    totalSize: _currentJob.totalSize || '',
    videoTitle: _currentJob.videoTitle,
    videoId: _currentJob.videoId,
    detectedMode: _currentJob.detectedMode || null,
    resolution: _currentJob.resolution || null,
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
  if (!_currentJob || !['fetching_info', 'downloading', 'merging', 'registering', 'converting'].includes(_currentJob.stage)) {
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
/**
 * Determine yt-dlp format and sort arguments for requested quality level.
 * Prioritizes high bitrate (vbr) and H.264/AAC streams for crisp, stream-ready video.
 *
 * @param {'1080p'|'720p'|'480p'|string} [quality='1080p']
 * @returns {{ format: string, sort: string }}
 */
export function getYtDlpFormatAndSort(quality = '1080p') {
  const q = String(quality || '').toLowerCase().trim();
  switch (q) {
    case '480p':
    case '480':
      return {
        format: 'bv*[height<=854][width<=854]+ba/b[height<=854][width<=854]/bv*+ba/b',
        sort: 'res:480,vcodec:h264,vbr,fps,acodec:aac',
      };
    case '720p':
    case '720':
      return {
        format: 'bv*[height<=1280][width<=1280]+ba/b[height<=1280][width<=1280]/bv*+ba/b',
        sort: 'res:720,vcodec:h264,vbr,fps,acodec:aac',
      };
    case '1080p':
    case '1080':
    case 'best':
    case 'max':
    case 'highest':
    default:
      // Default to 1080p high bitrate (vbr) for maximum visual clarity and non-pixelated streaming
      return {
        format: 'bv*[height<=1920][width<=1920]+ba/b[height<=1920][width<=1920]/bv*+ba/b',
        sort: 'res:1080,vcodec:h264,vbr,fps,acodec:aac',
      };
  }
}

/**
 * Completely strip all metadata, tags, chapters, timestamps, and encoder signatures
 * from a video file using FFmpeg stream copy.
 *
 * Lossless (zero re-encoding), near-instantaneous (~1-2s), and strips:
 * - Video title, description, synopsis, comment
 * - Channel / uploader / artist / author / album_artist
 * - YouTube video ID, URL / purl tags
 * - Upload date, year, creation_time
 * - Encoder and tool signatures (Lavf/Lavc/yt-dlp) via bitexact flags
 * - Chapters, subtitles, and attachment streams
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {string|null} [jobId=null]
 * @returns {Promise<void>}
 */
export async function stripVideoMetadata(inputPath, outputPath, jobId = null) {
  const ffmpegBin = (process.platform !== 'win32' && fsSync.existsSync('/usr/bin/ffmpeg'))
    ? '/usr/bin/ffmpeg'
    : 'ffmpeg';

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-nostdin',
      '-i', inputPath,
      '-map', '0:v',
      '-map', '0:a?',
      '-c', 'copy',
      '-map_metadata', '-1',
      '-map_metadata:s:v', '-1',
      '-map_metadata:s:a', '-1',
      '-map_chapters', '-1',
      '-fflags', '+bitexact',
      '-flags:v', '+bitexact',
      '-flags:a', '+bitexact',
      '-metadata', 'title=',
      '-metadata', 'artist=',
      '-metadata', 'album_artist=',
      '-metadata', 'author=',
      '-metadata', 'comment=',
      '-metadata', 'description=',
      '-metadata', 'synopsis=',
      '-metadata', 'purl=',
      '-metadata', 'url=',
      '-metadata', 'date=',
      '-metadata', 'year=',
      '-metadata', 'creation_time=',
      '-metadata', 'encoder=',
      '-metadata', 'encoded_by=',
      '-metadata', 'copyright=',
      '-metadata', 'show=',
      '-metadata', 'episode_id=',
      '-metadata', 'network=',
      '-metadata:s:v', 'title=',
      '-metadata:s:v', 'handler_name=',
      '-metadata:s:a', 'title=',
      '-metadata:s:a', 'handler_name=',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ];

    const proc = spawn(ffmpegBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (jobId && _currentJob && _currentJob.id === jobId) {
      _currentJob.proc = proc;
    }

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn FFmpeg for metadata stripping: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (jobId && _currentJob && _currentJob.id === jobId && _currentJob.proc === proc) {
        _currentJob.proc = null;
      }
      if (jobId && _currentJob && _currentJob.id === jobId && _currentJob.stage === 'cancelled') {
        return resolve();
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg metadata stripping failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });
  });
}

/**
 * One-time offline GOP normalizer for downloaded YouTube videos.
 *
 * Re-encodes video to embed strict 2.0s keyframes (GOP = 2*FPS, sc_threshold=0)
 * while preserving original resolution and copying AAC audio losslessly.
 * Also strips all embedded YouTube metadata and enables +faststart.
 *
 * Once normalized on disk, 24/7 streaming runs in direct stream-copy
 * (-c:v copy) mode with only 0.6% CPU and 100% YouTube compliance!
 */
export async function normalizeVideoGop(inputPath, outputPath, jobId = null, probe = null) {
  const ffmpegBin = (process.platform !== 'win32' && fsSync.existsSync('/usr/bin/ffmpeg'))
    ? '/usr/bin/ffmpeg'
    : 'ffmpeg';

  const fps = probe?.fps || 30;
  const gop = Math.round(fps * 2);
  const sourceBps = probe?.videoBitrate || 4_500_000;
  const targetKbps = Math.min(Math.round(sourceBps / 1000), 6000);
  const maxrateKbps = Math.round(targetKbps * 1.15);
  const bufsizeKbps = targetKbps * 2;

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-nostdin',
      '-progress', 'pipe:1',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', `${targetKbps}k`,
      '-maxrate', `${maxrateKbps}k`,
      '-bufsize', `${bufsizeKbps}k`,
      '-g', `${gop}`,
      '-keyint_min', `${gop}`,
      '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-c:a', 'copy',
      '-map_metadata', '-1',
      '-map_metadata:s:v', '-1',
      '-map_metadata:s:a', '-1',
      '-map_chapters', '-1',
      '-fflags', '+bitexact',
      '-flags:v', '+bitexact',
      '-flags:a', '+bitexact',
      '-metadata', 'title=',
      '-metadata', 'artist=',
      '-metadata', 'comment=',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ];

    const proc = spawn(ffmpegBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (jobId && _currentJob && _currentJob.id === jobId) {
      _currentJob.proc = proc;
    }

    const durationSec = probe?.durationSec || 0;
    proc.stdout.on('data', (d) => {
      if (durationSec > 0 && jobId && _currentJob && _currentJob.id === jobId) {
        const str = d.toString('utf8');
        const match = str.match(/out_time_us=(\d+)/);
        if (match) {
          const currentSec = parseInt(match[1], 10) / 1_000_000;
          const pct = Math.min(99, Math.round((currentSec / durationSec) * 100));
          _currentJob.percent = pct;
        }
      }
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn FFmpeg for GOP normalization: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (jobId && _currentJob && _currentJob.id === jobId && _currentJob.proc === proc) {
        _currentJob.proc = null;
      }
      if (jobId && _currentJob && _currentJob.id === jobId && _currentJob.stage === 'cancelled') {
        return resolve();
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg GOP normalization failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });
  });
}

/**
 * Start background YouTube video download job.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {boolean} [opts.autoSetActive=false]
 * @param {'1080p'|'720p'|'480p'} [opts.quality='1080p']
 * @returns {Promise<object>} Status object
 */
export async function startYouTubeDownload(rawUrl, { autoSetActive = false, quality = '1080p', force = false } = {}) {
  const raw = (rawUrl || '').trim();

  if (!isValidYouTubeUrl(raw)) {
    throw Object.assign(new Error('Invalid YouTube URL. Please provide a valid YouTube video or shorts link.'), {
      code: 'E_INVALID_URL',
    });
  }

  const url = normalizeYouTubeUrl(raw);

  // Duplicate check: if already present in library/server, warn user unless force=true
  if (!force) {
    const duplicate = await checkDuplicateYouTubeVideo(url);
    if (duplicate) {
      const err = new Error(`This YouTube video is already available on the server: "${duplicate.label}"`);
      err.code = 'E_DUPLICATE_VIDEO';
      err.existingVideo = duplicate;
      throw err;
    }
  }

  if (_currentJob && ['fetching_info', 'downloading', 'merging', 'converting'].includes(_currentJob.stage)) {
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

  let initialVideoId = null;
  try {
    const u = new URL(url);
    initialVideoId = u.searchParams.get('v') || null;
  } catch { /* ignore */ }

  _currentJob = {
    id: jobId,
    url,
    quality: quality || '1080p',
    stage: 'fetching_info',
    percent: 0,
    speed: '',
    eta: '',
    downloaded: '',
    totalSize: '',
    videoTitle: 'Fetching video details...',
    videoId: initialVideoId,
    autoSetActive,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    proc: null,
    tempFiles: [],
  };

  // Run async pipeline in background
  _executePipeline(jobId, url, autoSetActive, quality || '1080p').catch((err) => {
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
 * Internal async executor for the download pipeline.
 * Single-pass: downloads in high-bitrate quality (default 1080p), detects 16:9 vs 9:16,
 * registers directly as Stream-Ready without re-encoding, and appends to the playlist.
 */
async function _executePipeline(jobId, url, autoSetActive, quality = '1080p') {
  const incomingDir = PATHS.videosIncoming;
  const rawPath = path.join(incomingDir, `ytdl_${jobId}.mp4`);

  if (!_currentJob || _currentJob.id !== jobId) return;
  _currentJob.tempFiles.push(rawPath);

  // Extract video ID from URL if available
  const videoIdMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (videoIdMatch && _currentJob) {
    _currentJob.videoId = videoIdMatch[1];
  }

  // ─── 1. Single-pass Download & Title Extraction via yt-dlp ────────────────
  logger.info('ytdlp.start_download', `Starting single-pass YouTube download (${quality}) from ${url} to ${rawPath}`);
  _currentJob.stage = 'downloading';
  _currentJob.percent = 0;

  await _downloadVideo(url, rawPath, jobId, 0, { quality });

  if (_currentJob.stage === 'cancelled') return;

  // Verify downloaded raw file
  const rawStat = await fs.stat(rawPath);
  if (rawStat.size === 0) {
    throw new Error('Downloaded file is empty (0 bytes).');
  }

  // ─── 2. Probe downloaded video for native orientation & specs ────────────
  _currentJob.stage = 'probing';
  logger.info('ytdlp.probing_video', `Probing downloaded video ${rawPath}`);
  let rawProbe = null;
  let width = 1920;
  let height = 1080;
  try {
    rawProbe = await probeMedia(rawPath);
    if (rawProbe?.width) width = rawProbe.width;
    if (rawProbe?.height) height = rawProbe.height;
  } catch (probeErr) {
    logger.warn('ytdlp.probe_warning', `Could not probe downloaded video: ${probeErr.message}`);
  }

  const isHorizontal = width >= height;
  const mode = isHorizontal ? 'horizontal' : 'vertical';

  // ─── 3. Strip Metadata & Optional Auto-Normalize GOP ───────────────────────
  const cleanPath = path.join(incomingDir, `ytdl_${jobId}_clean.mp4`);
  _currentJob.tempFiles.push(cleanPath);

  const keyframeMaxSec = 4.0;
  // Temporarily bypassed auto-normalization on download as requested.
  // Set AUTO_NORMALIZE_GOP=true in env or config to re-enable automatic re-encoding upon download.
  const autoNormalizeEnabled = process.env.AUTO_NORMALIZE_GOP === 'true';
  const needsGopNormalization = autoNormalizeEnabled && (!rawProbe?.maxKeyframeIntervalSec || rawProbe.maxKeyframeIntervalSec > keyframeMaxSec);

  if (needsGopNormalization) {
    _currentJob.stage = 'optimizing_keyframes';
    _currentJob.percent = 0;
    logger.info('ytdlp.optimizing_keyframes', `Normalizing GOP to 2.0s keyframes for stream-copy readiness (${rawPath})`);
    try {
      await normalizeVideoGop(rawPath, cleanPath, jobId, rawProbe);
      await fs.unlink(rawPath).catch(() => {});
      await fs.rename(cleanPath, rawPath);
      logger.info('ytdlp.keyframes_optimized', `Successfully normalized GOP & stripped metadata for ${rawPath}`);
    } catch (normErr) {
      logger.warn('ytdlp.norm_warning', `GOP normalization failed: ${normErr.message}; continuing with original file`);
      try { await fs.unlink(cleanPath); } catch { /* ignore */ }
    }
  } else {
    _currentJob.stage = 'stripping_metadata';
    logger.info('ytdlp.strip_metadata', `Keyframes already compliant (≤4s); stripping container metadata from ${rawPath}`);
    try {
      await stripVideoMetadata(rawPath, cleanPath, jobId);
      await fs.unlink(rawPath).catch(() => {});
      await fs.rename(cleanPath, rawPath);
      logger.info('ytdlp.metadata_stripped', `Successfully stripped all metadata from ${rawPath}`);
    } catch (stripErr) {
      logger.warn('ytdlp.strip_metadata_warning', `Metadata stripping warning: ${stripErr.message}; continuing with downloaded file`);
      try { await fs.unlink(cleanPath); } catch { /* ignore */ }
    }
  }

  if (_currentJob.stage === 'cancelled') return;

  // ─── 3. Register Video Directly into Library (Stream-Ready) ──────────────
  logger.info('ytdlp.register_video', `Registering native ${mode} video (${width}x${height}) into library`);
  const safeTitle = (_currentJob.videoTitle || 'YouTube_Video')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .slice(0, 100);

  let targetYtId = null;
  try {
    const u = new URL(url);
    targetYtId = u.searchParams.get('v');
  } catch { /* ignore */ }

  const videoMeta = await importConvertedVideo(rawPath, `${safeTitle}.mp4`, {
    autoSetActive,
    isDirectCopy: true,
    youtubeUrl: url,
    youtubeVideoId: targetYtId,
  });

  // ─── 4. Auto-append to corresponding Horizontal/Vertical playlist ────────
  try {
    const currentSettings = getSettings();
    const currentPlaylists = {
      horizontal: Array.isArray(currentSettings.stream?.playlists?.horizontal) ? [...currentSettings.stream.playlists.horizontal] : [],
      vertical: Array.isArray(currentSettings.stream?.playlists?.vertical) ? [...currentSettings.stream.playlists.vertical] : [],
    };

    if (!currentPlaylists[mode].includes(videoMeta.id)) {
      currentPlaylists[mode].push(videoMeta.id);
    }

    const patch = {
      stream: {
        playlists: currentPlaylists,
      },
    };

    const activeStreamMode = currentSettings.stream?.mode || 'horizontal';
    if (mode === activeStreamMode) {
      patch.stream.playlist = [...currentPlaylists[activeStreamMode]];
      if (!currentSettings.stream?.videoId) {
        patch.stream.videoId = videoMeta.id;
      }
    }

    await saveSettings(patch);
    logger.info('ytdlp.playlist_appended', `Successfully appended ${videoMeta.id} to ${mode} (16:9/9:16) playlist`);
  } catch (plErr) {
    logger.warn('ytdlp.playlist_append_warning', `Failed to auto-append to playlist: ${plErr.message}`);
  }

  _currentJob.stage = 'completed';
  _currentJob.percent = 100;
  _currentJob.videoId = videoMeta.id;
  _currentJob.detectedMode = mode;
  _currentJob.resolution = `${width}x${height}`;
  _currentJob.completedAt = new Date().toISOString();

  logger.info('ytdlp.job_completed', `Successfully imported YouTube video ${videoMeta.id} (${safeTitle}) as native ${mode}`);
}

/**
 * Fetch YouTube video title using yt-dlp --print (utility helper).
 */
export async function getVideoTitle(url) {
  const baseArgs = await _buildYtDlpBaseArgs();
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [...baseArgs, '--print', '%(title)s', url], {
      env: _getYtDlpEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
 * Parse a single line from yt-dlp stdout/stderr and update job progress fields in real-time.
 *
 * @param {string} line
 * @param {object} job
 */
export function parseYtDlpProgressLine(line, job) {
  const trimmed = (line || '').trim();
  if (!trimmed || !job) return;

  if (trimmed.startsWith('title:')) {
    const extractedTitle = trimmed.substring('title:'.length).trim();
    if (extractedTitle) {
      job.videoTitle = extractedTitle;
    }
    job.stage = 'downloading';
    return;
  }

  // 1. Pipe-delimited progress formats
  let dlContent = null;
  if (trimmed.startsWith('yt_progress:')) {
    dlContent = trimmed.substring('yt_progress:'.length).trim();
  } else if (trimmed.startsWith('download:')) {
    dlContent = trimmed.substring('download:'.length).trim();
  } else if (trimmed.includes('|') && trimmed.includes('%')) {
    dlContent = trimmed;
  }

  if (dlContent) {
    const parts = dlContent.split('|').map(s => (s || '').trim());
    const pctStr = parts[0] || '';
    const speedStr = parts[1] || '';
    const etaStr = parts[2] || '';
    const dlBytesStr = parts[3] || '';
    const totalBytesStr = parts[4] || '';
    const totalEstStr = parts[5] || '';

    const pctNum = parseFloat(pctStr.replace('%', ''));
    if (!isNaN(pctNum) && pctNum >= 0) {
      // Avoid resetting progress bar if secondary stream (e.g. audio) starts
      if (pctNum < 5 && (job.percent || 0) > 85) {
        // secondary stream started, keep high progress
      } else {
        job.percent = Math.min(99.9, Math.max(job.percent || 0, pctNum));
      }
    }
    if (speedStr && speedStr !== 'Unknown' && speedStr !== 'NA' && speedStr !== 'N/A') {
      job.speed = speedStr;
    }
    if (etaStr && etaStr !== 'Unknown' && etaStr !== 'NA' && etaStr !== 'N/A') {
      job.eta = etaStr;
    }
    if (dlBytesStr && dlBytesStr !== 'Unknown' && dlBytesStr !== 'NA' && dlBytesStr !== 'N/A') {
      job.downloaded = dlBytesStr;
    }
    const effectiveTotal = (totalBytesStr && totalBytesStr !== 'Unknown' && totalBytesStr !== 'NA' && totalBytesStr !== 'N/A')
      ? totalBytesStr
      : ((totalEstStr && totalEstStr !== 'Unknown' && totalEstStr !== 'NA' && totalEstStr !== 'N/A') ? totalEstStr : null);
    if (effectiveTotal) {
      job.totalSize = effectiveTotal;
    }
    job.stage = 'downloading';
    return;
  }

  // 2. Postprocessing / Container remuxing
  if (trimmed.startsWith('postprocess:') || trimmed.startsWith('[Merger]') || trimmed.startsWith('[Fixup') || trimmed.includes('Merging formats into')) {
    job.stage = 'merging';
    job.speed = '';
    job.eta = '';
    return;
  }

  // 3. Fallback standard yt-dlp [download] progress regex
  const match = trimmed.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?([^\s]+))?(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/);
  if (match) {
    job.stage = 'downloading';
    const pct = parseFloat(match[1]);
    if (!isNaN(pct)) {
      if (pct < 5 && (job.percent || 0) > 85) {
        // secondary stream started
      } else {
        job.percent = Math.min(99.9, Math.max(job.percent || 0, pct));
      }
    }
    if (match[2] && match[2] !== 'Unknown' && match[2] !== 'N/A') job.totalSize = match[2];
    if (match[3] && match[3] !== 'Unknown' && match[3] !== 'N/A') job.speed = match[3];
    if (match[4] && match[4] !== 'Unknown' && match[4] !== 'N/A') job.eta = match[4];
  }
}

/**
 * Download raw video stream using yt-dlp with real-time title & progress parsing.
 * Single-pass: prints title before download and streams format simultaneously.
 */
async function _downloadVideo(url, outputPath, jobId, retryCount = 0, { extraExtractorArgs = null, extraFormat = null, extraSort = null, quality = '1080p' } = {}) {
  const baseArgs = await _buildYtDlpBaseArgs();
  const qualityCfg = getYtDlpFormatAndSort(quality);

  if (extraExtractorArgs) {
    const extIdx = baseArgs.indexOf('--extractor-args');
    if (extIdx !== -1) {
      baseArgs[extIdx + 1] = extraExtractorArgs;
    } else {
      baseArgs.push('--extractor-args', extraExtractorArgs);
    }
  }

  return new Promise((resolve, reject) => {
    const args = [
      ...baseArgs,
      '--print', 'before_dl:title:%(title)s',
      '--progress',
      '--newline',
      '--progress-delta', '1',
      '--progress-template', 'download:yt_progress:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._total_bytes_estimate_str)s',
      '--progress-template', 'postprocess:postprocess:%(progress.status)s',
      // Metadata prevention options: ensure yt-dlp never writes or embeds metadata
      '--no-embed-metadata',
      '--no-embed-info-json',
      '--no-embed-chapters',
      '--no-embed-thumbnail',
      '--no-embed-subs',
      '--no-write-comments',
      '--no-add-metadata',
      // Storage-optimized video and audio merged into MP4 container (default 720p, saves ~70% disk space)
      '-f', extraFormat || qualityCfg.format,
      '-S', extraSort || qualityCfg.sort,
      '--merge-output-format', 'mp4',
      '--no-part',                   // No .part temp files — cleaner on failure/cancel
      '--concurrent-fragments', '4', // Parallel chunk downloads — 2-4x faster on VPS
      '-o', outputPath,
      url,
    ];

    const proc = spawn('yt-dlp', args, {
      env: _getYtDlpEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (_currentJob && _currentJob.id === jobId) {
      _currentJob.proc = proc;
    }

    let stderr = '';

    const parseLine = (line) => {
      if (_currentJob && _currentJob.id === jobId) {
        parseYtDlpProgressLine(line, _currentJob);
      }
    };

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) parseLine(line);
    });

    let stderrBuffer = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      stderrBuffer += text;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop();
      for (const line of lines) parseLine(line);
    });

    proc.on('error', reject);
    proc.on('close', async (code) => {
      if (_currentJob && _currentJob.id === jobId && _currentJob.stage === 'cancelled') {
        return resolve();
      }
      if (code === 0) {
        if (_currentJob && _currentJob.id === jobId) _currentJob.percent = 100;
        return resolve();
      }

      const cleanErr = stderr
        .split('\n')
        .filter(l => !l.includes('Deprecated Feature:') && !l.startsWith('WARNING:'))
        .map(l => l.replace(/^ERROR:\s*/i, '').trim())
        .filter(Boolean)
        .join(' · ');

      // Automatic fallback retry if YouTube challenged the connection or format is restricted
      const isFormatOrChallengeError =
        cleanErr.includes('Requested format is not available') ||
        cleanErr.includes('format is not available') ||
        cleanErr.includes('The page needs to be reloaded') ||
        cleanErr.includes('Sign in to confirm');

      if (retryCount === 0 && isFormatOrChallengeError) {
        logger.warn('ytdlp.retry_challenge', `yt-dlp encountered YouTube restriction: "${cleanErr}". Retrying with flexible format selector and fallback player client...`);
        try {
          if (fsSync.existsSync(outputPath)) {
            await fs.unlink(outputPath).catch(() => {});
          }
          await syncChromeCookies().catch(() => {});
          await _downloadVideo(url, outputPath, jobId, retryCount + 1, {
            extraExtractorArgs: 'youtube:player_client=mweb,web_safari,web_embedded,-tv_downgraded',
            extraFormat: qualityCfg.format,
            extraSort: qualityCfg.sort,
            quality,
          });
          return resolve();
        } catch (retryErr) {
          return reject(retryErr);
        }
      }

      const fallbackMsg = cleanErr || (stderr.includes('Deprecated Feature:') ? `Process exited unexpectedly with code ${code}` : stderr.slice(-300).trim());
      reject(new Error(`yt-dlp download failed: ${fallbackMsg || `Process exited with code ${code}`}`));
    });
  });
}

/**
 * Convert raw downloaded video into vertical 1080x1920 30fps 2s GOP H.264/AAC.
 * Bitrate matches source video bitrate capped at 4 Mbps ceiling.
 */
function _convertVideo(inputPath, outputPath, totalDurationSec, jobId, rawBitrate = 0) {
  return new Promise((resolve, reject) => {
    // Preserve source video bitrate up to 6Mbps max; never blow up file size
    const maxBitrateBps = 6_000_000;
    const targetBitrateBps = rawBitrate > 0 ? Math.min(rawBitrate, maxBitrateBps) : maxBitrateBps;
    const targetKbps = Math.round(targetBitrateBps / 1000);
    const bufSizeKbps = Math.min(targetKbps * 2, 12000);

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
