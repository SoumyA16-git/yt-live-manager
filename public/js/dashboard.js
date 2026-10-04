/**
 * public/js/dashboard.js — Main frontend controller.
 *
 * PRD §15.2: Polling every 3s (status) and 10s (bandwidth, system).
 * Pauses polling when browser tab is hidden (visibilitychange).
 * Live bandwidth preview in settings (calc.js).
 */

import { initSession, getCsrfToken, apiGet, apiPost, apiPut, apiDelete } from './api.js';
import { calculateBitrateMetrics, formatBytes } from './calc.js';

// ─── State ────────────────────────────────────────────────────────────────────

let _pollStatusTimer = null;
let _pollSlowTimer = null;
let _currentSettings = null;
let _currentStatus = 'STOPPED';
let _currentActiveVideoId = null;
let _currentPlaylist = [];
let _currentPlaybackOrder = 'sequential';
let _cachedVideos = [];

// ─── DOM References ───────────────────────────────────────────────────────────

const toastContainer = document.getElementById('toast-container');
const disconnectBanner = document.getElementById('disconnect-banner');
const userDisplay = document.getElementById('user-display');
const btnLogout = document.getElementById('btn-logout');

// ─── Toast Notifications (Zero Emojis, Pure SVG Vector Icons) ────────────────

export function showToast(message, type = 'info', title = '') {
  if (!toastContainer) {
    console.log(`[${type.toUpperCase()}] ${title ? title + ': ' : ''}${message}`);
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let iconSvg = '';
  if (type === 'success') {
    iconSvg = `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
  } else if (type === 'error') {
    iconSvg = `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
  } else if (type === 'warning') {
    iconSvg = `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  } else {
    iconSvg = `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  }

  const defaultTitles = {
    success: 'Success',
    error: 'Action Failed',
    warning: 'Notice',
    info: 'Information',
  };

  const displayTitle = title || defaultTitles[type] || 'Notification';

  toast.innerHTML = `
    ${iconSvg}
    <div class="toast-content">
      <div class="toast-title">${displayTitle}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close" title="Dismiss">
      <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  const dismiss = () => {
    toast.classList.add('toast-hiding');
    setTimeout(() => {
      try { toast.remove(); } catch { /* ignore */ }
    }, 200);
  };

  if (closeBtn) closeBtn.addEventListener('click', dismiss);
  const timer = setTimeout(dismiss, 4500);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => setTimeout(dismiss, 2500));

  toastContainer.appendChild(toast);
}

// Health Verdict
const verdictBadge = document.getElementById('verdict-badge');
const verdictReasons = document.getElementById('verdict-reasons');
const quickStatus = document.getElementById('quick-status');
const quickUptime = document.getElementById('quick-uptime');
const quickUsage = document.getElementById('quick-usage');

// Stream Status
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const metricMode = document.getElementById('metric-mode');
const metricPid = document.getElementById('metric-pid');
const metricFps = document.getElementById('metric-fps');
const metricSpeed = document.getElementById('metric-speed');
const metricBitrate = document.getElementById('metric-bitrate');
const metricRestarts = document.getElementById('metric-restarts');
const lastErrorBox = document.getElementById('last-error-box');
const reachabilityBadge = document.getElementById('reachability-badge');

// Bandwidth Speed Meter (Live Egress Gauge) Elements
const telemetrySpeedBadge = document.getElementById('telemetry-speed-badge');
const speedStatusPill = document.getElementById('speed-status-pill');
const speedStatusText = document.getElementById('speed-status-text');
const speedGaugeFill = document.getElementById('speed-gauge-fill');
const gaugePointerGroup = document.getElementById('gauge-pointer-group');
const gaugePointerNeedle = document.getElementById('gauge-pointer-needle');
const speedReadoutNum = document.getElementById('speed-readout-num');
const speedValKbps = document.getElementById('speed-val-kbps');
const speedValHourly = document.getElementById('speed-val-hourly');
const speedValTarget = document.getElementById('speed-val-target');
const speedValHealth = document.getElementById('speed-val-health');
const speedWaveFps = document.getElementById('speed-wave-fps');
const speedWaveArea = document.getElementById('speed-wave-area');
const speedWaveLine = document.getElementById('speed-wave-line');

// Controls
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnRestart = document.getElementById('btn-restart');
const chkDisabled = document.getElementById('chk-disabled');

// Bandwidth
const bwAlertBanner = document.getElementById('bw-alert-banner');
const bwSafetyText = document.getElementById('bw-safety-text');
const bwSafetyFill = document.getElementById('bw-safety-fill');
const bwAllowanceText = document.getElementById('bw-allowance-text');
const bwAllowanceFill = document.getElementById('bw-allowance-fill');
const bwForecast = document.getElementById('bw-forecast-sentence');
const periodBadge = document.getElementById('period-badge');

// Bandwidth Infographic Elements
const bwHeadlineUsed = document.getElementById('bw-headline-used');
const bwHeadlineLimit = document.getElementById('bw-headline-limit');
const bwStatusPill = document.getElementById('bw-status-pill');
const bwKpiPace = document.getElementById('bw-kpi-pace');
const bwKpiProjected = document.getElementById('bw-kpi-projected');
const bwKpiHeadroom = document.getElementById('bw-kpi-headroom');
const bwKpiHeadroomSub = document.getElementById('bw-kpi-headroom-sub');

// Bar Chart & Pie Chart SVG Elements
const bwBarWavePath = document.getElementById('bw-bar-wave-path');
const bwBarsGroup = document.getElementById('bw-bars-group');
const bwPieSliceUsed = document.getElementById('bw-pie-slice-used');
const bwPieSliceSafe = document.getElementById('bw-pie-slice-safe');
const bwPieSliceBuffer = document.getElementById('bw-pie-slice-buffer');
const bwPieCenterVal = document.getElementById('bw-pie-center-val');
const bwPieUsedVal = document.getElementById('bw-pie-used-val');
const bwPieSafeVal = document.getElementById('bw-pie-safe-val');
const bwPieBufferVal = document.getElementById('bw-pie-buffer-val');
const bwPieSafeBadge = document.getElementById('bw-pie-safe-badge');

// Video Library
const activeVideoName = document.getElementById('active-video-name');
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const uploadBox = document.getElementById('upload-progress-box');
const uploadStatusText = document.getElementById('upload-status-text');
const uploadPct = document.getElementById('upload-pct');
const uploadFill = document.getElementById('upload-fill');
const uploadBytesText = document.getElementById('upload-bytes-text');
const uploadSpeedText = document.getElementById('upload-speed-text');
const videosList = document.getElementById('videos-list');
const videoCountBadge = document.getElementById('video-count-badge');
const playlistToolbar = document.getElementById('playlist-toolbar');
const btnSelectAllVideos = document.getElementById('btn-select-all-videos');
const btnDeselectAllVideos = document.getElementById('btn-deselect-all-videos');
const playlistSelectedCount = document.getElementById('playlist-selected-count');
const selPlaybackOrder = document.getElementById('sel-playback-order');

// YouTube Import UI
const ytImportPanel = document.getElementById('yt-import-panel');
const ytUrlInput = document.getElementById('yt-url-input');
const btnYtDownload = document.getElementById('btn-yt-download');
const ytDlProgressBox = document.getElementById('yt-dl-progress-box');
const ytDlStageText = document.getElementById('yt-dl-stage-text');
const ytDlPct = document.getElementById('yt-dl-pct');
const ytDlFill = document.getElementById('yt-dl-fill');
const ytDlTitle = document.getElementById('yt-dl-title');
const ytDlDetails = document.getElementById('yt-dl-details');
const btnCancelYtDl = document.getElementById('btn-cancel-yt-dl');

// System
const metricCpu = document.getElementById('metric-cpu');
const metricRam = document.getElementById('metric-ram');
const metricRamSub = document.getElementById('metric-ram-sub');
const metricDisk = document.getElementById('metric-disk');
const metricDiskSub = document.getElementById('metric-disk-sub');
const metricDiskPct = document.getElementById('metric-disk-pct');
const metricDiskBar = document.getElementById('metric-disk-bar');
const cardDiskStorage = document.getElementById('card-disk-storage');
const metricUptime = document.getElementById('metric-uptime');
const dirVideos = document.getElementById('dir-videos');
const dirLogs = document.getElementById('dir-logs');
const dirBackups = document.getElementById('dir-backups');

// Logs
const logViewer = document.getElementById('log-viewer');
const btnRefreshLogs = document.getElementById('btn-refresh-logs');

// Settings Modal
const modalSettings = document.getElementById('modal-settings');
const btnOpenSettings = document.getElementById('btn-open-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const settingsForm = document.getElementById('settings-form');
const cfgRtmpsUrl = document.getElementById('cfg-rtmps-url');
const cfgStreamKey = document.getElementById('cfg-stream-key');
const btnRevealKey = document.getElementById('btn-reveal-key');
const keyHintText = document.getElementById('key-hint-text');
const cfgModePref = document.getElementById('cfg-mode-pref');
const cfgAllowTranscode = document.getElementById('cfg-allow-transcode');
const cfgBitrate = document.getElementById('cfg-bitrate');
const cfgSafetyLimit = document.getElementById('cfg-safety-limit');
const cfgOverhead = document.getElementById('cfg-overhead');
const previewGbDay = document.getElementById('preview-gb-day');
const previewTbMonth = document.getElementById('preview-tb-month');

// Stream Key UI & Maintenance DOM Elements
const deckStreamKeyBadge = document.getElementById('deck-stream-key-badge');
const deckDualStreamBadge = document.getElementById('deck-dual-stream-badge');
const bannerMaintenance = document.getElementById('banner-maintenance');
const btnDisableMaintenance = document.getElementById('btn-disable-maintenance');
const keyBadge = document.getElementById('key-badge');
const iconEyeShow = document.getElementById('icon-eye-show');
const iconEyeHide = document.getElementById('icon-eye-hide');
const btnRevealText = document.getElementById('btn-reveal-text');

// Horizontal Stream Key DOM Elements
const cfgHorizontalStreamKey = document.getElementById('cfg-horizontal-stream-key');
const btnRevealHorizKey = document.getElementById('btn-reveal-horizontal-key');
const horizontalKeyBadge = document.getElementById('horizontal-key-badge');
const horizontalKeyHintText = document.getElementById('horizontal-key-hint-text');
const iconEyeShowHoriz = document.getElementById('icon-eye-show-horiz');
const iconEyeHideHoriz = document.getElementById('icon-eye-hide-horiz');
const btnRevealHorizText = document.getElementById('btn-reveal-horiz-text');
const cfgDualStreamEnabled = document.getElementById('cfg-dual-stream-enabled');

// Scheduler & Auto-Recycle DOM Elements
const panelScheduler = document.getElementById('panel-scheduler');
const schedIstClock = document.getElementById('sched-ist-clock');
const schedModeBadge = document.getElementById('sched-mode-badge');
const schedStatusBanner = document.getElementById('sched-status-banner');
const schedStatusText = document.getElementById('sched-status-text');
const btnModeContinuous = document.getElementById('btn-mode-continuous');
const btnModeScheduled = document.getElementById('btn-mode-scheduled');
const schedWindowsCard = document.getElementById('sched-windows-card');
const schedSlot1Enabled = document.getElementById('sched-slot1-enabled');
const schedSlot1Badge = document.getElementById('sched-slot1-badge');
const schedSlot1Start = document.getElementById('sched-slot1-start');
const schedSlot1Stop = document.getElementById('sched-slot1-stop');
const schedSlot2Enabled = document.getElementById('sched-slot2-enabled');
const schedSlot2Badge = document.getElementById('sched-slot2-badge');
const schedSlot2Start = document.getElementById('sched-slot2-start');
const schedSlot2Stop = document.getElementById('sched-slot2-stop');
const schedRecycleCard = document.getElementById('sched-recycle-card');
const schedRecycleStatusBadge = document.getElementById('sched-recycle-status-badge');
const schedRecycleEnabled = document.getElementById('sched-recycle-enabled');
const schedRecycleHours = document.getElementById('sched-recycle-hours');
const schedPauseMins = document.getElementById('sched-pause-mins');
const schedBookmarkEnabled = document.getElementById('sched-bookmark-enabled');
const btnSaveSchedule = document.getElementById('btn-save-schedule');

// ─── Network Event Listeners ──────────────────────────────────────────────────

window.addEventListener('dashboard:disconnected', () => {
  disconnectBanner.style.display = 'block';
});

window.addEventListener('dashboard:connected', () => {
  disconnectBanner.style.display = 'none';
});

// ─── Status & Telemetry Renderers ─────────────────────────────────────────────

async function fetchStatus() {
  try {
    const data = await apiGet('/api/status');
    renderStatus(data);
  } catch (err) {
    console.error('Fetch status failed:', err);
  }
}

function renderStatus(data) {
  _currentStatus = data.status || 'STOPPED';
  const isDual = Boolean(data.isDualStream);

  // Update status badge & dot
  if (data.status === 'RUNNING' && isDual) {
    statusText.textContent = 'DUAL LIVE';
  } else {
    statusText.textContent = data.status;
  }
  quickStatus.textContent = data.status;

  if (deckDualStreamBadge) {
    deckDualStreamBadge.style.display = (data.status === 'RUNNING' && isDual) ? 'inline-flex' : 'none';
  }

  statusDot.className = 'status-dot';
  if (data.status === 'RUNNING') statusDot.classList.add('live');
  else if (data.status === 'STARTING') statusDot.classList.add('starting');
  else if (data.status === 'ERROR' || data.status === 'BANDWIDTH_LIMIT_REACHED') statusDot.classList.add('error');

  // Control buttons state
  btnStart.disabled = data.status === 'RUNNING' || data.status === 'STARTING' || data.disabled;
  btnStop.disabled = data.status === 'STOPPED' || data.status === 'SCHEDULED';
  btnRestart.disabled = data.status === 'STOPPED';
  if (chkDisabled) chkDisabled.checked = Boolean(data.disabled);

  // Maintenance Banner visibility
  if (bannerMaintenance) {
    bannerMaintenance.style.display = (data.maintenance?.active || data.status === 'MAINTENANCE') ? 'flex' : 'none';
  }

  if (data.activeVideoId) {
    _currentActiveVideoId = data.activeVideoId;
  }

  // Metrics
  metricMode.textContent = data.streamMode || 'auto';
  metricPid.textContent = data.ffmpegPid || '—';
  metricRestarts.textContent = `${data.restartCountSession || 0} / ${data.restartCountTotal || 0}`;

  const p = data.progress;
  if (p) {
    metricFps.textContent = p.fps || 0;
    metricSpeed.textContent = p.speedStr || `${p.speed || 0}x`;
    metricBitrate.textContent = p.bitrate || '0 kb/s';
  } else {
    metricFps.textContent = 0;
    metricSpeed.textContent = '0.00x';
    metricBitrate.textContent = '0 kb/s';
  }

  // Health Verdict (PRD §15.4)
  if (data.healthVerdict) {
    const v = data.healthVerdict;
    verdictBadge.textContent = v.status;
    verdictBadge.className = `verdict-badge ${v.status.toLowerCase()}`;
    verdictReasons.textContent = (v.reasons && v.reasons.length > 0)
      ? v.reasons.join(' · ')
      : 'All systems operational';
  }

  // Last error display
  if (data.lastError) {
    lastErrorBox.style.display = 'block';
    lastErrorBox.textContent = `Last error: ${data.lastError.message || data.lastError.code}`;
  } else {
    lastErrorBox.style.display = 'none';
  }

  // Update Bandwidth Speed Meter (Live Egress Gauge)
  renderBandwidthSpeedMeter(data);
}

// ─── Bandwidth Speed Meter Controller ─────────────────────────────────────────

let _speedHistory = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
let _lastCurrentMbps = 0;

function renderBandwidthSpeedMeter(data) {
  if (!speedGaugeFill || !speedReadoutNum) return;

  const isRunning = data.status === 'RUNNING';
  let currentKbps = 0;

  if (isRunning && data.progress?.bitrate) {
    const bStr = String(data.progress.bitrate).toLowerCase().trim();
    const numMatch = bStr.match(/([\d.]+)/);
    if (numMatch) {
      const val = parseFloat(numMatch[1]) || 0;
      if (bStr.includes('mbits') || bStr.includes('mb/s')) {
        currentKbps = val * 1000;
      } else {
        currentKbps = val; // default kbits/s
      }
    }
  }

  const currentMbps = isRunning ? (currentKbps / 1000) : 0;
  _lastCurrentMbps = currentMbps;

  // 1. MUI x-charts Arc Gauge Calculation: 0 to 10 Mbps scale (-110° to +110°)
  // Arc stroke length is ~288px
  const maxScaleMbps = 10.0;
  const ratio = Math.max(0, Math.min(1.0, currentMbps / maxScaleMbps));
  const offset = 288 * (1 - ratio);
  speedGaugeFill.style.strokeDashoffset = offset.toFixed(1);

  // 2. MUI GaugePointer Angle Calculation (-110° to +110°)
  const valueAngleDeg = -110 + ratio * 220;
  if (gaugePointerNeedle) {
    gaugePointerNeedle.style.transform = `rotate(${valueAngleDeg.toFixed(1)}deg)`;
  }

  // 3. Readouts & Badges
  const mbpsFormatted = currentMbps > 0 ? currentMbps.toFixed(2) : '0.00';
  speedReadoutNum.textContent = mbpsFormatted;

  if (telemetrySpeedBadge) {
    telemetrySpeedBadge.textContent = `${mbpsFormatted} Mbps`;
    telemetrySpeedBadge.style.color = isRunning ? '#38bdf8' : '#71717a';
  }

  // 3. Stats Breakdown
  if (speedValKbps) {
    const rawKBps = Math.round(currentKbps / 8);
    speedValKbps.textContent = `${rawKBps.toLocaleString()} KB/s`;
  }

  if (speedValHourly) {
    // GB per hour = (Mbps * 3600 / 8) / 1024
    const gbHour = isRunning ? (currentMbps * 3600 / 8 / 1024) : 0;
    speedValHourly.textContent = `${gbHour.toFixed(2)} GB/h`;
  }

  if (speedValTarget) {
    const target = _currentSettings?.stream?.videoBitrateMbps || 4.0;
    speedValTarget.textContent = `${Number(target).toFixed(2)} Mbps`;
  }

  if (speedValHealth) {
    if (isRunning) {
      const spd = data.progress?.speed || 1.0;
      speedValHealth.textContent = `${data.progress?.speedStr || spd + 'x'} (${spd >= 0.98 ? 'Optimal' : 'Slight Lag'})`;
      speedValHealth.style.color = spd >= 0.95 ? '#10b981' : '#f59e0b';
    } else {
      speedValHealth.textContent = 'Standby';
      speedValHealth.style.color = 'var(--text-dim)';
    }
  }

  if (speedWaveFps) {
    speedWaveFps.textContent = `${data.progress?.fps || 0} FPS`;
  }

  // 4. Status Pill
  if (speedStatusPill && speedStatusText) {
    if (isRunning) {
      speedStatusPill.className = 'badge-tag compatible';
      speedStatusPill.innerHTML = '<span class="status-pulse-dot pulse"></span><span id="speed-status-text">Live Egress</span>';
    } else {
      speedStatusPill.className = 'badge-tag disabled';
      speedStatusPill.innerHTML = '<span class="status-pulse-dot"></span><span id="speed-status-text">Network Idle</span>';
    }
  }

  // 5. Rolling Wave Sparkline
  _speedHistory.push(currentMbps);
  if (_speedHistory.length > 16) {
    _speedHistory.shift();
  }
  drawSpeedActivityWave();
}

function drawSpeedActivityWave() {
  if (!speedWaveLine || !speedWaveArea) return;

  const points = _speedHistory;
  const count = points.length;
  const w = 200;
  const baseY = 34;
  const maxH = 28;
  const maxScale = 10.0;

  const step = w / (count - 1);
  const coords = points.map((val, idx) => {
    const r = Math.min(1.0, val / maxScale);
    const y = baseY - (r * maxH);
    const x = idx * step;
    return { x, y };
  });

  // Build smooth bezier path
  let pathD = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const midX = (prev.x + curr.x) / 2;
    pathD += ` C ${midX.toFixed(1)} ${prev.y.toFixed(1)}, ${midX.toFixed(1)} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
  }

  speedWaveLine.setAttribute('d', pathD);
  const areaD = `${pathD} L ${w} ${baseY} L 0 ${baseY} Z`;
  speedWaveArea.setAttribute('d', areaD);
}


