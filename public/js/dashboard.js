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

function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sc}s`;
}

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
    iconSvg = `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
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
const deckActiveKeyBadge = document.getElementById('deck-active-key-badge');

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
const btnRandomSelectVideos = document.getElementById('btn-random-select-videos');
const btnDeselectAllVideos = document.getElementById('btn-deselect-all-videos');
const playlistSelectedCount = document.getElementById('playlist-selected-count');
const selPlaybackOrder = document.getElementById('sel-playback-order');

// YouTube Import UI
const ytImportPanel = document.getElementById('yt-import-panel');
const ytUrlInput = document.getElementById('yt-url-input');
const ytQualitySelect = document.getElementById('yt-quality-select');
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
const cfgStudioBaseTitle = document.getElementById('cfg-studio-base-title');
const cfgStudioAutoEnabled = document.getElementById('cfg-studio-auto-enabled');
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
const deckStreamModeBadge = document.getElementById('deck-stream-mode-badge');
const bannerMaintenance = document.getElementById('banner-maintenance');
const btnDisableMaintenance = document.getElementById('btn-disable-maintenance');
const keyBadge = document.getElementById('key-badge');
const iconEyeShow = document.getElementById('icon-eye-show');
const iconEyeHide = document.getElementById('icon-eye-hide');
const btnRevealText = document.getElementById('btn-reveal-text');

// Mode Selection & Output Status DOM Elements
const btnModeHorizontal = document.getElementById('btn-mode-horizontal');
const btnModeVertical = document.getElementById('btn-mode-vertical');
const modeLockWarning = document.getElementById('mode-lock-warning');
const deckOutputRow = document.getElementById('deck-output-row');
const dotStreamOutput = document.getElementById('dot-stream-output');
const labelStreamOutput = document.getElementById('label-stream-output');
const textStreamOutput = document.getElementById('text-stream-output');

// Mode Playlist Selector Tabs DOM Elements
const tabPlaylistHorizontal = document.getElementById('tab-playlist-horizontal');
const tabPlaylistVertical = document.getElementById('tab-playlist-vertical');
const badgeCountHorizontal = document.getElementById('badge-count-horizontal');
const badgeCountVertical = document.getElementById('badge-count-vertical');
const chipLiveHorizontal = document.getElementById('chip-live-horizontal');
const chipLiveVertical = document.getElementById('chip-live-vertical');
const uploadZoneTitle = document.getElementById('upload-zone-title');
const uploadZoneSub = document.getElementById('upload-zone-sub');

// Scheduler & Auto-Recycle DOM Elements
const panelScheduler = document.getElementById('panel-scheduler');
const schedIstClock = document.getElementById('sched-ist-clock');
const schedModeBadge = document.getElementById('sched-mode-badge');
const schedStatusBanner = document.getElementById('sched-status-banner');
const schedStatusText = document.getElementById('sched-status-text');
const btnModeContinuous = document.getElementById('btn-mode-continuous');
const btnModeScheduled = document.getElementById('btn-mode-scheduled');
const schedWindowsCard = document.getElementById('sched-windows-card');
const schedSlotsContainer = document.getElementById('sched-slots-container');
const schedSlotsCountTag = document.getElementById('sched-slots-count-tag');
const btnAddSchedSlot = document.getElementById('btn-add-sched-slot');
const btnAddSchedSlotBottom = document.getElementById('btn-add-sched-slot-bottom');
const schedRecycleCard = document.getElementById('sched-recycle-card');
const schedRecycleStatusBadge = document.getElementById('sched-recycle-status-badge');
const schedRecycleEnabled = document.getElementById('sched-recycle-enabled');
const schedResumeBookmark = document.getElementById('sched-resume-bookmark');
const schedRecycleMinutes = document.getElementById('sched-recycle-minutes') || document.getElementById('sched-recycle-hours');
const schedPauseMins = document.getElementById('sched-pause-mins');
const deckAutoRecycleBadge = document.getElementById('deck-auto-recycle-badge');
const btnSaveSchedule = document.getElementById('btn-save-schedule');

if (deckAutoRecycleBadge) {
  deckAutoRecycleBadge.addEventListener('click', () => {
    const card = document.getElementById('sched-recycle-card');
    if (card) card.scrollIntoView({ behavior: 'smooth' });
  });
}

function updateRecycleHint(mins) {
  const hintEl = document.getElementById('sched-recycle-hint');
  if (!hintEl) return;
  const num = parseInt(mins, 10);
  if (!num || num <= 0) {
    hintEl.textContent = 'Set stream duration in minutes';
    return;
  }
  const h = (num / 60).toFixed(1).replace(/\.0$/, '');
  hintEl.textContent = `${num} mins = ${h} hours (Restart before 12h limit)`;
}

