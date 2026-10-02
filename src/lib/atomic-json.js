/**
 * lib/atomic-json.js — Atomic JSON read/write with per-file write queue.
 *
 * PRD §18.2 protocol:
 *   1. Serialise through a per-file promise queue (no concurrent writers).
 *   2. Write to <file>.tmp-<pid> in the SAME directory (same filesystem → rename is atomic).
 *   3. fsync the temp file, rename over target, fsync the directory fd.
 *   4. On read failure: try newest valid backup, else return defaultValue + flag.
 *
 * Backup creation and pruning is provided as a separate helper so callers
 * control throttle logic independently.
 */

import fs   from 'node:fs/promises';
import path from 'node:path';

// ─── Per-file write queue ────────────────────────────────────────────────────

/** @type {Map<string, Promise<void>>} */
const _queues = new Map();

/**
 * Enqueue `fn` for `filePath` so that writes to the same file never overlap.
 * The queue entry is cleaned up once the chain settles.
 */
function enqueue(filePath, fn) {
  const prev    = _queues.get(filePath) ?? Promise.resolve();
  const next    = prev.then(fn, fn);   // proceed even if prev failed
  const cleaned = next.finally(() => {
    if (_queues.get(filePath) === cleaned) _queues.delete(filePath);
  });
  _queues.set(filePath, cleaned);
  return cleaned;
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Atomically write `data` as pretty-printed JSON to `filePath`.
 *
 * @param {string}   filePath           Absolute target path.
 * @param {*}        data               Value to serialise.
 * @param {object}   [opts]
 * @param {number}   [opts.mode=0o600]  File permission bits.
 * @param {Function} [opts.backupFn]    Called with (filePath, data) after a
 *                                      successful write; errors are swallowed.
 */
export async function writeJSON(filePath, data, opts = {}) {
  return enqueue(filePath, async () => {
    const { mode = 0o600, backupFn } = opts;
    const dir  = path.dirname(filePath);
    const tmp  = `${filePath}.tmp-${process.pid}`;
    const json = JSON.stringify(data, null, 2);

    await fs.mkdir(dir, { recursive: true });

    // Write + fsync temp file
    const fh = await fs.open(tmp, 'w', mode);
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }

    // Atomic rename
    await fs.rename(tmp, filePath);

    // fsync the directory (best-effort; EPERM on some platforms/mounts)
    try {
      const dfh = await fs.open(dir, 'r');
      try { await dfh.sync(); } finally { await dfh.close(); }
    } catch { /* ignore */ }

    // Optional backup hook
    if (typeof backupFn === 'function') {
      try { await backupFn(filePath, data); } catch { /* non-fatal */ }
    }
  });
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Read and parse JSON from `filePath`.
 * On failure, tries `backupPaths` in order (newest first).
 *
 * @param {string}   filePath
 * @param {string[]} [backupPaths]   Ordered list (newest first) to try on primary failure.
 * @param {*}        [defaultValue]  Returned when all sources fail.
 * @returns {Promise<{ data: *, source: 'primary'|'backup'|'default', backupPath?: string, error?: Error }>}
 */
export async function readJSON(filePath, backupPaths = [], defaultValue = null) {
  // Primary
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return { data: JSON.parse(text), source: 'primary' };
  } catch (primaryErr) {
    // Backups
    for (const bp of backupPaths) {
      try {
        const text = await fs.readFile(bp, 'utf8');
        return { data: JSON.parse(text), source: 'backup', backupPath: bp };
      } catch { /* try next */ }
    }
    return { data: defaultValue, source: 'default', error: primaryErr };
  }
}

// ─── Backup helpers ──────────────────────────────────────────────────────────

/**
 * List backup files for a given base name in `backupDir`, sorted newest-first.
 * Backups are named `<baseName>.<timestamp>.json`.
 *
 * @param {string} backupDir
 * @param {string} baseName   e.g. `'settings'` (without .json extension)
 * @returns {Promise<string[]>}
 */
export async function listBackups(backupDir, baseName) {
  try {
    const entries = await fs.readdir(backupDir);
    const prefix  = baseName + '.';
    return entries
      .filter(e => e.startsWith(prefix) && e.endsWith('.json'))
      .sort()
      .reverse()
      .map(e => path.join(backupDir, e));
  } catch {
    return [];
  }
}

/**
 * Write a timestamped backup of `data` to `backupDir`, then prune old backups.
 *
 * @param {string} filePath    Original file path (used to derive the baseName).
 * @param {string} backupDir
 * @param {*}      data
 * @param {object} [opts]
 * @param {number} [opts.keep=20]     Max backups to retain per file.
 * @param {number} [opts.mode=0o600]
 * @returns {Promise<string|null>}    Backup path, or null on failure.
 */
export async function writeBackup(filePath, backupDir, data, opts = {}) {
  const { keep = 20, mode = 0o600 } = opts;
  const baseName = path.basename(filePath, '.json');
  const ts       = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
  const bkPath   = path.join(backupDir, `${baseName}.${ts}.json`);

  try {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(bkPath, JSON.stringify(data, null, 2), { mode });

    // Prune
    const all = await listBackups(backupDir, baseName);
    if (all.length > keep) {
      await Promise.allSettled(all.slice(keep).map(p => fs.unlink(p)));
    }

    return bkPath;
  } catch {
    return null;
  }
}