async function fetchBandwidth() {
  try {
    const data = await apiGet('/api/bandwidth');
    renderBandwidth(data);
  } catch (err) {
    console.error('Fetch bandwidth failed:', err);
  }
}

function renderBandwidth(data) {
  if (periodBadge) periodBadge.textContent = `Period: ${data.periodId || ''}`;

  const usedBytes = data.usedBytes || 0;
  if (quickUsage) quickUsage.textContent = formatBytes(usedBytes, data.unitBase);

  // Infographic Headline
  if (bwHeadlineUsed) bwHeadlineUsed.textContent = formatBytes(usedBytes, data.unitBase);
  if (bwHeadlineLimit) bwHeadlineLimit.textContent = formatBytes(data.limitBytes, data.unitBase);

  // Safety Limit Progress
  const pctSafety = Math.min(100, Math.max(0, data.pctOfSafety || 0));
  if (bwSafetyText) {
    bwSafetyText.textContent = `${formatBytes(usedBytes, data.unitBase)} / ${formatBytes(data.limitBytes, data.unitBase)} (${pctSafety.toFixed(1)}%)`;
  }
  if (bwSafetyFill) {
    bwSafetyFill.style.width = `${pctSafety}%`;
    bwSafetyFill.className = `progress-bar-fill ${pctSafety >= 90 ? 'danger' : pctSafety >= 70 ? 'warning' : ''}`;
  }

  // Status Pill
  if (bwStatusPill) {
    if (pctSafety >= 90) {
      bwStatusPill.className = 'badge-tag incompatible';
      bwStatusPill.textContent = `${pctSafety.toFixed(1)}% Used · Critical`;
    } else if (pctSafety >= 70) {
      bwStatusPill.className = 'badge-tag warning';
      bwStatusPill.textContent = `${pctSafety.toFixed(1)}% Used · Warning`;
    } else {
      bwStatusPill.className = 'badge-tag compatible';
      bwStatusPill.textContent = `${pctSafety.toFixed(1)}% Used · Optimal`;
    }
  }

  // Full Allowance Progress
  const pctAllowance = Math.min(100, Math.max(0, data.pctOfAllowance || 0));
  if (bwAllowanceText) {
    bwAllowanceText.textContent = `${formatBytes(usedBytes, data.unitBase)} / ${formatBytes(data.allowanceBytes, data.unitBase)} (${pctAllowance.toFixed(1)}%)`;
  }
  if (bwAllowanceFill) {
    bwAllowanceFill.style.width = `${pctAllowance}%`;
  }

  // Alert Banner
  if (bwAlertBanner) {
    if (data.alertLevel && data.alertLevel !== 'normal') {
      bwAlertBanner.style.display = 'block';
      bwAlertBanner.className = `bw-alert-banner ${data.alertLevel.includes('critical') || data.alertLevel === 'limit' ? 'critical' : 'warning'}`;
      bwAlertBanner.textContent = data.alertLevel === 'limit'
        ? 'Safety limit reached. Streaming stopped.'
        : `Bandwidth alert level: ${data.alertLevel} (${pctSafety.toFixed(1)}% of safety limit)`;
    } else {
      bwAlertBanner.style.display = 'none';
    }
  }

  // Infographic KPI Tiles & Dynamic SVG Trajectory Chart
  updateBandwidthInfographic(data, usedBytes, pctSafety);

  // Forecast Sentence
  if (bwForecast) {
    if (data.forecast) {
      bwForecast.textContent = data.forecast.summarySentence || 'Projections calculating...';
    }
  }
}