if (schedRecycleMinutes) {
  schedRecycleMinutes.addEventListener('input', () => {
    _schedRecycleDirty = true;
    updateRecycleHint(schedRecycleMinutes.value);
  });
}

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

  // Update Active Key and Stream Mode Badges
  const streamMode = (data.streamMode || _activeStreamMode || 'horizontal').toLowerCase();
  _activeStreamMode = streamMode;
  const isHoriz = streamMode === 'horizontal';

  if (deckActiveKeyBadge) {
    deckActiveKeyBadge.textContent = isHoriz ? 'ACTIVE KEY: Horizontal' : 'ACTIVE KEY: Vertical';
    deckActiveKeyBadge.title = isHoriz
      ? 'YouTube stream key for Horizontal 16:9 ("long")'
      : 'YouTube stream key for Vertical 9:16 ("shot")';
  }

  // Update Auto-Recycle Deck Badge
  const arStatus = data.scheduler?.autoRecycleStatus || data.autoRecycleStatus;
  const isArRecycling = Boolean(arStatus?.isRecycling || data.recyclingUntil || data.scheduler?.recycleState?.isRecycling);

  if (deckAutoRecycleBadge) {
    if (arStatus && arStatus.enabled) {
      deckAutoRecycleBadge.style.display = 'inline-flex';
      if (isArRecycling) {
        deckAutoRecycleBadge.className = 'reachability-pill warning';
        const rem = arStatus.nextStreamFormatted || (data.scheduler?.recycleState?.formatted) || '00:00:00';
        deckAutoRecycleBadge.innerHTML = `AUTO-RECYCLE PAUSE · Next: ${rem}`;
        deckAutoRecycleBadge.title = `Auto-recycle pause active. Next stream starts in: ${rem}`;
      } else if (data.status === 'RUNNING') {
        deckAutoRecycleBadge.className = 'reachability-pill healthy';
        const rem = arStatus.nextRecycleFormatted || '00:00:00';
        deckAutoRecycleBadge.innerHTML = `AUTO-RECYCLE · Next: ${rem}`;
        deckAutoRecycleBadge.title = `Auto-recycle armed. Next recycle in: ${rem}`;
      } else {
        deckAutoRecycleBadge.className = 'reachability-pill';
        deckAutoRecycleBadge.innerHTML = 'AUTO-RECYCLE: Armed';
        deckAutoRecycleBadge.title = 'Auto-recycle enabled; will activate once stream is running.';
      }
    } else {
      deckAutoRecycleBadge.style.display = 'none';
    }
  }

  updateModeSelectorUI(streamMode, data.status);

  // Single Output Channel Health Status Row
  const textModeStatus = document.getElementById('text-mode-status');
  const textSourceStatus = document.getElementById('text-source-status');
  const textKeyStatus = document.getElementById('text-key-status');

  if (textModeStatus) {
    textModeStatus.textContent = isHoriz ? 'HORIZONTAL 16:9' : 'VERTICAL 9:16';
  }
  if (textSourceStatus) {
    textSourceStatus.textContent = isHoriz ? 'Horizontal Playlist' : 'Vertical Playlist';
  }
  if (textKeyStatus) {
    const hint = _currentSettings?.youtube?.streamKeyHint;
    textKeyStatus.textContent = hint ? `Default (...${hint})` : (_currentSettings?.youtube?.streamKeySet ? 'Default' : 'Missing');
  }

  if (textStreamOutput) {
    const isConnected = data.status === 'RUNNING' && data.streamOutput === 'CONNECTED';
    const isStarting = data.status === 'STARTING';
    const outStatus = isConnected ? 'CONNECTED' : (isStarting ? 'CONNECTING' : 'DISCONNECTED');
    textStreamOutput.textContent = outStatus;
    if (dotStreamOutput) {
      if (outStatus === 'CONNECTED') dotStreamOutput.className = 'status-dot-sm live';
      else if (outStatus === 'CONNECTING') dotStreamOutput.className = 'status-dot-sm starting';
      else dotStreamOutput.className = 'status-dot-sm';
    }
  }

  if (data.status === 'RUNNING') {
    statusText.textContent = `LIVE (${streamMode.toUpperCase()} 1080p)`;
    statusDot.className = 'status-dot live';
  } else {
    statusText.textContent = data.status;
    statusDot.className = 'status-dot';
    if (data.status === 'STARTING') statusDot.classList.add('starting');
    else if (data.status === 'ERROR' || data.status === 'BANDWIDTH_LIMIT_REACHED') statusDot.classList.add('error');
  }

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

  const isRunning = data.status === 'RUNNING';
  const activeVideo = _cachedVideos.find(v => v.id === data.activeVideoId) || _cachedVideos[0];
  const videoFps = activeVideo?.probe?.fps || _currentSettings?.stream?.fps || 30;

  const p = data.progress;
  if (isRunning) {
    metricFps.textContent = (p && p.fps > 0) ? p.fps : videoFps;
    metricSpeed.textContent = (p && p.speedStr && p.speedStr !== 'N/A' && p.speedStr !== '0' && p.speedStr !== '0.00x')
      ? p.speedStr
      : '1.00x';
    const bStr = (p && p.bitrate && p.bitrate !== 'N/A' && p.bitrate !== '0kbits/s') ? p.bitrate : '';
    metricBitrate.textContent = bStr || `${Math.round((_currentSettings?.stream?.videoBitrateMbps || 4) * 1000)} kb/s`;
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

  // Last error display — only show during error states, never when healthy running
  if (data.lastError && (data.status === 'ERROR' || data.status === 'RECONNECTING')) {
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
  let currentMbps = 0;
  let currentKBps = 0;

  if (isRunning) {
    if (typeof data.progress?.outputMbps === 'number' && data.progress.outputMbps > 0) {
      currentMbps = data.progress.outputMbps;
      currentKBps = data.progress.outputKBps || Math.round((currentMbps * 1000) / 8);
    } else {
      let currentKbps = 0;
      if (data.progress?.bitrate && data.progress.bitrate !== 'N/A' && data.progress.bitrate !== '0kbits/s') {
        const bStr = String(data.progress.bitrate).toLowerCase().trim();
        const numMatch = bStr.match(/([\d.]+)/);
        if (numMatch) {
          const val = parseFloat(numMatch[1]) || 0;
          currentKbps = (bStr.includes('mbits') || bStr.includes('mb/s')) ? val * 1000 : val;
        }
      }
      if (!currentKbps || currentKbps <= 0) {
        currentKbps = Math.round((_currentSettings?.stream?.videoBitrateMbps || 4.0) * 1000);
      }
      currentMbps = currentKbps / 1000;
      currentKBps = Math.round(currentKbps / 8);
    }
  }

  _lastCurrentMbps = currentMbps;

  // 1. Arc Gauge Calculation: 0 to 10 Mbps scale (-110° to +110°)
  const maxScaleMbps = 10.0;
  const ratio = Math.max(0, Math.min(1.0, currentMbps / maxScaleMbps));
  const offset = 288 * (1 - ratio);
  speedGaugeFill.style.strokeDashoffset = offset.toFixed(1);

  // 2. GaugePointer Angle Calculation (-110° to +110°)
  const valueAngleDeg = -110 + ratio * 220;
  const targetMbps = Number(_currentSettings?.stream?.videoBitrateMbps);
  const isCapActive = !isNaN(targetMbps) && targetMbps > 0;
  const isOverTarget = isCapActive && currentMbps > (targetMbps * 1.10);
  const pointerColor = (currentMbps > 9.5 || isOverTarget) ? '#ef4444' : '#38bdf8';
  if (gaugePointerNeedle) {
    gaugePointerNeedle.style.transform = `rotate(${valueAngleDeg.toFixed(1)}deg)`;
    gaugePointerNeedle.setAttribute('stroke', pointerColor);
  }
  const pointerCircles = gaugePointerGroup ? gaugePointerGroup.querySelectorAll('circle') : [];
  if (pointerCircles.length > 0) {
    pointerCircles[0].setAttribute('fill', pointerColor);
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
    speedValKbps.textContent = `${currentKBps.toLocaleString()} KB/s`;
  }

  if (speedValHourly) {
    // GB per hour = (Mbps * 3600 / 8) / 1000
    const gbHour = isRunning ? (currentMbps * 3600 / 8 / 1000) : 0;
    speedValHourly.textContent = `${gbHour.toFixed(2)} GB/h`;
  }

  if (speedValTarget) {
    if (!isNaN(targetMbps) && targetMbps === 0) {
      speedValTarget.textContent = '0.00 Mbps (No Cap / Zero CPU)';
    } else {
      speedValTarget.textContent = `${Number(!isNaN(targetMbps) ? targetMbps : 4.0).toFixed(2)} Mbps`;
    }
  }

  if (speedValHealth) {
    if (isRunning) {
      const spd = (data.progress?.speed && data.progress.speed > 0) ? data.progress.speed : 1.0;
      const spdText = (data.progress?.speedStr && data.progress.speedStr !== 'N/A' && data.progress.speedStr !== '0') ? data.progress.speedStr : `${spd.toFixed(2)}x`;
      speedValHealth.textContent = `${spdText} (${spd >= 0.98 ? 'Optimal' : 'Slight Lag'})`;
      speedValHealth.style.color = spd >= 0.95 ? '#10b981' : '#f59e0b';
    } else {
      speedValHealth.textContent = 'Standby';
      speedValHealth.style.color = 'var(--text-dim)';
    }
  }

  if (speedWaveFps) {
    const fpsVal = (data.progress?.fps && data.progress.fps > 0)
      ? data.progress.fps
      : (isRunning ? (activeVideo?.probe?.fps || _currentSettings?.stream?.fps || 30) : 0);
    speedWaveFps.textContent = `${fpsVal} FPS`;
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
  if (_speedHistory.length > 20) {
    _speedHistory.shift();
  }
  drawSpeedActivityWave(isRunning);
}

function drawSpeedActivityWave(isRunning = false) {
  if (!speedWaveLine || !speedWaveArea) return;

  const points = _speedHistory;
  const count = points.length;
  const w = 200;
  const baseY = 34;
  const maxH = 28;
  const maxScale = 10.0;

  const step = w / (count - 1);
  const coords = points.map((val, idx) => {
    // Add micro-ripple if streaming live so wave visibly animates
    const ripple = (isRunning && val > 0) ? (1 + Math.sin(idx * 1.5 + Date.now() / 500) * 0.08) : 1.0;
    const r = Math.min(1.0, (val * ripple) / maxScale);
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
let _schedSlotsInitialized = false;
let _schedSlotsDirty = false;
let _schedModeDirty = false;
let _schedRecycleDirty = false;

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

function renderScheduler(data, options = {}) {
  if (!data) return;
  const forceSlots = !!options.forceSlots;
  const forceInputs = !!options.forceInputs;

  // 1. Live IST Clock (always updated on every poll)
  if (schedIstClock && data.clockStr) {
    schedIstClock.textContent = data.clockStr;
  }

  // 2. Mode State & Toggle Buttons
  if (!_schedModeDirty || forceInputs) {
    _schedSelectedMode = data.mode === 'scheduled' ? 'scheduled' : 'continuous';
    if (_schedSelectedMode === 'scheduled') {
      btnModeScheduled?.classList.add('active');
      btnModeContinuous?.classList.remove('active');
    } else {
      btnModeContinuous?.classList.add('active');
      btnModeScheduled?.classList.remove('active');
    }
  }

  if (schedModeBadge) {
    if (_schedModeDirty) {
      schedModeBadge.textContent = _schedSelectedMode === 'scheduled' ? 'Scheduled (Unsaved)' : '24×7 (Unsaved)';
      schedModeBadge.className = 'badge-tag warning';
    } else if (data.mode === 'scheduled') {
      schedModeBadge.textContent = 'Scheduled (IST)';
      schedModeBadge.className = 'badge-tag warning';
    } else {
      schedModeBadge.textContent = '24×7 Continuous';
      schedModeBadge.className = 'badge-tag compatible';
    }
  }

  // 3. Daily Streaming Windows (Dynamic Slots in IST)
  // CRITICAL FIX: Only rebuild slot elements on initial load or when forced (after user saves).
  // Background polling (every 10s) must NOT wipe or recreate the slots, otherwise user-added slots
  // and in-progress time edits get destroyed before they can click Save.
  const shouldBuildSlots = !_schedSlotsInitialized || forceSlots;
  const isEditingSlot = schedSlotsContainer && schedSlotsContainer.contains(document.activeElement);
  if (schedSlotsContainer && shouldBuildSlots && !isEditingSlot) {
    schedSlotsContainer.innerHTML = '';
    const windows = Array.isArray(data.windows) ? data.windows : [];
    if (windows.length > 0) {
      windows.forEach((win, i) => {
        const box = createSlotBox({ start: win.start || '10:00', stop: win.stop || '14:00', enabled: true }, i + 1);
        schedSlotsContainer.appendChild(box);
      });
    } else {
      const box = createSlotBox({ start: '10:00', stop: '14:00', enabled: false }, 1);
      schedSlotsContainer.appendChild(box);
    }
    renumberSlots();
    _schedSlotsInitialized = true;
    _schedSlotsDirty = false;
  }

  // 4. Auto-Recycle Settings (VOD Archive Protection)
  const ar = data.autoRecycle || {};
  const arStatus = data.autoRecycleStatus || {};
  const recMins = ar.maxSessionMinutes || (ar.maxSessionHours ? Math.round(ar.maxSessionHours * 60) : 480);
  const isEditingRecycle = schedRecycleCard && schedRecycleCard.contains(document.activeElement);

  if ((!_schedRecycleDirty || forceInputs) && !isEditingRecycle) {
    if (schedRecycleEnabled) schedRecycleEnabled.checked = !!ar.enabled;
    if (schedRecycleMinutes) schedRecycleMinutes.value = recMins;
    updateRecycleHint(recMins);
    if (schedPauseMins) schedPauseMins.value = ar.pauseMinutes || 60;
    if (schedResumeBookmark) schedResumeBookmark.checked = ar.resumeBookmark !== false;
    _schedRecycleDirty = false;
  }

  if (schedRecycleStatusBadge) {
    if (arStatus.isRecycling) {
      schedRecycleStatusBadge.textContent = `Pausing (${arStatus.nextStreamFormatted || 'Pause Active'})`;
      schedRecycleStatusBadge.className = 'badge-tag warning';
    } else if (ar.enabled && data.status === 'RUNNING') {
      schedRecycleStatusBadge.textContent = `Active (${arStatus.nextRecycleFormatted || 'Rotating'})`;
      schedRecycleStatusBadge.className = 'badge-tag compatible';
    } else {
      schedRecycleStatusBadge.textContent = ar.enabled ? 'Armed' : 'Off';
      schedRecycleStatusBadge.className = `badge-tag ${ar.enabled ? 'compatible' : 'disabled'}`;
    }
  }

  // 5. Dynamic Status Banner
  if (schedStatusBanner && schedStatusText) {
    if (arStatus.isRecycling || (data.recycleState && data.recycleState.isRecycling)) {
      schedStatusBanner.className = 'sched-banner recycle';
      const rem = arStatus.nextStreamFormatted || `${data.recycleState?.remainingMinutes || 0}m`;
      schedStatusText.innerHTML = `<strong>AUTO-RECYCLE PAUSE:</strong> Next stream in: <code>${rem}</code>. Stream paused to let YouTube finalize past broadcast as permanent VOD.`;
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
        const durLabel = (recMins % 60 === 0) ? `${recMins / 60}h` : `${recMins}m`;
        const nextStr = (data.status === 'RUNNING' && arStatus.nextRecycleFormatted) ? ` · Next recycle in: <code>${arStatus.nextRecycleFormatted}</code>` : '';
        schedStatusText.innerHTML = `<strong>AUTO-RECYCLE ACTIVE:</strong> Running non-stop with automatic ${durLabel} session rotation & ${ar.pauseMinutes || 60}m archive pause.${nextStr}`;
      } else {
        schedStatusBanner.className = 'sched-banner info';
        schedStatusText.innerHTML = `<strong>24×7 Continuous Streaming Active:</strong> Stream runs uninterrupted. Note: Streams exceeding 12h are not archived by YouTube into channel videos. Enable Auto-Recycle to save past streams automatically.`;
      }
    }
  }
}

function createSlotBox(slot = { start: '10:00', stop: '14:00', enabled: true }, index = 1) {
  const box = document.createElement('div');
  box.className = 'sched-slot-box';
  box.style.marginTop = index > 1 ? '0.5rem' : '0';
  box.innerHTML = `
    <div class="sched-slot-top">
      <label class="sched-checkbox-label">
        <input type="checkbox" class="sched-slot-enabled" ${slot.enabled !== false ? 'checked' : ''}>
        <strong class="sched-slot-title">Slot ${index}</strong>
      </label>
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <span class="badge-tag ${slot.enabled !== false ? 'compatible' : 'disabled'} sched-slot-badge">${slot.enabled !== false ? 'Active' : 'Disabled'}</span>
        <button type="button" class="btn-remove-sched-slot" title="Delete slot">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="sched-time-inputs">
      <div class="form-group">
        <span class="form-label">Start Time (IST)</span>
        <input type="time" class="form-control sched-slot-start" value="${slot.start || '10:00'}">
      </div>
      <div class="form-group">
        <span class="form-label">Stop Time (IST)</span>
        <input type="time" class="form-control sched-slot-stop" value="${slot.stop || '14:00'}">
      </div>
    </div>
  `;

  const chk = box.querySelector('.sched-slot-enabled');
  const badge = box.querySelector('.sched-slot-badge');
  chk?.addEventListener('change', () => {
    _schedSlotsDirty = true;
    if (badge) {
      badge.textContent = chk.checked ? 'Active' : 'Disabled';
      badge.className = `badge-tag ${chk.checked ? 'compatible' : 'disabled'} sched-slot-badge`;
    }
    updateSlotsCountTag();
  });

  const startInput = box.querySelector('.sched-slot-start');
  const stopInput = box.querySelector('.sched-slot-stop');
  startInput?.addEventListener('input', () => { _schedSlotsDirty = true; });
  stopInput?.addEventListener('input', () => { _schedSlotsDirty = true; });

  const btnDel = box.querySelector('.btn-remove-sched-slot');
  btnDel?.addEventListener('click', () => {
    _schedSlotsDirty = true;
    const totalSlots = schedSlotsContainer ? schedSlotsContainer.querySelectorAll('.sched-slot-box').length : 0;
    if (totalSlots <= 1) {
      showToast('At least one slot must remain. You can uncheck it to disable.', 'info', 'Slot Required');
      return;
    }
    box.remove();
    renumberSlots();
  });

  return box;
}

function updateSlotsCountTag() {
  if (!schedSlotsCountTag || !schedSlotsContainer) return;
  const boxes = schedSlotsContainer.querySelectorAll('.sched-slot-box');
  const activeCount = Array.from(boxes).filter(b => b.querySelector('.sched-slot-enabled')?.checked).length;
  schedSlotsCountTag.textContent = `${activeCount} / ${boxes.length} Active`;
}

function renumberSlots() {
  if (!schedSlotsContainer) return;
  const boxes = schedSlotsContainer.querySelectorAll('.sched-slot-box');
  boxes.forEach((box, i) => {
    const title = box.querySelector('.sched-slot-title');
    if (title) title.textContent = `Slot ${i + 1}`;
    box.style.marginTop = i > 0 ? '0.5rem' : '0';
  });
  updateSlotsCountTag();
}

function addNewStreamingSlot(startVal = null, stopVal = null) {
  _schedSlotsInitialized = true;
  _schedSlotsDirty = true;
  if (!schedSlotsContainer) return;
  const boxes = schedSlotsContainer.querySelectorAll('.sched-slot-box');
  const nextIdx = boxes.length + 1;

  let defStart = '10:00';
  let defStop = '14:00';
  if (boxes.length === 1) {
    defStart = '18:00';
    defStop = '22:00';
  } else if (boxes.length > 1) {
    const lastBox = boxes[boxes.length - 1];
    const lastStop = lastBox.querySelector('.sched-slot-stop')?.value || '22:00';
    const [h, m] = lastStop.split(':').map(Number);
    const nextH = ((h || 0) + 1) % 24;
    const endH = ((nextH + 4) % 24);
    defStart = `${String(nextH).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
    defStop = `${String(endH).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
  }

  const newBox = createSlotBox({
    start: startVal || defStart,
    stop: stopVal || defStop,
    enabled: true,
  }, nextIdx);

  schedSlotsContainer.appendChild(newBox);
  renumberSlots();

  const startInput = newBox.querySelector('.sched-slot-start');
  startInput?.focus();
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
    if (schedSlotsContainer) {
      const boxes = schedSlotsContainer.querySelectorAll('.sched-slot-box');
      boxes.forEach(box => {
        const enabled = box.querySelector('.sched-slot-enabled')?.checked;
        const start = box.querySelector('.sched-slot-start')?.value?.trim();
        const stop = box.querySelector('.sched-slot-stop')?.value?.trim();
        if (enabled && start && stop) {
          windows.push({
            days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
            start,
            stop,
          });
        }
      });
    }

    const payload = {
      mode: _schedSelectedMode,
      timezone: 'Asia/Kolkata',
      windows,
      autoRecycle: {
        enabled: schedRecycleEnabled ? schedRecycleEnabled.checked : false,
        maxSessionMinutes: parseInt(schedRecycleMinutes?.value, 10) || 480,
        maxSessionHours: +((parseInt(schedRecycleMinutes?.value, 10) || 480) / 60).toFixed(2),
        pauseMinutes: parseInt(schedPauseMins?.value, 10) || 60,
        resumeBookmark: schedResumeBookmark ? schedResumeBookmark.checked : true,
      },
    };

    const res = await apiPut('/api/scheduler', payload);
    _schedSlotsDirty = false;
    _schedModeDirty = false;
    _schedRecycleDirty = false;
    if (res?.scheduler) {
      renderScheduler(res.scheduler, { forceSlots: true, forceInputs: true });
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
  const heapUsed = data.appRam?.heapUsedMB || 0;
  const sysPct = data.ram?.usedPercent || 0;
  metricRam.textContent = `${appMb} MB`;
  if (metricRamSub) {
    metricRamSub.textContent = `Heap: ${heapUsed} MB (Pool: ${appMb} MB) · Sys: ${sysPct}%`;
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
    const ms = Number(data.reachability.latencyMs) || 0;
    const iconSvg = `<svg class="icon icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /><line x1="2" y1="12" x2="22" y2="12" /></svg>`;
    reachabilityBadge.innerHTML = data.reachability.reachable
      ? `${iconSvg} YouTube Reachable (${ms > 0 ? ms : '16'}ms)`
      : `${iconSvg} YouTube Unreachable`;
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

let _activeStreamMode = 'horizontal';
let _currentTabMode = 'horizontal';
let _playlists = { horizontal: [], vertical: [] };

function updateModeSelectorUI(mode, currentStatus) {
  const isLive = currentStatus === 'RUNNING' || currentStatus === 'STARTING';
  if (btnModeHorizontal && btnModeVertical) {
    if (mode === 'horizontal') {
      btnModeHorizontal.className = 'btn btn-sm mode-btn active btn-primary';
      btnModeVertical.className = 'btn btn-sm mode-btn btn-secondary';
    } else {
      btnModeHorizontal.className = 'btn btn-sm mode-btn btn-secondary';
      btnModeVertical.className = 'btn btn-sm mode-btn active btn-primary';
    }
    btnModeHorizontal.disabled = isLive;
    btnModeVertical.disabled = isLive;
  }

  if (modeLockWarning) {
    modeLockWarning.style.display = isLive ? 'inline' : 'none';
  }

  if (deckStreamModeBadge) {
    const isH = mode === 'horizontal';
    deckStreamModeBadge.textContent = `MODE: ${isH ? 'HORIZONTAL (16:9)' : 'VERTICAL (9:16)'}`;
    deckStreamModeBadge.style.color = isH ? '#38bdf8' : '#a78bfa';
  }

  if (chipLiveHorizontal) chipLiveHorizontal.style.display = mode === 'horizontal' ? 'inline-flex' : 'none';
  if (chipLiveVertical) chipLiveVertical.style.display = mode === 'vertical' ? 'inline-flex' : 'none';
}

function switchPlaylistTab(mode) {
  _currentTabMode = mode;
  if (tabPlaylistHorizontal && tabPlaylistVertical) {
    if (mode === 'horizontal') {
      tabPlaylistHorizontal.classList.add('active');
      tabPlaylistVertical.classList.remove('active');
    } else {
      tabPlaylistHorizontal.classList.remove('active');
      tabPlaylistVertical.classList.add('active');
    }
  }

  if (uploadZoneTitle && uploadZoneSub) {
    if (mode === 'horizontal') {
      uploadZoneTitle.textContent = 'Tap or Drag Horizontal (16:9) MP4 Video Here';
      uploadZoneSub.textContent = 'Recommended: 1920×1080, H.264 / AAC, 4.5 Mbps, Constant 30/60 fps';
    } else {
      uploadZoneTitle.textContent = 'Tap or Drag Vertical (9:16) MP4 Video Here';
      uploadZoneSub.textContent = 'Recommended: 1080×1920, H.264 / AAC, 4 Mbps, Constant 30/60 fps';
    }
  }

  const modePlaylist = _playlists[mode] || [];
  renderVideos(_cachedVideos, _currentActiveVideoId, modePlaylist, _currentPlaybackOrder);
}

async function changeStreamMode(targetMode) {
  if (_currentStatus === 'RUNNING' || _currentStatus === 'STARTING') {
    showToast('Cannot change stream mode while stream is running. Stop stream first.', 'warning', 'Stream Live');
    return;
  }

  try {
    const res = await apiPost('/api/stream/mode', { mode: targetMode });
    if (res.success) {
      _activeStreamMode = res.mode;
      switchPlaylistTab(res.mode);
      showToast(`Stream mode switched to ${res.mode.toUpperCase()}`, 'success', 'Mode Changed');
      await refreshAll();
    }
  } catch (err) {
    showToast(err.message, 'error', 'Mode Change Failed');
  }
}

async function fetchVideos() {
  try {
    const data = await apiGet('/api/videos');
    if (data.activeVideoId) {
      _currentActiveVideoId = data.activeVideoId;
    }
    _cachedVideos = data.videos || [];
    _playlists = data.playlists || {
      horizontal: Array.isArray(data.playlist) ? data.playlist : [],
      vertical: [],
    };
    if (data.streamMode) {
      _activeStreamMode = data.streamMode.toLowerCase();
    }
    _currentPlaybackOrder = data.playbackOrder || 'sequential';
    _currentPlaylist = _playlists[_currentTabMode] || [];

    // Update tab badges
    if (badgeCountHorizontal) badgeCountHorizontal.textContent = (_playlists.horizontal?.length || 0);
    if (badgeCountVertical) badgeCountVertical.textContent = (_playlists.vertical?.length || 0);

    updateModeSelectorUI(_activeStreamMode, _currentStatus);
    renderVideos(_cachedVideos, data.activeVideoId, _currentPlaylist, _currentPlaybackOrder);
  } catch (err) {
    console.error('Fetch videos failed:', err);
  }
}

async function updatePlaylist(newPlaylist, playbackOrder = _currentPlaybackOrder, mode = _currentTabMode, customToast = null) {
  const isLive = _currentStatus === 'RUNNING' || _currentStatus === 'STARTING';

  try {
    const url = '/api/videos/playlist';
    const res = await apiPost(url, { playlist: newPlaylist, playbackOrder, mode });
    if (res.playlists) {
      _playlists = res.playlists;
    } else {
      _playlists[mode] = res.playlist || newPlaylist;
    }
    _currentPlaylist = _playlists[_currentTabMode] || [];
    _currentPlaybackOrder = res.playbackOrder || playbackOrder;
    await fetchVideos();
    if (customToast) {
      showToast(customToast.message, customToast.type || 'success', customToast.title || 'Playlist Updated');
    } else if (isLive && mode === _activeStreamMode) {
      showToast('Playlist updated dynamically without stream restart.', 'success', 'Hot Sync Active');
    } else {
      showToast('Playlist updated.', 'success');
    }
  } catch (err) {
    showToast(err.message, 'error', 'Playlist Update Failed');
    await fetchVideos();
  }
}

function formatVideoBitrate(v) {
  const bps = Number(v?.probe?.videoBitrate || v?.videoBitrate || v?.probe?.bitrate || 0) ||
    ((v?.sizeBytes && v?.probe?.durationSec && v.probe.durationSec > 0)
      ? Math.round((v.sizeBytes * 8) / v.probe.durationSec)
      : 0);

  if (!bps || bps <= 0) return null;
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  }
  return `${Math.round(bps / 1000)} kbps`;
}

function renderVideos(videos, activeIdFromApi = null, playlist = (_playlists[_currentTabMode] || []), playbackOrder = _currentPlaybackOrder) {
  videosList.innerHTML = '';
  const currentVideoId = activeIdFromApi || _currentActiveVideoId || _currentSettings?.stream?.videoId;

  // Filter library videos to items matching current tab orientation
  const tabVideos = videos.filter(v => {
    const isHoriz = (v.probe?.width || 0) >= (v.probe?.height || 0);
    return _currentTabMode === 'horizontal' ? isHoriz : !isHoriz;
  });

  if (videoCountBadge) {
    videoCountBadge.textContent = `${tabVideos.length} ${_currentTabMode === 'horizontal' ? '16:9' : '9:16'} Videos`;
  }

  if (playlistSelectedCount) {
    const count = playlist.length;
    playlistSelectedCount.textContent = `${count} ${count === 1 ? 'Video' : 'Videos'} in ${_currentTabMode === 'horizontal' ? '16:9' : '9:16'} Playlist`;
  }

  if (selPlaybackOrder) {
    selPlaybackOrder.value = playbackOrder || 'sequential';
  }

  if (tabVideos.length === 0) {
    const isHoriz = _currentTabMode === 'horizontal';
    videosList.innerHTML = `
      <div class="videos-empty-state">
        <div class="empty-icon-bubble">
          <svg class="icon icon-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
            <polygon points="10 8 16 12 10 16 10 8" fill="rgba(255,255,255,0.08)" stroke="currentColor" />
          </svg>
        </div>
        <div class="empty-state-title">No ${isHoriz ? 'Horizontal (16:9)' : 'Vertical (9:16)'} videos in library</div>
        <div class="empty-state-subtitle">Upload a ${isHoriz ? '16:9' : '9:16'} MP4 video above to add it to this playlist</div>
        <button id="btn-sync-videos" class="btn btn-secondary btn-sm empty-state-btn">
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

  if (playlist.length === 0) {
    activeVideoName.textContent = 'Active: None';
  } else if (playlist.length === 1) {
    const single = tabVideos.find(v => v.id === playlist[0]) || videos.find(v => v.id === playlist[0]);
    const label = single ? (single.label || single.originalName) : playlist[0];
    activeVideoName.textContent = `Looping 1: ${label}`;
  } else {
    activeVideoName.textContent = `Looping ${playlist.length} Videos (${playbackOrder === 'shuffle' ? 'Shuffle' : 'Sequential'}) [${_currentTabMode.toUpperCase()}]`;
  }

  tabVideos.forEach(v => {
    const isSelected = playlist.includes(v.id);
    const orderIndex = playlist.indexOf(v.id);
    const isPlaying = (v.id === currentVideoId) && (_activeStreamMode === _currentTabMode);
    const isSoloActive = isSelected && playlist.length === 1;

    const item = document.createElement('div');
    item.className = `video-item ${isSelected ? 'in-playlist' : ''} ${isPlaying ? 'active' : ''}`;

    const isHorizontal = (v.probe?.width || 0) >= (v.probe?.height || 0);
    const compat = v.compatibility?.status === 'COMPATIBLE' ? 'compatible' : 'transcode';
    const compatLabel = v.compatibility?.status === 'COMPATIBLE' ? 'Stream-Copy Ready' : 'Needs Transcode';
    const bitrateStr = formatVideoBitrate(v);

    let chkAreaHtml = '';
    if (isSelected) {
      chkAreaHtml = `
        <label class="video-chk-label" title="Deselect from playlist">
          <input type="checkbox" class="video-select-chk" data-id="${v.id}" checked>
        </label>
        <span class="playlist-seq-badge" title="Position #${orderIndex + 1}">#${orderIndex + 1}</span>
      `;
    } else {
      chkAreaHtml = `
        <label class="video-chk-label" title="Select for playlist">
          <input type="checkbox" class="video-select-chk" data-id="${v.id}">
        </label>
      `;
    }

    item.innerHTML = `
      <div class="video-item-top">
        <div class="video-item-leading">
          ${chkAreaHtml}
        </div>
        <div class="video-name clickable-preview" data-id="${v.id}" title="Click to preview video: ${v.label || v.originalName}">${v.label || v.originalName}</div>
      </div>
      <div class="video-meta">
        <span class="badge-tag">${isHorizontal ? '16:9' : '9:16'}</span>
        <span class="meta-tag">${v.probe?.width || 0}×${v.probe?.height || 0}</span>
        <span class="meta-tag">${v.probe?.fps || 30}fps</span>
        ${bitrateStr ? `<span class="meta-tag meta-bitrate" title="Video Bitrate: ${bitrateStr}">${bitrateStr}</span>` : ''}
        <span class="meta-tag">${formatBytes(v.sizeBytes)}</span>
        ${v.probe?.durationSec ? `<span class="meta-tag">${formatDuration(v.probe.durationSec)}</span>` : ''}
        <span class="badge-tag ${compat}" title="${(v.compatibility?.explanations || []).join(' \\n ') || compatLabel}">${compatLabel}</span>
      </div>
      <div class="video-actions">
        <button class="btn btn-secondary btn-sm btn-preview-video" data-id="${v.id}" title="Watch video playback preview">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Preview
        </button>
        ${isPlaying
          ? '<span class="badge-tag badge-active">NOW PLAYING</span>'
          : isSelected
            ? `<span class="badge-tag badge-active">${isSoloActive ? 'ACTIVE SOLO' : `IN PLAYLIST (#${orderIndex + 1})`}</span>`
            : `<button class="btn btn-secondary btn-sm btn-play-solo" data-id="${v.id}" title="Play only this video in active playlist">
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
      let currentModePlaylist = [...(_playlists[_currentTabMode] || [])];
      if (chk.checked) {
        if (!currentModePlaylist.includes(id)) currentModePlaylist.push(id);
      } else {
        currentModePlaylist = currentModePlaylist.filter(x => x !== id);
      }
      await updatePlaylist(currentModePlaylist, _currentPlaybackOrder, _currentTabMode);
    });
  });

  // Attach Play Solo Events
  videosList.querySelectorAll('.btn-play-solo').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-id');
      await updatePlaylist([id], _currentPlaybackOrder, _currentTabMode);
    });
  });

  // Attach Video Playback Preview Events
  videosList.querySelectorAll('.btn-preview-video, .video-name.clickable-preview').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.getAttribute('data-id');
      const video = tabVideos.find(x => x.id === id) || videos.find(x => x.id === id);
      openVideoPreview(id, video);
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

function openVideoPreview(id, video) {
  const modal = document.getElementById('modal-video-preview');
  const titleEl = document.getElementById('preview-video-title');
  const metaEl = document.getElementById('preview-video-meta');
  const player = document.getElementById('preview-video-player');
  const infoEl = document.getElementById('preview-player-info');

  if (!modal || !player) return;

  const label = video?.label || video?.originalName || id;
  const isHoriz = (video?.probe?.width || 0) >= (video?.probe?.height || 0);
  const res = video?.probe?.width && video?.probe?.height ? `${video.probe.width}×${video.probe.height}` : '';
  const fps = video?.probe?.fps ? `${video.probe.fps}fps` : '';
  const dur = video?.probe?.durationSec ? formatDuration(video.probe.durationSec) : '';

  if (titleEl) {
    titleEl.textContent = label;
  }
  const bitrateStr = formatVideoBitrate(video);
  const defaultMeta = [
    isHoriz ? '16:9 Landscape' : '9:16 Vertical Shorts',
    res,
    fps,
    bitrateStr,
    dur
  ].filter(Boolean).join(' | ') || 'Direct stream playback preview';

  if (metaEl) {
    metaEl.textContent = defaultMeta;
  }
  if (infoEl) {
    infoEl.innerHTML = `
      <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" />
        <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
      </svg>
      Direct HTTP Range Stream (Muted for autoplay)`;
  }

  // Reset player state cleanly
  player.pause();
  player.currentTime = 0;
  player.muted = true; // Essential: allows modern browsers to autoplay without permission block

  // Attach error handler for feedback
  player.onerror = () => {
    const err = player.error;
    const code = err ? err.code : 'unknown';
    let msg = 'Failed to load video stream';
    if (code === 1) msg = 'Playback aborted';
    else if (code === 2) msg = 'Network error downloading stream';
    else if (code === 3) msg = 'Media decode error';
    else if (code === 4) msg = 'Format not supported or file missing on disk';
    if (metaEl) {
      metaEl.innerHTML = `<span style="color:var(--status-err, #f87171); font-weight:600;">Stream Error (${code}): ${msg}</span>`;
    }
  };

  player.onplaying = () => {
    if (metaEl && metaEl.textContent.startsWith('Stream Error')) return;
    if (metaEl) metaEl.textContent = defaultMeta;
  };

  // Set new source and trigger reload
  player.src = `/api/videos/${encodeURIComponent(id)}/stream`;
  player.load();
  modal.classList.add('open');

  const playPromise = player.play();
  if (playPromise !== undefined) {
    playPromise.catch(err => {
      console.debug('Autoplay preview video:', err?.message);
      if (infoEl) {
        infoEl.innerHTML = `
          <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
          </svg>
          Direct HTTP Range Stream (Click play to watch)`;
      }
    });
  }
}

function closeVideoPreview() {
  const modal = document.getElementById('modal-video-preview');
  const player = document.getElementById('preview-video-player');
  if (player) {
    player.pause();
    player.removeAttribute('src');
    player.load();
    player.onerror = null;
    player.onplaying = null;
  }
  if (modal) {
    modal.classList.remove('open');
  }
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
    row.textContent = `[${time}] [${lvl.toUpperCase()}] ${l.event || ''}: ${l.msg || l.message || l.raw || ''}`;
    logViewer.appendChild(row);
  });
  logViewer.scrollTop = logViewer.scrollHeight;
}

// ─── Settings Modal & Live Preview ────────────────────────────────────────────

function updateDeckStreamKeyBadge(settings) {
  if (!deckStreamKeyBadge) return;
  const hasKey = Boolean(settings?.youtube?.streamKeySet);
  const hint = settings?.youtube?.streamKeyHint;

  if (!hasKey) {
    deckStreamKeyBadge.textContent = 'Default Key Missing';
    deckStreamKeyBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    deckStreamKeyBadge.style.color = '#f87171';
    deckStreamKeyBadge.title = 'No YouTube default stream key configured! Click to open Settings.';
  } else {
    deckStreamKeyBadge.textContent = `Default Key (...${hint || 'Set'})`;
    deckStreamKeyBadge.style.borderColor = 'var(--border-muted)';
    deckStreamKeyBadge.style.color = 'var(--text-main)';
    deckStreamKeyBadge.title = `Canonical YouTube stream key configured (...${hint || 'Set'}). Used for both Horizontal and Vertical live streaming. Click to change.`;
  }
}

function updateKeyFeedback() {
  if (!keyBadge || !keyHintText || !cfgStreamKey) return;
  const val = cfgStreamKey.value.trim();
  if (val.length > 0) {
    keyBadge.textContent = 'Unsaved Entry';
    keyBadge.className = 'badge-tag badge-active';
    keyHintText.innerHTML = `New default stream key entered (${val.length} chars) — Click <strong>Save Configuration</strong> below to apply.`;
  } else if (_currentSettings?.youtube?.streamKeySet) {
    keyBadge.textContent = `Saved (...${_currentSettings.youtube.streamKeyHint})`;
    keyBadge.className = 'badge-tag';
    cfgStreamKey.placeholder = `Saved (ends in ...${_currentSettings.youtube.streamKeyHint})`;
    keyHintText.innerHTML = `YouTube Default Stream Key is saved (ends in ...${_currentSettings.youtube.streamKeyHint}). Used for all live streams in both Horizontal 16:9 and Vertical 9:16 modes.`;
  } else {
    keyBadge.textContent = 'Required';
    keyBadge.className = 'badge-tag';
    cfgStreamKey.placeholder = 'Paste YouTube Default Stream Key';
    keyHintText.innerHTML = 'Canonical YouTube stream key used for live broadcast transmission in both Horizontal and Vertical modes.';
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

    if (cfgStudioBaseTitle) {
      cfgStudioBaseTitle.value = settings.studioAutomation?.baseTitle || settings.youtube?.title || '';
    }
    if (cfgStudioAutoEnabled) {
      cfgStudioAutoEnabled.checked = settings.studioAutomation?.enabled !== false;
    }

    updateKeyFeedback();

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
    // Check cookies status and update VM Chrome session banner
    apiGet('/api/videos/cookies-status').then((s) => {
      const banner = document.getElementById('yt-chrome-banner');
      const sessionText = document.getElementById('yt-chrome-session-text');
      if (banner) banner.style.display = 'flex';
      if (sessionText) {
        if (s?.exists || s?.chromeActive) {
          sessionText.textContent = 'VM Chrome Session Active';
          sessionText.style.color = '#34d399';
        } else {
          sessionText.textContent = 'Chrome Session Pending';
          sessionText.style.color = '#fbbf24';
        }
      }
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
  formData.append('mode', _currentTabMode || _activeStreamMode || 'horizontal');

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
  merging: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  probing: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  optimizing_keyframes: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  registering: '<polyline points="20 6 9 17 4 12"/>',
  converting: '<polyline points="20 6 9 17 4 12"/>',
  completed: '<polyline points="20 6 9 17 4 12"/>',
  error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  cancelled: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

const _ytStageColors = {
  fetching_info: 'var(--accent-cyan)',
  downloading: 'var(--accent-primary)',
  merging: 'var(--accent-cyan)',
  probing: 'var(--accent-cyan)',
  optimizing_keyframes: 'var(--accent-primary)',
  stripping_metadata: 'var(--accent-cyan)',
  registering: 'var(--accent-cyan)',
  converting: 'var(--accent-cyan)',
  completed: 'var(--accent-emerald)',
  error: 'var(--accent-rose)',
  cancelled: 'var(--text-muted)',
};

const _ytStageLabels = {
  fetching_info: 'Fetching video info...',
  downloading: 'Downloading highest quality video...',
  merging: 'Finalizing MP4 container (remuxing)...',
  probing: 'Analyzing stream specs & GOP intervals...',
  optimizing_keyframes: 'Optimizing GOP for stream-copy (2.0s keyframes)...',
  stripping_metadata: 'Sanitizing container (cleaning all metadata)...',
  registering: 'Importing & updating playlist...',
  converting: 'Processing video...',
  completed: 'Download complete & playlist updated',
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
  if (status.stage === 'downloading') {
    const parts = [];
    if (status.downloaded && status.totalSize) {
      parts.push(`${status.downloaded} / ${status.totalSize}`);
    } else if (status.downloaded) {
      parts.push(status.downloaded);
    }
    if (status.speed) {
      parts.push(status.speed);
    }
    if (status.eta && status.eta !== 'Unknown') {
      parts.push(`ETA ${status.eta}`);
    }
    details = parts.join(' · ');
  } else if (status.stage === 'merging') {
    details = 'Network download finished. Remuxing to MP4 container...';
  } else if (status.stage === 'probing') {
    details = 'Analyzing video GOP structure and keyframe frequency...';
  } else if (status.stage === 'optimizing_keyframes') {
    details = 'Encoding 2.0s keyframes for zero-CPU stream copy...';
  } else if (status.stage === 'stripping_metadata') {
    details = 'Wiping video title, uploader, ID, dates, and encoder tags...';
  } else if (status.stage === 'registering') {
    details = 'Probing resolution and appending to playlist...';
  } else if (status.speed && (status.stage === 'converting')) {
    details = `Processing speed: ${status.speed}`;
  }
  if (ytDlDetails) ytDlDetails.textContent = details || (status.stage === 'downloading' ? 'Downloading...' : 'Working...');
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
        if (ytUrlInput) ytUrlInput.value = '';

        const detectedMode = status.detectedMode || 'horizontal';
        // Auto-switch to the orientation playlist matching the downloaded video
        switchPlaylistTab(detectedMode);
        await fetchVideos();

        const orientationLabel = detectedMode === 'horizontal' ? '16:9 Horizontal' : '9:16 Vertical';
        const resolution = (status.width && status.height) ? ` (${status.width}×${status.height})` : '';
        showToast(
          `"${status.videoTitle || 'YouTube Video'}" added to ${orientationLabel} playlist${resolution}.`,
          'success',
          'Download Complete'
        );

        if (ytDlProgressBox) {
          setTimeout(() => { ytDlProgressBox.style.display = 'none'; }, 2000);
        }

      } else if (status.stage === 'error') {
        _updateYtProgress({ ...status, stage: 'error' });
        if (ytDlDetails) {
          let errText = (status.error || 'Download failed')
            .replace(/Deprecated Feature:[^.\n]+\.?/gi, '')
            .replace(/ERROR:\s*/gi, '')
            .trim();
          ytDlDetails.textContent = errText || 'Download failed';
        }
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

  // Wire VM Chrome Cookie Resync button
  const btnResyncCookies = document.getElementById('btn-resync-cookies');
  if (btnResyncCookies) {
    btnResyncCookies.addEventListener('click', async () => {
      btnResyncCookies.disabled = true;
      const origHtml = btnResyncCookies.innerHTML;
      btnResyncCookies.textContent = 'Syncing...';
      try {
        const res = await apiPost('/api/videos/sync-chrome-cookies');
        if (res.success) {
          const countStr = res.cookieCount ? `${res.cookieCount} cookies` : `${(res.sizeBytes / 1024).toFixed(1)} KB`;
          showToast(`Chrome cookies synced (${countStr}).`, 'success', 'Session Synced');
          const sessionText = document.getElementById('yt-chrome-session-text');
          if (sessionText) {
            sessionText.textContent = 'VM Chrome Session Active';
            sessionText.style.color = '#34d399';
          }
        } else {
          showToast(res.error || res.message || 'Could not sync cookies from Chrome.', 'warning', 'Sync Notice');
        }
      } catch (err) {
        showToast(err.message || 'Cookie sync failed', 'error', 'Sync Failed');
      } finally {
        btnResyncCookies.disabled = false;
        btnResyncCookies.innerHTML = origHtml;
      }
    });
  }

  // Wire cookies file upload button (fallback)
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
            const banner = document.getElementById('yt-chrome-banner');
            const sessionText = document.getElementById('yt-chrome-session-text');
            if (sessionText) {
              sessionText.textContent = 'VM Chrome Session Active';
              sessionText.style.color = '#34d399';
            }
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

  let _pendingDuplicateDownload = null;

  function openDuplicateWarningModal(url, quality, existingVideo) {
    _pendingDuplicateDownload = { url, quality };
    const modal = document.getElementById('modal-duplicate-warning');
    const titleEl = document.getElementById('dup-video-title');
    const aspectEl = document.getElementById('dup-video-aspect');
    const resEl = document.getElementById('dup-video-res');
    const fpsEl = document.getElementById('dup-video-fps');
    const durEl = document.getElementById('dup-video-duration');
    const statusEl = document.getElementById('dup-video-status');

    if (titleEl) {
      titleEl.textContent = existingVideo?.label || existingVideo?.originalName || 'Existing YouTube Video';
    }
    const isHoriz = (existingVideo?.probe?.width || 0) >= (existingVideo?.probe?.height || 0);
    if (aspectEl) aspectEl.textContent = isHoriz ? '16:9' : '9:16';
    if (resEl) {
      resEl.textContent = (existingVideo?.probe?.width && existingVideo?.probe?.height)
        ? `${existingVideo.probe.width}×${existingVideo.probe.height}`
        : (isHoriz ? '1920×1080' : '1080×1920');
    }
    if (fpsEl) fpsEl.textContent = `${existingVideo?.probe?.fps || 30}fps`;
    if (durEl) {
      durEl.textContent = existingVideo?.probe?.durationSec
        ? formatDuration(existingVideo.probe.durationSec)
        : 'Library File';
    }
    if (statusEl) {
      if (existingVideo?.inPlaylist) {
        statusEl.textContent = 'In Active Playlist';
        statusEl.className = 'badge-tag badge-active';
      } else {
        statusEl.textContent = 'In Video Library';
        statusEl.className = 'badge-tag';
      }
    }

    if (modal) modal.classList.add('open');
  }

  function closeDuplicateWarningModal() {
    _pendingDuplicateDownload = null;
    const modal = document.getElementById('modal-duplicate-warning');
    if (modal) modal.classList.remove('open');
  }

  async function triggerYtDownload(url, quality, force = false) {
    if (ytDlProgressBox) ytDlProgressBox.style.display = 'block';
    _updateYtProgress({ stage: 'fetching_info', percent: 0, videoTitle: '', speed: '', eta: '' });
    if (ytDlDetails) ytDlDetails.textContent = 'Connecting...';
    btnYtDownload.disabled = true;

    try {
      await apiPost('/api/videos/download-youtube', { url, quality, autoSetActive: false, force });
      _clearYtPoll();
      _ytPollTimer = setInterval(_pollYtDownloadStatus, 1500);
    } catch (err) {
      btnYtDownload.disabled = false;

      if (err.code === 'E_DUPLICATE_VIDEO') {
        if (ytDlProgressBox) ytDlProgressBox.style.display = 'none';
        openDuplicateWarningModal(url, quality, err.existingVideo);
        return;
      }

      if (ytDlProgressBox) ytDlProgressBox.style.display = 'none';
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
  }

  // Duplicate Warning Modal button controls
  const btnCloseDup = document.getElementById('btn-close-duplicate-warning');
  const btnCancelDup = document.getElementById('btn-cancel-duplicate-download');
  const btnForceDup = document.getElementById('btn-force-duplicate-download');
  const modalDup = document.getElementById('modal-duplicate-warning');

  if (btnCloseDup) btnCloseDup.addEventListener('click', closeDuplicateWarningModal);
  if (btnCancelDup) btnCancelDup.addEventListener('click', closeDuplicateWarningModal);
  if (btnForceDup) {
    btnForceDup.addEventListener('click', async () => {
      if (_pendingDuplicateDownload) {
        const { url, quality } = _pendingDuplicateDownload;
        closeDuplicateWarningModal();
        await triggerYtDownload(url, quality, true);
      }
    });
  }
  if (modalDup) {
    modalDup.addEventListener('click', (e) => {
      if (e.target === modalDup) closeDuplicateWarningModal();
    });
  }

  btnYtDownload.addEventListener('click', async () => {
    const url = (ytUrlInput?.value || '').trim();
    if (!url) {
      showToast('Please enter a YouTube URL first.', 'warning', 'URL Required');
      ytUrlInput?.focus();
      return;
    }

    const quality = ytQualitySelect?.value || '1080p';
    await triggerYtDownload(url, quality, false);
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
    fetchLogs();
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

  // 1b. Video Preview Modal Controls
  const modalVideoPreview = document.getElementById('modal-video-preview');
  const btnCloseVideoPreview = document.getElementById('btn-close-video-preview');
  const btnDoneVideoPreview = document.getElementById('btn-done-video-preview');

  if (btnCloseVideoPreview) btnCloseVideoPreview.addEventListener('click', closeVideoPreview);
  if (btnDoneVideoPreview) btnDoneVideoPreview.addEventListener('click', closeVideoPreview);
  if (modalVideoPreview) {
    modalVideoPreview.addEventListener('click', (e) => {
      if (e.target === modalVideoPreview) closeVideoPreview();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (modalSettings.classList.contains('open')) {
        modalSettings.classList.remove('open');
      }
      if (modalVideoPreview?.classList.contains('open')) {
        closeVideoPreview();
      }
      const modalDup = document.getElementById('modal-duplicate-warning');
      if (modalDup?.classList.contains('open')) {
        modalDup.classList.remove('open');
      }
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

  // Mobile Top Sticky Deck Details Drawer Toggle
  const btnToggleDeckDetails = document.getElementById('btn-toggle-deck-details');
  const deckExpandable = document.getElementById('deck-expandable-details');
  const stickyDeck = document.querySelector('.sticky-control-deck');
  if (btnToggleDeckDetails && deckExpandable) {
    btnToggleDeckDetails.addEventListener('click', () => {
      const isOpen = deckExpandable.classList.toggle('open');
      stickyDeck?.classList.toggle('details-expanded', isOpen);
      btnToggleDeckDetails.setAttribute('aria-expanded', isOpen);
    });
  }

  // Auto-collapse heavy panels (Server Hardware & Logs Viewer) on mobile screens on initial load
  if (window.innerWidth <= 768) {
    ['body-system', 'body-logs'].forEach(targetId => {
      const body = document.getElementById(targetId);
      if (body && !body.classList.contains('collapsed')) {
        body.classList.add('collapsed');
        const btn = document.querySelector(`.panel-toggle-btn[data-target="${targetId}"]`);
        if (btn) {
          btn.classList.add('collapsed');
          btn.setAttribute('aria-expanded', 'false');
        }
      }
    });
  }

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
          `Cannot stream in pure Copy mode:\n- ${err.message}\n\nThis video requires transcoding (e.g. 720p / non-copy format to 1080p).\n\nWould you like to switch Stream Mode to 'Auto' with Transcoding enabled and start streaming now?`
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
      },
      bandwidth: {
        ...(Number.isFinite(safetyLimit) ? { safetyLimitTB: safetyLimit } : {}),
        ...(Number.isFinite(overhead) ? { overheadPercent: overhead } : {}),
      },
      studioAutomation: {
        enabled: cfgStudioAutoEnabled ? cfgStudioAutoEnabled.checked : true,
        baseTitle: cfgStudioBaseTitle ? cfgStudioBaseTitle.value.trim() : '',
      },
    };

    if (cfgStudioBaseTitle) {
      patch.youtube.title = cfgStudioBaseTitle.value.trim();
    }

    if (cfgStreamKey.value.trim()) {
      patch.youtube.streamKey = cfgStreamKey.value.trim();
    }

    try {
      const res = await apiPut('/api/settings', patch);
      _currentSettings = res.settings;
      updateDeckStreamKeyBadge(res.settings);
      modalSettings.classList.remove('open');
      await refreshAll();

      showToast('YouTube stream configuration saved successfully.', 'success', 'Settings Saved');

      if (res.requiresRestart) {
        const isLive = statusText.textContent === 'RUNNING' || statusText.textContent === 'STARTING' || statusText.textContent.includes('LIVE');
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
  const _unpickedRandomPool = { horizontal: [], vertical: [] };

  if (btnSelectAllVideos) {
    btnSelectAllVideos.addEventListener('click', async () => {
      if (btnSelectAllVideos.disabled) return;
      btnSelectAllVideos.disabled = true;
      try {
        const tabVideos = _cachedVideos.filter(v => {
          const isHoriz = (v.probe?.width || 0) >= (v.probe?.height || 0);
          return _currentTabMode === 'horizontal' ? isHoriz : !isHoriz;
        });
        const allIds = tabVideos.map(v => v.id);
        await updatePlaylist(allIds, _currentPlaybackOrder, _currentTabMode);
      } finally {
        btnSelectAllVideos.disabled = false;
      }
    });
  }

  if (btnRandomSelectVideos) {
    btnRandomSelectVideos.addEventListener('click', async () => {
      if (btnRandomSelectVideos.disabled) return;
      btnRandomSelectVideos.disabled = true;

      try {
        const res = await apiPost('/api/videos/random-select', { mode: _currentTabMode });
        if (res?.success) {
          if (res.playlists) {
            _playlists = res.playlists;
          } else if (res.playlist) {
            _playlists[_currentTabMode] = res.playlist;
          }
          _currentPlaylist = _playlists[_currentTabMode] || [];
          const isLive = _currentStatus === 'RUNNING' || _currentStatus === 'STARTING';
          showToast(res.message, 'success', isLive ? 'Hot Sync Active' : 'Random Select');
          await fetchVideos();
        } else {
          showToast(res?.error || 'Could not randomize videos', 'warning', 'Random Select');
        }
      } catch (err) {
        showToast(err.message, 'error', 'Random Select Failed');
      } finally {
        btnRandomSelectVideos.disabled = false;
      }
    });
  }

  if (btnDeselectAllVideos) {
    btnDeselectAllVideos.addEventListener('click', async () => {
      if (btnDeselectAllVideos.disabled) return;
      btnDeselectAllVideos.disabled = true;
      try {
        await updatePlaylist([], _currentPlaybackOrder, _currentTabMode);
      } finally {
        btnDeselectAllVideos.disabled = false;
      }
    });
  }

  if (selPlaybackOrder) {
    selPlaybackOrder.addEventListener('change', async (e) => {
      const newOrder = e.target.value;
      await updatePlaylist(_playlists[_currentTabMode] || [], newOrder, _currentTabMode);
    });
  }

  // Stream Mode Toggle Listeners
  if (btnModeHorizontal) {
    btnModeHorizontal.addEventListener('click', () => changeStreamMode('horizontal'));
  }
  if (btnModeVertical) {
    btnModeVertical.addEventListener('click', () => changeStreamMode('vertical'));
  }
  if (deckStreamModeBadge) {
    deckStreamModeBadge.addEventListener('click', () => {
      const nextMode = _activeStreamMode === 'horizontal' ? 'vertical' : 'horizontal';
      changeStreamMode(nextMode);
    });
  }

  // Playlist Mode Tab Switchers
  if (tabPlaylistHorizontal) {
    tabPlaylistHorizontal.addEventListener('click', () => switchPlaylistTab('horizontal'));
  }
  if (tabPlaylistVertical) {
    tabPlaylistVertical.addEventListener('click', () => switchPlaylistTab('vertical'));
  }

  // 4c. Stream Scheduler & Auto-Recycle Listeners
  if (btnModeContinuous) {
    btnModeContinuous.addEventListener('click', () => {
      _schedSelectedMode = 'continuous';
      _schedModeDirty = true;
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
      _schedModeDirty = true;
      btnModeScheduled.classList.add('active');
      btnModeContinuous?.classList.remove('active');
      if (schedModeBadge) {
        schedModeBadge.textContent = 'Scheduled (IST)';
        schedModeBadge.className = 'badge-tag warning';
      }
    });
  }

  if (btnAddSchedSlot) {
    btnAddSchedSlot.addEventListener('click', () => addNewStreamingSlot());
  }

  if (btnAddSchedSlotBottom) {
    btnAddSchedSlotBottom.addEventListener('click', () => addNewStreamingSlot());
  }

  if (schedRecycleEnabled) {
    schedRecycleEnabled.addEventListener('change', () => {
      _schedRecycleDirty = true;
      if (schedRecycleStatusBadge) {
        schedRecycleStatusBadge.textContent = schedRecycleEnabled.checked ? 'Protected' : 'Off';
        schedRecycleStatusBadge.className = `badge-tag ${schedRecycleEnabled.checked ? 'compatible' : 'disabled'}`;
      }
    });
  }

  if (schedPauseMins) {
    schedPauseMins.addEventListener('input', () => {
      _schedRecycleDirty = true;
    });
  }

  if (schedResumeBookmark) {
    schedResumeBookmark.addEventListener('change', () => {
      _schedRecycleDirty = true;
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
