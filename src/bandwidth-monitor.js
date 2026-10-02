/**
 * bandwidth-monitor.js — Threshold evaluation, alerts, forecasting, and safety lock.
 *
 * PRD §7.1, §7.3, §7.5, §7.6, §7.8:
 * - Evaluates current usage against safety limit and warning thresholds.
 * - Triggers safety lock when effective usage reaches 100% of safety limit.
 * - Computes consumption forecasts (daily average, safe remaining hours/days, projected 30-day).
 * - Compares App estimate vs. OCI-reported usage if available and fresh.
 */

import { getUsage, getEffectiveUsedBytes, markAlertFired, flushUsage } from './usage-manager.js';
import { getSettings, getSafetyLimitBytes, getMonthlyAllowanceBytes } from './config-manager.js';
import { getState, saveState } from './state-manager.js';
import { calculateBitrateMetrics, bytesToGB, gbToBytes } from './bitrate-calculator.js';
import { logger } from './logger.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getAlertLevelName(pct) {
  if (pct >= 100) return 'limit';
  if (pct >= 95)  return 'critical-protection';
  if (pct >= 90)  return 'critical';
  if (pct >= 80)  return 'warning-strong';
  if (pct >= 70)  return 'warning';
  return 'normal';
}

/**
 * Check if OCI reported usage is fresh enough to be authoritative.
 */
function isOciFresh(manualOciReportedAt, maxAgeHours = 24, now = new Date()) {
  if (!manualOciReportedAt) return false;
  const reportedTime = new Date(manualOciReportedAt).getTime();
  if (isNaN(reportedTime)) return false;
  const ageMs = now.getTime() - reportedTime;
  return ageMs >= 0 && ageMs <= maxAgeHours * 3600 * 1000;
}

// ─── Evaluation & Safety Lock ────────────────────────────────────────────────

/**
 * Evaluate current bandwidth usage against thresholds and safety limit.
 * If >= 100%, invokes onLimitReached callback (which triggers stream-manager stop).
 *
 * @param {object}   [opts]
 * @param {Date}     [opts.now=new Date()]
 * @param {Function} [opts.onLimitReached]  Async callback called when lock trips.
 * @returns {Promise<object>} Evaluation result.
 */
export async function evaluateBandwidth({ now = new Date(), onLimitReached = null } = {}) {
  const settings = getSettings();
  const usage    = getUsage();
  const limitBytes = getSafetyLimitBytes();
  const allowanceBytes = getMonthlyAllowanceBytes();

  const appBytes = getEffectiveUsedBytes();
  let authoritativeBytes = appBytes;
  let sourceDriven = 'app';

  // OCI reported check (PRD §7.3)
  if (settings.bandwidth?.oci?.enabled && usage.manualOciReportedGB != null) {
    if (isOciFresh(usage.manualOciReportedAt, settings.bandwidth.oci.maxAgeHours, now)) {
      const ociBytes = gbToBytes(usage.manualOciReportedGB, settings.bandwidth.unitBase);
      if (ociBytes > appBytes) {
        authoritativeBytes = ociBytes;
        sourceDriven = 'oci';
      }
    }
  }

  const pctOfSafety    = limitBytes > 0 ? (authoritativeBytes / limitBytes) * 100 : 0;
  const pctOfAllowance = allowanceBytes > 0 ? (authoritativeBytes / allowanceBytes) * 100 : 0;
  const alertLevel     = getAlertLevelName(pctOfSafety);

  // Check editable warning thresholds (PRD §7.5)
  const thresholds = settings.bandwidth?.warningThresholds ?? [70, 80, 90, 95];
  for (const t of thresholds) {
    if (pctOfSafety >= t && !usage.alertsFired.includes(t)) {
      markAlertFired(t);
      logger.warn('bandwidth.warning', `Bandwidth reached ${t}% of safety limit (${pctOfSafety.toFixed(1)}%)`, {
        threshold: t,
        pctOfSafety: Number(pctOfSafety.toFixed(1)),
        usedBytes: authoritativeBytes,
        limitBytes,
        source: sourceDriven,
      });
    }
  }

  // 100% Safety Limit Lock (PRD §7.6)
  let lockTriggered = false;
  if (pctOfSafety >= 100) {
    const currentState = getState();
    if (!currentState.bandwidthLock?.active) {
      lockTriggered = true;
      logger.error('bandwidth.limit_reached', 'Monthly bandwidth safety limit reached. Engaging safety lock.', {
        usedBytes: authoritativeBytes,
        limitBytes,
        pct: Number(pctOfSafety.toFixed(1)),
        periodId: usage.periodId,
        source: sourceDriven,
      });

      // Persist lock immediately in stream-state.json
      await saveState({
        status: 'BANDWIDTH_LIMIT_REACHED',
        desiredState: 'stopped',
        bandwidthLock: {
          active: true,
          since: now.toISOString(),
          periodId: usage.periodId,
          usedBytes: authoritativeBytes,
          limitBytes,
          source: sourceDriven,
        },
      }, { forceBackup: true });

      await flushUsage({ force: true, forceBackup: true });

      if (typeof onLimitReached === 'function') {
        try {
          await onLimitReached({
            periodId: usage.periodId,
            usedBytes: authoritativeBytes,
            limitBytes,
          });
        } catch (err) {
          logger.error('bandwidth.lock_callback_error', err.message);
        }
      }
    }
  }

  return {
    usedBytes: authoritativeBytes,
    appEstimateBytes: appBytes,
    sourceDriven,
    limitBytes,
    allowanceBytes,
    pctOfSafety: Number(pctOfSafety.toFixed(2)),
    pctOfAllowance: Number(pctOfAllowance.toFixed(2)),
    alertLevel,
    lockTriggered,
  };
}

