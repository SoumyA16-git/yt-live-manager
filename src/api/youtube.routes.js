/**
 * api/youtube.routes.js — YouTube template metadata management and synchronization routes.
 */

import { Router } from 'express';
import { getSettings, saveSettings, getMaskedSettings } from '../config-manager.js';
import {
  fetchVideoCategories,
  resolveCategoryName,
  fetchTemplateVideoMetadata,
} from '../youtube-api-manager.js';
import { logger } from '../logger.js';

export function createYouTubeRouter() {
  const router = Router();

  // GET /api/youtube/template — Fetch current YouTube template metadata configuration
  router.get('/template', (req, res) => {
    try {
      const settings = getSettings();
      const yt = settings.youtube || {};
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        templateVideoId: yt.templateVideoId || '',
        titleTemplate: yt.titleTemplate || 'Chinese Street Food Live Streaming Mochi "{DATE}" "{TIME}"',
        description: yt.description || '',
        categoryId: yt.categoryId || '',
        categoryName: yt.categoryName || '',
        tags: Array.isArray(yt.tags) ? yt.tags : [],
        thumbnail: yt.thumbnail || {
          sourceVideoId: '',
          sourceUrl: '',
          selectedResolution: '',
          customDataUrl: '',
        },
      });
    } catch (err) {
      logger.error('youtube_routes.get_template_failed', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/youtube/template — Save edited YouTube template metadata configuration
  router.put('/template', async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }

      // Title template always remains fixed to required format
      const DEFAULT_TITLE_TEMPLATE = 'Chinese Street Food Live Streaming Mochi "{DATE}" "{TIME}"';

      const patch = {};
      if (body.templateVideoId !== undefined) {
        patch.templateVideoId = String(body.templateVideoId).trim();
      }
      patch.titleTemplate = DEFAULT_TITLE_TEMPLATE;

      if (body.description !== undefined) {
        patch.description = String(body.description);
      }
      if (body.categoryId !== undefined) {
        patch.categoryId = String(body.categoryId);
      }
      if (body.categoryName !== undefined) {
        patch.categoryName = String(body.categoryName);
      }
      if (body.tags !== undefined) {
        patch.tags = Array.isArray(body.tags) ? body.tags.map(t => String(t).trim()).filter(Boolean) : [];
      }
      if (body.thumbnail !== undefined && typeof body.thumbnail === 'object') {
        patch.thumbnail = {
          sourceVideoId: String(body.thumbnail.sourceVideoId || ''),
          sourceUrl: String(body.thumbnail.sourceUrl || ''),
          selectedResolution: String(body.thumbnail.selectedResolution || ''),
          customDataUrl: String(body.thumbnail.customDataUrl || ''),
        };
      }

      await saveSettings({ youtube: patch });

      const updated = getSettings().youtube || {};
      res.json({
        success: true,
        metadata: {
          templateVideoId: updated.templateVideoId,
          titleTemplate: updated.titleTemplate,
          description: updated.description,
          categoryId: updated.categoryId,
          categoryName: updated.categoryName,
          tags: updated.tags,
          thumbnail: updated.thumbnail,
        },
      });
    } catch (err) {
      logger.error('youtube_routes.put_template_failed', err.message);
      res.status(400).json({ error: err.message, errors: err.errors });
    }
  });

  // POST /api/youtube/template/sync — Sync metadata from a YouTube video
  router.post('/template/sync', async (req, res) => {
    try {
      const { videoId } = req.body || {};
      if (!videoId || typeof videoId !== 'string') {
        return res.status(400).json({ error: 'Missing required field: videoId' });
      }

      logger.info('youtube_routes.sync_requested', `Sync requested for template video ID: ${videoId}`);
      const metadata = await fetchTemplateVideoMetadata(videoId.trim());

      res.json({
        success: true,
        metadata,
      });
    } catch (err) {
      logger.error('youtube_routes.sync_failed', `Failed to sync metadata for template video: ${err.message}`);
      res.status(err.status || 400).json({
        error: err.message,
        code: err.code || 'E_SYNC_FAILED',
        details: err.details,
      });
    }
  });

  // GET /api/youtube/categories — Get video categories for category dropdown
  router.get('/categories', async (req, res) => {
    try {
      const regionCode = req.query.regionCode ? String(req.query.regionCode).trim() : 'IN';
      const categories = await fetchVideoCategories(regionCode);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        success: true,
        categories,
      });
    } catch (err) {
      logger.error('youtube_routes.categories_failed', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
