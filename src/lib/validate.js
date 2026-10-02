/**
 * lib/validate.js — Hand-written schema validation for settings and API inputs.
 *
 * PRD §0: "unknown keys rejected; types and ranges enforced."
 * PRD §24: Full settings schema with all constraints.
 *
 * All public functions return { valid: boolean, errors: string[] }.
 * No I/O — pure functions only.
 */

// ─── Primitive helpers ────────────────────────────────────────────────────────

const isString  = v => typeof v === 'string';
const isNumber  = v => typeof v === 'number' && Number.isFinite(v);
const isBoolean = v => typeof v === 'boolean';
const isArray   = v => Array.isArray(v);
const isObject  = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function fieldErr(fieldPath, msg) { return `${fieldPath}: ${msg}`; }

/**
 * Validate a single value against a spec descriptor.
 * Pushes error strings into `errors`; returns nothing.
 *
 * spec shape: {
 *   type:     'string'|'number'|'boolean',
 *   required: boolean  (default true — only relevant in non-partial mode),
 *   min, max: number   (for type:'number')
 *   integer:  boolean  (for type:'number')
 *   enum:     any[]
 *   minLen, maxLen: number (for type:'string')
 *   pattern:  RegExp   (for type:'string')
 * }
 */
function validateField(fPath, value, spec, errors) {
  if (value === undefined || value === null) return; // absent fields skipped (partial mode)

  switch (spec.type) {
    case 'string':
      if (!isString(value)) { errors.push(fieldErr(fPath, 'must be a string')); return; }
      if (spec.minLen !== undefined && value.length < spec.minLen)
        errors.push(fieldErr(fPath, `must be at least ${spec.minLen} characters`));
      if (spec.maxLen !== undefined && value.length > spec.maxLen)
        errors.push(fieldErr(fPath, `must be at most ${spec.maxLen} characters`));
      if (spec.pattern && !spec.pattern.test(value))
        errors.push(fieldErr(fPath, 'has invalid format'));
      if (spec.enum && !spec.enum.includes(value))
        errors.push(fieldErr(fPath, `must be one of: ${spec.enum.join(', ')}`));
      break;

    case 'number':
      if (!isNumber(value)) { errors.push(fieldErr(fPath, 'must be a finite number')); return; }
      if (spec.integer && !Number.isInteger(value))
        errors.push(fieldErr(fPath, 'must be an integer'));
      if (spec.min !== undefined && value < spec.min)
        errors.push(fieldErr(fPath, `must be >= ${spec.min}`));
      if (spec.max !== undefined && value > spec.max)
        errors.push(fieldErr(fPath, `must be <= ${spec.max}`));
      if (spec.enum && !spec.enum.includes(value))
        errors.push(fieldErr(fPath, `must be one of: ${spec.enum.join(', ')}`));
      break;

    case 'boolean':
      if (!isBoolean(value))
        errors.push(fieldErr(fPath, 'must be a boolean'));
      break;
  }
}

// ─── Per-section schemas ─────────────────────────────────────────────────────

const STREAM_SCHEMA = {
  videoId:               { type: 'string', maxLen: 50 },
  modePreference:        { type: 'string', enum: ['auto', 'copy', 'transcode'] },
  allowTranscode:        { type: 'boolean' },
  autoResume:            { type: 'boolean' },
  resolution:            { type: 'string', enum: ['1080x1920'] },
  fps:                   { type: 'number', integer: true, enum: [24, 25, 30, 60] },
  videoBitrateMbps:      { type: 'number', min: 1, max: 50 },
  audioBitrateKbps:      { type: 'number', integer: true, min: 32, max: 320 },
  audioSampleRate:       { type: 'number', integer: true, enum: [44100, 48000] },
  keyframeSeconds:       { type: 'number', min: 0.5, max: 10 },
  keyframeMaxSeconds:    { type: 'number', min: 0.5, max: 10 },
  x264Preset:            { type: 'string', enum: ['ultrafast','superfast','veryfast','faster','fast','medium'] },
  loopStrategy:          { type: 'string', enum: ['stream_loop', 'concat'] },
  copyMinMbps:           { type: 'number', min: 0.1, max: 50 },
  copyMaxMbps:           { type: 'number', min: 1, max: 100 },
  stallSeconds:          { type: 'number', integer: true, min: 5, max: 300 },
  slowSeconds:           { type: 'number', integer: true, min: 10, max: 600 },
  minSpeed:              { type: 'number', min: 0.1, max: 2.0 },
  startupTimeoutSeconds: { type: 'number', integer: true, min: 5, max: 120 },
  stopGraceSeconds:      { type: 'number', integer: true, min: 1, max: 60 },
};

