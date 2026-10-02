/**
 * api/bandwidth.routes.js — Bandwidth metrics, manual offset adjustments, and safety unlock.
 */

import { Router } from 'express';
import { getBandwidthSummary } from '../bandwidth-monitor.js';
import {
  setManualOffsetBytes,
  setManualOciReported,
  getEffectiveUsedBytes,
  flushUsage,
} from '../usage-manager.js';
import { getSettings, saveSettings } from '../config-manager.js';
import { getState, saveState } from '../state-manager.js';
import { verifyPassword } from '../auth.js';
import { bytesToTB, tbToBytes } from '../bitrate-calculator.js';
import { logger } from '../logger.js';

export function createBandwidthRouter(envConfig) {
  const router = Router();
  const { adminPasswordHash } = envConfig;

  // GET /api/bandwidth
  router.get('/', async (req, res) => {
    try {
      const summary = await getBandwidthSummary();
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/bandwidth/adjust (PRD §7.3)
  router.post('/adjust', async (req, res) => {
    const { offsetBytes } = req.body || {};
    if (typeof offsetBytes !== 'number') {
      return res.status(400).json({ error: 'offsetBytes must be a number' });
    }

    setManualOffsetBytes(offsetBytes);
    await flushUsage({ force: true });
    logger.info('bandwidth.adjusted', `Manual bandwidth offset set to ${offsetBytes} bytes`);

    res.json({ success: true, effectiveUsedBytes: getEffectiveUsedBytes() });
  });

  // POST /api/bandwidth/manual-oci (PRD §7.3 P0)
  router.post('/manual-oci', async (req, res) => {
    const { ociGB } = req.body || {};
    if (typeof ociGB !== 'number' || ociGB < 0) {
      return res.status(400).json({ error: 'ociGB must be a non-negative number' });
    }

    setManualOciReported(ociGB);
    await flushUsage({ force: true });
    logger.info('bandwidth.manual_oci_updated', `Manual OCI reported bandwidth set to ${ociGB} GB`);

    res.json({ success: true, ociGB });
  });

  // POST /api/bandwidth/unlock (PRD §7.6)
  router.post('/unlock', async (req, res) => {
    const { password, newSafetyLimitTB } = req.body || {};

    if (!password || typeof password !== 'string') {
      return res.status(401).json({ error: 'Password is required to unlock bandwidth' });
    }

    const matches = await verifyPassword(password, adminPasswordHash);
    if (!matches) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    const currentUsed = getEffectiveUsedBytes();
    const settings = getSettings();
    const unitBase = settings.bandwidth?.unitBase ?? 1000;
    const currentUsedTB = bytesToTB(currentUsed, unitBase);

    // If a new limit was requested, validate and update it
    if (newSafetyLimitTB != null) {
      const newLimitTB = Number(newSafetyLimitTB);
      if (isNaN(newLimitTB) || newLimitTB <= currentUsedTB) {
        return res.status(400).json({
          error: `New safety limit (${newLimitTB} TB) must be greater than current usage (${currentUsedTB.toFixed(3)} TB)`,
          code: 'E_LIMIT_TOO_LOW',
        });
      }
      await saveSettings({ bandwidth: { safetyLimitTB: newLimitTB } });
    } else {
      // Must ensure current safety limit is already higher than usage
      const limitTB = settings.bandwidth?.safetyLimitTB ?? 9;
      if (limitTB <= currentUsedTB) {
        return res.status(400).json({
          error: `Cannot unlock without raising safetyLimitTB above current usage (${currentUsedTB.toFixed(3)} TB)`,
          code: 'E_LIMIT_TOO_LOW',
        });
      }
    }

    // Clear bandwidth lock in stream-state.json
    await saveState({
      status: 'STOPPED',
      bandwidthLock: { active: false },
    }, { forceBackup: true });

    logger.info('bandwidth.unlocked', 'Bandwidth safety lock released by administrator');
    res.json({ success: true, message: 'Bandwidth safety lock released' });
  });

  return router;
}
