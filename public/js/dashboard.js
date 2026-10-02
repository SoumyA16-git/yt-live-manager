/**
 * public/js/dashboard.js — Main frontend controller.
 *
 * PRD §15.2: Polling every 3s (status) and 10s (bandwidth, system).
 * Pauses polling when browser tab is hidden (visibilitychange).
 * Live bandwidth preview in settings (calc.js).
 */

import { initSession, apiGet, apiPost, apiPut, apiDelete } from './api.js';
import { calculateBitrateMetrics, formatBytes } from './calc.js';

// ─── State ────────────────────────────────────────────────────────────────────

let _pollStatusTimer = null;
let _pollSlowTimer   = null;
let _currentSettings = null;

// ─── DOM References ───────────────────────────────────────────────────────────

const disconnectBanner = document.getElementById('disconnect-banner');
const userDisplay      = document.getElementById('user-display');
const btnLogout        = document.getElementById('btn-logout');

// Health Verdict
const verdictBadge     = document.getElementById('verdict-badge');
const verdictReasons   = document.getElementById('verdict-reasons');
const quickStatus      = document.getElementById('quick-status');
const quickUptime      = document.getElementById('quick-uptime');
const quickUsage       = document.getElementById('quick-usage');

// Stream Status
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const metricMode       = document.getElementById('metric-mode');
const metricPid        = document.getElementById('metric-pid');
const metricFps        = document.getElementById('metric-fps');
const metricSpeed      = document.getElementById('metric-speed');
const metricBitrate    = document.getElementById('metric-bitrate');
const metricRestarts   = document.getElementById('metric-restarts');
const lastErrorBox     = document.getElementById('last-error-box');
const reachabilityBadge = document.getElementById('reachability-badge');

// Controls
const btnStart         = document.getElementById('btn-start');
const btnStop          = document.getElementById('btn-stop');
const btnRestart       = document.getElementById('btn-restart');
const chkDisabled      = document.getElementById('chk-disabled');

// Bandwidth
const bwAlertBanner    = document.getElementById('bw-alert-banner');
const bwSafetyText     = document.getElementById('bw-safety-text');
const bwSafetyFill     = document.getElementById('bw-safety-fill');
const bwAllowanceText  = document.getElementById('bw-allowance-text');
const bwAllowanceFill  = document.getElementById('bw-allowance-fill');
const bwForecast       = document.getElementById('bw-forecast-sentence');
const periodBadge      = document.getElementById('period-badge');

// Video Library
const activeVideoName  = document.getElementById('active-video-name');
const uploadZone       = document.getElementById('upload-zone');
const fileInput        = document.getElementById('file-input');
const uploadBox        = document.getElementById('upload-progress-box');
const uploadPct        = document.getElementById('upload-pct');
const uploadFill       = document.getElementById('upload-fill');
const videosList       = document.getElementById('videos-list');

// System
const metricCpu        = document.getElementById('metric-cpu');
const metricRam        = document.getElementById('metric-ram');
const metricDisk       = document.getElementById('metric-disk');
const metricUptime     = document.getElementById('metric-uptime');
const dirVideos        = document.getElementById('dir-videos');
const dirLogs          = document.getElementById('dir-logs');
const dirBackups       = document.getElementById('dir-backups');

// Logs
const logViewer        = document.getElementById('log-viewer');
const btnRefreshLogs   = document.getElementById('btn-refresh-logs');

