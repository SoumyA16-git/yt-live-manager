/**
 * logger.js — Structured JSON-Lines logger with redaction and size-based rotation.
 *
 * PRD §20:
 * - JSON Lines: { ts, level, event, msg, ...fields }
 * - Written to logs/app.log (file) AND stdout (journald captures it)
 * - Size-based rotation: maxFileMB × maxFiles; oldest shifted on rotate
 * - redact() applied to msg and all string fields as last line of defence
 * - Safe to call before initLogger() — pre-init writes to stdout only
 *
 * Event catalog is enforced at call sites, not here; this module is format-only.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { redact, redactObject } from './lib/redact.js';
import PATHS from './lib/paths.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let _cfg = { level: 'info', maxFileMB: 10, maxFiles: 5 };
let _logPath = PATHS.appLog;

// ─── File stream ──────────────────────────────────────────────────────────────

let _stream    = null;
let _sizeBytes = 0;
let _rotating  = false;

function logFilePath(index) {
  return index === 0
    ? _logPath
    : _logPath.replace(/\.log$/, `.${index}.log`);
}

function openStream() {
  try {
    _sizeBytes = fs.existsSync(_logPath) ? fs.statSync(_logPath).size : 0;
  } catch { _sizeBytes = 0; }
  _stream = fs.createWriteStream(_logPath, { flags: 'a', encoding: 'utf8' });
  _stream.on('error', err => {
    // Silently fail file writes if the stream breaks — don't crash the app
    process.stderr.write(`logger stream error: ${err.message}\n`);
    _stream = null;
  });
}

function rotate() {
  if (_rotating) return;
  _rotating = true;

  try {
    if (_stream) { _stream.destroy(); _stream = null; }

    // Shift: .4.log → .5.log, .3 → .4, ..., .1 → .2, current → .1
    for (let i = _cfg.maxFiles - 1; i >= 1; i--) {
      try { fs.renameSync(logFilePath(i), logFilePath(i + 1)); } catch { /* ignore */ }
    }
    try { fs.renameSync(_logPath, logFilePath(1)); } catch { /* ignore */ }

    // Delete any excess files beyond maxFiles
    for (let i = _cfg.maxFiles + 1; i <= _cfg.maxFiles + 10; i++) {
      try { fs.unlinkSync(logFilePath(i)); } catch { break; }
    }
  } finally {
    _rotating = false;
    openStream();
  }
}

// ─── Core write ───────────────────────────────────────────────────────────────

function write(level, event, msg, fields) {
  if (LEVELS[level] < LEVELS[_cfg.level ?? 'info']) return;

  // Build log entry — redact everything
  const entry = {
    ts:    new Date().toISOString(),
    level,
    event: String(event),
    msg:   redact(String(msg)),
    ...(fields ? redactObject(fields) : {}),
  };

  const line      = JSON.stringify(entry) + '\n';
  const lineBytes = Buffer.byteLength(line, 'utf8');

  // Always write to stdout (journald / docker)
  process.stdout.write(line);

  // Write to file if initialized and not mid-rotate
  if (_stream && _stream.writable && !_rotating) {
    _stream.write(line);
    _sizeBytes += lineBytes;

    const maxBytes = (_cfg.maxFileMB ?? 10) * 1024 * 1024;
    if (_sizeBytes >= maxBytes) rotate();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the file write stream. Call once after loading config.
 * Re-calling updates the path (useful in tests).
 *
 * @param {object} [config]  Overrides for { level, maxFileMB, maxFiles }
 * @param {string} [logPath] Absolute path to the log file
 */
export function initLogger(config = {}, logPath = PATHS.appLog) {
  _cfg     = { ..._cfg, ...config };
  _logPath = logPath;
  try { fs.mkdirSync(path.dirname(_logPath), { recursive: true }); } catch { /* ignore */ }
  if (_stream) { try { _stream.destroy(); } catch { /* ignore */ } _stream = null; }
  openStream();
}

/**
 * Update logger config without re-opening the stream (e.g. after settings reload).
 */
export function updateLoggerConfig(config = {}) {
  _cfg = { ..._cfg, ...config };
}

/**
 * Close the file stream gracefully (call during app shutdown).
 */
export function closeLogger() {
  return new Promise(resolve => {
    if (!_stream) { resolve(); return; }
    _stream.end(resolve);
    _stream = null;
  });
}

export const logger = {
  debug: (event, msg, fields) => write('debug', event, msg, fields),
  info:  (event, msg, fields) => write('info',  event, msg, fields),
  warn:  (event, msg, fields) => write('warn',  event, msg, fields),
  error: (event, msg, fields) => write('error', event, msg, fields),
};

export default logger;
