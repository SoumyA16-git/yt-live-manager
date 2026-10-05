/**
 * api/youtube.routes.js — Deprecated stub. Application no longer manages YouTube metadata.
 */

import { Router } from 'express';

export function createYouTubeRouter() {
  const router = Router();
  router.all('*', (req, res) => {
    res.status(410).json({ error: 'YouTube Data API endpoints permanently removed' });
  });
  return router;
}
