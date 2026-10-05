/**
 * api/videos.routes.js — Video library management and streaming multipart upload with busboy.
 */

import { Router } from 'express';
import busboy from 'busboy';
import fs from 'node:fs';
import path from 'node:path';
import {
  listVideos,
  getVideo,
  deleteVideo,
  setActiveVideo,
  setPlaylist,
  revalidateVideo,
  processUpload,
  syncDiskVideos,
  buildLogicalVideos,
} from '../video-manager.js';
import { getState } from '../state-manager.js';
import { stopStream, startStream } from '../stream-manager.js';
import { getSettings } from '../config-manager.js';
import {
  startYouTubeDownload,
  getDownloadStatus,
  cancelDownload,
  getCookiesStatus,
  saveCookiesFile,
} from '../ytdlp-manager.js';
import { logger } from '../logger.js';

export function createVideosRouter() {
  const router = Router();

  // GET /api/videos
  router.get('/', async (req, res) => {
    try {
      const forceSync = req.query.sync === '1' || req.query.sync === 'true';
      const videos = await listVideos({ forceSync });
      const streamSettings = getSettings().stream || {};
      const activeVideoId = streamSettings.videoId || getState().activeVideoId || null;
      const playlist = Array.isArray(streamSettings.playlist) ? streamSettings.playlist : (activeVideoId ? [activeVideoId] : []);
      const playbackOrder = streamSettings.playbackOrder || 'sequential';
      const logicalVideos = buildLogicalVideos(videos, playlist, activeVideoId);
      res.json({ videos, logicalVideos, activeVideoId, playlist, playbackOrder });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/videos/sync — manual trigger to scan disk & discover video files
  router.post('/sync', async (req, res) => {
    try {
      const videos = await syncDiskVideos();
      const activeVideoId = getSettings().stream?.videoId || getState().activeVideoId || null;
      res.json({ success: true, count: videos.length, videos, activeVideoId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/videos/playlist
  router.get('/playlist', (req, res) => {
    const streamSettings = getSettings().stream || {};
    const mode = (req.query.mode === 'horizontal' || req.query.mode === 'vertical')
      ? req.query.mode
      : (streamSettings.mode || 'horizontal');
    const playlists = streamSettings.playlists || { horizontal: [], vertical: [] };
    const playlist = Array.isArray(playlists[mode]) ? playlists[mode] : [];
    const playbackOrder = streamSettings.playbackOrder || 'serial';
    res.json({ playlist, playlists, mode, playbackOrder });
  });

  // POST /api/videos/playlist
  router.post('/playlist', async (req, res) => {
    const { playlist, playbackOrder, mode } = req.body || {};
    const shouldRestart = req.query.restart === 'true';

    try {
      const state = getState();
      const isLive = state.status === 'RUNNING' || state.status === 'STARTING';
      const currentMode = getSettings().stream?.mode || 'horizontal';
      const targetMode = (mode === 'horizontal' || mode === 'vertical') ? mode : currentMode;

      const updated = await setPlaylist(playlist || [], playbackOrder || 'serial', targetMode);

      if (isLive && targetMode === currentMode) {
        if (shouldRestart) {
          logger.info('video.playlist_restart', `Gracefully restarting stream onto new playlist (${updated.playlist.length} videos)`);
          await stopStream({ keepDesiredRunning: true, reason: 'playlist_change_restart' });
          await startStream({ reason: 'playlist_change_restart' });
        } else {
          logger.info('playlist.hot_sync', `Live stream playlist updated dynamically (${updated.playlist.length} items); next transition will reflect fresh playlist`);
        }
      }

      res.json({ success: true, hotSync: isLive && targetMode === currentMode && !shouldRestart, ...updated });
    } catch (err) {
      const status = err.code === 'E_INVALID_PLAYLIST' ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  // GET /api/videos/download-status
  router.get('/download-status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getDownloadStatus());
  });

  // POST /api/videos/download-youtube
  router.post('/download-youtube', async (req, res) => {
    const { url, autoSetActive } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid YouTube URL', code: 'E_INVALID_URL' });
    }

    try {
      const status = await startYouTubeDownload(url, { autoSetActive: Boolean(autoSetActive) });
      res.json({ success: true, status });
    } catch (err) {
      const statusCode = err.code === 'E_INVALID_URL' ? 400
        : err.code === 'E_JOB_RUNNING' ? 409
        : err.code === 'E_YTDLP_MISSING' ? 503
        : 500;
      res.status(statusCode).json({ error: err.message, code: err.code });
    }
  });

  // POST /api/videos/download-cancel
  router.post('/download-cancel', async (req, res) => {
    try {
      const cancelled = await cancelDownload();
      res.json({ success: true, cancelled });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/videos/cookies-status
  router.get('/cookies-status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const status = await getCookiesStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/videos/upload-cookies — save yt-cookies.txt to config dir
  router.post('/upload-cookies', (req, res) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }

    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    } catch (err) {
      return res.status(400).json({ error: 'Invalid multipart request' });
    }

    let chunks = [];
    let fileErr = null;
    let gotFile = false;

    bb.on('file', (_field, stream, info) => {
      const { filename } = info;
      const ext = path.extname(filename).toLowerCase();
      if (!['.txt', '.cookie', '.cookies', ''].includes(ext)) {
        stream.resume();
        fileErr = 'Invalid file. Please upload a Netscape cookies .txt file.';
        return;
      }
      gotFile = true;
      stream.on('data', (d) => chunks.push(d));
      stream.on('error', (e) => { fileErr = e.message; });
    });

    bb.on('finish', async () => {
      if (fileErr) return res.status(400).json({ error: fileErr });
      if (!gotFile || chunks.length === 0) return res.status(400).json({ error: 'No file received' });
      try {
        const content = Buffer.concat(chunks);
        await saveCookiesFile(content);
        const status = await getCookiesStatus();
        logger.info('ytdlp.cookies_uploaded', `yt-cookies.txt saved (${status.sizeBytes} bytes)`);
        res.json({ success: true, sizeBytes: status.sizeBytes });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    bb.on('error', (err) => res.status(500).json({ error: err.message }));
    req.pipe(bb);
  });

  // GET /api/videos/:id
  router.get('/:id', async (req, res) => {
    try {
      const video = await getVideo(req.params.id);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      res.json(video);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/videos/upload (PRD §13.3 — streaming busboy)
  router.post('/upload', (req, res) => {
    // Disable request and socket timeouts for large multi-gigabyte uploads (PRD §13.3)
    req.setTimeout(0);
    res.setTimeout(0);
    if (req.socket) {
      req.socket.setTimeout(0);
      req.socket.setKeepAlive(true, 10000);
      req.socket.setNoDelay(true);
    }

    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }

    const settings = getSettings();
    const maxBytes = settings.uploads?.maxBytes ?? 8 * 1024 * 1024 * 1024; // 8 GiB

    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { fileSize: maxBytes, files: 1 },
        highWaterMark: 2 * 1024 * 1024, // 2MB stream buffer for high-throughput upload
      });
    } catch (err) {
      return res.status(400).json({ error: `Busboy initialization failed: ${err.message}` });
    }

    let uploadPromise = null;
    let fileHandled = false;

    req.on('aborted', () => {
      logger.warn('video.upload_aborted', 'Client aborted video upload');
    });

    req.on('error', (err) => {
      logger.error('video.upload_req_error', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: `Upload transmission error: ${err.message}` });
      }
    });

    let uploadMode = req.query.mode || '';

    bb.on('field', (name, val) => {
      if (name === 'mode' && (val === 'horizontal' || val === 'vertical')) {
        uploadMode = val;
      }
    });

    bb.on('file', (name, fileStream, info) => {
      fileHandled = true;
      const { filename, mimeType } = info;
      const contentLength = parseInt(req.headers['content-length'], 10) || 0;

      uploadPromise = processUpload(fileStream, {
        filename,
        mimeType,
        sizeBytes: contentLength,
        uploadMode: uploadMode || req.query.mode || getSettings().stream?.mode || 'horizontal',
      });
    });

    bb.on('error', (err) => {
      logger.error('video.upload_error', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: `Upload stream failed: ${err.message}` });
      }
    });

    bb.on('close', async () => {
      if (!fileHandled || !uploadPromise) {
        return res.status(400).json({ error: 'No video file found in multipart upload' });
      }

      try {
        const videoMeta = await uploadPromise;

        // Video uploaded successfully to library. Active stream continues without interruption.
        res.status(201).json({ success: true, video: videoMeta });
      } catch (err) {
        const status = err.code === 'E_DISK_LOW' ? 507
          : err.code === 'E_INVALID_EXTENSION' ? 415
          : (err.code === 'E_VIDEO_UNSUPPORTED' || err.code === 'E_HORIZONTAL_VIDEO_REQUIRED' || err.code === 'E_VERTICAL_VIDEO_REQUIRED') ? 422
          : 500;
        res.status(status).json({ error: err.message, code: err.code });
      }
    });

    req.pipe(bb);
  });

  // DELETE /api/videos/:id
  router.delete('/:id', async (req, res) => {
    try {
      await deleteVideo(req.params.id);
      res.json({ success: true, id: req.params.id });
    } catch (err) {
      const status = err.code === 'E_VIDEO_IN_USE' ? 409
        : err.code === 'E_NOT_FOUND' ? 404
        : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  // POST /api/videos/:id/select
  router.post('/:id/select', async (req, res) => {
    const videoId = req.params.id;
    const shouldRestart = req.query.restart === 'true';

    try {
      const state = getState();
      const isLive = state.status === 'RUNNING' || state.status === 'STARTING';

      if (isLive && !shouldRestart) {
        return res.status(409).json({
          error: 'Stream is currently live. Pass ?restart=true to switch active video with immediate restart.',
          code: 'E_STREAM_LIVE',
        });
      }

      const video = await setActiveVideo(videoId);

      if (isLive && shouldRestart) {
        logger.info('video.switch_restart', `Gracefully restarting stream onto new video ${videoId}`);
        await stopStream({ keepDesiredRunning: true, reason: 'switch_video_restart' });
        await startStream({ reason: 'switch_video_restart' });
      }

      res.json({ success: true, activeVideo: video });
    } catch (err) {
      const status = err.code === 'E_NOT_FOUND' ? 404 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  // POST /api/videos/:id/revalidate
  router.post('/:id/revalidate', async (req, res) => {
    try {
      const updated = await revalidateVideo(req.params.id);
      res.json({ success: true, video: updated });
    } catch (err) {
      const status = err.code === 'E_NOT_FOUND' ? 404 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  return router;
}
