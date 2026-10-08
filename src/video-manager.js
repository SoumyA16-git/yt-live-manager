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
import { getSettings, saveSettings, isDualStreamEnabled, getHorizontalStreamKey } from './config-manager.js';
import { getState, saveState } from './state-manager.js';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

import { AsyncLocalStorage } from 'node:async_hooks';

const SCHEMA_VERSION = 1;

const _playlistLockStorage = new AsyncLocalStorage();
let _playlistMutex = Promise.resolve();

export function withPlaylistLock(fn) {
  if (_playlistLockStorage.getStore()) {
    // Already holding the playlist lock in this asynchronous context; avoid reentrant deadlock
    return fn();
  }
  const next = _playlistMutex.then(
    () => _playlistLockStorage.run(true, fn),
    () => _playlistLockStorage.run(true, fn)
  );
  _playlistMutex = next.catch(() => {});
  return next;
}

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

/**
 * Clean a video label or filename to its core base title by stripping
 * common aspect ratio / format tags (case-insensitive).
 */
export function getBaseVideoName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/\.[^/.]+$/, '') // remove extension
    .replace(/^vid_[0-9a-f]{8}_?/i, '') // remove vid_ prefix if any
    .replace(/[_-]?(vertical_shorts|vertical|shorts|yt1080x1920|1080p_clean|crisp_ready|horizontal_16x9|horizontal|16x9|1080p|clean|ready)/gi, '') // remove format suffixes
    .replace(/[_\s-]+$/g, '') // trim trailing separators
    .trim()
    .toLowerCase();
}

/**
 * Find matching horizontal video for a given vertical video.
 *
 * @param {object} verticalVideo
 * @param {Array<object>} allVideos
 * @returns {object|null}
 */
export function findPairedHorizontalVideo(verticalVideo, allVideos = []) {
  if (!verticalVideo) return null;

  // Filter for horizontal video candidates (width > height), excluding videos already paired to someone else
  const horizontalVideos = allVideos.filter(v => {
    if (v.id === verticalVideo.id) return false;
    if (v.pairedVideoId && v.pairedVideoId !== verticalVideo.id) return false;
    const w = v.probe?.width || 0;
    const h = v.probe?.height || 0;
    return (w > h) || v.probe?.orientation === 'horizontal' || v.orientation === 'horizontal';
  });

  if (horizontalVideos.length === 0) return null;

  // 1. Explicit pairing if configured in metadata
  if (verticalVideo.pairedVideoId) {
    const explicit = horizontalVideos.find(v => v.id === verticalVideo.pairedVideoId);
    if (explicit) return explicit;
  }

  // 2. Base name match
  const vertBase = getBaseVideoName(verticalVideo.originalName || verticalVideo.label || '');
  if (vertBase) {
    const exactMatch = horizontalVideos.find(v => {
      const horizBase = getBaseVideoName(v.originalName || v.label || '');
      return horizBase && horizBase === vertBase;
    });
    if (exactMatch) return exactMatch;
  }

  // 3. Prefix matching: if vertBase starts with horizBase or vice versa
  if (vertBase && vertBase.length >= 3) {
    const prefixMatch = horizontalVideos.find(v => {
      const horizBase = getBaseVideoName(v.originalName || v.label || '');
      return horizBase && horizBase.length >= 3 && (vertBase.startsWith(horizBase) || horizBase.startsWith(vertBase));
    });
    if (prefixMatch) return prefixMatch;
  }

  // 4. If there is only ONE horizontal video in the entire library and unassigned, auto-pair with it
  if (horizontalVideos.length === 1 && !horizontalVideos[0].pairedVideoId) {
    return horizontalVideos[0];
  }

  return null;
}

/**
 * Find matching vertical video for a given horizontal video.
 *
 * @param {object} horizontalVideo
 * @param {Array<object>} allVideos
 * @returns {object|null}
 */
