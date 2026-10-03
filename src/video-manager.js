/**
 * video-manager.js — Video library management, upload streaming, and path protection.
 *
 * PRD §13, §18:
 * - On-disk storage: videos/vid_<8 hex>.<ext>. Never raw user filenames.
 * - data/videos.json: metadata cache (id, label, originalName, sizeBytes, probe, compatibility).
 * - Path-traversal protection: all paths resolved against PATHS.videos.
 * - Uploads: streamed to videos/.incoming/<tmp> via busboy, probe-verified before rename.
 * - Disk reserve check before and during upload.
 * - Safe deletion: blocked if video is the active source of a running stream.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { readJSON, writeJSON } from './lib/atomic-json.js';
import { validateVideoId } from './lib/validate.js';
import { probeMedia, evaluateCompatibility } from './ffprobe-manager.js';
import { getSettings, saveSettings } from './config-manager.js';
import { getState, saveState } from './state-manager.js';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

const SCHEMA_VERSION = 1;

// ─── Path & ID Helpers ────────────────────────────────────────────────────────

/**
 * Generate a random 8-hex video ID (vid_xxxxxxxx).
 */
export function generateVideoId() {
  const hex = crypto.randomBytes(4).toString('hex');
  return `vid_${hex}`;
}

/**
 * Safely resolve a video ID to its on-disk absolute path.
 * Guaranteed to stay strictly within the videos/ directory.
 *
 * @param {string} id
 * @param {string} [ext='.mp4']
 * @returns {string} Absolute path
 */
export function resolveVideoPath(id, ext = '.mp4') {
  const { valid } = validateVideoId(id);
  if (!valid) {
    throw Object.assign(new Error(`Invalid video ID: ${id}`), { code: 'E_INVALID_ID' });
  }

  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  const filename = `${id}${cleanExt}`;
  const resolved = path.resolve(_videosDir, filename);

  const baseDir = path.resolve(_videosDir);
  if (!resolved.startsWith(baseDir + path.sep)) {
    throw Object.assign(new Error(`Path traversal attempt detected: ${id}`), { code: 'E_PATH_TRAVERSAL' });
  }

  return resolved;
}

// ─── Module State ────────────────────────────────────────────────────────────

let _videosIndex = PATHS.videosIndex;
let _videosDir   = PATHS.videos;
let _incomingDir = PATHS.videosIncoming;

// ─── Metadata Library Index ──────────────────────────────────────────────────

/**
 * Scan videos/ (and videos/.incoming/) directory on disk.
 * Discovers untracked video files, probes them, and syncs them into data/videos.json.
 * Also recovers completed .tmp files from .incoming.
 *
 * @returns {Promise<Array<object>>} Updated videos catalog
 */
