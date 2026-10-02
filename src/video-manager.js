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
 * Load videos metadata catalog from data/videos.json.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listVideos() {
  const { data } = await readJSON(_videosIndex, [], { schemaVersion: SCHEMA_VERSION, videos: [] });
  return data?.videos ?? [];
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
export async function checkDiskSpace(requiredBytes, reserveBytes = 500 * 1024 * 1024) {
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
    const reserve = settings.uploads?.diskReserveBytes ?? 500 * 1024 * 1024;
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

  // Auto-purge all previous video files (Single-video rotation: PRD §13 / User directive)
  const previousVideos = await listVideos();
  for (const old of previousVideos) {
    if (old.id !== id) {
      try {
        const ext = path.extname(old.filename || `${old.id}.mp4`);
        const oldPath = resolveVideoPath(old.id, ext);
        await fs.unlink(oldPath).catch(() => {});
        logger.info('video.auto_purged', `Auto-purged previous video file ${old.id} (${old.originalName}) on new upload`);
      } catch (err) {
        logger.warn('video.auto_purge_failed', `Could not delete old video file ${old.id}: ${err.message}`);
      }
    }
  }

  // Save catalog containing only the newly uploaded video
  await saveVideosIndex([videoMeta]);

  // Automatically mark the new video as active
  await setActiveVideo(id);

  logger.info('video.uploaded', `Uploaded video ${id} (${originalName}) - ${compatibility.status}`, {
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
  const isCurrentlyStreaming = state.status === 'RUNNING' || state.status === 'STARTING';
  if (state.activeVideoId === id && isCurrentlyStreaming) {
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

  // If deleted video was configured as active, clear it
  const settings = getSettings();
  if (settings.stream?.videoId === id) {
    await saveSettings({ stream: { videoId: '' } });
  }
  if (state.activeVideoId === id) {
    await saveState({ activeVideoId: null });
  }

  // Remove from catalog
  const videos = await listVideos();
  const updated = videos.filter(v => v.id !== id);
  await saveVideosIndex(updated);

  logger.info('video.deleted', `Deleted video ${id} (${video.originalName})`);
  return { deleted: true, id };
}

// ─── Set Active Video ────────────────────────────────────────────────────────

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

  await saveSettings({ stream: { videoId: id } });
  await saveState({ activeVideoId: id });
  logger.info('video.active_changed', `Set active video to ${id} (${video.originalName})`);
  return video;
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