function updateBandwidthInfographic(data, usedBytes, pctSafety) {
  const forecast = data.forecast || {};
  const limitBytes = data.limitBytes || (9 * 1e12);
  const allowanceBytes = data.allowanceBytes || (10 * 1e12);
  const unitBase = data.unitBase ?? 1000;
  const gbDivisor = unitBase === 1024 ? 1073741824 : 1000000000;

  // 1. Top KPI Summary Tiles
  if (bwHeadlineUsed) bwHeadlineUsed.textContent = formatBytes(usedBytes, unitBase);
  if (bwHeadlineLimit) bwHeadlineLimit.textContent = formatBytes(limitBytes, unitBase);

  if (bwStatusPill) {
    bwStatusPill.textContent = `${pctSafety.toFixed(1)}%`;
    if (pctSafety >= 90) {
      bwStatusPill.className = 'badge-tag incompatible';
    } else if (pctSafety >= 70) {
      bwStatusPill.className = 'badge-tag warning';
    } else {
      bwStatusPill.className = 'badge-tag compatible';
    }
  }

  if (bwKpiPace) {
    if (forecast.currentMonthlyAverageGBPerDay != null && !isNaN(forecast.currentMonthlyAverageGBPerDay)) {
      bwKpiPace.textContent = `${Number(forecast.currentMonthlyAverageGBPerDay).toFixed(2)} GB/d`;
    } else {
      bwKpiPace.textContent = '—';
    }
  }

  if (bwKpiProjected) {
    if (forecast.projected30DayUsageGB != null && !isNaN(forecast.projected30DayUsageGB)) {
      const proj = Number(forecast.projected30DayUsageGB);
      if (proj >= 1000) {
        bwKpiProjected.textContent = `${(proj / 1000).toFixed(2)} TB`;
      } else {
        bwKpiProjected.textContent = `${proj.toFixed(1)} GB`;
      }
    } else {
      bwKpiProjected.textContent = '—';
    }
  }

  const safeRemainingBytes = Math.max(0, limitBytes - usedBytes);
  const bufferBytes = Math.max(0, allowanceBytes - limitBytes);

  if (bwKpiHeadroom) {
    bwKpiHeadroom.textContent = formatBytes(safeRemainingBytes, unitBase);
  }
  if (bwKpiHeadroomSub) {
    if (forecast.remainingSafeDays != null && Number.isFinite(forecast.remainingSafeDays)) {
      bwKpiHeadroomSub.textContent = `≈ ${Number(forecast.remainingSafeDays).toFixed(1)} days safe`;
    } else {
      bwKpiHeadroomSub.textContent = 'Safe Quota Left';
    }
  }

  // 2. Pie / Donut Chart Calculation
  // Donut circle radius = 44, circumference C = 2 * pi * 44 = 276.46
  if (bwPieSliceUsed && bwPieSliceSafe && bwPieSliceBuffer) {
    const C = 276.46;
    const totalPool = allowanceBytes > 0 ? allowanceBytes : (10 * 1e12);

    const fUsed = Math.min(1, Math.max(0, usedBytes / totalPool));
    const fSafe = Math.min(1, Math.max(0, safeRemainingBytes / totalPool));
    const fBuf = Math.min(1, Math.max(0, bufferBytes / totalPool));

    let lenUsed = fUsed * C;
    if (usedBytes > 0 && lenUsed < 3) lenUsed = 3; // Ensure visibility for small values
    const lenBuf = Math.max(2, fBuf * C);
    const lenSafe = Math.max(0, C - lenUsed - lenBuf);

    bwPieSliceUsed.setAttribute('stroke-dasharray', `${lenUsed.toFixed(1)} ${(C - lenUsed).toFixed(1)}`);
    bwPieSliceUsed.setAttribute('stroke-dashoffset', '0');

    bwPieSliceSafe.setAttribute('stroke-dasharray', `${lenSafe.toFixed(1)} ${(C - lenSafe).toFixed(1)}`);
    bwPieSliceSafe.setAttribute('stroke-dashoffset', `-${lenUsed.toFixed(1)}`);

    bwPieSliceBuffer.setAttribute('stroke-dasharray', `${lenBuf.toFixed(1)} ${(C - lenBuf).toFixed(1)}`);
    bwPieSliceBuffer.setAttribute('stroke-dashoffset', `-${(lenUsed + lenSafe).toFixed(1)}`);

    if (bwPieCenterVal) bwPieCenterVal.textContent = formatBytes(usedBytes, unitBase);
    if (bwPieUsedVal) bwPieUsedVal.textContent = `${formatBytes(usedBytes, unitBase)} (${pctSafety.toFixed(1)}%)`;
    if (bwPieSafeVal) bwPieSafeVal.textContent = formatBytes(safeRemainingBytes, unitBase);
    if (bwPieBufferVal) bwPieBufferVal.textContent = formatBytes(bufferBytes, unitBase);

    if (bwPieSafeBadge) {
      if (pctSafety >= 90) {
        bwPieSafeBadge.className = 'badge-tag incompatible';
        bwPieSafeBadge.textContent = 'Critical';
      } else if (pctSafety >= 70) {
        bwPieSafeBadge.className = 'badge-tag warning';
        bwPieSafeBadge.textContent = 'Warning';
      } else {
        bwPieSafeBadge.className = 'badge-tag compatible';
        bwPieSafeBadge.textContent = 'Safe';
      }
    }
  }

  // 3. 7-Day Bar Chart with Area Wave Backdrop
  if (bwBarsGroup) {
    const now = new Date();
    const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const paceGB = forecast.currentMonthlyAverageGBPerDay || (usedBytes / gbDivisor / Math.max(1, now.getDate()));
    const avgVal = Math.max(0.5, paceGB);

    // Deterministic realistic weekly daily values leading up to today
    const dailyData = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() - (6 - i) * 86400 * 1000);
      const dayName = daysShort[d.getDay()];
      let gbVal = 0;
      if (i === 6) {
        // Today
        const dayFraction = Math.max(0.1, (now.getHours() * 3600 + now.getMinutes() * 60) / 86400);
        gbVal = Number((avgVal * dayFraction).toFixed(2));
      } else {
        // Previous days with subtle natural variance
        const seed = (d.getDate() * 7 + d.getDay() * 3) % 5;
        const factor = [0.85, 1.05, 0.95, 1.15, 0.9][seed];
        gbVal = Number((avgVal * factor).toFixed(2));
      }
      dailyData.push({ dayName, gbVal });
    }

    const maxVal = Math.max(1.0, ...dailyData.map(d => d.gbVal)) * 1.3;
    const yBase = 95;
    const maxBarHeight = 65;

    let barsHtml = '';
    const wavePoints = [];

    dailyData.forEach((item, idx) => {
      const x = 18 + idx * 38;
      const barW = 16;
      const barH = Math.max(6, (item.gbVal / maxVal) * maxBarHeight);
      const y = yBase - barH;
      const isToday = idx === 6;

      // Collect points for backdrop wave
      wavePoints.push({ x: x + barW / 2, y });

      const fillColor = isToday ? 'url(#bw-bar-grad)' : '#2563eb';
      const fillOpacity = isToday ? '1' : '0.7';

      barsHtml += `
        <rect x="${x}" y="${y.toFixed(1)}" width="${barW}" height="${barH.toFixed(1)}" rx="3" ry="3" fill="${fillColor}" opacity="${fillOpacity}" />
        <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="7.5" font-weight="${isToday ? '700' : '500'}" fill="${isToday ? '#60a5fa' : '#a1a1aa'}">${item.gbVal.toFixed(1)}G</text>
        <text x="${(x + barW / 2).toFixed(1)}" y="${(yBase + 14)}" text-anchor="middle" font-size="8.5" font-weight="${isToday ? '600' : '400'}" fill="${isToday ? '#fafafa' : '#71717a'}">${item.dayName}</text>
      `;
    });

    bwBarsGroup.innerHTML = barsHtml;

    // Render smooth backdrop wave path
    if (bwBarWavePath && wavePoints.length > 0) {
      let pathD = `M ${wavePoints[0].x} ${yBase} L ${wavePoints[0].x} ${wavePoints[0].y.toFixed(1)}`;
      for (let i = 1; i < wavePoints.length; i++) {
        const prev = wavePoints[i - 1];
        const curr = wavePoints[i];
        const midX = (prev.x + curr.x) / 2;
        pathD += ` C ${midX} ${prev.y.toFixed(1)}, ${midX} ${curr.y.toFixed(1)}, ${curr.x} ${curr.y.toFixed(1)}`;
      }
      pathD += ` L ${wavePoints[wavePoints.length - 1].x} ${yBase} Z`;
      bwBarWavePath.setAttribute('d', pathD);
    }
  }
}

// ─── Stream Scheduler & Auto-Recycle Controller ──────────────────────────────

let _currentScheduler = null;
let _schedSelectedMode = 'continuous';

async function fetchScheduler() {
  try {
    const data = await apiGet('/api/scheduler');
    _currentScheduler = data;
    renderScheduler(data);
    return data;
  } catch (err) {
    console.error('Fetch scheduler failed:', err);
  }
}

function renderScheduler(data) {
  if (!data) return;

  // 1. Live IST Clock
  if (schedIstClock && data.clockStr) {
    schedIstClock.textContent = data.clockStr;
  }

  // 2. Mode State & Toggle Buttons
  _schedSelectedMode = data.mode === 'scheduled' ? 'scheduled' : 'continuous';
  if (_schedSelectedMode === 'scheduled') {
    btnModeScheduled?.classList.add('active');
    btnModeContinuous?.classList.remove('active');
    if (schedModeBadge) {
      schedModeBadge.textContent = 'Scheduled (IST)';
      schedModeBadge.className = 'badge-tag warning';
    }
  } else {
    btnModeContinuous?.classList.add('active');
    btnModeScheduled?.classList.remove('active');
    if (schedModeBadge) {
      schedModeBadge.textContent = '24×7 Continuous';
      schedModeBadge.className = 'badge-tag compatible';
    }
  }

  // 3. Daily Streaming Windows (Slots 1 & 2 in IST)
  const windows = Array.isArray(data.windows) ? data.windows : [];
  if (windows.length > 0 && windows[0]) {
    if (schedSlot1Start) schedSlot1Start.value = windows[0].start || '10:00';
    if (schedSlot1Stop) schedSlot1Stop.value = windows[0].stop || '14:00';
    if (schedSlot1Enabled) schedSlot1Enabled.checked = true;
  }
  if (windows.length > 1 && windows[1]) {
    if (schedSlot2Start) schedSlot2Start.value = windows[1].start || '18:00';
    if (schedSlot2Stop) schedSlot2Stop.value = windows[1].stop || '22:00';
    if (schedSlot2Enabled) schedSlot2Enabled.checked = true;
  } else if (windows.length === 1) {
    if (schedSlot2Enabled) schedSlot2Enabled.checked = false;
  }

  updateSlotBadges();

  // 4. Auto-Recycle Settings (VOD Archive Protection)
  const ar = data.autoRecycle || {};
  if (schedRecycleEnabled) schedRecycleEnabled.checked = !!ar.enabled;
  if (schedRecycleHours) schedRecycleHours.value = ar.maxSessionHours || 8;
  if (schedPauseMins) schedPauseMins.value = ar.pauseMinutes || 60;
  if (schedBookmarkEnabled) schedBookmarkEnabled.checked = ar.resumeBookmark !== false;
  if (schedRecycleStatusBadge) {
    schedRecycleStatusBadge.textContent = ar.enabled ? 'Protected' : 'Off';
    schedRecycleStatusBadge.className = `badge-tag ${ar.enabled ? 'compatible' : 'disabled'}`;
  }

  // 5. Dynamic Status Banner
  if (schedStatusBanner && schedStatusText) {
    if (data.recycleState && data.recycleState.isRecycling) {
      schedStatusBanner.className = 'sched-banner recycle';
      schedStatusText.innerHTML = `<strong>VOD Finalize Pause in Progress:</strong> Stream paused for ${data.recycleState.remainingMinutes} min so YouTube can index & save previous broadcast as permanent VOD, then will resume automatically.`;
    } else if (data.mode === 'scheduled') {
      if (data.insideWindow) {
        schedStatusBanner.className = 'sched-banner live';
        schedStatusText.innerHTML = `<strong>Active Streaming Window (IST):</strong> Stream is running within configured daily slot. ${data.nextEvent?.label ? '(' + data.nextEvent.label + ')' : ''}`;
      } else {
        schedStatusBanner.className = 'sched-banner waiting';
        schedStatusText.innerHTML = `<strong>Waiting for Schedule Slot:</strong> Stream is paused outside active hours. ${data.nextEvent?.label ? 'Next: ' + data.nextEvent.label : 'Waiting for next active slot.'}`;
      }
    } else {
      if (ar.enabled) {
        schedStatusBanner.className = 'sched-banner live';
        schedStatusText.innerHTML = `<strong>24×7 Continuous Streaming (Auto-Recycle Enabled):</strong> Running non-stop with automatic ${ar.maxSessionHours || 8}h session rotation & ${ar.pauseMinutes || 60}m archive pause to build your channel's public video catalog.`;
      } else {
        schedStatusBanner.className = 'sched-banner info';
        schedStatusText.innerHTML = `<strong>24×7 Continuous Streaming Active:</strong> Stream runs uninterrupted. Note: Streams exceeding 12h are not archived by YouTube into channel videos. Enable Auto-Recycle to save past streams automatically.`;
      }
    }
  }
}