export async function syncDiskVideos() {
  const { data } = await readJSON(_videosIndex, [], { schemaVersion: SCHEMA_VERSION, videos: [] });
  let videos = Array.isArray(data?.videos) ? [...data.videos] : [];
  let changed = false;

  let settings = {};
  try { settings = getSettings() || {}; } catch { /* default */ }

  const allowedExts = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.webm']);

  // Ensure directories exist
  try {
    await fs.mkdir(_videosDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(_incomingDir, { recursive: true, mode: 0o700 });
  } catch { /* ignore */ }

  // 1. Check videos/.incoming for complete abandoned video files (> 5MB, not modified in 5s)
  try {
    const incomingEntries = await fs.readdir(_incomingDir, { withFileTypes: true });
    const now = Date.now();
    for (const ent of incomingEntries) {
      if (!ent.isFile()) continue;
      const tmpPath = path.join(_incomingDir, ent.name);
      try {
        const stat = await fs.stat(tmpPath);
        if (stat.size > 5 * 1024 * 1024 && (now - stat.mtimeMs > 5000)) {
          try {
            const probe = await probeMedia(tmpPath);
            if (probe && probe.hasVideo) {
              const newId = generateVideoId();
              const destPath = resolveVideoPath(newId, '.mp4');
              await fs.rename(tmpPath, destPath);
              logger.info('video.recovered_incoming', `Recovered complete video from incoming: ${ent.name} -> ${newId}.mp4`);
            }
          } catch {
            // Not a complete video yet; leave alone
          }
        }
      } catch { /* ignore stat error */ }
    }
  } catch { /* ignore if incoming dir missing */ }

  // 2. Scan main videos/ directory for untracked videos
  try {
    const diskEntries = await fs.readdir(_videosDir, { withFileTypes: true });
    const diskVideoFiles = [];

    for (const ent of diskEntries) {
      if (!ent.isFile()) continue;
      if (ent.name.startsWith('.')) continue; // ignore hidden
      const ext = path.extname(ent.name).toLowerCase();
      if (allowedExts.has(ext)) {
        diskVideoFiles.push(ent.name);
      }
    }

    for (const filename of diskVideoFiles) {
      let filePath = path.join(_videosDir, filename);
      const ext = path.extname(filename).toLowerCase();
      const baseName = path.basename(filename, ext);

      // Check if already in catalog
      const alreadyIndexed = videos.some(v =>
        v.filename === filename ||
        v.id === baseName ||
        (v.originalName && v.originalName === filename)
      );

      if (!alreadyIndexed) {
        try {
          const stat = await fs.stat(filePath);
          if (stat.size < 1024) continue; // skip tiny/empty files

          let videoId;
          let targetPath = filePath;

          // If filename is already vid_<8 hex>, use that ID
          if (/^vid_[0-9a-f]{8}$/i.test(baseName)) {
            videoId = baseName.toLowerCase();
          } else {
            // Standardize filename to vid_<hex><ext> so resolveVideoPath works seamlessly
            videoId = generateVideoId();
            targetPath = resolveVideoPath(videoId, ext);
            await fs.rename(filePath, targetPath);
            logger.info('video.normalized_name', `Renamed ${filename} -> ${path.basename(targetPath)}`);
          }

          const probe = await probeMedia(targetPath);
          const compatibility = evaluateCompatibility(probe, settings);
          const originalName = filename;
          const cleanLabel = baseName.replace(/^vid_[0-9a-f]{8}_?/i, '').trim() || originalName.replace(/\.[^/.]+$/, '');

          const newMeta = {
            id: videoId,
            label: cleanLabel || `Video_${videoId}`,
            originalName,
            filename: path.basename(targetPath),
            sizeBytes: stat.size,
            uploadedAt: new Date(stat.mtimeMs).toISOString(),
            mtimeMs: stat.mtimeMs,
            probe,
            compatibility,
          };

          videos.push(newMeta);
          changed = true;
          logger.info('video.auto_discovered', `Discovered and indexed video ${videoId} (${filename}) - ${compatibility.status}`);
        } catch (err) {
          logger.warn('video.probe_failed_during_sync', `Could not index ${filename}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    logger.warn('video.sync_readdir_error', `Could not read videos directory: ${err.message}`);
  }

  // 3. Re-evaluate compatibility for all videos
  videos = videos.map(v => {
    if (v.probe) {
      try {
        const freshCompat = evaluateCompatibility(v.probe, settings);
        if (!v.compatibility || v.compatibility.status !== freshCompat.status ||
            JSON.stringify(v.compatibility.reasons) !== JSON.stringify(freshCompat.reasons)) {
          v.compatibility = freshCompat;
          changed = true;
        }
      } catch (err) {
        logger.warn('video.eval_compat_error', `Could not evaluate compatibility for ${v.id}: ${err.message}`);
      }
    }
    return v;
  });

  // 4. If we have videos, ensure an active video is set
  const currentSettings = getSettings();
  const currentState = getState();
  const activeId = currentSettings?.stream?.videoId || currentState?.activeVideoId;
  const activeExists = videos.some(v => v.id === activeId);

  if (videos.length > 0 && (!activeId || !activeExists)) {
    const firstId = videos[0].id;
    try {
      await setActiveVideo(firstId);
      logger.info('video.auto_activated', `Automatically selected ${firstId} as active video`);
    } catch (err) {
      logger.warn('video.auto_activate_failed', `Could not set active video: ${err.message}`);
    }
  }

  if (changed) {
    await saveVideosIndex(videos);
  }

  return videos;
}

/**
 * Load videos metadata catalog from data/videos.json.
 * Auto-syncs from disk if catalog is empty or forceSync is true.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceSync=false]
 * @returns {Promise<Array<object>>}
 */
export async function listVideos({ forceSync = false } = {}) {
  const { data } = await readJSON(_videosIndex, [], { schemaVersion: SCHEMA_VERSION, videos: [] });
  let videos = data?.videos ?? [];
  let changed = false;

  // If index is empty or forced, scan disk to auto-discover existing video files
  if (videos.length === 0 || forceSync) {
    try {
      const diskVideos = await syncDiskVideos();
      if (diskVideos.length > 0) {
        return diskVideos;
      }
    } catch (err) {
      logger.warn('video.disk_sync_fallback_failed', err.message);
    }
  }

  let settings = {};
  try {
    settings = getSettings() || {};
  } catch { /* use defaults */ }

  const evaluatedVideos = videos.map(v => {
    if (v.probe) {
      try {
        const freshCompat = evaluateCompatibility(v.probe, settings);
        if (!v.compatibility || v.compatibility.status !== freshCompat.status ||
            JSON.stringify(v.compatibility.reasons) !== JSON.stringify(freshCompat.reasons)) {
          v.compatibility = freshCompat;
          changed = true;
        }
      } catch (err) {
        logger.warn('video.eval_compat_error', `Could not evaluate compatibility for ${v.id}: ${err.message}`);
      }
    }
    return v;
  });

  if (changed) {
    saveVideosIndex(evaluatedVideos).catch(err => {
      logger.warn('video.cache_save_failed', `Could not update videos.json cache: ${err.message}`);
    });
  }

  return evaluatedVideos;
}

/**
 * Find video metadata by ID.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getVideo(id) {
  const videos = await listVideos();
  return videos.find(v => v.id === id) || null;
}

/**
 * Save updated videos array to data/videos.json.
 */
async function saveVideosIndex(videos) {
  await writeJSON(_videosIndex, {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    videos,
  }, { mode: 0o600 });
}

// ─── Disk Space Pre-check (PRD §13.3) ────────────────────────────────────────

/**
 * Check if free disk space is sufficient for an upload.
 *
 * @param {number} requiredBytes
 * @param {number} [reserveBytes]
 */
export async function checkDiskSpace(requiredBytes, reserveBytes = 2 * 1024 * 1024 * 1024) {
  if (typeof fs.statfs !== 'function') return true; // Node older than 18.15 or unsupported FS

  try {
    const stats = await fs.statfs(_videosDir);
    const freeBytes = stats.bavail * stats.bsize;
    const totalNeeded = requiredBytes + reserveBytes;

    if (freeBytes < totalNeeded) {
      throw Object.assign(new Error('Insufficient disk space for upload'), {
        code: 'E_DISK_LOW',
        freeBytes,
        requiredBytes,
        reserveBytes,
      });
    }
  } catch (err) {
    if (err.code === 'E_DISK_LOW') throw err;
    logger.warn('video.disk_check_warning', `Could not check statfs: ${err.message}`);
  }
}

// ─── Upload Processing (PRD §13.3) ───────────────────────────────────────────

/**
 * Process a piped video stream from busboy into the video library.
 *
 * @param {import('node:stream').Readable} fileStream Readable stream of uploaded file
 * @param {object} fileInfo
 * @param {string} fileInfo.filename Original filename
 * @param {string} [fileInfo.mimeType]
 * @param {number} [fileInfo.sizeBytes=0]
 * @returns {Promise<object>} Newly created video metadata
 */
export async function processUpload(fileStream, fileInfo) {
  const settings = getSettings();
  const allowedExts = settings.uploads?.allowedExtensions ?? ['.mp4', '.mov', '.m4v', '.mkv'];

  const originalName = path.basename(fileInfo.filename || 'uploaded_video.mp4');
  const ext = path.extname(originalName).toLowerCase() || '.mp4';

  if (!allowedExts.includes(ext)) {
    throw Object.assign(new Error(`Extension ${ext} not allowed. Supported: ${allowedExts.join(', ')}`), {
      code: 'E_INVALID_EXTENSION',
    });
  }

  // Ensure directories exist
  await fs.mkdir(_incomingDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(_videosDir, { recursive: true, mode: 0o700 });

  const id = generateVideoId();
  const tempFilename = `${id}.tmp`;
  const tempPath = path.join(_incomingDir, tempFilename);
  const targetPath = resolveVideoPath(id, ext);

  // Pre-check disk space if Content-Length was known
  if (fileInfo.sizeBytes > 0) {
    const reserve = settings.uploads?.diskReserveBytes ?? (2 * 1024 * 1024 * 1024);
    await checkDiskSpace(fileInfo.sizeBytes, reserve);
  }

  // Stream directly to disk in .incoming with 2MB buffer for high-speed writes
  const outStream = fsSync.createWriteStream(tempPath, {
    mode: 0o600,
    highWaterMark: 2 * 1024 * 1024,
  });
  try {
    await pipeline(fileStream, outStream);
  } catch (err) {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
    throw Object.assign(new Error(`Upload write failed: ${err.message}`), { code: 'E_UPLOAD_FAILED' });
  }

  // Stat final uploaded file
  const stat = await fs.stat(tempPath);
  const sizeBytes = stat.size;

  // Probe the uploaded file — MUST have at least 1 video stream
  let probe;
  try {
    probe = await probeMedia(tempPath);
  } catch (err) {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
    throw Object.assign(new Error(`Uploaded file is not a valid video: ${err.message}`), {
      code: 'E_VIDEO_UNSUPPORTED',
    });
  }

  // Atomic rename into videos/ directory
  try {
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
    throw err;
  }

  // Evaluate compatibility
  const compatibility = evaluateCompatibility(probe, settings);

  const videoMeta = {
    id,
    label: originalName.replace(/\.[^/.]+$/, ''),
    originalName,
    filename: path.basename(targetPath),
    sizeBytes,
    uploadedAt: new Date().toISOString(),
    mtimeMs: stat.mtimeMs,
    probe,
    compatibility,
  };

  // Multi-video library: append newly uploaded video without purging existing library
  const existingVideos = await listVideos();
  const updatedVideos = [videoMeta, ...existingVideos.filter(v => v.id !== id)];
  await saveVideosIndex(updatedVideos);

  // If no active video or playlist configured, auto-select this new video
  const currentSettings = getSettings();
  const currentPlaylist = currentSettings?.stream?.playlist;
  const currentActive = currentSettings?.stream?.videoId;
  if (!currentActive || !Array.isArray(currentPlaylist) || currentPlaylist.length === 0) {
    await setActiveVideo(id);
  }

  logger.info('video.uploaded', `Uploaded video ${id} (${originalName}) - ${compatibility.status}`, {
    id,
    status: compatibility.status,
    sizeBytes,
  });

  return videoMeta;
}

/**
 * Register an externally converted video (e.g. from YouTube yt-dlp pipeline) into the library.
 *
 * @param {string} tempPath Path to the converted MP4 file
 * @param {string} originalName Descriptive name for the video
 * @param {object} [opts]
 * @param {boolean} [opts.autoSetActive=false]
 * @returns {Promise<object>} Video metadata object
 */
export async function importConvertedVideo(tempPath, originalName, { autoSetActive = false } = {}) {
  const settings = getSettings();
  const id = generateVideoId();
  const targetPath = resolveVideoPath(id, '.mp4');

  await fs.mkdir(_videosDir, { recursive: true, mode: 0o700 });

  const stat = await fs.stat(tempPath);
  const sizeBytes = stat.size;

  // Move temp converted file to target
  try {
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    // Fallback if cross-device link
    await fs.copyFile(tempPath, targetPath);
    await fs.unlink(tempPath).catch(() => {});
  }

  // Probe the converted file
  const probe = await probeMedia(targetPath);
  const compatibility = evaluateCompatibility(probe, settings);

  const cleanLabel = originalName.replace(/\.[^/.]+$/, '').trim() || `YouTube_${id}`;
  const videoMeta = {
    id,
    label: cleanLabel,
    originalName,
    filename: path.basename(targetPath),
    sizeBytes,
    uploadedAt: new Date().toISOString(),
    mtimeMs: stat.mtimeMs,
    probe,
    compatibility,
  };

  const existingVideos = await listVideos();
  const updatedVideos = [videoMeta, ...existingVideos.filter(v => v.id !== id)];
  await saveVideosIndex(updatedVideos);

  if (autoSetActive) {
    await setActiveVideo(id);
  }

  logger.info('video.imported', `Imported converted video ${id} (${cleanLabel}) - ${compatibility.status}`, {
    id,
    status: compatibility.status,
    sizeBytes,
  });

  return videoMeta;
}

// ─── Deletion (PRD §13.3) ────────────────────────────────────────────────────

/**
 * Delete a video from library.
 * Refuses (409) if the video is currently active and stream is running/starting.
 *
 * @param {string} id
 */
export async function deleteVideo(id) {
  const video = await getVideo(id);
  if (!video) {
    throw Object.assign(new Error('Video not found'), { code: 'E_NOT_FOUND' });
  }

  const state = getState();
  const settings = getSettings();
  const isCurrentlyStreaming = state.status === 'RUNNING' || state.status === 'STARTING';
  const isInActiveStream = (state.activeVideoId === id) || (Array.isArray(settings.stream?.playlist) && settings.stream.playlist.includes(id));
  if (isInActiveStream && isCurrentlyStreaming) {
    throw Object.assign(new Error('Cannot delete video while it is being actively streamed'), {
      code: 'E_VIDEO_IN_USE',
    });
  }

  // Delete physical file
  const ext = path.extname(video.filename || `${id}.mp4`);
  const filePath = resolveVideoPath(id, ext);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('video.delete_file_failed', `Could not delete file ${filePath}: ${err.message}`);
    }
  }

  // If deleted video was configured in playlist or as active, update settings
  const currentStream = settings.stream || {};
  let needSettingsSave = false;
  const newStreamSettings = {};

  if (Array.isArray(currentStream.playlist) && currentStream.playlist.includes(id)) {
    newStreamSettings.playlist = currentStream.playlist.filter(vid => vid !== id);
    needSettingsSave = true;
  }

  if (currentStream.videoId === id) {
    newStreamSettings.videoId = (newStreamSettings.playlist && newStreamSettings.playlist[0]) || '';
    needSettingsSave = true;
  }

  if (needSettingsSave) {
    await saveSettings({ stream: newStreamSettings });
  }
  if (state.activeVideoId === id) {
    await saveState({ activeVideoId: newStreamSettings.videoId || null });
  }

  // Remove from catalog
  const videos = await listVideos();
  const updated = videos.filter(v => v.id !== id);
  await saveVideosIndex(updated);

  logger.info('video.deleted', `Deleted video ${id} (${video.originalName})`);
  return { deleted: true, id };
}

// ─── Set Active Video & Playlist ─────────────────────────────────────────────

/**
 * Set active video ID in config and state.
 *
 * @param {string} id
 */
export async function setActiveVideo(id) {
  const video = await getVideo(id);
  if (!video) {
    throw Object.assign(new Error('Video not found'), { code: 'E_NOT_FOUND' });
  }

  const currentSettings = getSettings();
  let playlist = Array.isArray(currentSettings.stream?.playlist) ? [...currentSettings.stream.playlist] : [];
  if (!playlist.includes(id)) {
    playlist.unshift(id);
  }

  await saveSettings({ stream: { videoId: id, playlist } });
  await saveState({ activeVideoId: id });
  logger.info('video.active_changed', `Set active video to ${id} (${video.originalName})`);
  return video;
}

/**
 * Set stream playlist and playback order.
 *
 * @param {string[]} playlistIds Array of video IDs
 * @param {'sequential'|'shuffle'} [playbackOrder='sequential']
 * @returns {Promise<{ playlist: string[], playbackOrder: string }>}
 */
export async function setPlaylist(playlistIds, playbackOrder = 'sequential') {
  if (!Array.isArray(playlistIds)) {
    throw Object.assign(new Error('Playlist must be an array of video IDs'), { code: 'E_INVALID_PLAYLIST' });
  }

  const validOrder = ['sequential', 'shuffle'].includes(playbackOrder) ? playbackOrder : 'sequential';
  const existingVideos = await listVideos();
  const existingMap = new Map(existingVideos.map(v => [v.id, v]));

  // Validate all video IDs exist and preserve order without duplicates
  const validatedIds = [];
  for (const id of playlistIds) {
    if (existingMap.has(id) && !validatedIds.includes(id)) {
      validatedIds.push(id);
    }
  }

  const primaryVideoId = validatedIds[0] || '';

  await saveSettings({
    stream: {
      videoId: primaryVideoId,
      playlist: validatedIds,
      playbackOrder: validOrder,
    },
  });

  await saveState({ activeVideoId: primaryVideoId || null });

  logger.info('video.playlist_updated', `Updated stream playlist (${validatedIds.length} videos, order: ${validOrder})`, {
    playlist: validatedIds,
    playbackOrder: validOrder,
  });

  return { playlist: validatedIds, playbackOrder: validOrder };
}

// ─── Re-validate (PRD §5.1) ──────────────────────────────────────────────────

/**
 * Re-run probe and compatibility evaluation on an existing video.
 *
 * @param {string} id
 */
export async function revalidateVideo(id) {
  const video = await getVideo(id);
  if (!video) {
    throw Object.assign(new Error('Video not found'), { code: 'E_NOT_FOUND' });
  }

  const ext = path.extname(video.filename || `${id}.mp4`);
  const filePath = resolveVideoPath(id, ext);

  const stat = await fs.stat(filePath);
  const probe = await probeMedia(filePath);
  const settings = getSettings();
  const compatibility = evaluateCompatibility(probe, settings);

  video.mtimeMs = stat.mtimeMs;
  video.sizeBytes = stat.size;
  video.probe = probe;
  video.compatibility = compatibility;

  const videos = await listVideos();
  const idx = videos.findIndex(v => v.id === id);
  if (idx !== -1) videos[idx] = video;
  await saveVideosIndex(videos);

  logger.info('video.revalidated', `Re-validated video ${id}: ${compatibility.status}`);
  return video;
}

// ─── Orphan Cleanup (PRD §13.3) ──────────────────────────────────────────────

/**
 * Remove orphaned files in videos/.incoming older than maxAgeMs (default 1 h).
 */
export async function cleanOrphanIncoming(maxAgeMs = 3600 * 1000) {
  try {
    const entries = await fs.readdir(_incomingDir, { withFileTypes: true });
    const now = Date.now();
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const fPath = path.join(_incomingDir, ent.name);
      const stat = await fs.stat(fPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(fPath);
        logger.info('video.orphan_cleaned', `Cleaned orphan incoming file: ${ent.name}`);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('video.orphan_cleanup_error', err.message);
    }
  }
}

// ─── Test Helpers ────────────────────────────────────────────────────────────

export function _setPathsForTest(videosDir, incomingDir, videosIndex) {
  _videosDir   = videosDir;
  _incomingDir = incomingDir;
  _videosIndex = videosIndex;
}