// ─── Forecasting (PRD §7.8) ──────────────────────────────────────────────────

/**
 * Compute bandwidth forecasts for dashboard and API.
 *
 * @param {Date} [now=new Date()]
 * @returns {object}
 */
export function computeBandwidthForecast(now = new Date()) {
  const settings = getSettings();
  const usage    = getUsage();
  const limitBytes = getSafetyLimitBytes();
  const unitBase = settings.bandwidth?.unitBase ?? 1000;
  const effectiveUsed = getEffectiveUsedBytes();

  // Metrics based on current stream bitrate settings
  const metrics = calculateBitrateMetrics({
    videoBitrateMbps: settings.stream?.videoBitrateMbps ?? 8,
    audioBitrateKbps: settings.stream?.audioBitrateKbps ?? 128,
    overheadPercent:  settings.bandwidth?.overheadPercent ?? 10,
    unitBase,
  });

  const gbPerHourWithOverhead = metrics.withOverhead.gbPerHour;
  const gbPerDayWithOverhead  = metrics.withOverhead.gbPerDay;

  // Elapsed time in period
  const periodStartMs = new Date(usage.periodStart).getTime();
  const nowMs = now.getTime();
  const elapsedMs = Math.max(nowMs - periodStartMs, 3600 * 1000); // minimum 1 h clamp
  const elapsedDays = elapsedMs / (24 * 3600 * 1000);

  const usedGB = bytesToGB(effectiveUsed, unitBase);
  const limitGB = bytesToGB(limitBytes, unitBase);

  // currentMonthlyAverageGBPerDay
  const currentMonthlyAverageGBPerDay = usedGB / elapsedDays;

  // Remaining days in month approximation (assuming ~30-day period)
  const remainingDaysInPeriod = Math.max(0, 30 - elapsedDays);
  const remainingHoursInPeriod = remainingDaysInPeriod * 24;

  // projected30DayUsage: used + rateWithOverhead × remainingStreamingHoursInPeriod
  const projected30DayUsageGB = usedGB + (gbPerHourWithOverhead * remainingHoursInPeriod);

  // remainingSafeGB = limit - used
  const remainingSafeGB = Math.max(0, limitGB - usedGB);
  const remainingSafeHours = gbPerHourWithOverhead > 0 ? remainingSafeGB / gbPerHourWithOverhead : 0;
  const remainingSafeDays  = remainingSafeHours / 24;

  let projectedLimitReachedAt = null;
  if (remainingSafeHours < remainingHoursInPeriod && remainingSafeHours > 0) {
    projectedLimitReachedAt = new Date(nowMs + remainingSafeHours * 3600 * 1000).toISOString();
  }

  return {
    usedGB: Number(usedGB.toFixed(3)),
    limitGB: Number(limitGB.toFixed(3)),
    currentMonthlyAverageGBPerDay: Number(currentMonthlyAverageGBPerDay.toFixed(2)),
    projected30DayUsageGB: Number(projected30DayUsageGB.toFixed(2)),
    remainingSafeGB: Number(remainingSafeGB.toFixed(2)),
    remainingSafeHours: Number(remainingSafeHours.toFixed(1)),
    remainingSafeDays: Number(remainingSafeDays.toFixed(1)),
    projectedLimitReachedAt,
    summarySentence: `At current bitrate, estimated safe remaining streaming time: ${remainingSafeHours.toFixed(0)} hours (≈ ${remainingSafeDays.toFixed(1)} days).`,
  };
}

/**
 * Full summary representation for GET /api/bandwidth
 */
export async function getBandwidthSummary(now = new Date()) {
  const evalResult = await evaluateBandwidth({ now });
  const forecast   = computeBandwidthForecast(now);
  const usage      = getUsage();
  const settings   = getSettings();

  return {
    ...evalResult,
    periodId: usage.periodId,
    periodStart: usage.periodStart,
    streamingSeconds: usage.streamingSeconds,
    manualOffsetBytes: usage.manualOffsetBytes,
    manualOciReportedGB: usage.manualOciReportedGB,
    manualOciReportedAt: usage.manualOciReportedAt,
    forecast,
    history: usage.history || [],
    unitBase: settings.bandwidth?.unitBase ?? 1000,
  };
}
