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
import { importConvertedVideo } from './video-manager.js';
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
  await fs.mkdir(PATHS.config, { recursive: true });

  return new Promise((resolve) => {
    const args = [
      '--cookies-from-browser', `chrome:${chromeProfile}`,
      '--cookies', YT_COOKIES_PATH,
      '--js-runtimes', 'node',
      '--skip-download',
      '--print', 'id',
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    ];

    const proc = spawn('yt-dlp', args, { stdio: 'ignore' });
    proc.on('close', async (code) => {
      if (code === 0 && fsSync.existsSync(YT_COOKIES_PATH)) {
        try {
          const stat = await fs.stat(YT_COOKIES_PATH);
          const raw = await fs.readFile(YT_COOKIES_PATH, 'utf8');
          const count = raw.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
          logger.info('ytdlp.chrome_cookies_synced', `Successfully extracted ${count} cookies (${stat.size} bytes) from VM Chrome`);
          resolve({ success: true, sizeBytes: stat.size, cookieCount: count, path: YT_COOKIES_PATH });
        } catch (e) {
          resolve({ success: true, path: YT_COOKIES_PATH });
        }
      } else {
        logger.warn('ytdlp.chrome_sync_failed', `yt-dlp cookie export exited with code ${code}`);
        resolve({ success: false, error: `yt-dlp exit code ${code}` });
      }
    });
    proc.on('error', (err) => {
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
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--force-ipv4',
    '--js-runtimes', 'node', // Enable Node.js runtime for YouTube challenge solving
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
      videoTitle: '',
      videoId: null,
      detectedMode: null,
      resolution: null,
      error: null,
    };
  }

  return {
    active: ['fetching_info', 'downloading', 'registering'].includes(_currentJob.stage),
    jobId: _currentJob.id,
    url: _currentJob.url,
    stage: _currentJob.stage,
    percent: _currentJob.percent,
    speed: _currentJob.speed,
    eta: _currentJob.eta,
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
  if (!_currentJob || !['fetching_info', 'downloading', 'registering', 'converting'].includes(_currentJob.stage)) {
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
  const raw = (rawUrl || '').trim();

  if (!isValidYouTubeUrl(raw)) {
    throw Object.assign(new Error('Invalid YouTube URL. Please provide a valid YouTube video or shorts link.'), {
      code: 'E_INVALID_URL',
    });
  }

  const url = normalizeYouTubeUrl(raw);

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

  let initialVideoId = null;
  try {
    const u = new URL(url);
    initialVideoId = u.searchParams.get('v') || null;
  } catch { /* ignore */ }

  _currentJob = {
    id: jobId,
    url,
    stage: 'fetching_info',
    percent: 0,
    speed: '',
    eta: '',
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
 * Internal async executor for the download pipeline.
 * Single-pass: downloads in native highest quality, detects 16:9 vs 9:16,
 * registers directly as Stream-Ready without re-encoding, and appends to the playlist.
 */
async function _executePipeline(jobId, url, autoSetActive) {
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
  logger.info('ytdlp.start_download', `Starting single-pass YouTube download from ${url} to ${rawPath}`);
  _currentJob.stage = 'downloading';
  _currentJob.percent = 0;

  await _downloadVideo(url, rawPath, jobId);

  if (_currentJob.stage === 'cancelled') return;

  // Verify downloaded raw file
  const rawStat = await fs.stat(rawPath);
  if (rawStat.size === 0) {
    throw new Error('Downloaded file is empty (0 bytes).');
  }

  // ─── 2. Probe downloaded video for native orientation & specs ────────────
  _currentJob.stage = 'registering';
  logger.info('ytdlp.probing_video', `Probing downloaded video ${rawPath}`);
  let width = 1920;
  let height = 1080;
  try {
    const rawProbe = await probeMedia(rawPath);
    if (rawProbe?.width) width = rawProbe.width;
    if (rawProbe?.height) height = rawProbe.height;
  } catch (probeErr) {
    logger.warn('ytdlp.probe_warning', `Could not probe downloaded video: ${probeErr.message}`);
  }

  const isHorizontal = width >= height;
  const mode = isHorizontal ? 'horizontal' : 'vertical';

  // ─── 3. Register Video Directly into Library (Stream-Ready) ──────────────
  logger.info('ytdlp.register_video', `Registering native ${mode} video (${width}x${height}) into library`);
  const safeTitle = (_currentJob.videoTitle || 'YouTube_Video')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .slice(0, 100);

  const videoMeta = await importConvertedVideo(rawPath, `${safeTitle}.mp4`, {
    autoSetActive,
    isDirectCopy: true,
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
 * Download raw video stream using yt-dlp with real-time title & progress parsing.
 * Single-pass: prints title before download and streams format simultaneously.
 */
async function _downloadVideo(url, outputPath, jobId, retryCount = 0, { extraExtractorArgs = null, extraFormat = null } = {}) {
  const baseArgs = await _buildYtDlpBaseArgs();

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
      // Highest quality available video and audio merged into MP4 container
      // Prioritizes stream-ready H.264/AAC with resilient fallback to any best available stream
      '-f', extraFormat || [
        'bv*[vcodec^=avc]+ba[acodec^=mp4a]',
        'bv*[vcodec^=avc]+ba',
        'b*[vcodec^=avc]',
        'bv*[ext=mp4]+ba[ext=m4a]',
        'bv*+ba',
        'b*',
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
        const trimmed = line.trim();
        if (trimmed.startsWith('title:') && _currentJob && _currentJob.id === jobId) {
          const extractedTitle = trimmed.substring('title:'.length).trim();
          if (extractedTitle) {
            _currentJob.videoTitle = extractedTitle;
          }
          _currentJob.stage = 'downloading';
          continue;
        }

        // Example output: [download]  45.2% of ~ 150.00MiB at  5.20MiB/s ETA 00:15
        const match = trimmed.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)/);
        if (match && _currentJob && _currentJob.id === jobId) {
          _currentJob.stage = 'downloading';
          _currentJob.percent = Math.min(99.9, parseFloat(match[1]));
          _currentJob.speed = match[3];
          _currentJob.eta = match[4];
        }
      }
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
            extraExtractorArgs: 'youtube:player_client=android,web,web_embedded,-tv_downgraded',
            extraFormat: 'bestvideo*+bestaudio/bv*+ba/b*/best',
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