export function findPairedVerticalVideo(horizontalVideo, allVideos = []) {
  if (!horizontalVideo) return null;

  // Filter for vertical video candidates (height >= width or orientation vertical), excluding videos already paired to someone else
  const verticalVideos = allVideos.filter(v => {
    if (v.id === horizontalVideo.id) return false;
    if (v.pairedVideoId && v.pairedVideoId !== horizontalVideo.id) return false;
    const w = v.probe?.width || 0;
    const h = v.probe?.height || 0;
    return h >= w || v.probe?.orientation === 'vertical' || v.orientation === 'vertical';
  });

  if (verticalVideos.length === 0) return null;

  // 1. Explicit pairing if configured in metadata
  if (horizontalVideo.pairedVideoId) {
    const explicit = verticalVideos.find(v => v.id === horizontalVideo.pairedVideoId);
    if (explicit) return explicit;
  }

  // 2. Base name match
  const horizBase = getBaseVideoName(horizontalVideo.originalName || horizontalVideo.label || '');
  if (horizBase) {
    const exactMatch = verticalVideos.find(v => {
      const vertBase = getBaseVideoName(v.originalName || v.label || '');
      return vertBase && vertBase === horizBase;
    });
    if (exactMatch) return exactMatch;
  }

  // 3. Prefix matching: if horizBase starts with vertBase or vice versa
  if (horizBase && horizBase.length >= 3) {
    const prefixMatch = verticalVideos.find(v => {
      const vertBase = getBaseVideoName(v.originalName || v.label || '');
      return vertBase && vertBase.length >= 3 && (horizBase.startsWith(vertBase) || vertBase.startsWith(horizBase));
    });
    if (prefixMatch) return prefixMatch;
  }

  // 4. If there is only ONE vertical video in the entire library and unassigned, auto-pair with it
  if (verticalVideos.length === 1 && !verticalVideos[0].pairedVideoId) {
    return verticalVideos[0];
  }

  return null;
}

/**
 * Find matching complementary video for either horizontal or vertical input video.
 *
 * @param {object} video
 * @param {Array<object>} allVideos
 * @returns {object|null}
 */
export function findPairedComplementaryVideo(video, allVideos = []) {
  if (!video) return null;
  const w = video.probe?.width || 0;
  const h = video.probe?.height || 0;
  const isHoriz = w > h || video.probe?.orientation === 'horizontal' || video.orientation === 'horizontal';
  return isHoriz ? findPairedVerticalVideo(video, allVideos) : findPairedHorizontalVideo(video, allVideos);
}

/**
 * Check if dual streaming is currently active and configured with horizontal key.
 *
 * @param {object} [settings]
 * @returns {boolean}
 */
export function isDualActive(settings = null) {
  const currentSettings = settings || getSettings();
  const dualConfigured = currentSettings?.youtube?.dualStreamEnabled !== false;
  const horizontalKey = (currentSettings?.youtube?.horizontalStreamKey ?? getHorizontalStreamKey())?.trim();
  return Boolean(dualConfigured && horizontalKey);
}

/**
 * Build consolidated logical playlist videos from video library.
 * Each logical video encapsulates both vertical (9:16) and horizontal (16:9) versions.
 *
 * @param {Array<object>} allVideos
 * @param {Array<string>} [playlist=[]]
 * @param {string|null} [currentActiveId=null]
 * @param {object|null} [settings=null]
 * @returns {Array<object>} Logical video objects
 */
