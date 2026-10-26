/**
 * Daily YouTube download slots. Scheduled downloads call the same yt-dlp
 * pipeline as the dashboard's manual downloader and leave failed links queued.
 */

import crypto from 'node:crypto';
import { getSettings, saveSettings } from './config-manager.js';
import {
  getDownloadStatus,
  isValidYouTubeUrl,
  normalizeYouTubeUrl,
  startYouTubeDownload,
  cancelDownload,
  checkDuplicateYouTubeVideo,
} from './ytdlp-manager.js';
import { logger } from './logger.js';
import { getDiskMetrics } from './system-monitor.js';
import { sendDownloadCompletedEmail } from './email-alerts.js';
import { sendDownloadCompletedTelegram } from './telegram-alerts.js';

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  quality: '1080p',
  queues: { horizontal: [], vertical: [] },
  slots: [],
});

let _timer = null;
let _tickPromise = null;
let _stopping = false;
let _settingsQueue = Promise.resolve();
let _activeScheduledJob = null;
let _lastResult = null;
const _lastTriggeredDates = new Map();

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function configFromSettings() {
  const configured = getSettings().scheduledDownloads || {};
  return {
    ...copy(DEFAULT_CONFIG),
    ...copy(configured),
    queues: {
      horizontal: Array.isArray(configured.queues?.horizontal) ? copy(configured.queues.horizontal) : [],
      vertical: Array.isArray(configured.queues?.vertical) ? copy(configured.queues.vertical) : [],
    },
    slots: Array.isArray(configured.slots) ? copy(configured.slots) : [],
  };
}