// Settings Modal
const modalSettings    = document.getElementById('modal-settings');
const btnOpenSettings  = document.getElementById('btn-open-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const settingsForm     = document.getElementById('settings-form');
const cfgRtmpsUrl      = document.getElementById('cfg-rtmps-url');
const cfgStreamKey     = document.getElementById('cfg-stream-key');
const btnRevealKey     = document.getElementById('btn-reveal-key');
const keyHintText      = document.getElementById('key-hint-text');
const cfgModePref      = document.getElementById('cfg-mode-pref');
const cfgBitrate       = document.getElementById('cfg-bitrate');
const cfgSafetyLimit   = document.getElementById('cfg-safety-limit');
const cfgOverhead      = document.getElementById('cfg-overhead');
const previewGbDay     = document.getElementById('preview-gb-day');
const previewTbMonth   = document.getElementById('preview-tb-month');

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
  // Update status badge & dot
  statusText.textContent = data.status;
  quickStatus.textContent = data.status;

  statusDot.className = 'status-dot';
  if (data.status === 'RUNNING')       statusDot.classList.add('live');
  else if (data.status === 'STARTING') statusDot.classList.add('starting');
  else if (data.status === 'ERROR' || data.status === 'BANDWIDTH_LIMIT_REACHED') statusDot.classList.add('error');

  // Control buttons state
  btnStart.disabled   = data.status === 'RUNNING' || data.status === 'STARTING' || data.disabled;
  btnStop.disabled    = data.status === 'STOPPED' || data.status === 'SCHEDULED';
  btnRestart.disabled = data.status === 'STOPPED';
  chkDisabled.checked = Boolean(data.disabled);

  // Metrics
  metricMode.textContent     = data.streamMode || 'auto';
  metricPid.textContent      = data.ffmpegPid || '—';
  metricRestarts.textContent = `${data.restartCountSession || 0} session / ${data.restartCountTotal || 0} total`;

  const p = data.progress;
  if (p) {
    metricFps.textContent     = p.fps || 0;
    metricSpeed.textContent   = p.speedStr || `${p.speed || 0}x`;
    metricBitrate.textContent = p.bitrate || '0 kb/s';
  } else {
    metricFps.textContent     = 0;
    metricSpeed.textContent   = '0.00x';
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
  periodBadge.textContent = `Period: ${data.periodId || ''}`;

  const usedBytes = data.usedBytes || 0;
  quickUsage.textContent = formatBytes(usedBytes, data.unitBase);

  // Safety Limit Progress
  const pctSafety = Math.min(100, Math.max(0, data.pctOfSafety || 0));
  bwSafetyText.textContent = `${formatBytes(usedBytes, data.unitBase)} / ${formatBytes(data.limitBytes, data.unitBase)} (${pctSafety.toFixed(1)}%)`;
  bwSafetyFill.style.width = `${pctSafety}%`;
  bwSafetyFill.className = `progress-bar-fill ${pctSafety >= 90 ? 'danger' : pctSafety >= 70 ? 'warning' : ''}`;

  // Full Allowance Progress
  const pctAllowance = Math.min(100, Math.max(0, data.pctOfAllowance || 0));
  bwAllowanceText.textContent = `${formatBytes(usedBytes, data.unitBase)} / ${formatBytes(data.allowanceBytes, data.unitBase)} (${pctAllowance.toFixed(1)}%)`;
  bwAllowanceFill.style.width = `${pctAllowance}%`;

  // Alert Banner
  if (data.alertLevel && data.alertLevel !== 'normal') {
    bwAlertBanner.style.display = 'block';
    bwAlertBanner.className = `bw-alert-banner ${data.alertLevel.includes('critical') || data.alertLevel === 'limit' ? 'critical' : 'warning'}`;
    bwAlertBanner.textContent = data.alertLevel === 'limit'
      ? '🚨 Safety limit reached! Streaming stopped.'
      : `⚠️ Bandwidth alert level: ${data.alertLevel} (${pctSafety.toFixed(1)}% of safety limit)`;
  } else {
    bwAlertBanner.style.display = 'none';
  }

  // Forecast Sentence
  if (data.forecast) {
    bwForecast.textContent = data.forecast.summarySentence || 'Projections calculating...';
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
  metricCpu.textContent  = `${data.cpuPercent || 0}%`;
  metricRam.textContent  = `${data.ram?.usedPercent || 0}%`;
  metricDisk.textContent = `${data.disk?.usedPercent || 0}%`;

  const up = data.uptimeSec || 0;
  const days = Math.floor(up / 86400);
  const hours = Math.floor((up % 86400) / 3600);
  metricUptime.textContent = `${days}d ${hours}h`;
  quickUptime.textContent  = `${days}d ${hours}h`;

  if (data.dirSizes) {
    dirVideos.textContent  = formatBytes(data.dirSizes.videosBytes);
    dirLogs.textContent    = formatBytes(data.dirSizes.logsBytes);
    dirBackups.textContent = formatBytes(data.dirSizes.backupsBytes);
  }

  if (data.reachability) {
    reachabilityBadge.style.color = data.reachability.reachable ? 'var(--status-live)' : 'var(--status-error)';
    reachabilityBadge.textContent = data.reachability.reachable
      ? `● YouTube Reachable (${data.reachability.latencyMs}ms)`
      : '● YouTube Unreachable';
  }
}

async function fetchVideos() {
  try {
    const data = await apiGet('/api/videos');
    renderVideos(data.videos || []);
  } catch (err) {
    console.error('Fetch videos failed:', err);
  }
}

function renderVideos(videos) {
  videosList.innerHTML = '';
  const currentVideoId = _currentSettings?.stream?.videoId;

  if (videos.length === 0) {
    videosList.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 1rem;">No videos uploaded yet</div>';
    activeVideoName.textContent = 'None selected';
    return;
  }

  videos.forEach(v => {
    const isActive = v.id === currentVideoId;
    if (isActive) {
      activeVideoName.textContent = `${v.label || v.originalName} (${v.probe?.aspectRatio || '1080:1920'})`;
    }

    const item = document.createElement('div');
    item.className = `video-item ${isActive ? 'active' : ''}`;

    const compat = v.compatibility?.status === 'COMPATIBLE' ? 'compatible' : 'transcode';
    const compatLabel = v.compatibility?.status === 'COMPATIBLE' ? 'Compatible' : 'Needs Transcode';

    item.innerHTML = `
      <div>
        <div style="font-weight: 600; font-size: 0.85rem; color: var(--text-primary);">${v.label || v.originalName}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.15rem;">
          ${v.probe?.aspectRatio || '1080:1920'} · ${v.probe?.fps || 30}fps · ${formatBytes(v.sizeBytes)}
          <span class="video-badge ${compat}" style="margin-left: 0.4rem;">${compatLabel}</span>
        </div>
      </div>
      <div style="display: flex; gap: 0.4rem;">
        ${!isActive ? `<button class="btn btn-outline btn-select" data-id="${v.id}" style="font-size: 0.7rem; padding: 0.2rem 0.5rem;">Select</button>` : '<span style="font-size: 0.75rem; color: var(--status-live); font-weight: 700;">ACTIVE</span>'}
        <button class="btn btn-outline btn-delete" data-id="${v.id}" style="font-size: 0.7rem; padding: 0.2rem 0.4rem; color: #f87171;">✕</button>
      </div>
    `;

    videosList.appendChild(item);
  });

  // Attach button events
  videosList.querySelectorAll('.btn-select').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-id');
      try {
        await apiPost(`/api/videos/${id}/select`);
        await refreshAll();
      } catch (err) {
        if (err.code === 'E_STREAM_LIVE') {
          if (confirm('Stream is live. Restart onto this video now?')) {
            await apiPost(`/api/videos/${id}/select?restart=true`);
            await refreshAll();
          }
        } else {
          alert(err.message);
        }
      }
    });
  });

  videosList.querySelectorAll('.btn-delete').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-id');
      if (confirm('Delete this video from library?')) {
        try {
          await apiDelete(`/api/videos/${id}`);
          await fetchVideos();
        } catch (err) {
          alert(err.message);
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

async function openSettings() {
  try {
    const settings = await apiGet('/api/settings');
    _currentSettings = settings;

    cfgRtmpsUrl.value = settings.youtube?.rtmpsUrl || 'rtmps://a.rtmps.youtube.com:443/live2';
    cfgStreamKey.value = '';
    keyHintText.textContent = settings.youtube?.streamKeySet
      ? `Key configured (ends in ...${settings.youtube.streamKeyHint})`
      : 'No stream key configured';

    cfgModePref.value = settings.stream?.modePreference || 'auto';
    cfgBitrate.value  = settings.stream?.videoBitrateMbps || 8;
    cfgSafetyLimit.value = settings.bandwidth?.safetyLimitTB || 9;
    cfgOverhead.value = settings.bandwidth?.overheadPercent || 10;

    updateLiveBitratePreview();
    modalSettings.classList.add('open');
  } catch (err) {
    alert(`Could not load settings: ${err.message}`);
  }
}

function updateLiveBitratePreview() {
  const videoMbps = parseFloat(cfgBitrate.value) || 8;
  const overhead  = parseFloat(cfgOverhead.value) || 10;

  const m = calculateBitrateMetrics({
    videoBitrateMbps: videoMbps,
    audioBitrateKbps: 128,
    overheadPercent: overhead,
  });

  previewGbDay.textContent = `${m.withOverhead.gbPerDay.toFixed(2)} GB/day`;
  previewTbMonth.textContent = `${m.withOverhead.tbPer30Days.toFixed(3)} TB/30d`;
}

// ─── Upload Handling ──────────────────────────────────────────────────────────

function setupUploads() {
  uploadZone.addEventListener('click', () => fileInput.click());

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.style.borderColor = 'var(--accent-blue)';
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
  const formData = new FormData();
  formData.append('file', file);

  uploadBox.style.display = 'block';
  uploadPct.textContent = 'Uploading...';
  uploadFill.style.width = '30%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/videos/upload');

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      uploadPct.textContent = `${pct}%`;
      uploadFill.style.width = `${pct}%`;
    }
  };

  xhr.onload = async () => {
    uploadBox.style.display = 'none';
    fileInput.value = '';
    if (xhr.status === 201) {
      await fetchVideos();
    } else {
      try {
        const err = JSON.parse(xhr.responseText);
        alert(`Upload error: ${err.error || 'Upload failed'}`);
      } catch {
        alert('Upload failed');
      }
    }
  };

  xhr.onerror = () => {
    uploadBox.style.display = 'none';
    alert('Upload network error');
  };

  xhr.send(formData);
}

