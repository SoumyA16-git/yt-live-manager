/**
 * telegram-alerts.js — Best-effort Telegram notifications for stream lifecycle events.
 *
 * Telegram delivery stays separate from stream startup/recovery. Failure alerts
 * repeat serially until the configured chat owner acknowledges the inline button.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { logger } from './logger.js';
import { readJSON, writeJSON } from './lib/atomic-json.js';
import { redact } from './lib/redact.js';
import PATHS from './lib/paths.js';

const API_BASE = 'https://api.telegram.org';
const FAILURE_STATE_PATH = path.join(PATHS.data, 'telegram-alert-state.json');
const SEND_INTERVAL_MS = 1_000;
const LONG_POLL_SECONDS = 10;
const LONG_POLL_TIMEOUT_MS = 15_000;

let _activeFailure = null;
let _updateOffset = 0;
let _activationQueue = Promise.resolve();
let _messageSendQueue = Promise.resolve();
let _lastMessageStartedAt = 0;
let _missingConfigLogged = false;
let _sendErrorLoggedAt = 0;
let _pollErrorLoggedAt = 0;

function getTelegramConfig() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  const ackUserId = String(process.env.TELEGRAM_ACK_USER_ID || chatId).trim();
  const missing = [];

  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) missing.push('TELEGRAM_BOT_TOKEN');
  if (!/^-?\d{1,20}$/.test(chatId)) missing.push('TELEGRAM_CHAT_ID');
  if (!/^\d{1,20}$/.test(ackUserId)) missing.push('TELEGRAM_ACK_USER_ID');

  return { config: { token, chatId, ackUserId }, missing };
}

function logMissingConfig(missing) {
  if (_missingConfigLogged) return;
  _missingConfigLogged = true;
  logger.warn('stream.telegram_not_configured', `Telegram alerts require valid environment settings (${missing.join(', ')})`);
}

function serializeActivation(work) {
  const next = _activationQueue.then(work, work);
  _activationQueue = next.catch(() => {});
  return next;
}

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function cleanField(value, maxLength) {
  if (value === undefined || value === null) return '';
  return redact(String(value))
    .replace(/[\0\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeFailureDetails(details = {}) {
  return {
    createdAt: new Date().toISOString(),
    mode: cleanField(details.mode, 40) || 'unknown',
    phase: cleanField(details.phase, 180),
    code: cleanField(details.code, 120),
    reason: cleanField(details.reason, 1_400),
  };
}

function formatFailureMessage(alert) {
  const details = alert.details || {};
  return [
    '🚨 YouTube live stream failed',
    `Time (UTC): ${details.createdAt || new Date().toISOString()}`,
    `Mode: ${details.mode || 'unknown'}`,
    ...(details.phase ? [`Stage: ${details.phase}`] : []),
    ...(details.code ? [`Error code: ${details.code}`] : []),
    ...(details.reason ? [`Details: ${details.reason}`] : []),
    '',
    'This alert repeats every second until you press “Got it”.',
  ].join('\n').slice(0, 3_900);
}

function formatStartedMessage(details = {}) {
  const studioVerified = details.studioVerified === true;
  return [
    '✅ YouTube live stream started successfully',
    `Time (UTC): ${new Date().toISOString()}`,
    `Mode: ${cleanField(details.mode, 40) || 'unknown'}`,
    `Verification: ${studioVerified ? 'YouTube Studio confirmed the broadcast LIVE' : 'RTMPS output is healthy'}`,
    ...(details.phase ? [`Details: ${cleanField(details.phase, 300)}`] : []),
  ].join('\n').slice(0, 3_900);
}

function formatDownloadCompletedMessage(details = {}) {
  return [
    '✅ Scheduled YouTube download completed',
    `Time (UTC): ${cleanField(details.completedAt, 40) || new Date().toISOString()}`,
    `Video: ${cleanField(details.videoTitle, 300) || 'YouTube video'}`,
    ...(details.videoId ? [`Library ID: ${cleanField(details.videoId, 120)}`] : []),
    ...(details.mode ? [`Orientation: ${cleanField(details.mode, 40)}`] : []),
    ...(details.resolution ? [`Resolution: ${cleanField(details.resolution, 40)}`] : []),
    `Remaining server video storage: ${cleanField(details.storageFree, 80) || 'Unavailable'}`,
    ...(details.storageTotal ? [`Total video storage: ${cleanField(details.storageTotal, 80)}`] : []),
    ...(Number.isFinite(details.storageUsedPercent) ? [`Storage used: ${details.storageUsedPercent}%`] : []),
  ].join('\n').slice(0, 3_900);
}

async function callTelegram(method, payload, { timeoutMs = 15_000 } = {}) {
  const { config } = getTelegramConfig();
  if (!config.token) throw new Error('Telegram bot token is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(`${API_BASE}/bot${config.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Telegram ${method} returned an unreadable response (HTTP ${response.status})`);
    }

    if (!response.ok || body?.ok !== true) {
      const error = new Error(`Telegram ${method} failed (HTTP ${response.status}, API ${Number(body?.error_code) || 'unknown'})`);
      error.retryAfterSeconds = Number(body?.parameters?.retry_after) || 0;
      error.httpStatus = response.status;
      throw error;
    }

    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

function sendMessagePaced(payload) {
  const send = async () => {
    const waitMs = SEND_INTERVAL_MS - (Date.now() - _lastMessageStartedAt);
    if (waitMs > 0) await delay(waitMs);
    _lastMessageStartedAt = Date.now();
    return callTelegram('sendMessage', payload);
  };
  const next = _messageSendQueue.then(send, send);
  _messageSendQueue = next.catch(() => {});
  return next;
}

async function readPersistedFailure() {
  try {
    const { data } = await readJSON(FAILURE_STATE_PATH, [], { activeFailure: null });
    const alert = data?.activeFailure;
    if (typeof alert?.id !== 'string' || !alert.id || !alert.details || typeof alert.details !== 'object') return null;
    return { id: alert.id, details: alert.details };
  } catch (err) {
    logger.warn('stream.telegram_state_read_failed', `Could not read pending Telegram alert state: ${redact(err.message || 'read failed')}`);
    return null;
  }
}

async function persistFailure(alert) {
  await writeJSON(FAILURE_STATE_PATH, {
    schemaVersion: 1,
    activeFailure: alert ? { id: alert.id, details: alert.details } : null,
  });
}

function isActive(alert) {
  return _activeFailure === alert && alert.acknowledged !== true;
}

function failureKeyboard(alert) {
  return {
    inline_keyboard: [[{
      text: '✅ Got it',
      callback_data: `ack:${alert.id}`,
    }]],
  };
}

async function repeatFailureAlert(alert, config) {
  while (isActive(alert)) {
    const requestStartedAt = Date.now();
    try {
      await sendMessagePaced({
        chat_id: config.chatId,
        text: formatFailureMessage(alert),
        reply_markup: failureKeyboard(alert),
      });

      if (!alert.firstSendLogged) {
        alert.firstSendLogged = true;
        logger.info('stream.telegram_failure_alert_sent', 'Telegram failure alert is repeating until acknowledged', {
          chatId: config.chatId,
          mode: alert.details.mode || 'unknown',
        });
      }
    } catch (err) {
      const now = Date.now();
      if (now - _sendErrorLoggedAt >= 60_000) {
        _sendErrorLoggedAt = now;
        logger.warn('stream.telegram_failure_alert_send_failed', `Telegram failure alert send failed; it will retry (${redact(err.message || 'request failed')})`);
      }
      const retryAfterMs = Math.max(SEND_INTERVAL_MS, (err.retryAfterSeconds || 0) * 1_000);
      await delay(Math.max(retryAfterMs, SEND_INTERVAL_MS - (Date.now() - requestStartedAt)));
      continue;
    }

    // Pace requests from their start time and never overlap sends to this chat.
    await delay(SEND_INTERVAL_MS - (Date.now() - requestStartedAt));
  }
}

async function answerCallback(callbackQuery, text) {
  try {
    await callTelegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text,
      show_alert: false,
    });
  } catch (err) {
    logger.warn('stream.telegram_callback_answer_failed', `Could not answer Telegram button callback: ${redact(err.message || 'request failed')}`);
  }
}

async function acknowledgeFailure(alert, callbackQuery, config) {
  const acknowledged = await serializeActivation(async () => {
    if (!isActive(alert)) return false;

    alert.acknowledged = true;
    _activeFailure = null;
    try {
      await persistFailure(null);
    } catch (err) {
      logger.error('stream.telegram_ack_persist_failed', `Alert was acknowledged, but its saved state could not be cleared: ${redact(err.message || 'write failed')}`);
    }
    return true;
  });

  if (!acknowledged) {
    await answerCallback(callbackQuery, 'This failure alert is already acknowledged.');
    return;
  }

  await answerCallback(callbackQuery, 'Got it. Failure alerts have stopped.');
  const messageId = callbackQuery.message?.message_id;
  if (messageId) {
    try {
      await callTelegram('editMessageReplyMarkup', {
        chat_id: config.chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      logger.warn('stream.telegram_ack_button_cleanup_failed', `Could not remove the acknowledged Telegram button: ${redact(err.message || 'request failed')}`);
    }
  }

  logger.info('stream.telegram_failure_acknowledged', 'Telegram stream failure alert acknowledged; repeat notifications stopped', {
    chatId: config.chatId,
    mode: alert.details.mode || 'unknown',
  });
}

async function pollForAcknowledgement(alert, config) {
  while (isActive(alert)) {
    try {
      const updates = await callTelegram('getUpdates', {
        ...(Number.isSafeInteger(_updateOffset) && _updateOffset > 0 ? { offset: _updateOffset } : {}),
        timeout: LONG_POLL_SECONDS,
        allowed_updates: ['callback_query'],
      }, { timeoutMs: LONG_POLL_TIMEOUT_MS });

      for (const update of Array.isArray(updates) ? updates : []) {
        if (Number.isSafeInteger(update?.update_id)) _updateOffset = Math.max(_updateOffset, update.update_id + 1);
        const query = update?.callback_query;
        if (!query) continue;

        const queryChatId = String(query.message?.chat?.id ?? '');
        const queryUserId = String(query.from?.id ?? '');
        if (query.data === `ack:${alert.id}` && queryChatId === config.chatId && queryUserId === config.ackUserId) {
          await acknowledgeFailure(alert, query, config);
        } else if (query.data === `ack:${alert.id}`) {
          await answerCallback(query, 'Only the configured account can acknowledge this alert.');
        } else {
          await answerCallback(query, 'This alert is no longer active.');
        }
      }
    } catch (err) {
      const now = Date.now();
      if (now - _pollErrorLoggedAt >= 60_000) {
        _pollErrorLoggedAt = now;
        const webhookHint = err.httpStatus === 409
          ? ' Check that no webhook is configured for this bot; Telegram does not allow webhook delivery and getUpdates polling at the same time.'
          : '';
        logger.warn('stream.telegram_ack_poll_failed', `Telegram button acknowledgement polling failed; it will retry (${redact(err.message || 'request failed')}).${webhookHint}`);
      }
      await delay(Math.max(1_000, (err.retryAfterSeconds || 0) * 1_000));
    }
  }
}

function startFailureWorkers(alert, config) {
  if (!isActive(alert)) return;
  if (!alert.repeatPromise) {
    alert.repeatPromise = repeatFailureAlert(alert, config).catch(err => {
      logger.error('stream.telegram_failure_loop_stopped', `Telegram failure alert loop stopped unexpectedly: ${redact(err.message || 'unknown error')}`);
      alert.repeatPromise = null;
    });
  }
  if (!alert.pollPromise) {
    alert.pollPromise = pollForAcknowledgement(alert, config).catch(err => {
      logger.error('stream.telegram_ack_poll_stopped', `Telegram acknowledgement polling stopped unexpectedly: ${redact(err.message || 'unknown error')}`);
      alert.pollPromise = null;
    });
  }
}

export function sendLiveFailureTelegram(details = {}) {
  return serializeActivation(async () => {
    const { config, missing } = getTelegramConfig();
    if (missing.length) {
      logMissingConfig(missing);
      return { sent: false, configured: false };
    }

    let alert = _activeFailure || await readPersistedFailure();
    if (!alert) {
      alert = { id: randomUUID(), details: normalizeFailureDetails(details) };
      try {
        await persistFailure(alert);
      } catch (err) {
        logger.warn('stream.telegram_state_write_failed', `Could not save pending Telegram alert state: ${redact(err.message || 'write failed')}`);
      }
    }
    _activeFailure = alert;
    startFailureWorkers(alert, config);
    return { sent: true, repeating: true };
  });
}

export function resumePendingTelegramFailureAlert() {
  return serializeActivation(async () => {
    const alert = _activeFailure || await readPersistedFailure();
    if (!alert) return { resumed: false };

    const { config, missing } = getTelegramConfig();
    if (missing.length) {
      logMissingConfig(missing);
      return { resumed: false, configured: false };
    }

    _activeFailure = alert;
    startFailureWorkers(alert, config);
    logger.info('stream.telegram_failure_alert_resumed', 'Resumed an unacknowledged Telegram failure alert after service startup', {
      mode: alert.details.mode || 'unknown',
    });
    return { resumed: true };
  });
}

export async function sendLiveStartedTelegram(details = {}) {
  const { config, missing } = getTelegramConfig();
  if (missing.length) {
    logMissingConfig(missing);
    return { sent: false, configured: false };
  }

  try {
    await sendMessagePaced({
      chat_id: config.chatId,
      text: formatStartedMessage(details),
    });
    logger.info('stream.telegram_started_alert_sent', 'Telegram live-start notification sent once', {
      chatId: config.chatId,
      mode: cleanField(details.mode, 40) || 'unknown',
    });
    return { sent: true };
  } catch (err) {
    logger.warn('stream.telegram_started_alert_failed', `Could not send Telegram live-start notification: ${redact(err.message || 'request failed')}`);
    return { sent: false, error: true };
  }
}

export async function sendDownloadCompletedTelegram(details = {}) {
  const { config, missing } = getTelegramConfig();
  if (missing.length) {
    logMissingConfig(missing);
    return { sent: false, configured: false };
  }

  try {
    await sendMessagePaced({
      chat_id: config.chatId,
      text: formatDownloadCompletedMessage(details),
    });
    logger.info('scheduled_download.alert_telegram_sent', 'Scheduled download completion Telegram alert sent', {
      chatId: config.chatId,
      videoId: cleanField(details.videoId, 120) || null,
    });
    return { sent: true };
  } catch (err) {
    logger.warn('scheduled_download.alert_telegram_failed', `Could not send scheduled download Telegram alert: ${redact(err.message || 'request failed')}`);
    return { sent: false, error: true };
  }
}