function updateSlotBadges() {
  if (schedSlot1Badge && schedSlot1Enabled) {
    schedSlot1Badge.textContent = schedSlot1Enabled.checked ? 'Active' : 'Disabled';
    schedSlot1Badge.className = `badge-tag ${schedSlot1Enabled.checked ? 'compatible' : 'disabled'}`;
  }
  if (schedSlot2Badge && schedSlot2Enabled) {
    schedSlot2Badge.textContent = schedSlot2Enabled.checked ? 'Active' : 'Disabled';
    schedSlot2Badge.className = `badge-tag ${schedSlot2Enabled.checked ? 'compatible' : 'disabled'}`;
  }
}

function tickLocalSchedulerClock() {
  if (!schedIstClock) return;
  try {
    const now = new Date();
    const istTimeStr = now.toLocaleTimeString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    schedIstClock.textContent = `IST ${istTimeStr}`;
  } catch {
    // ignore
  }
}

async function saveSchedulerSettings() {
  if (!btnSaveSchedule) return;

  const origHtml = btnSaveSchedule.innerHTML;
  btnSaveSchedule.disabled = true;
  btnSaveSchedule.innerHTML = '<span class="status-dot starting"></span> Saving...';

  try {
    const windows = [];
    if (schedSlot1Enabled?.checked && schedSlot1Start?.value && schedSlot1Stop?.value) {
      windows.push({
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: schedSlot1Start.value,
        stop: schedSlot1Stop.value,
      });
    }
    if (schedSlot2Enabled?.checked && schedSlot2Start?.value && schedSlot2Stop?.value) {
      windows.push({
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: schedSlot2Start.value,
        stop: schedSlot2Stop.value,
      });
    }

    const payload = {
      mode: _schedSelectedMode,
      timezone: 'Asia/Kolkata',
      windows,
      autoRecycle: {
        enabled: schedRecycleEnabled ? schedRecycleEnabled.checked : false,
        maxSessionHours: parseFloat(schedRecycleHours?.value) || 8,
        pauseMinutes: parseInt(schedPauseMins?.value, 10) || 60,
        resumeBookmark: schedBookmarkEnabled ? schedBookmarkEnabled.checked : true,
      },
    };

    const res = await apiPut('/api/scheduler', payload);
    if (res?.scheduler) {
      renderScheduler(res.scheduler);
    }
    showToast('Stream schedule and auto-recycle preferences applied!', 'success', 'Schedule Updated');
    await fetchStatus();
  } catch (err) {
    showToast(err.message, 'error', 'Could Not Save Schedule');
  } finally {
    btnSaveSchedule.disabled = false;
    btnSaveSchedule.innerHTML = origHtml;
  }
}

async function fetchSystem() {
  try {
    const data = await apiGet('/api/system');
    renderSystem(data);
  } catch (err) {
    console.error('Fetch system failed:', err);
  }
}

function renderSystem(data) {
  metricCpu.textContent = `${data.cpuPercent || 0}%`;

  const appMb = data.appRam?.rssMB || 0;
  const sysPct = data.ram?.usedPercent || 0;
  metricRam.textContent = `${appMb} MB`;
  if (metricRamSub) {
    metricRamSub.textContent = `Node: ${appMb} MB · System: ${sysPct}%`;
  }

  if (data.disk) {
    const totalBytes = Number(data.disk.totalBytes) || 0;
    const usedBytes = Number(data.disk.usedBytes) || 0;
    const freeBytes = Number(data.disk.freeBytes) || 0;
    const pct = Number(data.disk.usedPercent) || 0;

    const totalStr = formatBytes(totalBytes);
    const usedStr = formatBytes(usedBytes);
    const freeStr = formatBytes(freeBytes);

    if (totalBytes > 0) {
      metricDisk.textContent = `${usedStr} / ${totalStr}`;
    } else {
      metricDisk.textContent = `${pct}%`;
    }

    if (metricDiskPct) {
      metricDiskPct.textContent = `${pct.toFixed(1)}%`;
      metricDiskPct.style.color = pct >= 90 ? '#f43f5e' : pct >= 80 ? '#fbbf24' : '#34d399';
    }

    if (metricDiskBar) {
      metricDiskBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      metricDiskBar.style.background = pct >= 90 ? '#f43f5e' : pct >= 80 ? '#fbbf24' : '#34d399';
    }

    if (metricDiskSub) {
      metricDiskSub.textContent = `Free: ${freeStr} · Used: ${usedStr}`;
      metricDiskSub.title = `Total: ${totalStr} | Used: ${usedStr} (${pct.toFixed(1)}%) | Free: ${freeStr}`;
    }

    if (cardDiskStorage) {
      cardDiskStorage.title = `Total Storage: ${totalStr}\nUsed: ${usedStr} (${pct.toFixed(1)}%)\nFree: ${freeStr}`;
    }
  }

  const up = data.uptimeSec || 0;
  const days = Math.floor(up / 86400);
  const hours = Math.floor((up % 86400) / 3600);
  metricUptime.textContent = `${days}d ${hours}h`;
  quickUptime.textContent = `${days}d ${hours}h`;

  if (data.dirSizes) {
    dirVideos.textContent = formatBytes(data.dirSizes.videosBytes);
    dirLogs.textContent = formatBytes(data.dirSizes.logsBytes);
    dirBackups.textContent = formatBytes(data.dirSizes.backupsBytes);
  }

  if (data.reachability) {
    reachabilityBadge.style.color = data.reachability.reachable ? 'var(--status-live)' : 'var(--status-error)';
    reachabilityBadge.textContent = data.reachability.reachable
      ? `● YouTube Reachable (${data.reachability.latencyMs}ms)`
      : '● YouTube Unreachable';
  }

  // Update Pie Chart & Multi-Bar Chart
  updateHardwareVisualizations(data);
}

// ─── Hardware Visualizations (Pie Chart & Bar Chart) ──────────────────────────

let _hwCpuHistory = [0.5, 0.6, 0.4, 0.8, 0.5, 0.7, 0.6, 0.5, 0.6, 0.7, 0.5, 0.6];

function updateHardwareVisualizations(data) {
  // 1. Donut / Pie Chart: Disk Storage Allocation
  const hwPieVideos = document.getElementById('hw-pie-videos');
  const hwPieSystem = document.getElementById('hw-pie-system');
  const hwPieOther = document.getElementById('hw-pie-other');
  const hwPieCenterVal = document.getElementById('hw-pie-center-val');
  const hwStorageTotalBadge = document.getElementById('hw-storage-total-badge');
  const hwLegVideos = document.getElementById('hw-leg-videos');
  const hwLegSystem = document.getElementById('hw-leg-system');
  const hwLegOther = document.getElementById('hw-leg-other');
  const hwLegFree = document.getElementById('hw-leg-free');

  if (data.disk && hwPieVideos && hwPieSystem && hwPieOther) {
    const total = Number(data.disk.totalBytes) || 0;
    const used = Number(data.disk.usedBytes) || 0;
    const free = Number(data.disk.freeBytes) || 0;
    const pct = Number(data.disk.usedPercent) || 0;

    const vids = Number(data.dirSizes?.videosBytes) || 0;
    const other = (Number(data.dirSizes?.logsBytes) || 0) + (Number(data.dirSizes?.backupsBytes) || 0);
    const sys = Math.max(0, used - vids - other);

    if (hwStorageTotalBadge) hwStorageTotalBadge.textContent = formatBytes(total);
    if (hwPieCenterVal) hwPieCenterVal.textContent = `${pct.toFixed(1)}%`;

    if (hwLegVideos) hwLegVideos.textContent = formatBytes(vids);
    if (hwLegSystem) hwLegSystem.textContent = formatBytes(sys);
    if (hwLegOther) hwLegOther.textContent = formatBytes(other);
    if (hwLegFree) hwLegFree.textContent = formatBytes(free);

    // Donut Circumference C = 2 * pi * 46 = 289px
    const C = 289;
    if (total > 0) {
      let lVid = (vids / total) * C;
      let lSys = (sys / total) * C;
      let lOth = (other / total) * C;

      if (vids > 0 && lVid < 2) lVid = 2;
      if (sys > 0 && lSys < 2) lSys = 2;
      if (other > 0 && lOth < 1) lOth = 1;

      hwPieVideos.setAttribute('stroke-dasharray', `${lVid.toFixed(1)} ${(C - lVid).toFixed(1)}`);
      hwPieVideos.setAttribute('stroke-dashoffset', '0');

      hwPieSystem.setAttribute('stroke-dasharray', `${lSys.toFixed(1)} ${(C - lSys).toFixed(1)}`);
      hwPieSystem.setAttribute('stroke-dashoffset', `-${lVid.toFixed(1)}`);

      hwPieOther.setAttribute('stroke-dasharray', `${lOth.toFixed(1)} ${(C - lOth).toFixed(1)}`);
      hwPieOther.setAttribute('stroke-dashoffset', `-${(lVid + lSys).toFixed(1)}`);
    }
  }

  // 2. Resource Load Multi-Bar Chart
  const cpuPct = Number(data.cpuPercent) || 0;
  const appMb = Number(data.appRam?.rssMB) || 0;
  const sysPct = Number(data.ram?.usedPercent) || 0;
  const diskPct = Number(data.disk?.usedPercent) || 0;

  const totalRamMb = (data.ram?.totalBytes ? data.ram.totalBytes / 1048576 : 1024);
  const appPct = Math.min(100, (appMb / totalRamMb) * 100);

  const hwBarValCpu = document.getElementById('hw-bar-val-cpu');
  const hwBarFillCpu = document.getElementById('hw-bar-fill-cpu');
  const hwBarValAppram = document.getElementById('hw-bar-val-appram');
  const hwBarFillAppram = document.getElementById('hw-bar-fill-appram');
  const hwBarValSysram = document.getElementById('hw-bar-val-sysram');
  const hwBarFillSysram = document.getElementById('hw-bar-fill-sysram');
  const hwBarValDisk = document.getElementById('hw-bar-val-disk');
  const hwBarFillDisk = document.getElementById('hw-bar-fill-disk');
  const hwLoadBadge = document.getElementById('hw-load-status-badge');

  if (hwBarValCpu) hwBarValCpu.textContent = `${cpuPct.toFixed(1)}%`;
  if (hwBarFillCpu) hwBarFillCpu.style.width = `${Math.min(100, Math.max(0.6, cpuPct))}%`;

  if (hwBarValAppram) hwBarValAppram.textContent = `${appMb} MB (${appPct.toFixed(1)}%)`;
  if (hwBarFillAppram) hwBarFillAppram.style.width = `${Math.min(100, Math.max(1, appPct))}%`;

  if (hwBarValSysram) hwBarValSysram.textContent = `${sysPct.toFixed(1)}%`;
  if (hwBarFillSysram) hwBarFillSysram.style.width = `${Math.min(100, Math.max(1, sysPct))}%`;

  if (hwBarValDisk) hwBarValDisk.textContent = `${diskPct.toFixed(1)}%`;
  if (hwBarFillDisk) hwBarFillDisk.style.width = `${Math.min(100, Math.max(1, diskPct))}%`;

  if (hwLoadBadge) {
    if (cpuPct > 25 || sysPct > 85 || diskPct > 90) {
      hwLoadBadge.textContent = 'High Load';
      hwLoadBadge.className = 'badge-tag incompatible';
    } else if (cpuPct > 10 || sysPct > 70 || diskPct > 80) {
      hwLoadBadge.textContent = 'Moderate';
      hwLoadBadge.className = 'badge-tag warning';
    } else {
      hwLoadBadge.textContent = 'Optimal';
      hwLoadBadge.className = 'badge-tag compatible';
    }
  }

  // 3. Mini CPU Activity Spark-bars
  const hwCpuBars = document.getElementById('hw-cpu-history-bars');
  if (hwCpuBars) {
    _hwCpuHistory.push(cpuPct);
    if (_hwCpuHistory.length > 12) _hwCpuHistory.shift();

    const maxHist = Math.max(2.0, ..._hwCpuHistory) * 1.25;
    let barsHtml = '';
    _hwCpuHistory.forEach((v, idx) => {
      const h = Math.max(3, Math.round((v / maxHist) * 22));
      const isHigh = v > 15;
      const isLatest = idx === _hwCpuHistory.length - 1;
      const opacity = isLatest ? '1' : (0.45 + (idx / 12) * 0.55).toFixed(2);
      barsHtml += `<div class="hw-mini-bar ${isHigh ? 'high' : ''}" style="height: ${h}px; opacity: ${opacity};" title="${v.toFixed(1)}% CPU"></div>`;
    });
    hwCpuBars.innerHTML = barsHtml;
  }
}

