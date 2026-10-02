/**
 * api/system.routes.js — System metrics, disk usage, and application log viewer.
 */

import { Router } from 'express';
import fs from 'node:fs/promises';
import { getSystemSnapshot } from '../system-monitor.js';
import { redact } from '../lib/redact.js';
import PATHS from '../lib/paths.js';

export function createSystemRouter() {
  const router = Router();

  // GET /api/system
  router.get('/', async (req, res) => {
    try {
      const snapshot = await getSystemSnapshot();
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/logs (PRD §20)
  router.get('/logs', async (req, res) => {
    const limit = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 100));
    try {
      let raw = '';
      try {
        raw = await fs.readFile(PATHS.appLog, 'utf8');
      } catch {
        raw = '';
      }

      const allLines = raw.split('\n').filter(l => l.trim().length > 0);
      const recent = allLines.slice(-limit).map(line => {
        try {
          const parsed = JSON.parse(line);
          return parsed;
        } catch {
          return { raw: redact(line) };
        }
      });

      res.json({
        totalLines: allLines.length,
        lines: recent,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
