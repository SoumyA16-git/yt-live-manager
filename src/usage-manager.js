/**
 * usage-manager.js — Byte accounting, period rollover, and usage persistence.
 *
 * PRD §7.2, §7.7, §18:
 * - Primary counter: FFmpeg progress deltas (total_size).
 * - Fallback counter: time × bitrate when progress missing > 15 s.
 * - Accounting period: derived from wall clock + configured resetDay/resetHour/timezone.
 * - Monotonic rollover guard (prevents double-reset on backward clock jump).
 * - Clock sanity check vs. lastSeenAt (> 1 h backward jump flags E_CLOCK).
 * - Atomic persistence to data/bandwidth-usage.json (throttled 30 s default).
 * - History capped at 12 closed periods.
 */

import { readJSON, writeJSON, writeBackup, listBackups } from './lib/atomic-json.js';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

const SCHEMA_VERSION = 1;
const MAX_HISTORY = 12;

// ─── Period Calculation Helper (PRD §7.7) ────────────────────────────────────

/**
 * Compute the accounting period ID and period start boundary for a given timestamp.
 * Formula: YYYY-MM in accounting_tz after offsetting for resetDay / resetHour.
 *
 * @param {Date} date
 * @param {object} accountingCfg
 * @param {number} [accountingCfg.resetDay=1]
 * @param {number} [accountingCfg.resetHour=0]
 * @param {string} [accountingCfg.timezone='UTC']
 * @returns {{ periodId: string, periodStart: string }}
 */
export function computePeriodInfo(date, accountingCfg = {}) {
  const resetDay  = accountingCfg.resetDay  ?? 1;
  const resetHour = accountingCfg.resetHour ?? 0;
  const tz        = accountingCfg.timezone  || 'UTC';

  // Format date parts in target timezone
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
  let year  = parseInt(parts.year, 10);
  let month = parseInt(parts.month, 10); // 1-12
  const day   = parseInt(parts.day, 10);
  const hour  = parseInt(parts.hour, 10);

  // If before this month's reset point, the period belongs to the previous month
  if (day < resetDay || (day === resetDay && hour < resetHour)) {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }

  const mm = String(month).padStart(2, '0');
  const periodId = `${year}-${mm}`;

  // Period start representation (ISO format in local calendar equivalent)
  const periodStart = `${year}-${mm}-${String(resetDay).padStart(2, '0')}T${String(resetHour).padStart(2, '0')}:00:00Z`;

  return { periodId, periodStart };
}

// ─── Default Data Structure ──────────────────────────────────────────────────

function createDefaultUsage(periodId, periodStart) {
  return {
    schemaVersion:         SCHEMA_VERSION,
    periodId,
    periodStart,
    lastResetAt:           new Date().toISOString(),
    estimatedBytes:        0,
    overheadBytes:         0,
    streamingSeconds:      0,
    alertsFired:           [],
    manualOffsetBytes:     0,
    manualOciReportedGB:   null,
    manualOciReportedAt:   null,
    hostTxBytesThisPeriod: null,
    history:               [],
  };
}

// ─── Module State ────────────────────────────────────────────────────────────

let _usage       = null;
let _lastTotalSize = null;
let _dirty       = false;
let _lastSaveAt  = 0;
let _lastBkAt    = 0;

let _usagePath   = PATHS.bandwidthUsage;
let _backupDir   = PATHS.backups;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load bandwidth usage from disk. If absent or corrupt, initializes with
 * computed period for current time.
 *
 * @param {object} accountingCfg
 * @param {Date}   [now=new Date()]
 */
