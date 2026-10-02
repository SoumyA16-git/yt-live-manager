/**
 * bitrate-calculator.js — Pure bandwidth math. Single source of truth.
 *
 * PRD §6:
 * - Pure functions, NO I/O.
 * - Single source of truth for every bandwidth number in UI and API.
 * - Units: 1 GB = 10^9 bytes, 1 TB = 10^12 bytes by default (unitBase = 1000).
 * - Overhead factor (default 10%) models TCP/TLS/RTMP/FLV framing.
 * - All reference values must match §6.3 table.
 */

/**
 * Return total Mbps from video Mbps and audio Kbps.
 * total_mbps = video_mbps + audio_kbps / 1000
 */
export function totalMbps(videoMbps, audioKbps = 128) {
  const v = Number(videoMbps) || 0;
  const a = Number(audioKbps) || 0;
  return v + (a / 1000);
}

/**
 * bytes_per_second = total_mbps * 1,000,000 / 8
 */
export function bytesPerSecond(totalMb) {
  return (Number(totalMb) || 0) * 1_000_000 / 8;
}

/**
 * GB_per_hour = total_mbps * 3600 / 8 / 1000
 */
export function gbPerHour(totalMb) {
  return (Number(totalMb) || 0) * 3600 / 8 / 1000;
}

/**
 * GB_per_day = GB_per_hour * 24
 */
export function gbPerDay(totalMb) {
  return gbPerHour(totalMb) * 24;
}

/**
 * GB_per_30_days = GB_per_day * 30
 */
export function gbPer30Days(totalMb) {
  return gbPerDay(totalMb) * 30;
}

/**
 * TB_per_30_days = GB_per_30_days / unitBase
 */
export function tbPer30Days(totalMb, unitBase = 1000) {
  const base = Number(unitBase) === 1024 ? 1024 : 1000;
  return gbPer30Days(totalMb) / base;
}

/**
 * with_overhead(x) = x * (1 + overheadPercent / 100)
 */
export function withOverhead(val, overheadPercent = 10) {
  const v = Number(val) || 0;
  const p = Number(overheadPercent) || 0;
  return v * (1 + p / 100);
}

/**
 * Convert bytes to GB using unitBase.
 */
export function bytesToGB(bytes, unitBase = 1000) {
  const b = Number(bytes) || 0;
  const base = Number(unitBase) === 1024 ? 1024 : 1000;
  return b / Math.pow(base, 3);
}

/**
 * Convert bytes to TB using unitBase.
 */
export function bytesToTB(bytes, unitBase = 1000) {
  const b = Number(bytes) || 0;
  const base = Number(unitBase) === 1024 ? 1024 : 1000;
  return b / Math.pow(base, 4);
}

/**
 * Convert GB to bytes using unitBase.
 */
export function gbToBytes(gb, unitBase = 1000) {
  const g = Number(gb) || 0;
  const base = Number(unitBase) === 1024 ? 1024 : 1000;
  return Math.round(g * Math.pow(base, 3));
}

/**
 * Convert TB to bytes using unitBase.
 */
export function tbToBytes(tb, unitBase = 1000) {
  const t = Number(tb) || 0;
  const base = Number(unitBase) === 1024 ? 1024 : 1000;
  return Math.round(t * Math.pow(base, 4));
}

/**
 * Format bytes into human-readable string (e.g. "2.45 TB", "850.2 GB").
 */
export function formatBytes(bytes, unitBase = 1000, decimals = 2) {
  const b = Number(bytes) || 0;
  const base = Number(unitBase) === 1024 ? 1024 : 1000;
  const units = base === 1024
    ? ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    : ['B', 'KB', 'MB', 'GB', 'TB'];

  if (b === 0) return `0 ${units[0]}`;
  const i = Math.min(Math.floor(Math.log(b) / Math.log(base)), units.length - 1);
  const val = b / Math.pow(base, i);
  return `${val.toFixed(decimals)} ${units[i]}`;
}

/**
 * Calculate complete set of bitrate and bandwidth metrics for given config.
 *
 * @param {object} params
 * @param {number} params.videoBitrateMbps
 * @param {number} [params.audioBitrateKbps=128]
 * @param {number} [params.overheadPercent=10]
 * @param {number} [params.unitBase=1000]
 * @returns {object}
 */
export function calculateBitrateMetrics({
  videoBitrateMbps,
  audioBitrateKbps = 128,
  overheadPercent = 10,
  unitBase = 1000,
}) {
  const totMbps = totalMbps(videoBitrateMbps, audioBitrateKbps);
  const bps     = bytesPerSecond(totMbps);
  const gbHr    = gbPerHour(totMbps);
  const gbDay   = gbPerDay(totMbps);
  const gb30d   = gbPer30Days(totMbps);
  const tb30d   = tbPer30Days(totMbps, unitBase);

  const bpsWithOverhead   = withOverhead(bps, overheadPercent);
  const gbHrWithOverhead  = withOverhead(gbHr, overheadPercent);
  const gbDayWithOverhead = withOverhead(gbDay, overheadPercent);
  const gb30dWithOverhead = withOverhead(gb30d, overheadPercent);
  const tb30dWithOverhead = withOverhead(tb30d, overheadPercent);

  return {
    videoBitrateMbps: Number(videoBitrateMbps) || 0,
    audioBitrateKbps: Number(audioBitrateKbps) || 0,
    totalMbps: totMbps,
    overheadPercent: Number(overheadPercent) || 0,
    unitBase: Number(unitBase) === 1024 ? 1024 : 1000,

    payload: {
      bytesPerSecond: bps,
      gbPerHour: gbHr,
      gbPerDay: gbDay,
      gbPer30Days: gb30d,
      tbPer30Days: tb30d,
    },
    withOverhead: {
      bytesPerSecond: bpsWithOverhead,
      gbPerHour: gbHrWithOverhead,
      gbPerDay: gbDayWithOverhead,
      gbPer30Days: gb30dWithOverhead,
      tbPer30Days: tb30dWithOverhead,
    },
  };
}