export function buildLogicalVideos(allVideos = [], playlist = [], currentActiveId = null, settings = null) {
  const dualEnabled = isDualActive(settings);
  const visited = new Set();
  const logicalVideos = [];

  const fileExists = (v) => {
    if (!v) return false;
    try {
      const ext = path.extname(v.filename || `${v.id}.mp4`);
      const p = resolveVideoPath(v.id, ext);
      return fsSync.existsSync(p);
    } catch {
      return false;
    }
  };

  for (const v of allVideos) {
    if (visited.has(v.id)) continue;

    const w = v.probe?.width || 0;
    const h = v.probe?.height || 0;
    const isHoriz = w > h || v.probe?.orientation === 'horizontal' || v.orientation === 'horizontal';

    let vert = isHoriz ? null : v;
    let horiz = isHoriz ? v : null;

    const comp = findPairedComplementaryVideo(v, allVideos);
    if (comp) {
      if (isHoriz) {
        vert = comp;
      } else {
        horiz = comp;
      }
      visited.add(comp.id);
    }
    visited.add(v.id);

    const vertExists = fileExists(vert);
    const horizExists = fileExists(horiz);
    const isComplete = dualEnabled ? Boolean(vert && horiz && vertExists && horizExists) : Boolean((vert && vertExists) || (horiz && horizExists));

    const canonicalId = (vert && vert.id) ? vert.id : (horiz && horiz.id ? horiz.id : v.id);
    const rawLabel = (vert && (vert.label || vert.originalName)) || (horiz && (horiz.label || horiz.originalName)) || v.label || v.originalName;
    const cleanLabel = getBaseVideoName(rawLabel) || rawLabel.replace(/\.[^/.]+$/, '');
    const displayLabel = cleanLabel ? (cleanLabel.charAt(0).toUpperCase() + cleanLabel.slice(1)) : canonicalId;

    const inPlaylist = (vert && playlist.includes(vert.id)) || (horiz && playlist.includes(horiz.id)) || playlist.includes(canonicalId);
    const isPlaying = (vert && vert.id === currentActiveId) || (horiz && horiz.id === currentActiveId) || canonicalId === currentActiveId;

    let status = 'READY';
    if (isPlaying) {
      status = 'PLAYING';
    } else if (!isComplete) {
      status = 'PENDING_PAIR';
    } else {
      status = 'READY';
    }

    logicalVideos.push({
      id: canonicalId,
      label: displayLabel,
      verticalVideoId: vert?.id || null,
      horizontalVideoId: horiz?.id || null,
      vertical: vert ? {
        id: vert.id,
        label: vert.label,
        originalName: vert.originalName,
        filename: vert.filename,
        filePath: vert.filePath || resolveVideoPath(vert.id, path.extname(vert.filename || `${vert.id}.mp4`)),
        sizeBytes: vert.sizeBytes,
        probe: vert.probe,
        compatibility: vert.compatibility,
        exists: vertExists,
      } : null,
      horizontal: horiz ? {
        id: horiz.id,
        label: horiz.label,
        originalName: horiz.originalName,
        filename: horiz.filename,
        filePath: horiz.filePath || resolveVideoPath(horiz.id, path.extname(horiz.filename || `${horiz.id}.mp4`)),
        sizeBytes: horiz.sizeBytes,
        probe: horiz.probe,
        compatibility: horiz.compatibility,
        exists: horizExists,
      } : null,
      isComplete,
      inPlaylist,
      isPlaying,
      status,
    });
  }

  return logicalVideos;
}

/**
 * Retrieve fresh, validated playable playlist of logical videos.
 * Guarantees that only complete, verified pairs are returned.
 *
 * @param {object} [settings]
 * @param {Array<object>} [allVideos]
 * @returns {Promise<Array<object>>}
 */
export async function getFreshPlayablePlaylist(settings = null, allVideos = null) {
  const currentSettings = settings || getSettings();
  const mode = currentSettings.stream?.mode || 'horizontal';
  const modePlaylists = currentSettings.stream?.playlists;
  const currentPlaylist = (modePlaylists && Array.isArray(modePlaylists[mode]) && modePlaylists[mode].length > 0)
    ? modePlaylists[mode]
    : (Array.isArray(currentSettings.stream?.playlist) ? currentSettings.stream.playlist : []);

  const videos = allVideos || await listVideos();
  const videoMap = new Map(videos.map(v => [v.id, v]));

  const playable = [];
  const seenIds = new Set();

  for (const id of currentPlaylist) {
    if (seenIds.has(id)) continue;
    const v = videoMap.get(id);
    if (!v) {
      logger.warn('playlist.video_missing', `Configured playlist item ${id} not found in library`);
      continue;
    }

    const ext = path.extname(v.filename || `${v.id}.mp4`);
    const p = resolveVideoPath(v.id, ext);
    if (!fsSync.existsSync(p)) {
      logger.warn('playlist.video_missing', `Playlist item ${id} file is missing on disk: ${p}`);
      continue;
    }

    const isHoriz = (v.probe?.width || 0) >= (v.probe?.height || 0);
    // Strict mode check: do not mix modes
    if (mode === 'horizontal' && !isHoriz) {
      logger.warn('playlist.orientation_mismatch', `Skipping vertical video ${id} in horizontal mode`);
      continue;
    }
    if (mode === 'vertical' && isHoriz) {
      logger.warn('playlist.orientation_mismatch', `Skipping horizontal video ${id} in vertical mode`);
      continue;
    }

    seenIds.add(id);
    playable.push({
      ...v,
      id: v.id,
      logicalId: v.id,
      videoPath: p,
      isHoriz,
      horizontal: isHoriz ? { ...v, path: p, exists: true } : null,
      vertical: !isHoriz ? { ...v, path: p, exists: true } : null,
      horizontalVideoId: isHoriz ? v.id : null,
      verticalVideoId: !isHoriz ? v.id : null,
    });
  }

  // Fallback: if playlist was empty but single active video exists matching mode
  if (playable.length === 0 && currentSettings.stream?.videoId) {
    const singleV = videoMap.get(currentSettings.stream.videoId);
    if (singleV) {
      const isHoriz = (singleV.probe?.width || 0) >= (singleV.probe?.height || 0);
      if ((mode === 'horizontal' && isHoriz) || (mode === 'vertical' && !isHoriz)) {
        const ext = path.extname(singleV.filename || `${singleV.id}.mp4`);
        const p = resolveVideoPath(singleV.id, ext);
        if (fsSync.existsSync(p)) {
          playable.push({
            ...singleV,
            id: singleV.id,
            logicalId: singleV.id,
            videoPath: p,
            isHoriz,
            horizontal: isHoriz ? { ...singleV, path: p, exists: true } : null,
            vertical: !isHoriz ? { ...singleV, path: p, exists: true } : null,
            horizontalVideoId: isHoriz ? singleV.id : null,
            verticalVideoId: !isHoriz ? singleV.id : null,
          });
        }
      }
    }
  }

  return playable;
}

