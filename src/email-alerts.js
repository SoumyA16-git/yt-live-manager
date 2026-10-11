/**
 * email-alerts.js — Best-effort SMTP alerts for live stream lifecycle events.
 *
 * Uses Node's TLS/socket modules so the stream manager gains no runtime
 * dependency. Mail delivery is deliberately isolated from stream startup and
 * recovery: an SMTP outage can never prevent or stop a live stream.
 */

import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { redact } from './lib/redact.js';

const DEFAULTS = Object.freeze({
  host: 'smtp.maileroo.com',
  port: 465,
});

const SMTP_TIMEOUT_MS = 15_000;
const FAILURE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

let _lastFailureAlertAt = 0;
let _missingConfigLogged = false;
let _sendQueue = Promise.resolve();

function getSmtpConfig() {
  const env = process.env;
  const port = Number(env.SMTP_PORT || DEFAULTS.port);
  const secure = env.SMTP_SECURE === undefined
    ? port === 465
    : /^(1|true|yes)$/i.test(String(env.SMTP_SECURE).trim());
  const config = {
    host: (env.SMTP_HOST || DEFAULTS.host).trim(),
    port,
    secure,
    user: (env.SMTP_USER || '').trim(),
    password: env.SMTP_PASS || '',
    from: (env.SMTP_FROM || env.SMTP_USER || '').trim(),
    to: (env.STREAM_ALERT_EMAIL_TO || '').trim(),
  };

  const addressIsValid = value => value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+$/.test(value);
  const missing = [];
  if (!config.password) missing.push('SMTP_PASS');
  if (!config.host || /[\s\r\n]/.test(config.host)) missing.push('SMTP_HOST');
  if (!Number.isInteger(config.port) || ![465, 587, 2525].includes(config.port)) missing.push('SMTP_PORT');
  if (!config.user || /[\r\n]/.test(config.user)) missing.push('SMTP_USER');
  if (!addressIsValid(config.from)) missing.push('SMTP_FROM');
  if (!addressIsValid(config.to)) missing.push('STREAM_ALERT_EMAIL_TO');
  if (config.port === 465 && !config.secure) missing.push('SMTP_SECURE=true is required on port 465');
  if (config.port !== 465 && config.secure) missing.push('SMTP_SECURE=false is required on ports 587/2525 for STARTTLS');

  return { config, missing };
}

class SmtpSession {
  constructor(socket) {
    this.socket = null;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.failure = null;
    this.handlers = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    const onData = chunk => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 65_536) {
        socket.destroy(new Error('SMTP response exceeded the allowed size'));
        return;
      }
      let end;
      while ((end = this.buffer.indexOf('\r\n')) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        this.lines.push(line);
      }
      this.flush();
    };
    const onError = err => this.fail(err);
    const onClose = () => this.fail(new Error('SMTP connection closed'));
    const onTimeout = () => socket.destroy(new Error('SMTP operation timed out'));
    this.handlers = { onData, onError, onClose, onTimeout };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
    socket.setTimeout(SMTP_TIMEOUT_MS);
  }

  detach() {
    const socket = this.socket;
    if (socket && this.handlers) {
      const { onData, onError, onClose, onTimeout } = this.handlers;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
      socket.setTimeout(0);
    }
    this.socket = null;
    this.handlers = null;
    return socket;
  }

  flush() {
    while (this.lines.length && this.waiters.length) {
      this.waiters.shift().resolve(this.lines.shift());
    }
  }

  fail(err) {
    if (this.failure) return;
    this.failure = err instanceof Error ? err : new Error('SMTP connection failed');
    while (this.waiters.length) this.waiters.shift().reject(this.failure);
  }

  readLine() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async readReply() {
    const firstLine = await this.readLine();
    const firstMatch = /^(\d{3})([- ])/.exec(firstLine);
    if (!firstMatch) throw new Error('SMTP server returned an invalid response');
    const code = Number(firstMatch[1]);
    const lines = [firstLine];
    let line = firstLine;
    while (line[3] === '-') {
      line = await this.readLine();
      if (!new RegExp(`^${code}[ -]`).test(line)) {
        throw new Error('SMTP server returned an inconsistent multi-line response');
      }
      lines.push(line);
    }
    return { code, lines };
  }

  async write(data) {
    if (!this.socket || this.socket.destroyed) throw new Error('SMTP connection is unavailable');
    await new Promise((resolve, reject) => {
      this.socket.write(data, err => err ? reject(err) : resolve());
    });
  }

  async command(command, expectedCodes, label) {
    if (/[\r\n]/.test(command)) throw new Error('Invalid SMTP command');
    await this.write(`${command}\r\n`);
    const response = await this.readReply();
    if (!expectedCodes.includes(response.code)) {
      throw new Error(`SMTP ${label} failed with server status ${response.code}`);
    }
    return response;
  }

  close() {
    const socket = this.detach();
    if (socket && !socket.destroyed) socket.destroy();
  }
}

