/**
 * api/scheduler.routes.js — Live scheduler status and configuration endpoints.
 */

import { Router } from 'express';
import { getSchedulerStatus, tickScheduler } from '../scheduler.js';
import { saveSettings } from '../config-manager.js';
import { validateSettings } from '../lib/validate.js';
import { logger } from '../logger.js';

export function createSchedulerRouter() {
  const router = Router();

  // GET /api/scheduler
  router.get('/', (req, res) => {
    try {
      const status = getSchedulerStatus(new Date());
      res.json(status);
    } catch (err) {
      logger.error('scheduler.status_error', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/scheduler
  router.put('/', async (req, res) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'Request body must be an object' });
    }

    const { valid, errors } = validateSettings({ scheduler: patch }, { partial: true });
    if (!valid) {
      return res.status(400).json({ error: 'Scheduler validation failed', errors });
    }

    try {
      await saveSettings({ scheduler: patch });
      await tickScheduler(new Date());
      const updatedStatus = getSchedulerStatus(new Date());
      res.json({ success: true, scheduler: updatedStatus });
    } catch (err) {
      logger.error('scheduler.save_error', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
