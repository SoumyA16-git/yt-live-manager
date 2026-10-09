/**
 * config-manager.js — Load, validate, merge, and save settings.json.
 *
 * PRD §24: Full settings schema with defaults, masking, schema versioning.
 * PRD §18: Atomic writes, backups before every change, 0600 file permissions.
 *
 * Dependency order: paths → redact → atomic-json → validate → logger → config-manager
 * (logger is imported but safe to call before initLogger — writes to stdout)
 */

import { readJSON, writeJSON, writeBackup, listBackups } from './lib/atomic-json.js';
import { validateSettings } from './lib/validate.js';
import { setSecret } from './lib/redact.js';
import { logger } from './logger.js';
import PATHS from './lib/paths.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

/** Migration table: { fromVersion → (data) => migratedData } */
const MIGRATIONS = {
  // Example: 1: d => ({ ...d, schemaVersion: 2, newField: 'default' })
};

// ─── Defaults (PRD §24) ───────────────────────────────────────────────────────

export const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  stream: {
    mode: 'horizontal',
    videoId: '',
    playlist: [],
    playlists: {
      horizontal: [],
      vertical: [],
    },
    playbackOrder: 'serial',
    modePreference: 'auto',
    allowTranscode: true,
    autoResume: true,
    resolution: '1920x1080',
    fps: 30,
    videoBitrateMbps: 4,
    audioBitrateKbps: 128,
    audioSampleRate: 44100,
    keyframeSeconds: 2,
    keyframeMaxSeconds: 8.5,
    x264Preset: 'ultrafast',
    loopStrategy: 'stream_loop',
    copyMinMbps: 0.1,
    copyMaxMbps: 8.5,
    stallSeconds: 30,
    slowSeconds: 60,
    minSpeed: 0.90,
    startupTimeoutSeconds: 30,
    stopGraceSeconds: 8,
  },
  youtube: {
    rtmpsUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
    streamKey: '',
  },
  youtubeGuidance: { recommendedMbps: [3, 9] },
  bandwidth: {
    monthlyAllowanceTB: 10,
    safetyLimitTB: 9,
    unitBase: 1000,
    overheadPercent: 10,
    warningThresholds: [70, 80, 90, 95],
    accounting: { resetDay: 1, resetHour: 0, timezone: 'UTC' },
    persistIntervalSeconds: 30,
    oci: { enabled: false, maxAgeHours: 24 },
  },
  recovery: {
    strategy: 'exponential',
    baseDelaySeconds: 10,
    factor: 2,
    maxDelaySeconds: 300,
    jitterPercent: 10,
    stableAfterSeconds: 120,
    maxConsecutiveFailures: 20,
    onThresholdExceeded: 'slow_retry',
    slowRetryCooldownSeconds: 600,
  },
  scheduler: {
    mode: 'continuous',
    timezone: 'Asia/Kolkata',
    windows: [],
    autoRecycle: {
      enabled: false,
      maxSessionHours: 8,
      pauseMinutes: 60,
      resumeBookmark: true,
    },
  },
  uploads: {
    maxBytes: 4 * 1024 * 1024 * 1024,  // 4 GiB
    allowedExtensions: ['.mp4', '.mov', '.m4v', '.mkv'],
    diskReserveBytes: 5 * 1024 * 1024 * 1024,  // 5 GiB
  },
  disk: { warnPercent: 80, criticalPercent: 90, emergencyPercent: 95 },
  logs: { level: 'info', maxFileMB: 10, maxFiles: 5 },
  backups: { keep: 20, minIntervalSeconds: 3600 },
  studioAutomation: {
    enabled: true,
    url: 'https://studio.youtube.com/video/xHUulPKBtJs/livestreaming',
    baseTitle: '',
    timezone: 'Asia/Kolkata',
    previewWaitSec: 10,
    timeoutMs: 120000,
    display: ':10',
    chromePath: '/usr/bin/google-chrome',
    userDataDir: '/home/ubuntu/.config/google-chrome',
  },
  ui: { pollSeconds: 3 },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Deep-merge `overrides` onto `defaults`.
 * - Arrays in overrides replace arrays in defaults (not merged element-by-element).
 * - Unknown keys in overrides pass through (lenient load — D-022).
 */
