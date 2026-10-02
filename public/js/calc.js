/**
 * public/js/calc.js — Client-side bitrate calculator for live preview.
 * Exact formula mirror of src/bitrate-calculator.js (PRD §6.5).
 */

export function totalMbps(videoMbps, audioKbps = 128) {
  const v = Number(videoMbps) || 0;
  const a = Number(audioKbps) || 0;
  return v + (a / 1000);
}

export function bytesPerSecond(totalMb) {
  return (Number(totalMb) || 0) * 1_000_000 / 8;
}

export function gbPerHour(totalMb) {
  return (Number(totalMb) || 0) * 3600 / 8 / 1000;
}

export function gbPerDay(totalMb) {
  return gbPerHour(totalMb) * 24;
}

export function gbPer30Days(totalMb) {
  return gbPerDay(totalMb) * 30;
}

export function tbPer30Days(totalMb, unitBase = 1000) {
  const base = Number(unitBase) === 1024 ? 1024 : 1000;
  return gbPer30Days(totalMb) / base;
}

export function withOverhead(val, overheadPercent = 10) {
  const v = Number(val) || 0;
  const p = Number(overheadPercent) || 0;
  return v * (1 + p / 100);
}

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