function mutateConfig(mutator) {
  const operation = _settingsQueue.then(async () => {
    const current = configFromSettings();
    const next = await mutator(current);
    if (next === null) return current;
    await saveSettings({ scheduledDownloads: next });
    return copy(next);
  });
  _settingsQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function localClock(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function setSlotRunDate(slotId, date) {
  return mutateConfig(config => {
    const slot = config.slots.find(item => item.id === slotId);
    if (!slot || slot.lastRunDate === date) return null;
    slot.lastRunDate = date;
    return config;
  });
}

async function removeQueueItem(mode, linkId) {
  return mutateConfig(config => {
    const queue = config.queues[mode];
    const nextQueue = queue.filter(item => item.id !== linkId);
    if (nextQueue.length === queue.length) return null;
    config.queues[mode] = nextQueue;
    return config;
  });
}

function rememberResult(result) {
  _lastResult = { ...result, at: new Date().toISOString() };
}

function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

async function notifyScheduledDownloadCompleted(status) {
  let disk = null;
  try {
    disk = await getDiskMetrics();
  } catch (err) {
    logger.warn('scheduled_download.storage_check_failed', `Could not read remaining server storage: ${err.message}`);
  }

  const details = {
    videoTitle: status.videoTitle,
    videoId: status.videoId,
    mode: status.detectedMode,
    resolution: status.resolution,
    completedAt: status.completedAt,
    storageFree: disk?.totalBytes > 0 ? formatStorageBytes(disk.freeBytes) : 'Unavailable',
    storageTotal: disk?.totalBytes > 0 ? formatStorageBytes(disk.totalBytes) : '',
    storageUsedPercent: disk?.totalBytes > 0 ? disk.usedPercent : null,
  };

  void Promise.all([
    sendDownloadCompletedEmail(details),
    sendDownloadCompletedTelegram(details),
  ]).catch(err => {
    logger.warn('scheduled_download.notification_dispatch_failed', `Could not dispatch download completion notifications: ${err.message}`);
  });
}

async function onScheduledJobSettled(slot, link, status) {
  const successful = status?.stage === 'completed';
  try {
    if (successful) {
      await notifyScheduledDownloadCompleted(status);
      await removeQueueItem(slot.mode, link.id);
      logger.info('scheduled_download.link_removed', 'Scheduled YouTube link removed after the shared download and import pipeline completed', {
        slotId: slot.id,
        linkId: link.id,
        videoId: status.videoId,
        detectedMode: status.detectedMode,
      });
      rememberResult({
        status: 'completed',
        slotId: slot.id,
        linkId: link.id,
        videoTitle: status.videoTitle,
        detectedMode: status.detectedMode,
      });
    } else {
      const error = status?.error || (status?.stage === 'cancelled' ? 'Download cancelled' : 'Download did not complete');
      rememberResult({ status: status?.stage || 'error', slotId: slot.id, linkId: link.id, error });
      logger.warn('scheduled_download.failed', 'Scheduled YouTube download failed; the link remains queued', {
        slotId: slot.id,
        linkId: link.id,
        stage: status?.stage,
        error,
      });
    }
  } catch (err) {
    rememberResult({ status: 'error', slotId: slot.id, linkId: link.id, error: err.message });
    logger.error('scheduled_download.queue_update_failed', 'Could not update the scheduled download queue after its pipeline settled', {
      slotId: slot.id,
      linkId: link.id,
      error: err.message,
    });
  } finally {
    if (_activeScheduledJob?.linkId === link.id && _activeScheduledJob?.slotId === slot.id) {
      _activeScheduledJob = null;
    }
  }
}

async function tickScheduledDownloads(now = new Date()) {
  if (_stopping) return;
  if (_tickPromise) return _tickPromise;
  _tickPromise = (async () => {
    const config = configFromSettings();
    if (!config.enabled || _activeScheduledJob) return;

    const download = getDownloadStatus();
    if (download.active) return;

    const settings = getSettings();
    const timeZone = settings.scheduler?.timezone || 'Asia/Kolkata';
    let clock;
    try {
      clock = localClock(now, timeZone);
    } catch (err) {
      logger.error('scheduled_download.timezone_error', 'Could not evaluate scheduled download slots in the configured timezone', {
        timeZone,
        error: err.message,
      });
      return;
    }

    const dueSlots = config.slots
      .filter(slot => slot.enabled && slot.lastRunDate !== clock.date && _lastTriggeredDates.get(slot.id) !== clock.date && slot.time <= clock.time)
      .sort((a, b) => a.time.localeCompare(b.time));

    for (const slot of dueSlots) {
      // Keep FIFO order while allowing a slot to select only its configured type.
      const link = config.queues[slot.mode].find(item => item.videoType === slot.videoType);
      if (!link) continue;

      // A queued URL may have been downloaded manually since it was added.
      // Remove it and consider the next queued item on the next scheduler tick.
      try {
        _activeScheduledJob = {
          slotId: slot.id,
          linkId: link.id,
          mode: slot.mode,
          videoType: slot.videoType,
          url: link.url,
          startedAt: new Date().toISOString(),
        };
        logger.info('scheduled_download.triggered', 'Scheduled YouTube download triggered', {
          slotId: slot.id,
          scheduledTime: slot.time,
          timeZone,
          mode: slot.mode,
          videoType: slot.videoType,
          linkId: link.id,
          quality: config.quality,
        });

        await startYouTubeDownload(link.url, {
          autoSetActive: false,
          quality: config.quality,
          onSettled: status => onScheduledJobSettled(slot, link, status),
        });
        _lastTriggeredDates.set(slot.id, clock.date);
        rememberResult({ status: 'started', slotId: slot.id, linkId: link.id, videoType: slot.videoType });
        try {
          await setSlotRunDate(slot.id, clock.date);
        } catch (err) {
          logger.error('scheduled_download.run_date_save_failed', 'The download started but its slot run date could not be saved', {
            slotId: slot.id,
            linkId: link.id,
            error: err.message,
          });
        }
        return;
      } catch (err) {
        if (_activeScheduledJob?.linkId === link.id && _activeScheduledJob?.slotId === slot.id) {
          _activeScheduledJob = null;
        }

        if (err.code === 'E_JOB_RUNNING') {
          // A manual download won the race. Leave this slot due for the next tick.
          return;
        }

        if (err.code === 'E_DUPLICATE_VIDEO') {
          await removeQueueItem(slot.mode, link.id);
          logger.info('scheduled_download.duplicate_removed', 'Scheduled link was already present in the library and was removed from its queue', {
            slotId: slot.id,
            linkId: link.id,
            existingVideoId: err.existingVideo?.id || null,
          });
          rememberResult({ status: 'already_downloaded', slotId: slot.id, linkId: link.id });
          return;
        }

        _lastTriggeredDates.set(slot.id, clock.date);
        try {
          await setSlotRunDate(slot.id, clock.date);
        } catch (saveErr) {
          logger.error('scheduled_download.run_date_save_failed', 'Could not save the attempted slot date after the scheduled start failed', {
            slotId: slot.id,
            linkId: link.id,
            error: saveErr.message,
          });
        }
        rememberResult({ status: 'error', slotId: slot.id, linkId: link.id, error: err.message });
        logger.error('scheduled_download.start_failed', 'Could not start scheduled YouTube download; the link remains queued', {
          slotId: slot.id,
          linkId: link.id,
          code: err.code || null,
          error: err.message,
        });
        return;
      }
    }
  })().finally(() => { _tickPromise = null; });
  return _tickPromise;
}

export function getScheduledDownloadsConfig() {
  return configFromSettings();
}

export function getScheduledDownloadsStatus() {
  const config = configFromSettings();
  return {
    enabled: config.enabled,
    quality: config.quality,
    timezone: getSettings().scheduler?.timezone || 'Asia/Kolkata',
    queueCounts: {
      horizontal: config.queues.horizontal.length,
      vertical: config.queues.vertical.length,
    },
    activeJob: _activeScheduledJob ? { ..._activeScheduledJob } : null,
    download: getDownloadStatus(),
    lastResult: _lastResult ? { ..._lastResult } : null,
  };
}

export function updateScheduledDownloadsPreferences(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('Scheduled download settings must be an object'), { code: 'E_INVALID_SETTINGS' });
  }
  for (const key of Object.keys(patch)) {
    if (!['enabled', 'quality'].includes(key)) {
      throw Object.assign(new Error(`Unknown scheduled download setting: ${key}`), { code: 'E_INVALID_SETTINGS' });
    }
  }
  const { enabled, quality } = patch;
  return mutateConfig(config => {
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { code: 'E_INVALID_SETTINGS' });
      config.enabled = enabled;
    }
    if (quality !== undefined) {
      if (!['1080p', '720p', '480p'].includes(quality)) {
        throw Object.assign(new Error('quality must be 1080p, 720p, or 480p'), { code: 'E_INVALID_SETTINGS' });
      }
      config.quality = quality;
    }
    return config;
  });
}

