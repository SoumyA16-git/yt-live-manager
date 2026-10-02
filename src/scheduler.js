/**
 * scheduler.js — Lightweight in-process scheduler.
 *
 * PRD §11:
 * - Modes: continuous, scheduled, manual.
 * - Ticks every 15 s (no cron dependency).
 * - Window evaluation via Intl.DateTimeFormat in configured timezone.
 * - Supports overnight windows (start > stop, e.g. 22:00 → 02:00).
 * - Transitions: window open → startStream, window close → stopStream & state SCHEDULED.
 */

import { getSettings } from './config-manager.js';
import { getState, saveState } from './state-manager.js';
import { startStream, stopStream } from './stream-manager.js';
import { logger } from './logger.js';

// ─── Window Evaluation Helpers ────────────────────────────────────────────────

const DAY_MAP = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Extract local day (mon..sun) and minutes from midnight (0..1439) in target timezone.
 *
 * @param {Date} date
 * @param {string} timezone
 * @returns {{ dayOfWeek: string, minutes: number, dateStr: string }}
 */
export function getLocalTimeInZone(date, timezone = 'Asia/Kolkata') {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
  const dayOfWeek = (parts.weekday || 'mon').toLowerCase().slice(0, 3);
  const hour = parseInt(parts.hour, 10) || 0;
  const minute = parseInt(parts.minute, 10) || 0;
  const minutes = hour * 60 + minute;

  return { dayOfWeek, minutes, hour, minute };
}

function parseTimeToMinutes(str) {
  const [h, m] = str.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Check if a given date falls inside any of the configured scheduled windows.
 *
 * @param {Date} date
 * @param {Array<object>} windows
 * @param {string} timezone
 * @returns {boolean} True if inside active window
 */
export function isInsideWindow(date, windows = [], timezone = 'Asia/Kolkata') {
  if (!Array.isArray(windows) || windows.length === 0) return false;

  const current = getLocalTimeInZone(date, timezone);
  const todayDay = current.dayOfWeek;
  const currentMins = current.minutes;

  // Previous day of week for overnight window checks
  const todayIdx = DAY_MAP.indexOf(todayDay);
  const prevDay = DAY_MAP[(todayIdx + 6) % 7];

  for (const win of windows) {
    const days = (win.days || []).map(d => d.toLowerCase());
    const startMins = parseTimeToMinutes(win.start);
    const stopMins  = parseTimeToMinutes(win.stop);

    if (startMins <= stopMins) {
      // Normal intraday window (e.g. 06:00 → 23:30)
      if (days.includes(todayDay)) {
        if (currentMins >= startMins && currentMins < stopMins) {
          return true;
        }
      }
    } else {
      // Overnight window (e.g. 22:00 → 02:00)
      // Portion 1: Same day on/after start (e.g. >= 22:00 on start day)
      if (days.includes(todayDay) && currentMins >= startMins) {
        return true;
      }
      // Portion 2: Next day before stop (e.g. < 02:00 on day following start day)
      if (days.includes(prevDay) && currentMins < stopMins) {
        return true;
      }
    }
  }

  return false;
}

// ─── Scheduler Loop ───────────────────────────────────────────────────────────

let _timer = null;
let _wasInsideWindow = null;

/**
 * Execute one tick of the scheduler.
 *
 * @param {Date} [now=new Date()]
 */
export async function tickScheduler(now = new Date()) {
  const settings = getSettings();
  const state    = getState();

  const mode = settings.scheduler?.mode || 'continuous';
  const tz   = settings.scheduler?.timezone || 'Asia/Kolkata';

  if (mode === 'manual') {
    // Manual mode: scheduler takes no action
    return { mode: 'manual' };
  }

  if (mode === 'continuous') {
    // Continuous mode: if stopped but desired is running, start
    if (state.desiredState === 'running' && state.status === 'STOPPED') {
      logger.info('scheduler.continuous_start', 'Continuous mode active; initiating stream start');
      await startStream({ reason: 'scheduler.continuous' });
    }
    return { mode: 'continuous' };
  }

  if (mode === 'scheduled') {
    const inside = isInsideWindow(now, settings.scheduler?.windows || [], tz);

    if (inside) {
      // Window is open
      if (_wasInsideWindow === false || state.status === 'SCHEDULED' || state.status === 'STOPPED') {
        logger.info('scheduler.window_opened', 'Scheduled window opened; starting stream');
        _wasInsideWindow = true;
        await startStream({ reason: 'scheduler.window_opened' });
      }
    } else {
      // Window is closed
      if (_wasInsideWindow === true || state.status === 'RUNNING' || state.status === 'STARTING') {
        logger.info('scheduler.window_closed', 'Scheduled window closed; stopping stream');
        _wasInsideWindow = false;
        await stopStream({ keepDesiredRunning: false, reason: 'scheduler.window_closed' });
        await saveState({ status: 'SCHEDULED' });
      } else if (state.status !== 'SCHEDULED' && state.status !== 'DISABLED' && state.status !== 'BANDWIDTH_LIMIT_REACHED') {
        await saveState({ status: 'SCHEDULED' });
      }
    }

    return { mode: 'scheduled', insideWindow: inside };
  }

  return { mode };
}

/**
 * Start recurring 15 s scheduler tick.
 */
export function startScheduler() {
  if (_timer) return;
  _timer = setInterval(async () => {
    try {
      await tickScheduler(new Date());
    } catch (err) {
      logger.error('scheduler.tick_error', err.message);
    }
  }, 15000);
  logger.info('scheduler.started', 'Scheduler tick loop started (15s interval)');
}

/**
 * Stop scheduler recurring tick.
 */
export function stopScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('scheduler.stopped', 'Scheduler tick loop stopped');
  }
}
