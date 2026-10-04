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
import {
  startStream,
  stopStream,
  transitionState,
  triggerAutoRecycle,
  executeAutoResume,
  getAutoRecycleStatus,
} from './stream-manager.js';
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

/**
 * Calculate the next scheduled event (start or stop) and countdown.
 *
 * @param {Date} date
 * @param {Array<object>} windows
 * @param {string} timezone
 * @returns {object} Next event details
 */
export function getNextScheduleEvent(date, windows = [], timezone = 'Asia/Kolkata') {
  if (!Array.isArray(windows) || windows.length === 0) {
    return { hasEvent: false, label: 'No scheduled windows configured' };
  }

  const current = getLocalTimeInZone(date, timezone);
  const currentMins = current.minutes;
  const todayDay = current.dayOfWeek;
  const todayIdx = DAY_MAP.indexOf(todayDay);

  let bestDiff = Infinity;
  let nextEvt = null;

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const checkDay = DAY_MAP[(todayIdx + dayOffset) % 7];

    for (const win of windows) {
      const days = (win.days || []).map(d => d.toLowerCase());
      if (!days.includes(checkDay)) continue;

      const startMins = parseTimeToMinutes(win.start);
      const stopMins  = parseTimeToMinutes(win.stop);

      // Candidate 1: Window Start
      let diffStart = (dayOffset * 1440) + (startMins - currentMins);
      if (diffStart > 0 && diffStart < bestDiff) {
        bestDiff = diffStart;
        nextEvt = {
          type: 'start',
          timeStr: win.start,
          day: checkDay,
          inMinutes: diffStart,
          label: `Starts at ${win.start} IST (${checkDay.toUpperCase()})`,
        };
      }

      // Candidate 2: Window Stop
      let diffStop = (dayOffset * 1440) + (stopMins - currentMins);
      if (diffStop > 0 && diffStop < bestDiff) {
        bestDiff = diffStop;
        nextEvt = {
          type: 'stop',
          timeStr: win.stop,
          day: checkDay,
          inMinutes: diffStop,
          label: `Ends at ${win.stop} IST (${checkDay.toUpperCase()})`,
        };
      }
    }

    if (nextEvt && dayOffset > 0) break; // Found nearest upcoming event
  }

  return nextEvt ? { hasEvent: true, ...nextEvt } : { hasEvent: false, label: 'No upcoming events' };
}

/**
 * Return live scheduler status snapshot for API & UI.
 *
 * @param {Date} [now=new Date()]
 * @returns {object}
 */
export function getSchedulerStatus(now = new Date()) {
  const settings = getSettings();
  const state    = getState();

  const mode = settings.scheduler?.mode || 'continuous';
  const tz   = settings.scheduler?.timezone || 'Asia/Kolkata';
  const windows = settings.scheduler?.windows || [];
  const autoRecycle = settings.scheduler?.autoRecycle || { enabled: false, maxSessionHours: 8, pauseMinutes: 60, resumeBookmark: true };

  const currentLocal = getLocalTimeInZone(now, tz);
  const inside = isInsideWindow(now, windows, tz);
  const nextEvent = getNextScheduleEvent(now, windows, tz);

  const autoRecycleStatus = getAutoRecycleStatus(now);

  let recycleState = null;
  if (state.recyclingUntil) {
    const untilMs = new Date(state.recyclingUntil).getTime();
    const remainingMins = Math.max(0, Math.ceil((untilMs - now.getTime()) / 60000));
    const remainingSec = Math.max(0, Math.ceil((untilMs - now.getTime()) / 1000));
    recycleState = {
      isRecycling: true,
      until: state.recyclingUntil,
      remainingMinutes: remainingMins,
      remainingSec,
      formatted: autoRecycleStatus.nextStreamFormatted,
      label: `AUTO-RECYCLE PAUSE: Next stream in ${autoRecycleStatus.nextStreamFormatted || `${remainingMins}m`}`,
    };
  }

  // Format 12-hour IST Clock string
  const h12 = currentLocal.hour % 12 || 12;
  const ampm = currentLocal.hour >= 12 ? 'PM' : 'AM';
  const minPad = String(currentLocal.minute).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  const clockStr = `${h12}:${minPad}:${sec} ${ampm} IST`;

  return {
    mode,
    timezone: tz,
    clockStr,
    hour: currentLocal.hour,
    minute: currentLocal.minute,
    dayOfWeek: currentLocal.dayOfWeek,
    insideWindow: inside,
    windows,
    autoRecycle,
    autoRecycleStatus,
    recycleState,
    nextEvent,
    status: state.status,
  };
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
  const windows = settings.scheduler?.windows || [];
  const autoRecycle = settings.scheduler?.autoRecycle || { enabled: false, maxSessionHours: 8, pauseMinutes: 60, resumeBookmark: true };

  if (mode === 'manual') {
    return { mode: 'manual' };
  }

  // Check VOD recycle pause state
  if (state.recyclingUntil) {
    const untilMs = new Date(state.recyclingUntil).getTime();
    if (now.getTime() < untilMs) {
      const remainingMins = Math.ceil((untilMs - now.getTime()) / 60000);
      logger.debug('scheduler.recycling_wait', `In auto-recycle pause; resuming in ${remainingMins}m`);
      return { mode, recycling: true, remainingMins };
    } else {
      logger.info('scheduler.auto_recycle_pause_complete', 'Auto-recycle pause completed; triggering auto-resume');
      await executeAutoResume();
      return { mode, recycling: false };
    }
  }

  if (mode === 'continuous') {
    // Check autoRecycle max duration in continuous mode as safety watchdog
    if (autoRecycle.enabled && state.status === 'RUNNING' && state.streamStartedAt) {
      const startedMs = new Date(state.streamStartedAt).getTime();
      const elapsedMins = (now.getTime() - startedMs) / 60000;
      const limitMins = autoRecycle.maxSessionMinutes || (autoRecycle.maxSessionHours ? autoRecycle.maxSessionHours * 60 : 480);

      if (elapsedMins >= limitMins) {
        logger.info('scheduler.auto_recycle_triggered', `Watchdog detected session limit reached (${elapsedMins.toFixed(1)}m >= ${limitMins}m); invoking triggerAutoRecycle`);
        await triggerAutoRecycle();
        return { mode: 'continuous', autoRecycleTriggered: true };
      }
    }

    // Continuous mode: if stopped or scheduled (and not in recycle pause) but desired is running
    if (state.desiredState === 'running' && (state.status === 'STOPPED' || state.status === 'SCHEDULED') && !state.recyclingUntil) {
      logger.info('scheduler.continuous_start', `Continuous mode active (status=${state.status}); initiating stream start`);
      const res = await startStream({ reason: 'scheduler.continuous' });
      if (!res.started) {
        logger.warn('scheduler.continuous_start_failed', `Continuous mode start failed: ${res.message} (${res.code})`);
      }
    }
    return { mode: 'continuous' };
  }

  if (mode === 'scheduled') {
    const inside = isInsideWindow(now, windows, tz);

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