// ─── Refresh Orchestrator ─────────────────────────────────────────────────────

async function refreshAll() {
  await Promise.all([
    fetchStatus(),
    fetchBandwidth(),
    fetchSystem(),
    fetchVideos(),
    fetchLogs(),
  ]);
}

function startPolling() {
  stopPolling();
  // PRD §15.2: status every 3s, bandwidth & system every 10s
  _pollStatusTimer = setInterval(fetchStatus, 3000);
  _pollSlowTimer   = setInterval(() => {
    fetchBandwidth();
    fetchSystem();
  }, 10000);
}

function stopPolling() {
  if (_pollStatusTimer) { clearInterval(_pollStatusTimer); _pollStatusTimer = null; }
  if (_pollSlowTimer)   { clearInterval(_pollSlowTimer);   _pollSlowTimer = null; }
}

// ─── Main Bootstrap ───────────────────────────────────────────────────────────

async function init() {
  const user = await initSession();
  if (!user) return;

  userDisplay.textContent = user.username || 'Admin';

  // PRD §15.2: Pause polling when the browser tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopPolling();
    } else {
      refreshAll();
      startPolling();
    }
  });

  // Attach button handlers
  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    try {
      await apiPost('/api/stream/start');
      await fetchStatus();
    } catch (err) {
      alert(`Start failed: ${err.message}`);
    }
  });

  btnStop.addEventListener('click', async () => {
    if (confirm('Are you sure you want to stop the live stream?')) {
      btnStop.disabled = true;
      try {
        await apiPost('/api/stream/stop');
        await fetchStatus();
      } catch (err) {
        alert(`Stop failed: ${err.message}`);
      }
    }
  });

  btnRestart.addEventListener('click', async () => {
    if (confirm('Restart FFmpeg streaming onto YouTube?')) {
      btnRestart.disabled = true;
      try {
        await apiPost('/api/stream/restart');
        await fetchStatus();
      } catch (err) {
        alert(`Restart failed: ${err.message}`);
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

  // Settings
  btnOpenSettings.addEventListener('click', openSettings);
  btnCloseSettings.addEventListener('click', () => modalSettings.classList.remove('open'));
  btnCancelSettings.addEventListener('click', () => modalSettings.classList.remove('open'));

  cfgBitrate.addEventListener('input', updateLiveBitratePreview);
  cfgOverhead.addEventListener('input', updateLiveBitratePreview);

  btnRevealKey.addEventListener('click', async () => {
    const password = prompt('Re-enter admin password to reveal stream key:');
    if (!password) return;

    try {
      const res = await apiPost('/api/settings/reveal-stream-key', { password });
      cfgStreamKey.type = 'text';
      cfgStreamKey.value = res.streamKey;
      btnRevealKey.textContent = 'Hide';
      setTimeout(() => {
        cfgStreamKey.type = 'password';
        cfgStreamKey.value = '';
        btnRevealKey.textContent = 'Show';
      }, 30000);
    } catch (err) {
      alert(`Key reveal failed: ${err.message}`);
    }
  });

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {
      stream: {
        modePreference: cfgModePref.value,
        videoBitrateMbps: parseFloat(cfgBitrate.value),
      },
      youtube: {
        rtmpsUrl: cfgRtmpsUrl.value.trim(),
      },
      bandwidth: {
        safetyLimitTB: parseFloat(cfgSafetyLimit.value),
        overheadPercent: parseFloat(cfgOverhead.value),
      },
    };

    if (cfgStreamKey.value.trim()) {
      patch.youtube.streamKey = cfgStreamKey.value.trim();
    }

    try {
      await apiPut('/api/settings', patch);
      modalSettings.classList.remove('open');
      await refreshAll();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  });

  setupUploads();
  await refreshAll();
  startPolling();
}

init();
