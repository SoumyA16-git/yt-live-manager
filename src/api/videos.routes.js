/**
 * api/videos.routes.js — Video library management and streaming multipart upload with busboy.
 */

import { Router } from 'express';
import busboy from 'busboy';
import {
  listVideos,
  getVideo,
  deleteVideo,
  setActiveVideo,
  revalidateVideo,
  processUpload,
} from '../video-manager.js';
import { getState } from '../state-manager.js';
import { stopStream, startStream } from '../stream-manager.js';
import { getSettings } from '../config-manager.js';
import { logger } from '../logger.js';

export function createVideosRouter() {
  const router = Router();

  // GET /api/videos
  router.get('/', async (req, res) => {
    try {
      const videos = await listVideos();
      const activeVideoId = getSettings().stream?.videoId || getState().activeVideoId || null;
      res.json({ videos, activeVideoId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

    bb.on('file', (name, fileStream, info) => {
      fileHandled = true;
      const { filename, mimeType } = info;
      const contentLength = parseInt(req.headers['content-length'], 10) || 0;

      uploadPromise = processUpload(fileStream, {
        filename,
        mimeType,
        sizeBytes: contentLength,
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

        // If stream is actively live, seamlessly restart onto newly uploaded video
        const state = getState();
        const isLive = state.status === 'RUNNING' || state.status === 'STARTING';
        if (isLive) {
          logger.info('video.upload_restart', `Stream is active; switching stream onto new upload ${videoMeta.id}`);
          await stopStream({ keepDesiredRunning: true, reason: 'upload_video_rotation' });
          await startStream({ reason: 'upload_video_rotation' });
        }

        res.status(201).json({ success: true, video: videoMeta, autoSelected: true });
      } catch (err) {
        const status = err.code === 'E_DISK_LOW' ? 507
          : err.code === 'E_INVALID_EXTENSION' ? 415
          : err.code === 'E_VIDEO_UNSUPPORTED' ? 422
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