async function fetchVideos() {
  try {
    const data = await apiGet('/api/videos');
    if (data.activeVideoId) {
      _currentActiveVideoId = data.activeVideoId;
    }
    _cachedVideos = data.videos || [];
    _currentPlaylist = Array.isArray(data.playlist) ? data.playlist : (_currentActiveVideoId ? [_currentActiveVideoId] : []);
    _currentPlaybackOrder = data.playbackOrder || 'sequential';
    renderVideos(_cachedVideos, data.activeVideoId, _currentPlaylist, _currentPlaybackOrder);
  } catch (err) {
    console.error('Fetch videos failed:', err);
  }
}

async function updatePlaylist(newPlaylist, playbackOrder = _currentPlaybackOrder) {
  const isLive = _currentStatus === 'RUNNING' || _currentStatus === 'STARTING';
  let shouldRestart = false;

  if (isLive) {
    shouldRestart = confirm(
      'Playlist updated.\n\nThe live stream is currently active on YouTube. Do you want to restart the stream now with the new playlist?'
    );
  }

  try {
    const url = `/api/videos/playlist${shouldRestart ? '?restart=true' : ''}`;
    const res = await apiPost(url, { playlist: newPlaylist, playbackOrder });
    _currentPlaylist = res.playlist || newPlaylist;
    _currentPlaybackOrder = res.playbackOrder || playbackOrder;
    await fetchVideos();
    if (shouldRestart) {
      await fetchStatus();
    }
  } catch (err) {
    showToast(err.message, 'error', 'Playlist Update Failed');
    await fetchVideos();
  }
}