function deepMerge(defaults, overrides) {
  if (typeof defaults !== 'object' || defaults === null) return overrides ?? defaults;
  if (typeof overrides !== 'object' || overrides === null) return defaults;
  if (Array.isArray(defaults)) return Array.isArray(overrides) ? overrides : defaults;
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (key in defaults
      && typeof defaults[key] === 'object'
      && defaults[key] !== null
      && !Array.isArray(defaults[key])) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

/** Apply any pending schema migrations sequentially. */
function migrate(data) {
  let d = { ...data };
  let v = d.schemaVersion ?? 0;
  while (v < SCHEMA_VERSION) {
    const fn = MIGRATIONS[v];
    d = fn ? fn(d) : { ...d, schemaVersion: v + 1 };
    v = d.schemaVersion;
  }
  return d;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let _settings = null;
let _settingsPath = PATHS.settings;
let _backupDir = PATHS.backups;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load settings from disk (or defaults if absent/corrupt).
 * Registers the stream key with the redact module.
 * Must be called once at startup before any other config-manager function.
 */
export async function loadSettings() {
  const backups = await listBackups(_backupDir, 'settings');
  const { data, source } = await readJSON(_settingsPath, backups, {});

  if (source === 'backup') {
    logger.warn('config.restored_from_backup',
      'Settings file was corrupt and has been restored from backup');
  } else if (source === 'default') {
    logger.info('config.using_defaults', 'No settings file found; using factory defaults');
  }

  _settings = deepMerge(DEFAULTS, migrate(data ?? {}));

  // Auto-heal stream settings and mode-specific playlists
  if (_settings.stream) {
    if (!_settings.stream.mode || !['horizontal', 'vertical'].includes(_settings.stream.mode)) {
      _settings.stream.mode = 'horizontal';
    }
    if (!_settings.stream.playlists || typeof _settings.stream.playlists !== 'object') {
      _settings.stream.playlists = {
        horizontal: [],
        vertical: [],
      };
    } else {
      if (!Array.isArray(_settings.stream.playlists.horizontal)) _settings.stream.playlists.horizontal = [];
      if (!Array.isArray(_settings.stream.playlists.vertical)) _settings.stream.playlists.vertical = [];
    }
    if (!Array.isArray(_settings.stream.playlist)) {
      _settings.stream.playlist = _settings.stream.playlists[_settings.stream.mode] || [];
    }
    if (!_settings.stream.playbackOrder || !['sequential', 'shuffle', 'serial'].includes(_settings.stream.playbackOrder)) {
      _settings.stream.playbackOrder = 'serial';
    }
    if (_settings.stream.copyMinMbps === undefined || _settings.stream.copyMinMbps > 0.1) {
      _settings.stream.copyMinMbps = 0.1;
    }
    if (_settings.stream.copyMaxMbps === undefined || _settings.stream.copyMaxMbps > 4.0) {
      _settings.stream.copyMaxMbps = 4.0;
    }
    if (_settings.stream.keyframeMaxSeconds === undefined || _settings.stream.keyframeMaxSeconds > 4.0) {
      _settings.stream.keyframeMaxSeconds = 4.0;
    }
  }

  // Register stream key — must happen before any log line that might contain it
  if (_settings.youtube?.streamKey) {
    setSecret(_settings.youtube.streamKey);
  }

  return _settings;
}

/**
 * Apply a partial patch to the current settings, validate the result, then
 * persist atomically (with backup before the write).
 *
 * @param {object}  patch
 * @param {object}  [opts]
 * @param {boolean} [opts.skipBackup=false]
 * @returns {Promise<object>}  The new masked settings (safe to return to API callers).
 */
export async function saveSettings(patch, { skipBackup = false } = {}) {
  if (!_settings) throw new Error('config-manager: settings not loaded');

  const candidate = deepMerge(_settings, patch);

  // Normalise safetyLimitGB → safetyLimitTB (D-013)
  if (candidate.bandwidth?.safetyLimitGB != null) {
    const base = candidate.bandwidth.unitBase ?? 1000;
    candidate.bandwidth.safetyLimitTB = candidate.bandwidth.safetyLimitGB / base;
    delete candidate.bandwidth.safetyLimitGB;
  }

  // Validate
  const { valid, errors } = validateSettings(candidate, { partial: false });
  if (!valid) throw Object.assign(new Error('Settings validation failed'), { code: 'E_VALIDATION', errors });

  // Backup hook
  const backupFn = skipBackup ? undefined : async () => {
    await writeBackup(_settingsPath, _backupDir, _settings, { keep: DEFAULTS.backups.keep });
  };

  await writeJSON(_settingsPath, candidate, { mode: 0o600, backupFn });

  // Update redact module if key changed
  if (candidate.youtube?.streamKey) {
    setSecret(candidate.youtube.streamKey);
  }

  _settings = candidate;
  logger.info('config.changed', 'Settings saved');
  return getMaskedSettings();
}

/**
 * Return a deep clone of the current settings (internal use — contains secrets).
 * Never pass the return value directly to API responses; use getMaskedSettings().
 */
export function getSettings() {
  if (!_settings) throw new Error('config-manager: settings not loaded');
  return JSON.parse(JSON.stringify(_settings));
}

/**
 * Return settings safe for API responses — stream keys replaced with hints.
 */
export function getMaskedSettings() {
  const s = getSettings();
  const key = s.youtube?.streamKey;
  if (key) {
    s.youtube.streamKeySet = true;
    s.youtube.streamKeyHint = key.slice(-4);
  } else {
    s.youtube.streamKeySet = false;
    s.youtube.streamKeyHint = '';
  }
  delete s.youtube.streamKey;

  // Remove legacy key from masked output if present
  delete s.youtube?.horizontalStreamKey;
  s.youtube.horizontalStreamKeySet = s.youtube.streamKeySet;
  s.youtube.horizontalStreamKeyHint = s.youtube.streamKeyHint;

  return s;
}

/**
 * Return the raw canonical YouTube stream key for internal use ONLY.
 * Never log the return value.
 */
export function getStreamKey() {
  return _settings?.youtube?.streamKey ?? '';
}

/**
 * Legacy alias for getStreamKey() — always returns the single canonical streamKey.
 * Never log the return value.
 */
export function getHorizontalStreamKey() {
  return getStreamKey();
}

/**
 * Return the current stream mode ('horizontal' | 'vertical').
 */
export function getStreamMode() {
  return _settings?.stream?.mode || 'horizontal';
}

/**
 * Return the playlist for a specific mode (or current mode if omitted).
 *
 * @param {'horizontal'|'vertical'} [mode]
 * @returns {string[]}
 */
export function getModePlaylist(mode = getStreamMode()) {
  const playlists = _settings?.stream?.playlists;
  if (playlists && Array.isArray(playlists[mode])) {
    return [...playlists[mode]];
  }
  return Array.isArray(_settings?.stream?.playlist) ? [..._settings.stream.playlist] : [];
}

/**
 * Return copy of both playlists.
 * @returns {{ horizontal: string[], vertical: string[] }}
 */
export function getPlaylists() {
  return {
    horizontal: Array.isArray(_settings?.stream?.playlists?.horizontal) ? [..._settings.stream.playlists.horizontal] : [],
    vertical: Array.isArray(_settings?.stream?.playlists?.vertical) ? [..._settings.stream.playlists.vertical] : [],
  };
}

/**
 * Check if dual streaming is enabled in settings (legacy compatibility).
 */
export function isDualStreamEnabled() {
  return false;
}

// ─── Computed byte helpers ────────────────────────────────────────────────────

function _unitPow(n) {
  const base = _settings?.bandwidth?.unitBase ?? 1000;
  return Math.pow(base, n);
}

export function getSafetyLimitBytes() {
  const bw = _settings?.bandwidth;
  if (!bw) return 9 * _unitPow(4);
  if (bw.safetyLimitGB != null) return bw.safetyLimitGB * _unitPow(3);
  return (bw.safetyLimitTB ?? 9) * _unitPow(4);
}

export function getMonthlyAllowanceBytes() {
  const bw = _settings?.bandwidth;
  if (!bw) return 10 * _unitPow(4);
  return (bw.monthlyAllowanceTB ?? 10) * _unitPow(4);
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Allow tests to inject custom paths without touching real data. */
export function _setPathsForTest(settingsPath, backupDir) {
  _settingsPath = settingsPath;
  _backupDir = backupDir;
  _settings = null;
}

export { saveSettings as updateSettings };
