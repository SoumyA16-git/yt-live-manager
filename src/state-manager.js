/**
 * state-manager.js — Load/save stream-state.json and stream-history.json.
 *
 * PRD §8, §18:
 * - Persists desiredState, actual status, locks, counters.
 * - stream-history.json capped at 500 entries.
 * - Atomic writes with backup throttling (1 h default + forced on special events).
 * - Session-only fields (ffmpegPid, restartCountSession) are cleared on load.
 * - lastSeenAt is updated on every save (used for clock sanity check in §7.7).
 */

import { readJSON, writeJSON, writeBackup, listBackups } from './lib/atomic-json.js';
import { logger }  from './logger.js';
import PATHS       from './lib/paths.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const HISTORY_CAP    = 500;

const STATE_DEFAULTS = {
  schemaVersion:       SCHEMA_VERSION,
  desiredState:        'stopped',   // 'running' | 'stopped'
  status:              'STOPPED',   // §8.2 states
  disabled:            false,
  maintenance:         null,        // null | { active, source, since }
  bandwidthLock:       { active: false },
  restartCountSession: 0,           // reset on load
  restartCountTotal:   0,
  consecutiveFailures: 0,
  lastExit:            null,        // { code, signal, at }
  lastError:           null,        // { code, message, at }
  lastSeenAt:          null,        // ISO timestamp — clock sanity anchor
  activeVideoId:       null,
  streamMode:          null,        // 'copy' | 'hybrid' | 'transcode'
  ffmpegPid:           null,        // runtime only — cleared on load
  streamStartedAt:     null,
};

// ─── Module state ─────────────────────────────────────────────────────────────

let _state       = null;
let _lastBkAt    = 0;
let _statePath   = PATHS.streamState;
let _historyPath = PATHS.streamHistory;
let _backupDir   = PATHS.backups;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load persisted state from disk (or defaults if absent/corrupt).
 * Clears session-only fields that must not survive a restart.
 */
export async function loadState() {
  const backups = await listBackups(_backupDir, 'stream-state');
  const { data, source } = await readJSON(_statePath, backups, {});

  if (source === 'backup') {
    logger.warn('state.restored_from_backup', 'stream-state.json restored from backup');
  }

  _state = {
    ...STATE_DEFAULTS,
    ...(data ?? {}),
    // Always reset session-only fields
    schemaVersion:       SCHEMA_VERSION,
    restartCountSession: 0,
    ffmpegPid:           null,
    lastSeenAt:          new Date().toISOString(),
  };

  return { ..._state };
}

/**
 * Persist a patch to the current state.
 *
 * @param {object}  patch
 * @param {object}  [opts]
 * @param {boolean} [opts.forceBackup=false]  Force a backup regardless of throttle.
 */
export async function saveState(patch = {}, { forceBackup = false } = {}) {
  if (!_state) throw new Error('state-manager: state not loaded');

  Object.assign(_state, patch);
  _state.lastSeenAt     = new Date().toISOString();
  _state.schemaVersion  = SCHEMA_VERSION;

  const now         = Date.now();
  const throttleMs  = 3600 * 1000;  // 1 h default (PRD §18.3)
  const doBackup    = forceBackup || (now - _lastBkAt >= throttleMs);

  const backupFn = doBackup ? async () => {
    await writeBackup(_statePath, _backupDir, _state, { keep: 20 });
    _lastBkAt = Date.now();
  } : undefined;

  await writeJSON(_statePath, _state, { backupFn });
  return { ..._state };
}

/**
 * Return a shallow clone of the current in-memory state.
 * Cheap — use freely; does not touch disk.
 */
export function getState() {
  if (!_state) throw new Error('state-manager: state not loaded');
  return { ..._state };
}

export const getDesiredState = () => _state?.desiredState ?? 'stopped';
export const getStatus       = () => _state?.status       ?? 'STOPPED';

/**
 * Append a session record to stream-history.json (capped at HISTORY_CAP).
 * Errors are swallowed — history is non-critical.
 */
export async function appendHistory(entry) {
  try {
    const { data } = await readJSON(_historyPath, [], { sessions: [] });
    const sessions = data?.sessions ?? [];
    sessions.push({ ...entry, at: new Date().toISOString() });
    if (sessions.length > HISTORY_CAP) sessions.splice(0, sessions.length - HISTORY_CAP);
    await writeJSON(_historyPath, { schemaVersion: SCHEMA_VERSION, sessions });
  } catch (err) {
    logger.warn('state.history_write_error', err.message);
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Allow tests to inject custom paths without touching real data. */
export function _setPathsForTest(statePath, historyPath, backupDir) {
  _statePath   = statePath;
  _historyPath = historyPath;
  _backupDir   = backupDir;
  _state       = null;
  _lastBkAt    = 0;
}