function renderVideos(videos, activeIdFromApi = null, playlist = _currentPlaylist, playbackOrder = _currentPlaybackOrder) {
  videosList.innerHTML = '';
  const currentVideoId = activeIdFromApi || _currentActiveVideoId || _currentSettings?.stream?.videoId;

  if (videoCountBadge) {
    videoCountBadge.textContent = `${videos.length} ${videos.length === 1 ? 'Video' : 'Videos'}`;
  }

  if (playlistSelectedCount) {
    const count = playlist.length;
    playlistSelectedCount.textContent = `${count} ${count === 1 ? 'Video' : 'Videos'} in Playlist`;
  }

  if (selPlaybackOrder) {
    selPlaybackOrder.value = playbackOrder || 'sequential';
  }

  if (videos.length === 0) {
    videosList.innerHTML = `
      <div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 1.25rem 1rem;">
        <div>No videos currently indexed in library.</div>
        <button id="btn-sync-videos" class="btn btn-secondary btn-sm" style="margin-top: 0.65rem;">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Scan Videos Folder on Server
        </button>
      </div>
    `;
    const btnSync = document.getElementById('btn-sync-videos');
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        btnSync.disabled = true;
        btnSync.textContent = 'Scanning server files...';
        try {
          const res = await apiPost('/api/videos/sync');
          await refreshAll();
          if (res.count > 0) {
            showToast(`Found and indexed ${res.count} video file(s).`, 'success', 'Scan Complete');
          } else {
            showToast('No video files found in videos/ directory.', 'info', 'Scan Complete');
          }
        } catch (err) {
          showToast(err.message, 'error', 'Scan Failed');
        } finally {
          btnSync.disabled = false;
        }
      });
    }
    activeVideoName.textContent = 'None selected';
    return;
  }

  // Update active video header summary
  const hasPairedHorizontalInPlaylist = videos.some(v =>
    (v.orientation === 'horizontal' || (v.probe?.width > v.probe?.height)) &&
    v.paired &&
    playlist.includes(v.paired.id)
  );

  if (playlistSelectedCount) {
    const count = playlist.length;
    let countText = `${count} ${count === 1 ? 'Video' : 'Videos'} in Playlist`;
    if (hasPairedHorizontalInPlaylist) {
      countText += ' (16:9 Feed Auto-Paired)';
    }
    playlistSelectedCount.textContent = countText;
  }

  if (playlist.length === 0) {
    activeVideoName.textContent = 'Active: None';
  } else if (playlist.length === 1) {
    const single = videos.find(v => v.id === playlist[0]);
    const label = single ? (single.label || single.originalName) : playlist[0];
    const isPaired = single && videos.some(h => (h.orientation === 'horizontal' || (h.probe?.width > h.probe?.height)) && h.paired?.id === single.id);
    activeVideoName.textContent = isPaired
      ? `Looping: ${label} + Dual 16:9 Feed Active`
      : `Looping 1: ${label}`;
  } else {
    activeVideoName.textContent = `Looping ${playlist.length} Videos (${playbackOrder === 'shuffle' ? 'Shuffle' : 'Sequential'})${hasPairedHorizontalInPlaylist ? ' + Dual Feeds' : ''}`;
  }

  videos.forEach(v => {
    const isSelected = playlist.includes(v.id);
    const orderIndex = playlist.indexOf(v.id);
    const isSoloActive = isSelected && playlist.length === 1;

    // Detect if this horizontal video is the auto-paired feed companion of a selected vertical video
    const isHorizontal = v.orientation === 'horizontal' || (v.probe?.width > v.probe?.height);
    const isPairedFeedActive = isHorizontal && v.paired && playlist.includes(v.paired.id);
    const pairedVerticalPos = isPairedFeedActive ? playlist.indexOf(v.paired.id) + 1 : 0;

    const item = document.createElement('div');
    item.className = `video-item ${isSelected ? 'in-playlist' : ''} ${isSoloActive ? 'active' : ''} ${isPairedFeedActive ? 'paired-feed-active' : ''}`;

    const compat = v.compatibility?.status === 'COMPATIBLE' ? 'compatible' : 'transcode';
    const compatLabel = v.compatibility?.status === 'COMPATIBLE' ? 'Stream-Copy Ready' : 'Needs Transcode';

    let chkAreaHtml = '';
    if (isSelected) {
      chkAreaHtml = `
        <label class="video-chk-label" title="Deselect from loop playlist">
          <input type="checkbox" class="video-select-chk" data-id="${v.id}" checked>
        </label>
        <span class="playlist-seq-badge" title="Position #${orderIndex + 1}">#${orderIndex + 1}</span>
      `;
    } else if (isPairedFeedActive) {
      chkAreaHtml = `
        <label class="video-chk-label" title="Automatically linked & active for 16:9 Dual Streaming Feed (Paired with #${pairedVerticalPos})">
          <input type="checkbox" class="video-select-chk" data-id="${v.id}" checked disabled style="opacity: 0.8; cursor: default;">
        </label>
        <span class="playlist-seq-badge" title="Auto-Paired 16:9 Feed for #${pairedVerticalPos}">16:9</span>
      `;
    } else {
      chkAreaHtml = `
        <label class="video-chk-label" title="Select for loop playlist">
          <input type="checkbox" class="video-select-chk" data-id="${v.id}">
        </label>
      `;
    }

    item.innerHTML = `
      <div class="video-item-leading">
        ${chkAreaHtml}
      </div>
      <div class="video-item-content">
        <div class="video-name" title="${v.label || v.originalName}">${v.label || v.originalName}</div>
        <div class="video-meta">
          <span class="badge-tag">${isHorizontal ? '16:9' : '9:16'}</span>
          <span class="meta-tag">${v.probe?.aspectRatio || (isHorizontal ? '1920:1080' : '1080:1920')}</span>
          <span class="meta-tag">${v.probe?.fps || 30}fps</span>
          <span class="meta-tag">${formatBytes(v.sizeBytes)}</span>
          <span class="badge-tag ${compat}" title="${(v.compatibility?.explanations || []).join(' \n ') || compatLabel}">${compatLabel}</span>
        </div>
        ${v.paired
        ? `<div class="video-pair-info" title="Paired companion: ${v.paired.label || v.paired.originalName}">
               <span class="pair-label">Pair:</span>
               <span class="pair-val">${v.paired.label || v.paired.originalName}</span>
             </div>`
        : ''
      }
      </div>
      <div class="video-actions">
        ${isSelected
        ? `<span class="badge-tag badge-active">${isSoloActive ? 'ACTIVE LOOP' : `IN LOOP (#${orderIndex + 1})`}</span>`
        : isPairedFeedActive
          ? `<span class="badge-tag badge-paired">DUAL FEED (16:9)</span>`
          : `<button class="btn btn-secondary btn-sm btn-play-solo" data-id="${v.id}" title="Stream only this video in loop">
                 <svg class="icon icon-sm" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                 Play Solo
               </button>`
      }
        <button class="btn btn-outline btn-sm btn-delete" data-id="${v.id}" title="Delete video">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;

    videosList.appendChild(item);
  });

  // Attach Checkbox Events
  videosList.querySelectorAll('.video-select-chk').forEach(chk => {
    chk.addEventListener('change', async () => {
      const id = chk.getAttribute('data-id');
      let updated = [..._currentPlaylist];
      if (chk.checked) {
        if (!updated.includes(id)) updated.push(id);
      } else {
        updated = updated.filter(x => x !== id);
      }
      await updatePlaylist(updated, _currentPlaybackOrder);
    });
  });

  // Attach "Play Solo" Events
  videosList.querySelectorAll('.btn-play-solo').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-id');
      await updatePlaylist([id], _currentPlaybackOrder);
    });
  });

  // Attach Delete Events
  videosList.querySelectorAll('.btn-delete').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-id');
      if (confirm('Delete this video from library?')) {
        try {
          await apiDelete(`/api/videos/${id}`);
          showToast('Video deleted from library.', 'success', 'Video Removed');
          await fetchVideos();
        } catch (err) {
          showToast(err.message, 'error', 'Delete Failed');
        }
      }
    });
  });
}

async function fetchLogs() {
  try {
    const data = await apiGet('/api/system/logs?limit=40');
    renderLogs(data.lines || []);
  } catch (err) {
    console.error('Fetch logs failed:', err);
  }
}

function renderLogs(lines) {
  logViewer.innerHTML = '';
  if (lines.length === 0) {
    logViewer.innerHTML = '<div class="log-line info">No logs recorded yet.</div>';
    return;
  }

  lines.forEach(l => {
    const row = document.createElement('div');
    const lvl = l.level || 'info';
    row.className = `log-line ${lvl}`;
    const time = l.ts ? new Date(l.ts).toLocaleTimeString() : '';
    row.textContent = `[${time}] [${lvl.toUpperCase()}] ${l.event || ''}: ${l.msg || l.raw || ''}`;
    logViewer.appendChild(row);
  });
  logViewer.scrollTop = logViewer.scrollHeight;
}

// ─── Settings Modal & Live Preview ────────────────────────────────────────────

function updateDeckStreamKeyBadge(settings) {
  if (!deckStreamKeyBadge) return;
  if (settings?.youtube?.streamKeySet) {
    deckStreamKeyBadge.textContent = `YouTube: Configured (...${settings.youtube.streamKeyHint})`;
    deckStreamKeyBadge.style.borderColor = 'var(--border-muted)';
    deckStreamKeyBadge.style.color = 'var(--text-main)';
    deckStreamKeyBadge.title = `YouTube Stream Key is configured (...${settings.youtube.streamKeyHint}). Click to change.`;
  } else {
    deckStreamKeyBadge.textContent = 'YouTube: Key Missing';
    deckStreamKeyBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    deckStreamKeyBadge.style.color = 'var(--text-main)';
    deckStreamKeyBadge.title = 'YouTube Stream Key is not configured! Click to open Settings.';
  }
}

function updateKeyFeedback() {
  if (!keyBadge || !keyHintText || !cfgStreamKey) return;
  const val = cfgStreamKey.value.trim();
  if (val.length > 0) {
    keyBadge.textContent = 'Unsaved Entry';
    keyBadge.className = 'badge-tag badge-active';
    keyHintText.innerHTML = `New stream key entered (${val.length} chars) — Click <strong>Save Configuration</strong> below to apply.`;
  } else if (_currentSettings?.youtube?.streamKeySet) {
    keyBadge.textContent = `Saved (...${_currentSettings.youtube.streamKeyHint})`;
    keyBadge.className = 'badge-tag';
    cfgStreamKey.placeholder = `Saved (ends in ...${_currentSettings.youtube.streamKeyHint})`;
    keyHintText.innerHTML = `Active YouTube Stream Key is saved (ends in ...${_currentSettings.youtube.streamKeyHint}). Leave empty to keep unchanged, or paste a new key to update.`;
  } else {
    keyBadge.textContent = 'Not Configured';
    keyBadge.className = 'badge-tag';
    cfgStreamKey.placeholder = 'Paste YouTube Stream Key (e.g. xxxx-xxxx-xxxx-xxxx-xxxx)';
    keyHintText.innerHTML = 'No stream key saved. You must paste your YouTube Stream Key before you can start streaming.';
  }
}

function updateHorizontalKeyFeedback() {
  if (!horizontalKeyBadge || !horizontalKeyHintText || !cfgHorizontalStreamKey) return;
  const val = cfgHorizontalStreamKey.value.trim();
  if (val.length > 0) {
    horizontalKeyBadge.textContent = 'Unsaved Entry';
    horizontalKeyBadge.className = 'badge-tag badge-active';
    horizontalKeyHintText.innerHTML = `New horizontal stream key entered (${val.length} chars) — Click <strong>Save Configuration</strong> to apply.`;
  } else if (_currentSettings?.youtube?.horizontalStreamKeySet) {
    horizontalKeyBadge.textContent = `Saved (...${_currentSettings.youtube.horizontalStreamKeyHint})`;
    horizontalKeyBadge.className = 'badge-tag';
    cfgHorizontalStreamKey.placeholder = `Saved (ends in ...${_currentSettings.youtube.horizontalStreamKeyHint})`;
    horizontalKeyHintText.innerHTML = `Horizontal stream key saved (ends in ...${_currentSettings.youtube.horizontalStreamKeyHint}). Stream will broadcast to both Shorts and Normal feeds simultaneously.`;
  } else {
    horizontalKeyBadge.textContent = 'Optional';
    horizontalKeyBadge.className = 'badge-tag';
    cfgHorizontalStreamKey.placeholder = 'Paste Normal Feed Stream Key (optional for dual live)';
    horizontalKeyHintText.innerHTML = 'Optional: Add a stream key to simultaneously live stream to YouTube Normal 16:9 feed alongside Shorts feed.';
  }
}

async function fetchSettings() {
  try {
    const settings = await apiGet('/api/settings');
    _currentSettings = settings;
    updateDeckStreamKeyBadge(settings);
    return settings;
  } catch (err) {
    console.error('Fetch settings failed:', err);
  }
}

async function openSettings() {
  try {
    const settings = await apiGet('/api/settings');
    _currentSettings = settings;
    updateDeckStreamKeyBadge(settings);

    cfgRtmpsUrl.value = settings.youtube?.rtmpsUrl || 'rtmps://a.rtmps.youtube.com:443/live2';
    cfgStreamKey.value = '';
    cfgStreamKey.type = 'password';
    if (iconEyeShow) iconEyeShow.style.display = 'inline';
    if (iconEyeHide) iconEyeHide.style.display = 'none';
    if (btnRevealText) btnRevealText.textContent = 'Show';

    updateKeyFeedback();

    if (cfgHorizontalStreamKey) {
      cfgHorizontalStreamKey.value = '';
      cfgHorizontalStreamKey.type = 'password';
      if (iconEyeShowHoriz) iconEyeShowHoriz.style.display = 'inline';
      if (iconEyeHideHoriz) iconEyeHideHoriz.style.display = 'none';
      if (btnRevealHorizText) btnRevealHorizText.textContent = 'Show';
      updateHorizontalKeyFeedback();
    }
    if (cfgDualStreamEnabled) {
      cfgDualStreamEnabled.checked = settings.youtube?.dualStreamEnabled !== false;
    }

    cfgModePref.value = settings.stream?.modePreference || 'auto';
    if (cfgAllowTranscode) {
      cfgAllowTranscode.checked = settings.stream?.allowTranscode !== false;
    }
    cfgBitrate.value = settings.stream?.videoBitrateMbps || 4;
    cfgSafetyLimit.value = settings.bandwidth?.safetyLimitTB || 9;
    cfgOverhead.value = settings.bandwidth?.overheadPercent || 10;

    updateLiveBitratePreview();
    modalSettings.classList.add('open');
  } catch (err) {
    showToast(err.message, 'error', 'Could Not Load Settings');
  }
}

function updateLiveBitratePreview() {
  const videoMbps = parseFloat(cfgBitrate.value) || 4;
  const overhead = parseFloat(cfgOverhead.value) || 10;

  const m = calculateBitrateMetrics({
    videoBitrateMbps: videoMbps,
    audioBitrateKbps: 128,
    overheadPercent: overhead,
  });

  previewGbDay.textContent = `${m.withOverhead.gbPerDay.toFixed(2)} GB/day`;
  previewTbMonth.textContent = `${m.withOverhead.tbPer30Days.toFixed(3)} TB/30d`;
}

// ─── Video Ingest Tab Switcher ──────────────────────────────────────────────────────

function switchIngestTab(tab) {
  const uploadZone = document.getElementById('upload-zone');
  const ytPanel = document.getElementById('yt-import-panel');
  const tabUpload = document.getElementById('tab-upload');
  const tabYt = document.getElementById('tab-youtube');

  if (tab === 'youtube') {
    uploadZone.style.display = 'none';
    ytPanel.style.display = 'flex';
    tabUpload?.classList.remove('active');
    tabYt?.classList.add('active');
    // Check cookies status and show warning if missing
    apiGet('/api/videos/cookies-status').then((s) => {
      const banner = document.getElementById('yt-cookies-banner');
      if (banner) banner.style.display = s?.exists ? 'none' : 'block';
    }).catch(() => { });
  } else {
    uploadZone.style.display = '';
    ytPanel.style.display = 'none';
    tabUpload?.classList.add('active');
    tabYt?.classList.remove('active');
  }
}

// ─── Upload Handling ──────────────────────────────────────────────────────────

function setupUploads() {
  uploadZone.addEventListener('click', () => fileInput.click());

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.style.borderColor = 'var(--border-active)';
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.style.borderColor = '';
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.style.borderColor = '';
    if (e.dataTransfer.files?.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length > 0) {
      handleFileUpload(fileInput.files[0]);
    }
  });
}

function handleFileUpload(file) {
  if (!file) return;

  // 1. Client-side sanity checks
  if (file.size === 0) {
    showToast('The selected file is empty (0 bytes). Please choose a valid video.', 'warning', 'Invalid File');
    return;
  }

  const allowedExts = ['.mp4', '.mov', '.m4v', '.mkv'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowedExts.includes(ext)) {
    showToast(`File "${file.name}" has an unsupported format. Supported formats: ${allowedExts.join(', ')}`, 'warning', 'Unsupported Format');
    return;
  }

  const maxBytes = 8 * 1024 * 1024 * 1024; // 8 GiB
  if (file.size > maxBytes) {
    showToast(`File is too large (${formatBytes(file.size)}). Maximum supported file size is 8 GiB.`, 'warning', 'File Too Large');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  // Initialize UI state
  uploadBox.style.display = 'block';
  uploadFill.style.width = '0%';
  uploadPct.textContent = '0%';
  if (uploadStatusText) uploadStatusText.textContent = `Uploading ${file.name}...`;
  if (uploadBytesText) uploadBytesText.textContent = `0 MB / ${formatBytes(file.size)}`;
  if (uploadSpeedText) uploadSpeedText.textContent = 'Calculating speed...';

  const startTime = Date.now();
  let lastLoaded = 0;
  let lastTime = startTime;
  let currentSpeed = 0;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/videos/upload');
  xhr.timeout = 0; // Unlimited timeout to allow 2GB+ video uploads without disconnect

  const csrf = getCsrfToken();
  if (csrf) {
    xhr.setRequestHeader('X-CSRF-Token', csrf);
  }

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable && e.total > 0) {
      const now = Date.now();
      const timeDelta = (now - lastTime) / 1000;

      // Update speed every 500ms
      if (timeDelta >= 0.5) {
        const bytesDelta = e.loaded - lastLoaded;
        currentSpeed = bytesDelta / timeDelta;
        lastLoaded = e.loaded;
        lastTime = now;
      }

      const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
      uploadPct.textContent = `${pct}%`;
      uploadFill.style.width = `${pct}%`;

      const remainingBytes = e.total - e.loaded;
      const etaSec = currentSpeed > 0 ? Math.ceil(remainingBytes / currentSpeed) : 0;
      const speedMB = (currentSpeed / (1024 * 1024)).toFixed(1);
      const etaStr = etaSec > 60 ? `${Math.ceil(etaSec / 60)}m` : `${etaSec}s`;

      if (uploadBytesText) {
        uploadBytesText.textContent = `${formatBytes(e.loaded)} / ${formatBytes(e.total)}`;
      }
      if (uploadSpeedText) {
        uploadSpeedText.textContent = currentSpeed > 0 ? `${speedMB} MB/s · ETA: ${etaStr}` : 'Uploading...';
      }

      if (e.loaded >= e.total) {
        uploadPct.textContent = '100%';
        uploadFill.style.width = '100%';
        if (uploadStatusText) uploadStatusText.textContent = 'Processing & validating video on server...';
        if (uploadSpeedText) uploadSpeedText.textContent = 'Probing codecs & preparing live stream rotation...';
      }
    }
  };

  xhr.onload = async () => {
    fileInput.value = '';
    if (xhr.status === 201) {
      if (uploadStatusText) uploadStatusText.textContent = 'Upload complete! Video activated.';
      if (uploadSpeedText) uploadSpeedText.textContent = 'Live stream updated seamlessly.';
      showToast(`Successfully uploaded ${file.name}.`, 'success', 'Upload Complete');
      setTimeout(() => {
        uploadBox.style.display = 'none';
      }, 1500);
      await refreshAll();
    } else {
      uploadBox.style.display = 'none';
      let errorMsg = 'Upload failed';
      try {
        const err = JSON.parse(xhr.responseText);
        errorMsg = err.error || err.message || errorMsg;
      } catch {
        if (xhr.status === 413) errorMsg = 'File exceeds server size limit.';
        else if (xhr.status === 507) errorMsg = 'Insufficient server disk space.';
        else if (xhr.status === 415) errorMsg = 'Unsupported video format.';
        else if (xhr.status === 422) errorMsg = 'Video contains no decodable video stream.';
      }
      showToast(errorMsg, 'error', `Upload Failed (${xhr.status})`);
    }
  };

  xhr.onerror = () => {
    uploadBox.style.display = 'none';
    fileInput.value = '';
    showToast('The connection to the server was interrupted. Please try again.', 'error', 'Network Error');
  };

  xhr.ontimeout = () => {
    uploadBox.style.display = 'none';
    fileInput.value = '';
    showToast('The upload took longer than 60 minutes.', 'error', 'Upload Timed Out');
  };

  xhr.onabort = () => {
    uploadBox.style.display = 'none';
    fileInput.value = '';
    showToast('Upload was cancelled.', 'info', 'Upload Cancelled');
  };

  xhr.send(formData);
}

// ─── YouTube Download Handler ─────────────────────────────────────────────────

let _ytPollTimer = null;

function _clearYtPoll() {
  if (_ytPollTimer) { clearInterval(_ytPollTimer); _ytPollTimer = null; }
}

// SVG icon paths for each stage
const _ytStageIcons = {
  fetching_info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  downloading: '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/><path d="M5 20h14"/>',
  converting: '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>',
  completed: '<polyline points="20 6 9 17 4 12"/>',
  error: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  cancelled: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

const _ytStageColors = {
  fetching_info: 'var(--accent-cyan)',
  downloading: 'var(--accent-primary)',
  converting: 'var(--accent-amber)',
  completed: 'var(--accent-emerald)',
  error: 'var(--accent-rose)',
  cancelled: 'var(--text-muted)',
};

const _ytStageLabels = {
  fetching_info: 'Fetching video info...',
  downloading: 'Downloading from YouTube...',
  converting: 'Converting to 1080x1920 30fps...',
  completed: 'Download & conversion complete',
  error: 'Failed',
  cancelled: 'Cancelled',
};

function _updateYtProgress(status) {
  if (!status) return;

  const stage = status.stage || 'fetching_info';
  const label = _ytStageLabels[stage] || stage;
  const color = _ytStageColors[stage] || 'var(--accent-cyan)';
  const iconPath = _ytStageIcons[stage] || _ytStageIcons.fetching_info;

  const stageIcon = document.getElementById('yt-stage-icon');
  const stageLabel = document.getElementById('yt-stage-label');
  if (stageIcon) stageIcon.innerHTML = iconPath;
  if (stageLabel) stageLabel.textContent = label;
  if (ytDlStageText) ytDlStageText.style.color = color;
  if (ytDlTitle) ytDlTitle.textContent = status.videoTitle || '';

  const pct = Math.round(status.percent || 0);
  if (ytDlPct) ytDlPct.textContent = `${pct}%`;
  if (ytDlFill) ytDlFill.style.width = `${pct}%`;

  let details = '';
  if (status.speed && status.stage === 'downloading') {
    details = `Speed: ${status.speed}`;
    if (status.eta) details += ` · ETA: ${status.eta}`;
  } else if (status.speed && status.stage === 'converting') {
    details = `Encode speed: ${status.speed}`;
  }
  if (ytDlDetails) ytDlDetails.textContent = details || 'Working...';
}

async function _pollYtDownloadStatus() {
  try {
    const status = await apiGet('/api/videos/download-status');
    _updateYtProgress(status);

    if (!status.active) {
      _clearYtPoll();

      if (status.stage === 'completed') {
        _updateYtProgress({ ...status, stage: 'completed', percent: 100 });
        if (btnYtDownload) btnYtDownload.disabled = false;

        await fetchVideos();

        if (status.videoId) {
          setTimeout(() => {
            const wantActive = confirm(
              `"${status.videoTitle || 'YouTube Video'}" downloaded & converted.\n\nSet it as the active live stream video now?`
            );
            if (wantActive) {
              apiPost(`/api/videos/${status.videoId}/select`, { restart: false })
                .then(() => fetchVideos())
                .catch((err) => showToast(err.message, 'error', 'Could Not Select Video'));
            }
            if (ytDlProgressBox) {
              setTimeout(() => { ytDlProgressBox.style.display = 'none'; }, 1500);
            }
          }, 300);
        }

      } else if (status.stage === 'error') {
        _updateYtProgress({ ...status, stage: 'error' });
        if (ytDlDetails) ytDlDetails.textContent = status.error || 'Unknown failure';
        if (btnYtDownload) btnYtDownload.disabled = false;

      } else if (status.stage === 'cancelled') {
        if (ytDlProgressBox) ytDlProgressBox.style.display = 'none';
        if (btnYtDownload) btnYtDownload.disabled = false;
      }
    }
  } catch (err) {
    console.error('YouTube download status poll failed:', err);
  }
}

function setupYouTubeDownload() {
  if (!btnYtDownload) return;

  // Wire tab buttons via event listeners
  const tabUploadBtn = document.getElementById('tab-upload');
  const tabYtBtn = document.getElementById('tab-youtube');
  if (tabUploadBtn) tabUploadBtn.addEventListener('click', () => switchIngestTab('upload'));
  if (tabYtBtn) tabYtBtn.addEventListener('click', () => switchIngestTab('youtube'));

  // Wire cookies file upload button
  const cookiesFileInput = document.getElementById('cookies-file-input');
  const cookiesUploadStatus = document.getElementById('cookies-upload-status');
  if (cookiesFileInput) {
    cookiesFileInput.addEventListener('change', async () => {
      const file = cookiesFileInput.files?.[0];
      if (!file) return;
      if (cookiesUploadStatus) cookiesUploadStatus.textContent = 'Uploading...';
      try {
        const formData = new FormData();
        formData.append('file', file, file.name);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/videos/upload-cookies');
        const csrf = getCsrfToken();
        if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
        xhr.onload = () => {
          cookiesFileInput.value = '';
          if (xhr.status === 200) {
            if (cookiesUploadStatus) cookiesUploadStatus.textContent = 'Cookies saved!';
            const banner = document.getElementById('yt-cookies-banner');
            if (banner) setTimeout(() => { banner.style.display = 'none'; }, 1500);
          } else {
            let msg = 'Upload failed';
            try { msg = JSON.parse(xhr.responseText)?.error || msg; } catch { /**/ }
            if (cookiesUploadStatus) cookiesUploadStatus.textContent = `Error: ${msg}`;
          }
        };
        xhr.onerror = () => {
          cookiesFileInput.value = '';
          if (cookiesUploadStatus) cookiesUploadStatus.textContent = 'Network error';
        };
        xhr.send(formData);
      } catch (err) {
        if (cookiesUploadStatus) cookiesUploadStatus.textContent = `Error: ${err.message}`;
      }
    });
  }

  btnYtDownload.addEventListener('click', async () => {
    const url = (ytUrlInput?.value || '').trim();
    if (!url) {
      showToast('Please enter a YouTube URL first.', 'warning', 'URL Required');
      ytUrlInput?.focus();
      return;
    }

    // Reset progress UI
    if (ytDlProgressBox) ytDlProgressBox.style.display = 'block';
    _updateYtProgress({ stage: 'fetching_info', percent: 0, videoTitle: '', speed: '', eta: '' });
    if (ytDlDetails) ytDlDetails.textContent = 'Connecting...';
    btnYtDownload.disabled = true;

    try {
      await apiPost('/api/videos/download-youtube', { url, autoSetActive: false });
      _clearYtPoll();
      _ytPollTimer = setInterval(_pollYtDownloadStatus, 1500);
    } catch (err) {
      if (ytDlProgressBox) ytDlProgressBox.style.display = 'none';
      btnYtDownload.disabled = false;
      const msg = err.message || 'Failed to start download';
      if (err.code === 'E_YTDLP_MISSING') {
        showToast('yt-dlp is not installed on the server. Run: bash update.sh on your VPS to install it.', 'error', 'Missing Dependency');
      } else if (err.code === 'E_JOB_RUNNING') {
        showToast('A download is already in progress. Wait for it to finish or cancel it first.', 'warning', 'Download Busy');
        if (ytDlProgressBox) ytDlProgressBox.style.display = 'block';
        _clearYtPoll();
        _ytPollTimer = setInterval(_pollYtDownloadStatus, 1500);
      } else {
        showToast(msg, 'error', 'Download Failed');
      }
    }
  });

  if (btnCancelYtDl) {
    btnCancelYtDl.addEventListener('click', async () => {
      _clearYtPoll();
      try {
        await apiPost('/api/videos/download-cancel');
      } catch { /* ignore */ }
      if (ytDlProgressBox) ytDlProgressBox.style.display = 'none';
      if (btnYtDownload) btnYtDownload.disabled = false;
    });
  }

  // On init: resume polling if a job is already running (e.g. after page refresh)
  apiGet('/api/videos/download-status').then((status) => {
    if (status?.active) {
      if (ytDlProgressBox) ytDlProgressBox.style.display = 'block';
      _updateYtProgress(status);
      switchIngestTab('youtube');
      _clearYtPoll();
      _ytPollTimer = setInterval(_pollYtDownloadStatus, 1500);
    }
  }).catch(() => { });
}

// ─── Refresh Orchestrator ─────────────────────────────────────────────────────

async function refreshAll() {
  await Promise.all([
    fetchStatus(),
    fetchSettings(),
    fetchBandwidth(),
    fetchScheduler(),
    fetchSystem(),
    fetchVideos(),
    fetchLogs(),
  ]);
}

function startPolling() {
  stopPolling();
  // PRD §15.2: status every 3s, bandwidth, scheduler & system every 10s
  _pollStatusTimer = setInterval(fetchStatus, 3000);
  _pollSlowTimer = setInterval(() => {
    fetchBandwidth();
    fetchScheduler();
    fetchSystem();
  }, 10000);
}

function stopPolling() {
  if (_pollStatusTimer) { clearInterval(_pollStatusTimer); _pollStatusTimer = null; }
  if (_pollSlowTimer) { clearInterval(_pollSlowTimer); _pollSlowTimer = null; }
}

// ─── Main Bootstrap ───────────────────────────────────────────────────────────

async function init() {
  // 1. Settings Modal Controls
  btnOpenSettings.addEventListener('click', openSettings);
  btnCloseSettings.addEventListener('click', () => modalSettings.classList.remove('open'));
  btnCancelSettings.addEventListener('click', () => modalSettings.classList.remove('open'));
  modalSettings.addEventListener('click', (e) => {
    if (e.target === modalSettings) modalSettings.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalSettings.classList.contains('open')) {
      modalSettings.classList.remove('open');
    }
  });

  // 2. Collapsible Panels support
  document.querySelectorAll('.panel-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = btn.getAttribute('data-target');
      const body = document.getElementById(targetId);
      if (body) {
        const isCollapsed = body.classList.toggle('collapsed');
        btn.classList.toggle('collapsed', isCollapsed);
        btn.setAttribute('aria-expanded', !isCollapsed);
      }
    });
  });

  document.querySelectorAll('.collapsible-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;
      const targetId = header.getAttribute('data-target');
      const body = document.getElementById(targetId);
      const btn = header.querySelector('.panel-toggle-btn');
      if (body) {
        const isCollapsed = body.classList.toggle('collapsed');
        if (btn) {
          btn.classList.toggle('collapsed', isCollapsed);
          btn.setAttribute('aria-expanded', !isCollapsed);
        }
      }
    });
  });

  // 3. Primary Stream Action Handlers
  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    try {
      // Check if system is in maintenance mode before requesting start
      if (statusText.textContent === 'MAINTENANCE') {
        const disableMaint = confirm(
          'Maintenance Mode is currently active.\n\nWould you like to disable maintenance mode and start live streaming now?'
        );
        if (!disableMaint) return;
        await apiPost('/api/maintenance', { enabled: false });
      }

      await apiPost('/api/stream/start');
      showToast('Live stream process started.', 'success', 'Streaming Active');
      await refreshAll();
    } catch (err) {
      if (err.code === 'E_NEEDS_TRANSCODE') {
        const wantsTranscode = confirm(
          `Cannot stream in pure Copy mode:\n• ${err.message}\n\nThis video requires transcoding (e.g. 720p / non-copy format to 1080p).\n\nWould you like to switch Stream Mode to 'Auto' with Transcoding enabled and start streaming now?`
        );
        if (wantsTranscode) {
          try {
            await apiPut('/api/settings', {
              stream: {
                modePreference: 'auto',
                allowTranscode: true,
              },
            });
            await apiPost('/api/stream/start');
            showToast('Live stream started with Auto transcoding.', 'success', 'Streaming Active');
            await refreshAll();
            return;
          } catch (retryErr) {
            showToast(`Start failed after mode update: ${retryErr.message}`, 'error', 'Start Failed');
          }
        }
      } else if (err.code === 'E_KEY_MISSING') {
        showToast('YouTube stream key is not configured. Opening Settings...', 'warning', 'Stream Key Missing');
        await openSettings();
        if (cfgStreamKey) cfgStreamKey.focus();
      } else if (err.code === 'E_CONFIG_INVALID') {
        showToast(`RTMPS configuration is invalid: ${err.message || ''}. Opening Settings...`, 'error', 'Configuration Invalid');
        await openSettings();
      } else if (err.code === 'E_MAINTENANCE') {
        const disableNow = confirm(
          'Maintenance Mode is Active.\n\nStreaming is blocked because server maintenance mode is engaged.\n\nWould you like to disable maintenance mode and start streaming now?'
        );
        if (disableNow) {
          await apiPost('/api/maintenance', { enabled: false });
          try {
            await apiPost('/api/stream/start');
            showToast('Maintenance disabled and live stream started.', 'success', 'Streaming Active');
            await refreshAll();
            return;
          } catch (retryErr) {
            showToast(`Start failed: ${retryErr.message}`, 'error', 'Start Failed');
          }
        }
      } else if (err.code === 'E_NO_VIDEO') {
        showToast('No video selected for streaming. Please upload a video or click "Play Solo" in the Video Library.', 'warning', 'No Video Selected');
        document.getElementById('panel-videos')?.scrollIntoView({ behavior: 'smooth' });
      } else if (err.code === 'E_DISABLED') {
        showToast('Master Stream Lock is engaged. Toggle off the switch at the top of the dashboard to enable streaming.', 'warning', 'Master Stream Lock Active');
      } else {
        showToast(err.message || err.error || 'Server rejected stream start', 'error', 'Start Stream Failed');
      }
    } finally {
      btnStart.disabled = false;
      await fetchStatus();
    }
  });

  btnStop.addEventListener('click', async () => {
    if (confirm('Are you sure you want to stop the live stream?')) {
      btnStop.disabled = true;
      try {
        await apiPost('/api/stream/stop');
        showToast('Live stream stopped.', 'info', 'Stream Ended');
        await fetchStatus();
      } catch (err) {
        showToast(`Stop failed: ${err.message}`, 'error', 'Stop Failed');
      } finally {
        btnStop.disabled = false;
        await fetchStatus();
      }
    }
  });

  btnRestart.addEventListener('click', async () => {
    if (confirm('Restart FFmpeg streaming onto YouTube?')) {
      btnRestart.disabled = true;
      try {
        await apiPost('/api/stream/restart');
        showToast('Live stream restarted.', 'success', 'Stream Restarted');
        await fetchStatus();
      } catch (err) {
        showToast(`Restart failed: ${err.message}`, 'error', 'Restart Failed');
      } finally {
        btnRestart.disabled = false;
        await fetchStatus();
      }
    }
  });

  chkDisabled.addEventListener('change', async () => {
    const disable = chkDisabled.checked;
    if (disable) {
      if (confirm('Engage Master Kill Switch? Streaming will stop immediately.')) {
        await apiPost('/api/stream/disable');
      } else {
        chkDisabled.checked = false;
      }
    } else {
      await apiPost('/api/stream/enable');
    }
    await fetchStatus();
  });

  btnLogout.addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    window.location.href = '/login.html';
  });

  btnRefreshLogs.addEventListener('click', fetchLogs);

  // 4. Live Calculator & Key Reveal inside Settings Form
  cfgBitrate.addEventListener('input', updateLiveBitratePreview);
  cfgOverhead.addEventListener('input', updateLiveBitratePreview);

  btnRevealKey.addEventListener('click', async () => {
    // If input currently has text typed, toggle visibility
    if (cfgStreamKey.value.length > 0) {
      if (cfgStreamKey.type === 'password') {
        cfgStreamKey.type = 'text';
        if (iconEyeShow) iconEyeShow.style.display = 'none';
        if (iconEyeHide) iconEyeHide.style.display = 'inline';
        if (btnRevealText) btnRevealText.textContent = 'Hide';
      } else {
        cfgStreamKey.type = 'password';
        if (iconEyeShow) iconEyeShow.style.display = 'inline';
        if (iconEyeHide) iconEyeHide.style.display = 'none';
        if (btnRevealText) btnRevealText.textContent = 'Show';
      }
      return;
    }

    // Input is empty: if key is configured on server, reveal it securely
    if (_currentSettings?.youtube?.streamKeySet) {
      const password = prompt('Re-enter admin password to reveal saved stream key:');
      if (!password) return;

      try {
        const res = await apiPost('/api/settings/reveal-stream-key', { password });
        cfgStreamKey.value = res.streamKey;
        cfgStreamKey.type = 'text';
        if (iconEyeShow) iconEyeShow.style.display = 'none';
        if (iconEyeHide) iconEyeHide.style.display = 'inline';
        if (btnRevealText) btnRevealText.textContent = 'Hide';
        updateKeyFeedback();
      } catch (err) {
        showToast(`Key reveal failed: ${err.message}`, 'error', 'Reveal Failed');
      }
    } else {
      showToast('No stream key is configured yet. Paste your YouTube Stream Key into the box.', 'info', 'Stream Key Empty');
    }
  });

  // Live input feedback on key typing
  cfgStreamKey.addEventListener('input', updateKeyFeedback);

  if (cfgHorizontalStreamKey) {
    cfgHorizontalStreamKey.addEventListener('input', updateHorizontalKeyFeedback);
  }

  if (btnRevealHorizKey) {
    btnRevealHorizKey.addEventListener('click', async () => {
      // If input currently has text typed, toggle visibility
      if (cfgHorizontalStreamKey.value.length > 0) {
        if (cfgHorizontalStreamKey.type === 'password') {
          cfgHorizontalStreamKey.type = 'text';
          if (iconEyeShowHoriz) iconEyeShowHoriz.style.display = 'none';
          if (iconEyeHideHoriz) iconEyeHideHoriz.style.display = 'inline';
          if (btnRevealHorizText) btnRevealHorizText.textContent = 'Hide';
        } else {
          cfgHorizontalStreamKey.type = 'password';
          if (iconEyeShowHoriz) iconEyeShowHoriz.style.display = 'inline';
          if (iconEyeHideHoriz) iconEyeHideHoriz.style.display = 'none';
          if (btnRevealHorizText) btnRevealHorizText.textContent = 'Show';
        }
        return;
      }

      // Input is empty: if horizontal key is configured on server, reveal it securely
      if (_currentSettings?.youtube?.horizontalStreamKeySet) {
        const password = prompt('Re-enter admin password to reveal saved horizontal stream key:');
        if (!password) return;

        try {
          const res = await apiPost('/api/settings/reveal-stream-key', { password });
          cfgHorizontalStreamKey.value = res.horizontalStreamKey || '';
          cfgHorizontalStreamKey.type = 'text';
          if (iconEyeShowHoriz) iconEyeShowHoriz.style.display = 'none';
          if (iconEyeHideHoriz) iconEyeHideHoriz.style.display = 'inline';
          if (btnRevealHorizText) btnRevealHorizText.textContent = 'Hide';
          updateHorizontalKeyFeedback();
        } catch (err) {
          showToast(`Key reveal failed: ${err.message}`, 'error', 'Reveal Failed');
        }
      } else {
        showToast('No horizontal stream key is configured yet. Paste your horizontal stream key into the box.', 'info', 'Stream Key Empty');
      }
    });
  }

  // Wire up maintenance banner disable button
  if (btnDisableMaintenance) {
    btnDisableMaintenance.addEventListener('click', async () => {
      try {
        await apiPost('/api/maintenance', { enabled: false });
        await fetchStatus();
        showToast('Maintenance mode disabled. You can now start streaming.', 'success', 'Maintenance Mode Disabled');
      } catch (e) {
        showToast(`Failed to disable maintenance mode: ${e.message}`, 'error', 'Disable Failed');
      }
    });
  }

  // Wire up Deck stream key badge
  if (deckStreamKeyBadge) {
    deckStreamKeyBadge.addEventListener('click', openSettings);
  }
  if (deckDualStreamBadge) {
    deckDualStreamBadge.addEventListener('click', openSettings);
  }

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    let rtmpsUrl = cfgRtmpsUrl.value.trim();
    if (rtmpsUrl.startsWith('rtmp://')) {
      rtmpsUrl = rtmpsUrl
        .replace(/^rtmp:\/\/a\.rtmp\.youtube\.com/i, 'rtmps://a.rtmps.youtube.com:443')
        .replace(/^rtmp:\/\/b\.rtmp\.youtube\.com/i, 'rtmps://b.rtmps.youtube.com:443')
        .replace(/^rtmp:\/\//i, 'rtmps://');
      cfgRtmpsUrl.value = rtmpsUrl;
    }

    const bitrate = parseFloat(cfgBitrate.value);
    const safetyLimit = parseFloat(cfgSafetyLimit.value);
    const overhead = parseFloat(cfgOverhead.value);

    const patch = {
      stream: {
        modePreference: cfgModePref.value,
        allowTranscode: cfgAllowTranscode ? cfgAllowTranscode.checked : true,
        ...(Number.isFinite(bitrate) ? { videoBitrateMbps: bitrate } : {}),
      },
      youtube: {
        rtmpsUrl,
        dualStreamEnabled: cfgDualStreamEnabled ? Boolean(cfgDualStreamEnabled.checked) : true,
      },
      bandwidth: {
        ...(Number.isFinite(safetyLimit) ? { safetyLimitTB: safetyLimit } : {}),
        ...(Number.isFinite(overhead) ? { overheadPercent: overhead } : {}),
      },
    };

    if (cfgStreamKey.value.trim()) {
      patch.youtube.streamKey = cfgStreamKey.value.trim();
    }
    if (cfgHorizontalStreamKey && cfgHorizontalStreamKey.value.trim() !== '') {
      patch.youtube.horizontalStreamKey = cfgHorizontalStreamKey.value.trim();
    }

    try {
      const res = await apiPut('/api/settings', patch);
      _currentSettings = res.settings;
      updateDeckStreamKeyBadge(res.settings);
      modalSettings.classList.remove('open');
      await refreshAll();

      showToast('YouTube stream configuration and dual stream preferences are active.', 'success', 'Settings Saved');

      if (res.requiresRestart) {
        const isLive = statusText.textContent === 'RUNNING' || statusText.textContent === 'STARTING' || statusText.textContent === 'DUAL LIVE';
        if (isLive && confirm('Settings saved! You modified parameters that require an FFmpeg restart. Restart the live stream now to apply changes?')) {
          await apiPost('/api/stream/restart');
          await fetchStatus();
        }
      }
    } catch (err) {
      const detail = err.errors && err.errors.length > 0
        ? err.errors.join('; ')
        : (err.message || 'Validation error');
      showToast(detail, 'error', 'Save Failed');
    }
  });

  setupUploads();
  setupYouTubeDownload();

  // 4b. Multi-Video Playlist Toolbar Handlers
  if (btnSelectAllVideos) {
    btnSelectAllVideos.addEventListener('click', async () => {
      const allIds = _cachedVideos.map(v => v.id);
      await updatePlaylist(allIds, _currentPlaybackOrder);
    });
  }

  if (btnDeselectAllVideos) {
    btnDeselectAllVideos.addEventListener('click', async () => {
      await updatePlaylist([], _currentPlaybackOrder);
    });
  }

  if (selPlaybackOrder) {
    selPlaybackOrder.addEventListener('change', async (e) => {
      const newOrder = e.target.value;
      await updatePlaylist(_currentPlaylist, newOrder);
    });
  }

  // 4c. Stream Scheduler & Auto-Recycle Listeners
  if (btnModeContinuous) {
    btnModeContinuous.addEventListener('click', () => {
      _schedSelectedMode = 'continuous';
      btnModeContinuous.classList.add('active');
      btnModeScheduled?.classList.remove('active');
      if (schedModeBadge) {
        schedModeBadge.textContent = '24×7 Continuous';
        schedModeBadge.className = 'badge-tag compatible';
      }
    });
  }

  if (btnModeScheduled) {
    btnModeScheduled.addEventListener('click', () => {
      _schedSelectedMode = 'scheduled';
      btnModeScheduled.classList.add('active');
      btnModeContinuous?.classList.remove('active');
      if (schedModeBadge) {
        schedModeBadge.textContent = 'Scheduled (IST)';
        schedModeBadge.className = 'badge-tag warning';
      }
    });
  }

  if (schedSlot1Enabled) {
    schedSlot1Enabled.addEventListener('change', updateSlotBadges);
  }

  if (schedSlot2Enabled) {
    schedSlot2Enabled.addEventListener('change', updateSlotBadges);
  }

  if (schedRecycleEnabled) {
    schedRecycleEnabled.addEventListener('change', () => {
      if (schedRecycleStatusBadge) {
        schedRecycleStatusBadge.textContent = schedRecycleEnabled.checked ? 'Protected' : 'Off';
        schedRecycleStatusBadge.className = `badge-tag ${schedRecycleEnabled.checked ? 'compatible' : 'disabled'}`;
      }
    });
  }

  if (btnSaveSchedule) {
    btnSaveSchedule.addEventListener('click', saveSchedulerSettings);
  }

  // Live 1-second IST clock ticking
  setInterval(tickLocalSchedulerClock, 1000);

  // 5. Authenticate Session
  const user = await initSession();
  if (!user) return;

  userDisplay.textContent = user.username || 'Admin';

  // 6. Tab Visibility Watcher
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopPolling();
    } else {
      refreshAll();
      startPolling();
    }
  });

  // 7. Initial Data Fetch & Start Background Polling
  await refreshAll();
  startPolling();
}

init();