export async function loadUsage(accountingCfg = {}, now = new Date()) {
  const backups = await listBackups(_backupDir, 'bandwidth-usage');
  const { data, source } = await readJSON(_usagePath, backups, null);

  const { periodId, periodStart } = computePeriodInfo(now, accountingCfg);

  if (!data) {
    _usage = createDefaultUsage(periodId, periodStart);
    logger.info('usage.initialized', `Initialized new bandwidth usage for period ${periodId}`);
  } else {
    if (source === 'backup') {
      logger.warn('usage.restored_from_backup', 'Restored bandwidth-usage.json from backup');
    }
    _usage = {
      ...createDefaultUsage(periodId, periodStart),
      ...data,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  _lastTotalSize = null;
  _dirty = false;
  return getUsage();
}

/**
 * Reset FFmpeg baseline tracker (call when a new FFmpeg process starts).
 */
export function resetProcessBaseline() {
  _lastTotalSize = null;
}

/**
 * Record byte progress from FFmpeg -progress total_size emission.
 *
 * @param {number} totalSize
 * @param {number} deltaSeconds
 * @param {number} [overheadPercent=10]
 */
export function recordProgressBytes(totalSize, deltaSeconds = 0, overheadPercent = 10) {
  if (!_usage) return;
  const current = Number(totalSize) || 0;

  if (_lastTotalSize === null) {
    _lastTotalSize = current;
    return;
  }

  if (current >= _lastTotalSize) {
    const delta = current - _lastTotalSize;
    _usage.estimatedBytes += delta;
    _usage.overheadBytes += Math.round(delta * (overheadPercent / 100));
  } else {
    // Process restarted or counter wrapped; reset baseline
    logger.debug('usage.baseline_reset', 'FFmpeg total_size decreased, resetting baseline');
  }

  _lastTotalSize = current;
  if (deltaSeconds > 0) {
    _usage.streamingSeconds += deltaSeconds;
  }
  _dirty = true;
}

/**
 * Fallback: record estimated bytes from bitrate * elapsed when progress is missing.
 *
 * @param {number} bytes
 * @param {number} deltaSeconds
 * @param {number} [overheadPercent=10]
 */
export function recordEstimatedBytes(bytes, deltaSeconds = 0, overheadPercent = 10) {
  if (!_usage) return;
  const b = Number(bytes) || 0;
  _usage.estimatedBytes += b;
  _usage.overheadBytes += Math.round(b * (overheadPercent / 100));
  if (deltaSeconds > 0) {
    _usage.streamingSeconds += deltaSeconds;
  }
  _dirty = true;
}

/**
 * Apply manual byte offset (/api/bandwidth/adjust).
 */
export function setManualOffsetBytes(offsetBytes) {
  if (!_usage) return;
  _usage.manualOffsetBytes = Math.round(Number(offsetBytes) || 0);
  _dirty = true;
}

/**
 * Set manual OCI reported usage.
 */
export function setManualOciReported(gb, at = new Date().toISOString()) {
  if (!_usage) return;
  _usage.manualOciReportedGB = Number(gb) || 0;
  _usage.manualOciReportedAt = at;
  _dirty = true;
}

/**
 * Record that an alert threshold has fired in the current period.
 */
export function markAlertFired(threshold) {
  if (!_usage) return;
  if (!_usage.alertsFired.includes(threshold)) {
    _usage.alertsFired.push(threshold);
    _dirty = true;
  }
}

/**
 * Return in-memory snapshot of bandwidth usage.
 */
export function getUsage() {
  if (!_usage) throw new Error('usage-manager: usage not loaded');
  return JSON.parse(JSON.stringify(_usage));
}

/**
 * Return total effective used bytes:
 * estimatedBytes + overheadBytes + manualOffsetBytes.
 */
export function getEffectiveUsedBytes() {
  if (!_usage) return 0;
  const raw = (_usage.estimatedBytes || 0) + (_usage.overheadBytes || 0) + (_usage.manualOffsetBytes || 0);
  return Math.max(0, raw);
}

/**
 * Return pure raw publisher output bytes (excluding overhead and manual offsets).
 */
export function getRawUsedBytes() {
  if (!_usage) return 0;
  return Math.max(0, _usage.estimatedBytes || 0);
}

/**
 * Evaluates whether period rollover should occur (PRD §7.7).
 * Rollover triggers when computed periodId > stored periodId.
 *
 * @param {object} accountingCfg
 * @param {Date}   [now=new Date()]
 * @param {string} [lastSeenAt=null]
 * @returns {{ rolledOver: boolean, oldPeriodId?: string, newPeriodId?: string, clockError?: boolean }}
 */
export async function evaluatePeriodRollover(accountingCfg = {}, now = new Date(), lastSeenAt = null) {
  if (!_usage) return { rolledOver: false };

  // Clock sanity check (PRD §7.7): backward jump > 1 h vs lastSeenAt
  if (lastSeenAt) {
    const lastSeenMs = new Date(lastSeenAt).getTime();
    if (!isNaN(lastSeenMs) && now.getTime() < lastSeenMs - 3600_000) {
      logger.error('usage.clock_error', 'System clock appears wrong (behind lastSeenAt by > 1 h)');
      return { rolledOver: false, clockError: true };
    }
  }

  const { periodId: nextPeriodId, periodStart: nextPeriodStart } = computePeriodInfo(now, accountingCfg);
  const currentPeriodId = _usage.periodId;

  // Monotonic guard: rollover only if nextPeriodId > currentPeriodId
  if (nextPeriodId !== currentPeriodId && nextPeriodId > currentPeriodId) {
    logger.info('bandwidth.period_reset', `Rolling over bandwidth period from ${currentPeriodId} to ${nextPeriodId}`);

    // Archive current period into history
    const archive = {
      periodId:         currentPeriodId,
      periodStart:      _usage.periodStart,
      periodEnd:        now.toISOString(),
      estimatedBytes:   _usage.estimatedBytes,
      overheadBytes:    _usage.overheadBytes,
      totalBytes:       getEffectiveUsedBytes(),
      streamingSeconds: _usage.streamingSeconds,
      manualOffsetBytes: _usage.manualOffsetBytes,
    };

    const history = [archive, ...(_usage.history || [])].slice(0, MAX_HISTORY);

    // Reset current counters
    _usage.periodId          = nextPeriodId;
    _usage.periodStart        = nextPeriodStart;
    _usage.lastResetAt       = now.toISOString();
    _usage.estimatedBytes    = 0;
    _usage.overheadBytes     = 0;
    _usage.streamingSeconds  = 0;
    _usage.alertsFired       = [];
    _usage.manualOffsetBytes = 0;
    _usage.history           = history;
    _lastTotalSize           = null;
    _dirty                   = true;

    await flushUsage({ forceBackup: true });

    return {
      rolledOver: true,
      oldPeriodId: currentPeriodId,
      newPeriodId: nextPeriodId,
    };
  }

  return { rolledOver: false };
}

/**
 * Flush in-memory usage to disk atomically.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.force=false]
 * @param {boolean} [opts.forceBackup=false]
 */
export async function flushUsage({ force = false, forceBackup = false } = {}) {
  if (!_usage || (!_dirty && !force)) return;

  const now = Date.now();
  const throttleMs = 3600 * 1000;
  const doBackup = forceBackup || (now - _lastBkAt >= throttleMs);

  const backupFn = doBackup ? async () => {
    await writeBackup(_usagePath, _backupDir, _usage, { keep: 20 });
    _lastBkAt = Date.now();
  } : undefined;

  await writeJSON(_usagePath, _usage, { mode: 0o600, backupFn });
  _dirty = false;
  _lastSaveAt = now;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

export function _setPathsForTest(usagePath, backupDir) {
  _usagePath     = usagePath;
  _backupDir     = backupDir;
  _usage         = null;
  _lastTotalSize = null;
  _dirty         = false;
  _lastSaveAt    = 0;
  _lastBkAt      = 0;
}