const YOUTUBE_SCHEMA = {
  rtmpsUrl:  { type: 'string', pattern: /^rtmps:\/\//i },
  streamKey: { type: 'string', maxLen: 256 },   // special handling below
  title:     { type: 'string', maxLen: 200 },
  label:     { type: 'string', maxLen: 100 },
};

const BANDWIDTH_ACCOUNTING_SCHEMA = {
  resetDay:  { type: 'number', integer: true, min: 1, max: 28 },
  resetHour: { type: 'number', integer: true, min: 0, max: 23 },
  timezone:  { type: 'string', minLen: 1, maxLen: 64 },
};

const BANDWIDTH_SCHEMA = {
  monthlyAllowanceTB:   { type: 'number', min: 0.001, max: 1000 },
  safetyLimitTB:        { type: 'number', min: 0.00001, max: 1000 },
  safetyLimitGB:        { type: 'number', min: 0.001, max: 1_000_000 },   // optional alt form
  unitBase:             { type: 'number', integer: true, enum: [1000, 1024] },
  overheadPercent:      { type: 'number', min: 0, max: 100 },
  persistIntervalSeconds: { type: 'number', integer: true, min: 5, max: 3600 },
  // warningThresholds, accounting, oci — handled specially
};

const RECOVERY_SCHEMA = {
  strategy:                  { type: 'string', enum: ['exponential', 'linear'] },
  baseDelaySeconds:          { type: 'number', integer: true, min: 1, max: 3600 },
  factor:                    { type: 'number', min: 1.1, max: 10 },
  maxDelaySeconds:           { type: 'number', integer: true, min: 1, max: 86400 },
  jitterPercent:             { type: 'number', min: 0, max: 50 },
  stableAfterSeconds:        { type: 'number', integer: true, min: 10, max: 3600 },
  maxConsecutiveFailures:    { type: 'number', integer: true, min: 1, max: 1000 },
  onThresholdExceeded:       { type: 'string', enum: ['slow_retry', 'stop'] },
  slowRetryCooldownSeconds:  { type: 'number', integer: true, min: 10, max: 86400 },
};

const SCHEDULER_SCHEMA = {
  mode:     { type: 'string', enum: ['continuous', 'scheduled', 'manual'] },
  timezone: { type: 'string', minLen: 1, maxLen: 64 },
  // windows — handled specially
};

const DISK_SCHEMA = {
  warnPercent:      { type: 'number', integer: true, min: 1, max: 98 },
  criticalPercent:  { type: 'number', integer: true, min: 2, max: 99 },
  emergencyPercent: { type: 'number', integer: true, min: 3, max: 99 },
};

const LOGS_SCHEMA = {
  level:      { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
  maxFileMB:  { type: 'number', integer: true, min: 1, max: 1000 },
  maxFiles:   { type: 'number', integer: true, min: 1, max: 100 },
};

const BACKUPS_SCHEMA = {
  keep:               { type: 'number', integer: true, min: 1, max: 1000 },
  minIntervalSeconds: { type: 'number', integer: true, min: 60, max: 86400 },
};

const UI_SCHEMA = {
  pollSeconds: { type: 'number', integer: true, min: 2, max: 5 },
};

// Top-level keys that require an FFmpeg restart when changed
const RESTART_KEYS = new Set([
  'stream.resolution', 'stream.fps', 'stream.videoBitrateMbps',
  'stream.audioBitrateKbps', 'stream.audioSampleRate', 'stream.keyframeSeconds',
  'stream.keyframeMaxSeconds', 'stream.x264Preset', 'stream.loopStrategy',
  'stream.videoId', 'youtube.rtmpsUrl', 'youtube.streamKey',
]);

// ─── Section validators ───────────────────────────────────────────────────────

function validateSection(sectionPath, input, schema, errors) {
  if (!isObject(input)) {
    errors.push(fieldErr(sectionPath, 'must be an object')); return;
  }
  for (const [key, spec] of Object.entries(schema)) {
    if (input[key] !== undefined) validateField(`${sectionPath}.${key}`, input[key], spec, errors);
  }
  for (const key of Object.keys(input)) {
    if (!(key in schema)) errors.push(fieldErr(`${sectionPath}.${key}`, 'unknown field'));
  }
}

function validateTimezone(fPath, tz, errors) {
  if (!tz) return;
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); }
  catch { errors.push(fieldErr(fPath, `invalid IANA timezone: "${tz}"`)); }
}

