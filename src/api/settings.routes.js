/**
 * api/settings.routes.js — Configuration management and secure key reveal.
 */

import { Router } from 'express';
import {
  getMaskedSettings,
  saveSettings,
  getStreamKey,
} from '../config-manager.js';
import { validateSettings } from '../lib/validate.js';
import { verifyPassword } from '../auth.js';
import { logger } from '../logger.js';

export function createSettingsRouter(envConfig) {
  const router = Router();
  const { adminPasswordHash } = envConfig;

  // Rate limiter for reveal-stream-key: 3 attempts per minute
  const _revealAttempts = [];

  // GET /api/settings
  router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getMaskedSettings());
  });

  // PUT /api/settings
  router.put('/', async (req, res) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }

    // Auto-upgrade rtmp:// to rtmps:// for YouTube ingestion (PRD §19.2)
    if (patch.youtube && typeof patch.youtube.rtmpsUrl === 'string') {
      let url = patch.youtube.rtmpsUrl.trim();
      if (url.startsWith('rtmp://')) {
        url = url.replace(/^rtmp:\/\/a\.rtmp\.youtube\.com/i, 'rtmps://a.rtmps.youtube.com:443')
                 .replace(/^rtmp:\/\/b\.rtmp\.youtube\.com/i, 'rtmps://b.rtmps.youtube.com:443')
                 .replace(/^rtmp:\/\//i, 'rtmps://');
        patch.youtube.rtmpsUrl = url;
      }
    }

    // If streamKey in patch is empty/blank, remove it so existing key is preserved
    if (patch.youtube && typeof patch.youtube.streamKey === 'string') {
      patch.youtube.streamKey = patch.youtube.streamKey.trim();
      if (patch.youtube.streamKey === '') {
        delete patch.youtube.streamKey;
      }
    } else if (patch.youtube && !patch.youtube.streamKey) {
      delete patch.youtube.streamKey;
    }

    const { requiresRestart } = validateSettings(patch, { partial: true });

    try {
      const updated = await saveSettings(patch);
      res.json({ success: true, settings: updated, requiresRestart: Boolean(requiresRestart) });
    } catch (err) {
      if (err.code === 'E_VALIDATION') {
        const errorDetail = err.errors && err.errors.length > 0 ? err.errors.join('; ') : err.message;
        return res.status(400).json({ error: errorDetail, code: err.code, errors: err.errors });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/settings/reveal-stream-key (PRD §12)
  router.post('/reveal-stream-key', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const now = Date.now();
    // Prune attempts older than 60s
    while (_revealAttempts.length > 0 && _revealAttempts[0] < now - 60000) {
      _revealAttempts.shift();
    }

    if (_revealAttempts.length >= 3) {
      return res.status(429).json({
        error: 'Too many reveal requests. Please wait a minute.',
        code: 'E_RATE_LIMIT',
      });
    }

    _revealAttempts.push(now);

    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(401).json({ error: 'Password is required to reveal stream key' });
    }

    const matches = await verifyPassword(password, adminPasswordHash);
    if (!matches) {
      logger.warn('settings.reveal_failed', 'Failed attempt to reveal stream key (invalid password)');
      return res.status(401).json({ error: 'Incorrect password', code: 'E_INVALID_CREDENTIALS' });
    }

    logger.info('settings.key_revealed', 'Admin revealed stream key');
    res.json({ streamKey: getStreamKey() });
  });

  return router;
}