export function addScheduledDownloadLink({ mode, url, videoType }) {
  return mutateConfig(async config => {
    if (!['horizontal', 'vertical'].includes(mode)) throw Object.assign(new Error('Choose a 16:9 or 9:16 queue'), { code: 'E_INVALID_MODE' });
    if (!['long', 'short'].includes(videoType)) throw Object.assign(new Error('Choose Long or Short video type'), { code: 'E_INVALID_VIDEO_TYPE' });
    if (!isValidYouTubeUrl(url)) throw Object.assign(new Error('Enter a supported YouTube video, Shorts, or live URL'), { code: 'E_INVALID_URL' });

    const normalizedUrl = normalizeYouTubeUrl(url);
    const duplicate = [...config.queues.horizontal, ...config.queues.vertical]
      .some(item => normalizeYouTubeUrl(item.url) === normalizedUrl);
    if (duplicate) throw Object.assign(new Error('This YouTube link is already in a scheduled queue'), { code: 'E_QUEUE_DUPLICATE' });

    const existingVideo = await checkDuplicateYouTubeVideo(normalizedUrl);
    if (existingVideo) {
      const existingName = existingVideo.label || existingVideo.originalName || existingVideo.id;
      throw Object.assign(new Error(`This video is already in your library: ${existingName}`), {
        code: 'E_LIBRARY_DUPLICATE',
        existingVideo,
      });
    }

    const item = { id: crypto.randomUUID(), url: normalizedUrl, videoType, addedAt: new Date().toISOString() };
    config.queues[mode].push(item);
    return config;
  });
}