function validateWarningThresholds(fPath, wt, errors) {
  if (!isArray(wt)) { errors.push(fieldErr(fPath, 'must be an array')); return; }
  if (wt.length < 1 || wt.length > 8) { errors.push(fieldErr(fPath, 'must have 1–8 entries')); return; }
  for (let i = 0; i < wt.length; i++) {
    if (!Number.isInteger(wt[i]) || wt[i] < 1 || wt[i] > 99)
      errors.push(fieldErr(`${fPath}[${i}]`, 'must be an integer in 1–99'));
    if (i > 0 && wt[i] <= wt[i - 1])
      errors.push(fieldErr(fPath, 'must be strictly ascending'));
  }
}

function validateSchedulerWindows(fPath, windows, errors) {
  if (!isArray(windows)) { errors.push(fieldErr(fPath, 'must be an array')); return; }
  const DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const wp = `${fPath}[${i}]`;
    if (!isObject(w)) { errors.push(fieldErr(wp, 'must be an object')); continue; }
    if (!isArray(w.days) || w.days.length === 0)
      errors.push(fieldErr(`${wp}.days`, 'must be a non-empty array'));
    else if (w.days.some(d => !DAYS.includes(d)))
      errors.push(fieldErr(`${wp}.days`, `each entry must be one of: ${DAYS.join(', ')}`));
    if (!isString(w.start) || !/^\d{2}:\d{2}$/.test(w.start))
      errors.push(fieldErr(`${wp}.start`, 'must be HH:MM'));
    if (!isString(w.stop) || !/^\d{2}:\d{2}$/.test(w.stop))
      errors.push(fieldErr(`${wp}.stop`, 'must be HH:MM'));
    // Unknown keys in window
    for (const k of Object.keys(w)) {
      if (!['days','start','stop'].includes(k))
        errors.push(fieldErr(`${wp}.${k}`, 'unknown field'));
    }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Validate a (partial) settings patch object from the API.
 *
 * @param {object}  input
 * @param {object}  [opts]
 * @param {boolean} [opts.partial=true]  If true, absent top-level sections are OK.
 * @returns {{ valid: boolean, errors: string[], requiresRestart: boolean }}
 */
export function validateSettings(input, { partial = true } = {}) {
  const errors = [];
  let requiresRestart = false;

  if (!isObject(input)) {
    return { valid: false, errors: ['Input must be a plain object'], requiresRestart: false };
  }

  // ── stream ──
  if (input.stream !== undefined) {
    const s = input.stream;
    validateSection('stream', s, STREAM_SCHEMA, errors);
    // requiresRestart tracking
    if (isObject(s)) {
      for (const k of Object.keys(s)) {
        if (RESTART_KEYS.has(`stream.${k}`)) requiresRestart = true;
      }
    }
  }

  // ── youtube ──
  if (input.youtube !== undefined) {
    const yt = input.youtube;
    if (!isObject(yt)) {
      errors.push(fieldErr('youtube', 'must be an object'));
    } else {
      // rtmpsUrl
      if (yt.rtmpsUrl !== undefined) {
        validateField('youtube.rtmpsUrl', yt.rtmpsUrl, YOUTUBE_SCHEMA.rtmpsUrl, errors);
        requiresRestart = true;
      }
      // streamKey — empty string means "do not change"
      if (yt.streamKey !== undefined && yt.streamKey !== '') {
        const r = validateStreamKey(yt.streamKey);
        if (!r.valid) errors.push(...r.errors.map(e => `youtube.streamKey: ${e}`));
        requiresRestart = true;
      }
      // title, label
      if (yt.title !== undefined) validateField('youtube.title', yt.title, YOUTUBE_SCHEMA.title, errors);
      if (yt.label !== undefined) validateField('youtube.label', yt.label, YOUTUBE_SCHEMA.label, errors);
      for (const k of Object.keys(yt)) {
        if (!['rtmpsUrl','streamKey','title','label'].includes(k))
          errors.push(fieldErr(`youtube.${k}`, 'unknown field'));
      }
    }
  }

  // ── youtubeGuidance ──
  if (input.youtubeGuidance !== undefined) {
    if (!isObject(input.youtubeGuidance)) {
      errors.push(fieldErr('youtubeGuidance', 'must be an object'));
    } else {
      const rm = input.youtubeGuidance.recommendedMbps;
      if (rm !== undefined) {
        if (!isArray(rm) || rm.length !== 2 || !isNumber(rm[0]) || !isNumber(rm[1]) || rm[0] >= rm[1])
          errors.push(fieldErr('youtubeGuidance.recommendedMbps', 'must be [minMbps, maxMbps] with min < max'));
      }
      for (const k of Object.keys(input.youtubeGuidance)) {
        if (k !== 'recommendedMbps')
          errors.push(fieldErr(`youtubeGuidance.${k}`, 'unknown field'));
      }
    }
  }

  // ── bandwidth ──
  if (input.bandwidth !== undefined) {
    const bw = input.bandwidth;
    if (!isObject(bw)) {
      errors.push(fieldErr('bandwidth', 'must be an object'));
    } else {
      for (const [key, spec] of Object.entries(BANDWIDTH_SCHEMA)) {
        if (bw[key] !== undefined) validateField(`bandwidth.${key}`, bw[key], spec, errors);
      }
      if (bw.warningThresholds !== undefined)
        validateWarningThresholds('bandwidth.warningThresholds', bw.warningThresholds, errors);
      if (bw.accounting !== undefined) {
        if (!isObject(bw.accounting)) {
          errors.push(fieldErr('bandwidth.accounting', 'must be an object'));
        } else {
          for (const [k, spec] of Object.entries(BANDWIDTH_ACCOUNTING_SCHEMA)) {
            if (bw.accounting[k] !== undefined)
              validateField(`bandwidth.accounting.${k}`, bw.accounting[k], spec, errors);
          }
          validateTimezone('bandwidth.accounting.timezone', bw.accounting.timezone, errors);
        }
      }
      if (bw.oci !== undefined && !isObject(bw.oci))
        errors.push(fieldErr('bandwidth.oci', 'must be an object'));
      const KNOWN_BW = new Set([...Object.keys(BANDWIDTH_SCHEMA), 'warningThresholds', 'accounting', 'oci']);
      for (const k of Object.keys(bw)) {
        if (!KNOWN_BW.has(k)) errors.push(fieldErr(`bandwidth.${k}`, 'unknown field'));
      }
    }
  }

  // ── recovery ──
  if (input.recovery !== undefined) {
    validateSection('recovery', input.recovery, RECOVERY_SCHEMA, errors);
  }

  // ── scheduler ──
  if (input.scheduler !== undefined) {
    const sc = input.scheduler;
    if (!isObject(sc)) {
      errors.push(fieldErr('scheduler', 'must be an object'));
    } else {
      for (const [k, spec] of Object.entries(SCHEDULER_SCHEMA)) {
        if (sc[k] !== undefined) validateField(`scheduler.${k}`, sc[k], spec, errors);
      }
      validateTimezone('scheduler.timezone', sc.timezone, errors);
      if (sc.windows !== undefined)
        validateSchedulerWindows('scheduler.windows', sc.windows, errors);
      const KNOWN_SC = new Set([...Object.keys(SCHEDULER_SCHEMA), 'windows']);
      for (const k of Object.keys(sc)) {
        if (!KNOWN_SC.has(k)) errors.push(fieldErr(`scheduler.${k}`, 'unknown field'));
      }
    }
  }

  // ── uploads ──
  if (input.uploads !== undefined) {
    if (!isObject(input.uploads)) {
      errors.push(fieldErr('uploads', 'must be an object'));
    } else {
      const UPL = {
        maxBytes:          { type: 'number', integer: true, min: 1048576, max: 107374182400 },
        diskReserveBytes:  { type: 'number', integer: true, min: 104857600 },
      };
      for (const [k, spec] of Object.entries(UPL)) {
        if (input.uploads[k] !== undefined) validateField(`uploads.${k}`, input.uploads[k], spec, errors);
      }
      if (input.uploads.allowedExtensions !== undefined) {
        if (!isArray(input.uploads.allowedExtensions))
          errors.push(fieldErr('uploads.allowedExtensions', 'must be an array'));
      }
    }
  }

  // ── disk ──
  if (input.disk !== undefined) {
    validateSection('disk', input.disk, DISK_SCHEMA, errors);
    if (isObject(input.disk)) {
      const d = input.disk;
      if (d.warnPercent !== undefined && d.criticalPercent !== undefined && d.warnPercent >= d.criticalPercent)
        errors.push('disk.criticalPercent must be > disk.warnPercent');
      if (d.criticalPercent !== undefined && d.emergencyPercent !== undefined && d.criticalPercent >= d.emergencyPercent)
        errors.push('disk.emergencyPercent must be > disk.criticalPercent');
    }
  }

  // ── logs ──
  if (input.logs !== undefined) validateSection('logs', input.logs, LOGS_SCHEMA, errors);

  // ── backups ──
  if (input.backups !== undefined) validateSection('backups', input.backups, BACKUPS_SCHEMA, errors);

  // ── ui ──
  if (input.ui !== undefined) validateSection('ui', input.ui, UI_SCHEMA, errors);

  // ── Cross-validations (non-partial only) ──
  if (!partial && input.bandwidth) {
    const bw  = input.bandwidth;
    const base = bw.unitBase ?? 1000;
    const limitTB = bw.safetyLimitGB != null
      ? bw.safetyLimitGB / (base === 1024 ? 1024 : 1000)
      : bw.safetyLimitTB;
    if (limitTB != null && bw.monthlyAllowanceTB != null && limitTB > bw.monthlyAllowanceTB)
      errors.push('bandwidth.safetyLimitTB must be <= bandwidth.monthlyAllowanceTB');
  }

  return { valid: errors.length === 0, errors, requiresRestart };
}

// ─── Standalone validators ────────────────────────────────────────────────────

/**
 * Validate a YouTube stream key string.
 * @param {string} key
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateStreamKey(key) {
  const errs = [];
  if (!isString(key))   { return { valid: false, errors: ['must be a string'] }; }
  const trimmed = key.trim();
  if (trimmed.length < 8)   errs.push('too short (minimum 8 characters)');
  if (trimmed.length > 128) errs.push('too long (maximum 128 characters)');
  if (/\s/.test(trimmed))   errs.push('stream key must not contain spaces');
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) errs.push('contains invalid characters (allowed: A-Z a-z 0-9 _ - .)');
  return { valid: errs.length === 0, errors: errs };
}

/**
 * Validate a generated video ID.
 * @param {string} id
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateVideoId(id) {
  if (isString(id) && /^vid_[a-f0-9]{8}$/.test(id)) return { valid: true, errors: [] };
  return { valid: false, errors: ['invalid video ID format (expected vid_xxxxxxxx)'] };
}

/**
 * Validate an RTMPS URL, with optional test-mode relaxation.
 * @param {string} url
 * @param {boolean} [allowPlainRtmp=false]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRtmpsUrl(url, allowPlainRtmp = false) {
  if (!isString(url)) return { valid: false, errors: ['must be a string'] };
  const rtmpsOk = /^rtmps:\/\//i.test(url);
  const rtmpTestOk = allowPlainRtmp && /^rtmp:\/\/127\.0\.0\.1/i.test(url);
  if (!rtmpsOk && !rtmpTestOk)
    return { valid: false, errors: ['must start with rtmps:// (only rtmp://127.0.0.1 accepted in test mode)'] };
  return { valid: true, errors: [] };
}