/**
 * Evaluate if a newly uploaded video completes a paired logical video.
 * If both vertical and horizontal versions exist and validate on disk:
 * - Links the pair in metadata.
 * - Atomically appends the logical item to settings.stream.playlist if not present.
 * - Emits structured logs (playlist.pair_ready, playlist.hot_sync).
 *
 * @param {string} videoId Newly uploaded video ID
 * @returns {Promise<{ paired: boolean, isComplete: boolean, logicalId?: string, verticalId?: string, horizontalId?: string }>}
 */
export async function finalizePairIfComplete(videoId) {
  return withPlaylistLock(async () => {
    const allVideos = await listVideos();
    const uploaded = allVideos.find(v => v.id === videoId);
    if (!uploaded) return { paired: false, isComplete: false };

    const dualEnabled = isDualActive();

    // If dual streaming is disabled, any single video is immediately complete
    if (!dualEnabled) {
      const ext = path.extname(uploaded.filename || `${uploaded.id}.mp4`);
      const filePath = resolveVideoPath(uploaded.id, ext);
      if (fsSync.existsSync(filePath)) {
        logger.info('playlist.pair_ready', `Single video ${uploaded.id} is ready for playback`);
        return { paired: false, isComplete: true, logicalId: uploaded.id };
      }
      return { paired: false, isComplete: false };
    }

    // Dual stream mode: search for complementary pair
    const comp = findPairedComplementaryVideo(uploaded, allVideos);
    if (!comp) {
      logger.info('playlist.pair_pending', `Video ${uploaded.id} (${uploaded.originalName}) is uploaded but awaiting complementary pair`, {
        videoId: uploaded.id,
        orientation: (uploaded.probe?.width > uploaded.probe?.height) ? 'horizontal' : 'vertical',
      });
      return { paired: false, isComplete: false, videoId };
    }

    // Both exist: validate both physical files
    const upExt = path.extname(uploaded.filename || `${uploaded.id}.mp4`);
    const compExt = path.extname(comp.filename || `${comp.id}.mp4`);
    const upPath = resolveVideoPath(uploaded.id, upExt);
    const compPath = resolveVideoPath(comp.id, compExt);

    if (!fsSync.existsSync(upPath) || !fsSync.existsSync(compPath)) {
      logger.warn('playlist.pair_validation_failed', `Files missing on disk for pair ${uploaded.id} + ${comp.id}`);
      return { paired: false, isComplete: false, error: 'Files missing on disk' };
    }

    // Verify probe validity
    const hasValidVideo = (p) => Boolean(p && (p.hasVideo !== false) && (p.width > 0 || p.hasVideo));
    if (!hasValidVideo(uploaded.probe) || !hasValidVideo(comp.probe)) {
      logger.warn('playlist.pair_validation_failed', `Invalid video streams for pair ${uploaded.id} + ${comp.id}`);
      return { paired: false, isComplete: false, error: 'Invalid video stream probe' };
    }

    // Mutually link pairedVideoId in videos.json
    uploaded.pairedVideoId = comp.id;
    comp.pairedVideoId = uploaded.id;

    const isUploadedHoriz = (uploaded.probe?.width > uploaded.probe?.height);
    const vert = isUploadedHoriz ? comp : uploaded;
    const horiz = isUploadedHoriz ? uploaded : comp;

    const updatedVideos = allVideos.map(v => {
      if (v.id === uploaded.id) return { ...v, pairedVideoId: comp.id };
      if (v.id === comp.id) return { ...v, pairedVideoId: uploaded.id };
      return v;
    });
    await saveVideosIndex(updatedVideos);

    // Atomically persist to stream playlist
    const currentSettings = getSettings();
    let playlist = Array.isArray(currentSettings.stream?.playlist) ? [...currentSettings.stream.playlist] : [];
    const primaryId = vert.id;

    // Check if either primaryId or comp.id is in playlist
    const alreadyInPlaylist = playlist.includes(primaryId) || playlist.includes(comp.id);
    if (!alreadyInPlaylist) {
      playlist.push(primaryId);
      await saveSettings({
        stream: {
          playlist,
          videoId: currentSettings.stream?.videoId || primaryId,
        },
      });
      logger.info('playlist.hot_sync', `Atomically synced complete pair ${primaryId} into live playlist (total items: ${playlist.length})`, {
        logicalId: primaryId,
        verticalVideoId: vert.id,
        horizontalVideoId: horiz.id,
        playlistCount: playlist.length,
      });
    }

    logger.info('playlist.pair_ready', `Pair validated and finalized: ${vert.id} (vertical) + ${horiz.id} (horizontal)`, {
      logicalId: primaryId,
      verticalVideoId: vert.id,
      horizontalVideoId: horiz.id,
      status: 'READY',
    });

    return {
      paired: true,
      isComplete: true,
      logicalId: primaryId,
      verticalId: vert.id,
      horizontalId: horiz.id,
    };
  });
}