export function deleteScheduledDownloadLink(mode, linkId) {
  if (!['horizontal', 'vertical'].includes(mode)) throw Object.assign(new Error('Invalid queue mode'), { code: 'E_INVALID_MODE' });
  return mutateConfig(config => {
    const queue = config.queues[mode];
    const nextQueue = queue.filter(item => item.id !== linkId);
    if (nextQueue.length === queue.length) throw Object.assign(new Error('Scheduled link was not found'), { code: 'E_NOT_FOUND' });
    config.queues[mode] = nextQueue;
    return config;
  });
}

export function addScheduledDownloadSlot({ time, mode, videoType }) {
  return mutateConfig(config => {
    if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw Object.assign(new Error('Choose a valid daily time'), { code: 'E_INVALID_TIME' });
    }
    if (!['horizontal', 'vertical'].includes(mode)) throw Object.assign(new Error('Choose a 16:9 or 9:16 queue'), { code: 'E_INVALID_MODE' });
    if (!['long', 'short'].includes(videoType)) throw Object.assign(new Error('Choose Long or Short video type'), { code: 'E_INVALID_VIDEO_TYPE' });
    if (config.slots.length >= 64) throw Object.assign(new Error('You can create up to 64 download slots'), { code: 'E_SLOT_LIMIT' });
    config.slots.push({ id: crypto.randomUUID(), time, mode, videoType, enabled: true, lastRunDate: '' });
    config.slots.sort((a, b) => a.time.localeCompare(b.time));
    return config;
  });
}

export function setScheduledDownloadSlotEnabled(slotId, enabled) {
  return mutateConfig(config => {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { code: 'E_INVALID_SETTINGS' });
    const slot = config.slots.find(item => item.id === slotId);
    if (!slot) throw Object.assign(new Error('Scheduled slot was not found'), { code: 'E_NOT_FOUND' });
    slot.enabled = enabled;
    return config;
  });
}

export function deleteScheduledDownloadSlot(slotId) {
  return mutateConfig(config => {
    const nextSlots = config.slots.filter(slot => slot.id !== slotId);
    if (nextSlots.length === config.slots.length) throw Object.assign(new Error('Scheduled slot was not found'), { code: 'E_NOT_FOUND' });
    config.slots = nextSlots;
    return config;
  });
}

export function startScheduledDownloads() {
  if (_timer) return;
  _stopping = false;
  void tickScheduledDownloads().catch(err => {
    logger.error('scheduled_download.tick_error', 'Scheduled YouTube download tick failed', { error: err.message });
  });
  _timer = setInterval(() => {
    void tickScheduledDownloads().catch(err => {
      logger.error('scheduled_download.tick_error', 'Scheduled YouTube download tick failed', { error: err.message });
    });
  }, 15000);
  _timer.unref?.();
  logger.info('scheduled_download.loop_started', 'Scheduled YouTube download loop started (15s interval)');
}

export async function stopScheduledDownloads() {
  _stopping = true;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_tickPromise) {
    try { await _tickPromise; } catch { /* the caller logs shutdown failures */ }
  }
  if (_activeScheduledJob && getDownloadStatus().active) {
    logger.info('scheduled_download.shutdown_cancel', 'Cancelling active scheduled download during application shutdown', {
      slotId: _activeScheduledJob.slotId,
      linkId: _activeScheduledJob.linkId,
    });
    await cancelDownload();
  }
}
