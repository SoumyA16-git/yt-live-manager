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

  // GET /api/logs (PRD §20 — Zero-bloat tail reader: max 16 KB from end of file)
  router.get('/logs', async (req, res) => {
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 40));
    try {
      let raw = '';
      let fh = null;
      try {
        fh = await fs.open(PATHS.appLog, 'r');
        const stat = await fh.stat();
        const readBytes = Math.min(stat.size, 16384);
        const buffer = Buffer.alloc(readBytes);
        await fh.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
        raw = buffer.toString('utf8');
      } catch {
        raw = '';
      } finally {
        if (fh) await fh.close();
      }

      const allLines = raw.split('\n').filter(l => l.trim().length > 0);
      const recent = allLines.slice(-limit).map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: redact(line) };
        }
      });

      res.json({
        totalLines: recent.length,
        lines: recent,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