// ─── Module State ────────────────────────────────────────────────────────────

let _videosIndex = PATHS.videosIndex;
let _videosDir   = PATHS.videos;
let _incomingDir = PATHS.videosIncoming;
let _syncPromise = null;

// ─── Metadata Library Index ──────────────────────────────────────────────────

/**
 * Scan videos/ (and videos/.incoming/) directory on disk.
 * Discovers untracked video files, probes them, and syncs them into data/videos.json.
 * Also recovers completed .tmp files from .incoming.
 * Guarded against re-entrant and concurrent executions.
 *
 * @returns {Promise<Array<object>>} Updated videos catalog
 */
export async function syncDiskVideos() {
  if (_syncPromise) {
    return _syncPromise;
  }

  _syncPromise = _executeDiskSync();
  try {
    return await _syncPromise;
  } finally {
    _syncPromise = null;
  }
}

async function _executeDiskSync() {
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
          const targetOrient = (probe && probe.width > probe.height) ? 'horizontal' : 'vertical';
          const compatibility = evaluateCompatibility(probe, settings, targetOrient);
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
        const targetOrient = (v.probe && v.probe.width > v.probe.height) ? 'horizontal' : 'vertical';
        const freshCompat = evaluateCompatibility(v.probe, settings, targetOrient);
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

  // 3b. Persist updated index immediately BEFORE auto-activation or returning
  if (changed) {
    await saveVideosIndex(videos);
  }

  // 4. If we have videos, ensure an active video is set
  const currentSettings = getSettings();
  const currentState = getState();
  const activeId = currentSettings?.stream?.videoId || currentState?.activeVideoId;
  const activeExists = videos.some(v => v.id === activeId);

  if (videos.length > 0 && (!activeId || !activeExists)) {
    const firstId = videos[0].id;
    try {
      let playlist = Array.isArray(currentSettings?.stream?.playlist) ? [...currentSettings.stream.playlist] : [];
      if (!playlist.includes(firstId)) {
        playlist.unshift(firstId);
      }
      await saveSettings({ stream: { videoId: firstId, playlist } });
      await saveState({ activeVideoId: firstId });
      logger.info('video.auto_activated', `Automatically selected ${firstId} as active video`);
    } catch (err) {
      logger.warn('video.auto_activate_failed', `Could not set active video: ${err.message}`);
    }
  }

  try {
    await migratePlaylistsByOrientation(videos);
  } catch (err) {
    logger.warn('video.migrate_playlists_failed', `Could not auto-migrate playlists: ${err.message}`);
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
  const { data, source } = await readJSON(_videosIndex, [], { schemaVersion: SCHEMA_VERSION, videos: [] });
  let videos = data?.videos ?? [];
  let changed = false;

  // Auto-discover if index file did not exist on disk yet (source === 'default') or forceSync requested
  if ((source === 'default' && videos.length === 0) || forceSync) {
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
        const targetOrient = (v.probe && v.probe.width > v.probe.height) ? 'horizontal' : 'vertical';
        const freshCompat = evaluateCompatibility(v.probe, settings, targetOrient);
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

  const enrichedVideos = evaluatedVideos.map(v => {
    const isVertical = !v.probe || (v.probe.height >= v.probe.width);
    const orientation = isVertical ? 'vertical' : 'horizontal';
    let paired = null;
    if (isVertical) {
      const hVideo = findPairedHorizontalVideo(v, evaluatedVideos);
      if (hVideo) {
        paired = { id: hVideo.id, label: hVideo.label, originalName: hVideo.originalName };
      }
    } else {
      const vVideo = evaluatedVideos.find(cand => {
        if (!cand.probe || cand.probe.height < cand.probe.width) return false;
        const match = findPairedHorizontalVideo(cand, evaluatedVideos);
        return match && match.id === v.id;
      });
      if (vVideo) {
        paired = { id: vVideo.id, label: vVideo.label, originalName: vVideo.originalName };
      }
    }
    return {
      ...v,
      orientation,
      paired,
    };
  });

  return enrichedVideos;
}

/**
 * Find video metadata by ID.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getVideo(id) {
  const { data } = await readJSON(_videosIndex, [], { schemaVersion: SCHEMA_VERSION, videos: [] });
  if (Array.isArray(data?.videos)) {
    const found = data.videos.find(v => v.id === id);
    if (found) return found;
  }
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

  // Dimension validation per upload mode
  const uploadMode = (fileInfo.uploadMode || fileInfo.mode || getStreamMode() || 'horizontal').toLowerCase();
  const width = probe.width || 0;
  const height = probe.height || 0;
  const isHorizontalVideo = width >= height;

  if (uploadMode === 'horizontal') {
    if (!isHorizontalVideo) {
      try { await fs.unlink(tempPath); } catch { /* ignore */ }
      throw Object.assign(new Error('Horizontal 16:9 video required.'), {
        code: 'E_HORIZONTAL_VIDEO_REQUIRED',
      });
    }
  } else if (uploadMode === 'vertical') {
    if (isHorizontalVideo) {
      try { await fs.unlink(tempPath); } catch { /* ignore */ }
      throw Object.assign(new Error('Vertical 9:16 video required.'), {
        code: 'E_VERTICAL_VIDEO_REQUIRED',
      });
    }
  }

  // Atomic rename into videos/ directory
  try {
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
    throw err;
  }

  // Evaluate compatibility
  const targetOrient = uploadMode;
  const compatibility = evaluateCompatibility(probe, settings, targetOrient);

  const videoMeta = {
    id,
    label: originalName.replace(/\.[^/.]+$/, ''),
    originalName,
    filename: path.basename(targetPath),
    sizeBytes,
    mode: uploadMode,
    orientation: uploadMode,
    uploadedAt: new Date().toISOString(),
    mtimeMs: stat.mtimeMs,
    probe,
    compatibility,
  };

  // Multi-video library: append newly uploaded video without purging existing library
  const existingVideos = await listVideos();
  const updatedVideos = [videoMeta, ...existingVideos.filter(v => v.id !== id)];
  await saveVideosIndex(updatedVideos);

  // Auto-append to target mode playlist
  const currentSettings = getSettings();
  const currentPlaylists = {
    horizontal: Array.isArray(currentSettings.stream?.playlists?.horizontal) ? [...currentSettings.stream.playlists.horizontal] : [],
    vertical: Array.isArray(currentSettings.stream?.playlists?.vertical) ? [...currentSettings.stream.playlists.vertical] : [],
  };

  if (!currentPlaylists[uploadMode].includes(id)) {
    currentPlaylists[uploadMode].push(id);
  }

  const patch = {
    stream: {
      playlists: currentPlaylists,
    },
  };

  const activeStreamMode = currentSettings.stream?.mode || 'horizontal';
  if (uploadMode === activeStreamMode) {
    patch.stream.playlist = [...currentPlaylists[activeStreamMode]];
    if (!currentSettings.stream?.videoId) {
      patch.stream.videoId = id;
    }
  }

  await saveSettings(patch);

  logger.info('video.uploaded', `Uploaded ${uploadMode} video ${id} (${originalName}) - ${compatibility.status}`, {
    id,
    mode: uploadMode,
    status: compatibility.status,
    sizeBytes,
  });

  return {
    ...videoMeta,
    logicalId: id,
  };
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
export async function importConvertedVideo(tempPath, originalName, {
  autoSetActive = false,
  isDirectCopy = true,
  youtubeUrl = null,
  youtubeVideoId = null,
} = {}) {
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
  if (isDirectCopy && probe) {
    probe.isDirectCopy = true;
  }
  const targetOrient = (probe && probe.width >= probe.height) ? 'horizontal' : 'vertical';
  const compatibility = evaluateCompatibility(probe, settings, targetOrient);
  const keyframeMaxSec = Math.min(4.0, Number(settings.stream?.keyframeMaxSeconds ?? 4.0));
  const isGopCompliant = !probe?.maxKeyframeIntervalSec || probe.maxKeyframeIntervalSec <= keyframeMaxSec;
  if (isDirectCopy && isGopCompliant) {
    compatibility.status = 'COMPATIBLE';
    compatibility.modeAllowed = { copy: true, hybrid: true, transcode: true };
  } else if (!isGopCompliant && compatibility.status === 'COMPATIBLE') {
    compatibility.status = 'REQUIRES_TRANSCODING';
    compatibility.modeAllowed = { copy: false, hybrid: false, transcode: true };
  }

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
    youtubeUrl: youtubeUrl || null,
    youtubeVideoId: youtubeVideoId || null,
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
  const isCurrentlyStreaming = state.status === 'RUNNING' || state.status === 'STARTING' || state.currentPlaybackState === 'PLAYING';
  const isInActiveStream = (state.activeVideoId === id) ||
    (state.currentVerticalVideoId === id) ||
    (state.currentHorizontalVideoId === id) ||
    (state.currentLogicalVideoId === id);

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
 * Set stream playlist and playback order for a specific mode.
 *
 * @param {string[]} playlistIds Array of video IDs
 * @param {'sequential'|'shuffle'|'serial'} [playbackOrder='serial']
 * @param {'horizontal'|'vertical'} [mode] Target mode (defaults to current stream.mode)
 * @returns {Promise<{ mode: string, playlist: string[], playlists: object, playbackOrder: string }>}
 */
export async function setPlaylist(playlistIds, playbackOrder = 'serial', mode = null) {
  return withPlaylistLock(async () => {
    if (!Array.isArray(playlistIds)) {
      throw Object.assign(new Error('Playlist must be an array of video IDs'), { code: 'E_INVALID_PLAYLIST' });
    }

    const validOrder = ['sequential', 'shuffle', 'serial'].includes(playbackOrder) ? playbackOrder : 'serial';
    const existingVideos = await listVideos();
    const existingMap = new Map(existingVideos.map(v => [v.id, v]));

    const currentSettings = getSettings();
    const currentMode = currentSettings.stream?.mode || 'horizontal';
    const targetMode = (mode === 'horizontal' || mode === 'vertical') ? mode : currentMode;

    // Validate all video IDs exist and match the mode's orientation
    const validatedIds = [];
    for (const id of playlistIds) {
      const v = existingMap.get(id);
      if (v && !validatedIds.includes(id)) {
        const isHoriz = (v.probe?.width || 0) >= (v.probe?.height || 0);
        if (targetMode === 'horizontal' && isHoriz) {
          validatedIds.push(id);
        } else if (targetMode === 'vertical' && !isHoriz) {
          validatedIds.push(id);
        }
      }
    }

    const currentPlaylists = {
      horizontal: Array.isArray(currentSettings.stream?.playlists?.horizontal) ? [...currentSettings.stream.playlists.horizontal] : [],
      vertical: Array.isArray(currentSettings.stream?.playlists?.vertical) ? [...currentSettings.stream.playlists.vertical] : [],
    };
    currentPlaylists[targetMode] = validatedIds;

    const patch = {
      stream: {
        playlists: currentPlaylists,
        playbackOrder: validOrder,
      },
    };

    if (targetMode === currentMode) {
      const primaryVideoId = validatedIds[0] || '';
      patch.stream.playlist = validatedIds;
      patch.stream.videoId = primaryVideoId;
      await saveState({ activeVideoId: primaryVideoId || null });
    }

    await saveSettings(patch);

    logger.info('video.playlist_updated', `Updated ${targetMode} playlist (${validatedIds.length} videos, order: ${validOrder})`, {
      mode: targetMode,
      playlist: validatedIds,
      playbackOrder: validOrder,
    });
    logger.info('playlist.hot_sync', `Hot playlist configuration updated (${validatedIds.length} items)`, {
      itemCount: validatedIds.length,
    });

    return { mode: targetMode, playlist: validatedIds, playlists: currentPlaylists, playbackOrder: validOrder };
  });
}

/**
 * Migrate legacy playlist and videos into mode-specific playlists based on ffprobe dimensions.
 */
export async function migratePlaylistsByOrientation(providedVideos = null) {
  return withPlaylistLock(async () => {
    const settings = getSettings();
    const stream = settings.stream || {};
    let changed = false;

    const currentPlaylists = {
      horizontal: Array.isArray(stream.playlists?.horizontal) ? [...stream.playlists.horizontal] : [],
      vertical: Array.isArray(stream.playlists?.vertical) ? [...stream.playlists.vertical] : [],
    };

    let videos = providedVideos;
    if (!videos) {
      const { data } = await readJSON(_videosIndex, [], { schemaVersion: SCHEMA_VERSION, videos: [] });
      videos = data?.videos ?? [];
    }

    for (const v of videos) {
      const isHoriz = (v.probe?.width || 0) >= (v.probe?.height || 0);
      if (isHoriz) {
        if (!currentPlaylists.horizontal.includes(v.id)) {
          currentPlaylists.horizontal.push(v.id);
          changed = true;
        }
      } else {
        if (!currentPlaylists.vertical.includes(v.id)) {
          currentPlaylists.vertical.push(v.id);
          changed = true;
        }
      }
    }

    if (Array.isArray(stream.playlist) && stream.playlist.length > 0) {
      const legacyHoriz = stream.playlist.filter(id => {
        const v = videos.find(x => x.id === id);
        return v && (v.probe?.width || 0) >= (v.probe?.height || 0);
      });
      const legacyVert = stream.playlist.filter(id => {
        const v = videos.find(x => x.id === id);
        return v && (v.probe?.height || 0) > (v.probe?.width || 0);
      });

      if (legacyHoriz.length > 0) {
        currentPlaylists.horizontal = [
          ...legacyHoriz,
          ...currentPlaylists.horizontal.filter(id => !legacyHoriz.includes(id)),
        ];
        changed = true;
      }
      if (legacyVert.length > 0) {
        currentPlaylists.vertical = [
          ...legacyVert,
          ...currentPlaylists.vertical.filter(id => !legacyVert.includes(id)),
        ];
        changed = true;
      }
    }

    const mode = stream.mode || 'horizontal';
    const activePlaylist = currentPlaylists[mode] || [];
    const activeVideoId = activePlaylist[0] || stream.videoId || '';

    if (changed || !stream.playlists) {
      await saveSettings({
        stream: {
          mode,
          playlists: currentPlaylists,
          playlist: activePlaylist,
          videoId: activeVideoId,
        },
      });
      await saveState({ activeVideoId });
      logger.info('video.playlists_migrated', `Playlists migrated by orientation: ${currentPlaylists.horizontal.length} horizontal, ${currentPlaylists.vertical.length} vertical`);
    }

    return currentPlaylists;
  });
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
  const targetOrient = (probe && probe.width > probe.height) ? 'horizontal' : 'vertical';
  const compatibility = evaluateCompatibility(probe, settings, targetOrient);

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
  _syncPromise = null;
}