function waitForSocket(socket, eventName) {
  return new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onError = err => { cleanup(); reject(err); };
    const cleanup = () => {
      socket.removeListener(eventName, onReady);
      socket.removeListener('error', onError);
    };
    socket.once(eventName, onReady);
    socket.once('error', onError);
  });
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function formatMessage({ config, kind, mode, reason, code, phase, studioVerified }) {
  const isStarted = kind === 'started';
  const subject = isStarted ? 'YouTube live stream started' : 'YouTube live stream failed';
  const eventText = isStarted ? 'LIVE STARTED' : 'LIVE START FAILED';
  const details = [
    'YT Live Manager stream alert',
    `Event: ${eventText}`,
    `Time (UTC): ${new Date().toISOString()}`,
    `Stream mode: ${mode || 'unknown'}`,
    ...(phase ? [`Stage: ${redact(String(phase)).slice(0, 300)}`] : []),
    ...(code ? [`Error code: ${redact(String(code)).slice(0, 120)}`] : []),
    ...(reason ? [`Details: ${redact(String(reason)).replace(/[\0\r]/g, '').slice(0, 2000)}`] : []),
    isStarted
      ? (studioVerified
          ? 'YouTube Studio startup gates passed, the broadcast was verified live, and RTMPS output was healthy.'
          : 'RTMPS output was healthy; YouTube Studio startup verification was disabled.')
      : 'The configured startup gate or live stream process did not complete successfully.',
  ].join('\n');
  const body = Buffer.from(details, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  const headers = [
    `From: <${config.from}>`,
    `To: <${config.to}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@yt-live-manager.local>`,
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

async function deliverSmtp(config, message) {
  const socket = config.secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: true })
    : net.connect({ host: config.host, port: config.port });
  const session = new SmtpSession(socket);

  try {
    await waitForSocket(socket, config.secure ? 'secureConnect' : 'connect');
    const greeting = await session.readReply();
    if (greeting.code !== 220) throw new Error(`SMTP greeting failed with server status ${greeting.code}`);

    let ehlo = await session.command('EHLO yt-live-manager.local', [250], 'EHLO');
    if (!config.secure) {
      const supportsStartTls = ehlo.lines.some(line => /\bSTARTTLS\b/i.test(line));
      if (!supportsStartTls) throw new Error('SMTP server does not advertise STARTTLS');
      await session.command('STARTTLS', [220], 'STARTTLS');

      const rawSocket = session.detach();
      const secureSocket = tls.connect({
        socket: rawSocket,
        servername: config.host,
        rejectUnauthorized: true,
      });
      session.attach(secureSocket);
      await waitForSocket(secureSocket, 'secureConnect');
      ehlo = await session.command('EHLO yt-live-manager.local', [250], 'EHLO after STARTTLS');
    }

    const authLines = ehlo.lines.filter(line => /\bAUTH(?:=|\s)/i.test(line));
    const supportsLogin = authLines.some(line => /\bLOGIN\b/i.test(line));
    const supportsPlain = authLines.some(line => /\bPLAIN\b/i.test(line));
    if (supportsLogin) {
      await session.command('AUTH LOGIN', [334], 'AUTH LOGIN');
      await session.command(Buffer.from(config.user, 'utf8').toString('base64'), [334], 'SMTP username authentication');
      await session.command(Buffer.from(config.password, 'utf8').toString('base64'), [235], 'SMTP password authentication');
    } else if (supportsPlain) {
      const credentials = Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64');
      const response = await session.command(`AUTH PLAIN ${credentials}`, [235, 334], 'AUTH PLAIN');
      if (response.code === 334) {
        await session.command(credentials, [235], 'SMTP PLAIN authentication');
      }
    } else {
      throw new Error('SMTP server does not advertise a supported authentication mechanism');
    }
    await session.command(`MAIL FROM:<${config.from}>`, [250], 'MAIL FROM');
    await session.command(`RCPT TO:<${config.to}>`, [250, 251], 'RCPT TO');
    await session.command('DATA', [354], 'DATA');
    await session.write(`${message.replace(/\r?\n/g, '\r\n')}.\r\n`);
    await session.command('QUIT', [221], 'QUIT');
  } finally {
    session.close();
  }
}

async function performAlert({ kind, mode, reason, code, phase, studioVerified }) {
  if (kind === 'failed') {
    const now = Date.now();
    if (now - _lastFailureAlertAt < FAILURE_ALERT_COOLDOWN_MS) {
      logger.info('stream.alert_email_throttled', 'Repeated stream failure email suppressed during cooldown');
      return { sent: false, suppressed: true };
    }
    _lastFailureAlertAt = now;
  }

  const { config, missing } = getSmtpConfig();
  if (missing.length) {
    if (!_missingConfigLogged) {
      logger.warn('stream.alert_email_not_configured', `Email alerts require valid SMTP settings (${missing.join(', ')})`);
      _missingConfigLogged = true;
    }
    return { sent: false, configured: false };
  }

  await deliverSmtp(config, formatMessage({ config, kind, mode, reason, code, phase, studioVerified }));
  logger.info('stream.alert_email_sent', `Stream ${kind === 'started' ? 'started' : 'failure'} email alert sent`, {
    recipient: config.to,
    mode: mode || 'unknown',
  });
  return { sent: true };
}

function enqueueAlert(alert) {
  const send = () => performAlert(alert).catch(err => {
    logger.warn('stream.alert_email_failed', `Could not send stream email alert: ${redact(err.message || 'SMTP delivery failed')}`);
    return { sent: false, error: true };
  });
  _sendQueue = _sendQueue.then(send, send);
  return _sendQueue;
}

export function sendLiveStartedEmail(details = {}) {
  return enqueueAlert({ ...details, kind: 'started' });
}

export function sendLiveFailureEmail(details = {}) {
  return enqueueAlert({ ...details, kind: 'failed' });
}
