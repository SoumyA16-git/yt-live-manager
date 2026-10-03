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

let _pollStatusTimer      = null;
let _pollSlowTimer        = null;
let _currentSettings      = null;
let _currentStatus        = 'STOPPED';
let _currentActiveVideoId = null;
let _currentPlaylist      = [];
let _currentPlaybackOrder = 'sequential';
let _cachedVideos         = [];

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
const uploadStatusText = document.getElementById('upload-status-text');
const uploadPct        = document.getElementById('upload-pct');
const uploadFill       = document.getElementById('upload-fill');
const uploadBytesText  = document.getElementById('upload-bytes-text');
const uploadSpeedText  = document.getElementById('upload-speed-text');
const videosList            = document.getElementById('videos-list');
const videoCountBadge       = document.getElementById('video-count-badge');
const playlistToolbar       = document.getElementById('playlist-toolbar');
const btnSelectAllVideos    = document.getElementById('btn-select-all-videos');
const btnDeselectAllVideos  = document.getElementById('btn-deselect-all-videos');
const playlistSelectedCount = document.getElementById('playlist-selected-count');
const selPlaybackOrder      = document.getElementById('sel-playback-order');

// YouTube Import UI
const ytImportPanel    = document.getElementById('yt-import-panel');
const ytUrlInput       = document.getElementById('yt-url-input');
const btnYtDownload    = document.getElementById('btn-yt-download');
const ytDlProgressBox  = document.getElementById('yt-dl-progress-box');
const ytDlStageText    = document.getElementById('yt-dl-stage-text');
const ytDlPct          = document.getElementById('yt-dl-pct');
const ytDlFill         = document.getElementById('yt-dl-fill');
const ytDlTitle        = document.getElementById('yt-dl-title');
const ytDlDetails      = document.getElementById('yt-dl-details');
const btnCancelYtDl    = document.getElementById('btn-cancel-yt-dl');

// System
const metricCpu        = document.getElementById('metric-cpu');
const metricRam        = document.getElementById('metric-ram');
const metricRamSub     = document.getElementById('metric-ram-sub');
const metricDisk       = document.getElementById('metric-disk');
const metricDiskSub    = document.getElementById('metric-disk-sub');
const metricDiskPct    = document.getElementById('metric-disk-pct');
const metricDiskBar    = document.getElementById('metric-disk-bar');
const cardDiskStorage  = document.getElementById('card-disk-storage');
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
const cfgAllowTranscode = document.getElementById('cfg-allow-transcode');
const cfgBitrate       = document.getElementById('cfg-bitrate');
const cfgSafetyLimit   = document.getElementById('cfg-safety-limit');
const cfgOverhead      = document.getElementById('cfg-overhead');
const previewGbDay     = document.getElementById('preview-gb-day');
const previewTbMonth   = document.getElementById('preview-tb-month');

// Stream Key UI & Maintenance DOM Elements
const deckStreamKeyBadge     = document.getElementById('deck-stream-key-badge');
const bannerMaintenance      = document.getElementById('banner-maintenance');
const btnDisableMaintenance  = document.getElementById('btn-disable-maintenance');
const keyBadge               = document.getElementById('key-badge');
const iconEyeShow            = document.getElementById('icon-eye-show');
const iconEyeHide            = document.getElementById('icon-eye-hide');
const btnRevealText          = document.getElementById('btn-reveal-text');

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
  if (chkDisabled) chkDisabled.checked = Boolean(data.disabled);

  // Maintenance Banner visibility
  if (bannerMaintenance) {
    bannerMaintenance.style.display = (data.maintenance?.active || data.status === 'MAINTENANCE') ? 'flex' : 'none';
  }

  if (data.activeVideoId) {
    _currentActiveVideoId = data.activeVideoId;
  }

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
      ? 'Safety limit reached. Streaming stopped.'
      : `Bandwidth alert level: ${data.alertLevel} (${pctSafety.toFixed(1)}% of safety limit)`;
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

  const appMb = data.appRam?.rssMB || 0;
  const sysPct = data.ram?.usedPercent || 0;
  metricRam.textContent = `${appMb} MB`;
  if (metricRamSub) {
    metricRamSub.textContent = `Node: ${appMb} MB · System: ${sysPct}%`;
  }

  if (data.disk) {
    const totalBytes = Number(data.disk.totalBytes) || 0;
    const usedBytes  = Number(data.disk.usedBytes) || 0;
    const freeBytes  = Number(data.disk.freeBytes) || 0;
    const pct        = Number(data.disk.usedPercent) || 0;

    const totalStr = formatBytes(totalBytes);
    const usedStr  = formatBytes(usedBytes);
    const freeStr  = formatBytes(freeBytes);

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
    alert(`Could not update playlist: ${err.message}`);
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
            alert(`Found and indexed ${res.count} video file(s)!`);
          } else {
            alert('Scan complete. No video files found in videos/ directory.');
          }
        } catch (err) {
          alert(`Scan failed: ${err.message}`);
        } finally {
          btnSync.disabled = false;
        }
      });
    }
    activeVideoName.textContent = 'None selected';
    return;
  }

  // Update active video header summary
  if (playlist.length === 0) {
    activeVideoName.textContent = 'Active: None';
  } else if (playlist.length === 1) {
    const single = videos.find(v => v.id === playlist[0]);
    activeVideoName.textContent = `Looping 1: ${single ? (single.label || single.originalName) : playlist[0]}`;
  } else {
    activeVideoName.textContent = `Looping ${playlist.length} Videos (${playbackOrder === 'shuffle' ? 'Shuffle' : 'Sequential'})`;
  }

  videos.forEach(v => {
    const isSelected = playlist.includes(v.id);
    const orderIndex = playlist.indexOf(v.id);
    const isSoloActive = isSelected && playlist.length === 1;

    const item = document.createElement('div');
    item.className = `video-item ${isSelected ? 'in-playlist' : ''} ${isSoloActive ? 'active' : ''}`;

    const compat = v.compatibility?.status === 'COMPATIBLE' ? 'compatible' : 'transcode';
    const compatLabel = v.compatibility?.status === 'COMPATIBLE' ? 'Stream-Copy Ready' : 'Needs Transcode';

    item.innerHTML = `
      <div class="video-item-left">
        <label class="video-chk-label" title="${isSelected ? 'Deselect from loop playlist' : 'Select for loop playlist'}">
          <input type="checkbox" class="video-select-chk" data-id="${v.id}" ${isSelected ? 'checked' : ''}>
        </label>
        ${isSelected
          ? `<span class="playlist-seq-badge" title="Position #${orderIndex + 1}">#${orderIndex + 1}</span>`
          : ''
        }
        <div class="video-info">
          <div class="video-name">${v.label || v.originalName}</div>
          <div class="video-meta">
            <span class="meta-tag">${v.probe?.aspectRatio || '1080:1920'}</span>
            <span class="meta-tag">${v.probe?.fps || 30}fps</span>
            <span class="meta-tag">${formatBytes(v.sizeBytes)}</span>
            <span class="badge-tag ${compat}" title="${(v.compatibility?.explanations || []).join(' \n ') || compatLabel}">${compatLabel}</span>
          </div>
        </div>
      </div>
      <div class="video-actions">
        ${isSelected
          ? `<span class="badge-tag" style="background: rgba(99, 102, 241, 0.15); color: #818cf8; font-weight: 600;">
               ${isSoloActive ? 'ACTIVE LOOP' : `IN LOOP (#${orderIndex + 1})`}
             </span>`
          : `<button class="btn btn-secondary btn-sm btn-play-solo" data-id="${v.id}" title="Stream only this video in loop">
               <svg class="icon icon-sm" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
               Play Solo
             </button>`
        }
        <button class="btn btn-outline btn-sm btn-delete" data-id="${v.id}" title="Delete video" style="color: #f43f5e; padding: 0.35rem 0.5rem;">
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

function updateDeckStreamKeyBadge(settings) {
  if (!deckStreamKeyBadge) return;
  if (settings?.youtube?.streamKeySet) {
    deckStreamKeyBadge.textContent = `YouTube: Configured (ends in ...${settings.youtube.streamKeyHint})`;
    deckStreamKeyBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
    deckStreamKeyBadge.style.color = '#4ade80';
    deckStreamKeyBadge.title = `YouTube Stream Key is configured (...${settings.youtube.streamKeyHint}). Click to change.`;
  } else {
    deckStreamKeyBadge.textContent = '⚠️ YouTube: Key Missing';
    deckStreamKeyBadge.style.borderColor = 'rgba(239, 68, 68, 0.5)';
    deckStreamKeyBadge.style.color = '#f87171';
    deckStreamKeyBadge.title = 'YouTube Stream Key is not configured! Click to open Settings.';
  }
}

function updateKeyFeedback() {
  if (!keyBadge || !keyHintText || !cfgStreamKey) return;
  const val = cfgStreamKey.value.trim();
  if (val.length > 0) {
    keyBadge.textContent = 'Unsaved Entry';
    keyBadge.style.background = 'rgba(96, 165, 250, 0.2)';
    keyBadge.style.color = '#60a5fa';
    keyHintText.innerHTML = `✏️ <strong style="color: #60a5fa;">New stream key entered (${val.length} chars)</strong> — Click <strong>Save Configuration</strong> below to apply.`;
  } else if (_currentSettings?.youtube?.streamKeySet) {
    keyBadge.textContent = `Saved (...${_currentSettings.youtube.streamKeyHint})`;
    keyBadge.style.background = 'rgba(34, 197, 94, 0.2)';
    keyBadge.style.color = '#4ade80';
    cfgStreamKey.placeholder = `•••••••••••• (Saved. Leave blank to keep key ending in ...${_currentSettings.youtube.streamKeyHint})`;
    keyHintText.innerHTML = `✅ <strong style="color: #4ade80;">Active YouTube Stream Key is saved</strong> (ends in ...${_currentSettings.youtube.streamKeyHint}). Leave empty to keep unchanged, or paste a new key to update.`;
  } else {
    keyBadge.textContent = 'Not Configured';
    keyBadge.style.background = 'rgba(239, 68, 68, 0.2)';
    keyBadge.style.color = '#f87171';
    cfgStreamKey.placeholder = 'Paste YouTube Stream Key (e.g. xxxx-xxxx-xxxx-xxxx-xxxx)';
    keyHintText.innerHTML = '⚠️ <strong style="color: #f87171;">No stream key saved.</strong> You must paste your YouTube Stream Key before you can start streaming.';
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

    cfgModePref.value = settings.stream?.modePreference || 'auto';
    if (cfgAllowTranscode) {
      cfgAllowTranscode.checked = settings.stream?.allowTranscode !== false;
    }
    cfgBitrate.value  = settings.stream?.videoBitrateMbps || 4;
    cfgSafetyLimit.value = settings.bandwidth?.safetyLimitTB || 9;
    cfgOverhead.value = settings.bandwidth?.overheadPercent || 10;

    updateLiveBitratePreview();
    modalSettings.classList.add('open');
  } catch (err) {
    alert(`Could not load settings: ${err.message}`);
  }
}

function updateLiveBitratePreview() {
  const videoMbps = parseFloat(cfgBitrate.value) || 4;
  const overhead  = parseFloat(cfgOverhead.value) || 10;

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
  const ytPanel    = document.getElementById('yt-import-panel');
  const tabUpload  = document.getElementById('tab-upload');
  const tabYt      = document.getElementById('tab-youtube');

  if (tab === 'youtube') {
    uploadZone.style.display = 'none';
    ytPanel.style.display    = 'block';
    tabUpload.style.background = 'transparent';
    tabUpload.style.color      = 'var(--text-muted)';
    tabYt.style.background     = 'var(--accent-rose)';
    tabYt.style.color          = '#fff';
    // Check cookies status and show warning if missing
    apiGet('/api/videos/cookies-status').then((s) => {
      const banner = document.getElementById('yt-cookies-banner');
      if (banner) banner.style.display = s?.exists ? 'none' : 'block';
    }).catch(() => {});
  } else {
    uploadZone.style.display = '';
    ytPanel.style.display    = 'none';
    tabUpload.style.background = 'var(--accent-primary)';
    tabUpload.style.color      = 'var(--bg-canvas)';
    tabYt.style.background     = 'transparent';
    tabYt.style.color          = 'var(--text-muted)';
  }
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
  if (!file) return;

  // 1. Client-side sanity checks
  if (file.size === 0) {
    alert('The selected file is empty (0 bytes). Please choose a valid video.');
    return;
  }

  const allowedExts = ['.mp4', '.mov', '.m4v', '.mkv'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowedExts.includes(ext)) {
    alert(`File "${file.name}" has an unsupported format. Supported formats: ${allowedExts.join(', ')}`);
    return;
  }

  const maxBytes = 8 * 1024 * 1024 * 1024; // 8 GiB
  if (file.size > maxBytes) {
    alert(`File is too large (${formatBytes(file.size)}). Maximum supported file size is 8 GiB.`);
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  // Initialize UI state
  uploadBox.style.display = 'block';
  uploadFill.style.width = '0%';
  uploadPct.textContent = '0%';
  if (uploadStatusText) uploadStatusText.textContent = `Uploading ${file.name}...`;
  if (uploadBytesText)  uploadBytesText.textContent  = `0 MB / ${formatBytes(file.size)}`;
  if (uploadSpeedText)  uploadSpeedText.textContent  = 'Calculating speed...';

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
        if (uploadSpeedText)  uploadSpeedText.textContent  = 'Probing codecs & preparing live stream rotation...';
      }
    }
  };

  xhr.onload = async () => {
    fileInput.value = '';
    if (xhr.status === 201) {
      if (uploadStatusText) uploadStatusText.textContent = 'Upload complete! Video activated.';
      if (uploadSpeedText)  uploadSpeedText.textContent  = 'Live stream updated seamlessly.';
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
      alert(`Upload failed (HTTP ${xhr.status}):\n${errorMsg}`);
    }
  };

  xhr.onerror = () => {
    uploadBox.style.display = 'none';
    fileInput.value = '';
    alert('Upload network error: The connection to the server was interrupted. Please try again.');
  };

  xhr.ontimeout = () => {
    uploadBox.style.display = 'none';
    fileInput.value = '';
    alert('Upload timed out: The upload took longer than 60 minutes.');
  };

  xhr.onabort = () => {
    uploadBox.style.display = 'none';
    fileInput.value = '';
    alert('Upload was cancelled.');
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
  downloading:   '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/><path d="M5 20h14"/>',
  converting:    '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>',
  completed:     '<polyline points="20 6 9 17 4 12"/>',
  error:         '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  cancelled:     '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

const _ytStageColors = {
  fetching_info: 'var(--accent-cyan)',
  downloading:   'var(--accent-primary)',
  converting:    'var(--accent-amber)',
  completed:     'var(--accent-emerald)',
  error:         'var(--accent-rose)',
  cancelled:     'var(--text-muted)',
};

const _ytStageLabels = {
  fetching_info: 'Fetching video info...',
  downloading:   'Downloading from YouTube...',
  converting:    'Converting to 1080x1920 30fps...',
  completed:     'Download & conversion complete',
  error:         'Failed',
  cancelled:     'Cancelled',
};

function _updateYtProgress(status) {
  if (!status) return;

  const stage = status.stage || 'fetching_info';
  const label = _ytStageLabels[stage] || stage;
  const color = _ytStageColors[stage] || 'var(--accent-cyan)';
  const iconPath = _ytStageIcons[stage] || _ytStageIcons.fetching_info;

  const stageIcon = document.getElementById('yt-stage-icon');
  const stageLabel = document.getElementById('yt-stage-label');
  if (stageIcon)  stageIcon.innerHTML = iconPath;
  if (stageLabel) stageLabel.textContent = label;
  if (ytDlStageText) ytDlStageText.style.color = color;
  if (ytDlTitle)     ytDlTitle.textContent = status.videoTitle || '';

  const pct = Math.round(status.percent || 0);
  if (ytDlPct)  ytDlPct.textContent  = `${pct}%`;
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
                .catch((err) => alert(`Could not set active video: ${err.message}`));
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
        if (btnYtDownload)   btnYtDownload.disabled = false;
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
  const tabYtBtn     = document.getElementById('tab-youtube');
  if (tabUploadBtn) tabUploadBtn.addEventListener('click', () => switchIngestTab('upload'));
  if (tabYtBtn)     tabYtBtn.addEventListener('click',     () => switchIngestTab('youtube'));

  // Wire cookies file upload button
  const cookiesFileInput   = document.getElementById('cookies-file-input');
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
      alert('Please enter a YouTube URL first.');
      ytUrlInput?.focus();
      return;
    }

    // Reset progress UI
    if (ytDlProgressBox) ytDlProgressBox.style.display = 'block';
    _updateYtProgress({ stage: 'fetching_info', percent: 0, videoTitle: '', speed: '', eta: '' });
    if (ytDlDetails)  ytDlDetails.textContent = 'Connecting...';
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
        alert('yt-dlp is not installed on the server.\n\nRun: bash update.sh\non your VPS to install it.');
      } else if (err.code === 'E_JOB_RUNNING') {
        alert('A download is already in progress. Wait for it to finish or cancel it first.');
        if (ytDlProgressBox) ytDlProgressBox.style.display = 'block';
        _clearYtPoll();
        _ytPollTimer = setInterval(_pollYtDownloadStatus, 1500);
      } else {
        alert(`Download failed:\n${msg}`);
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
      if (btnYtDownload)   btnYtDownload.disabled = false;
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
  }).catch(() => {});
}

// ─── Refresh Orchestrator ─────────────────────────────────────────────────────

async function refreshAll() {
  await Promise.all([
    fetchStatus(),
    fetchSettings(),
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
  // 1. Settings Modal Controls
  btnOpenSettings.addEventListener('click', openSettings);
  btnCloseSettings.addEventListener('click', () => modalSettings.classList.remove('open'));
  btnCancelSettings.addEventListener('click', () => modalSettings.classList.remove('open'));

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
          '⚠️ Maintenance Mode is currently active.\n\nWould you like to disable maintenance mode and start live streaming now?'
        );
        if (!disableMaint) return;
        await apiPost('/api/maintenance', { enabled: false });
      }

      await apiPost('/api/stream/start');
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
            await refreshAll();
            return;
          } catch (retryErr) {
            alert(`Start failed after mode update: ${retryErr.message}`);
          }
        }
      } else if (err.code === 'E_KEY_MISSING') {
        alert('⚠️ YouTube stream key is not configured.\n\nOpening Settings so you can enter your YouTube Stream Key.');
        await openSettings();
        if (cfgStreamKey) cfgStreamKey.focus();
      } else if (err.code === 'E_CONFIG_INVALID') {
        alert(`⚠️ RTMPS configuration is invalid.\n\n${err.message || ''}\n\nOpening Settings so you can verify your YouTube RTMPS URL.`);
        await openSettings();
      } else if (err.code === 'E_MAINTENANCE') {
        const disableNow = confirm(
          '⚠️ Maintenance Mode is Active.\n\nStreaming is blocked because server maintenance mode is engaged.\n\nWould you like to disable maintenance mode and start streaming now?'
        );
        if (disableNow) {
          await apiPost('/api/maintenance', { enabled: false });
          try {
            await apiPost('/api/stream/start');
            await refreshAll();
            return;
          } catch (retryErr) {
            alert(`Start failed: ${retryErr.message}`);
          }
        }
      } else if (err.code === 'E_NO_VIDEO') {
        alert('⚠️ No video selected for streaming.\n\nPlease upload a video or click "Select as Active" in the Video Library below.');
        document.getElementById('panel-videos')?.scrollIntoView({ behavior: 'smooth' });
      } else if (err.code === 'E_DISABLED') {
        alert('⚠️ Master Stream Lock is engaged.\n\nPlease toggle off the "Master Stream Lock" switch at the top of the dashboard to enable streaming.');
      } else {
        alert(`Start failed: ${err.message || err.error || 'Server rejected stream start'}\nCode: ${err.code || 'unknown'}`);
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
        await fetchStatus();
      } catch (err) {
        alert(`Stop failed: ${err.message}`);
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
        await fetchStatus();
      } catch (err) {
        alert(`Restart failed: ${err.message}`);
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
        alert(`Key reveal failed: ${err.message}`);
      }
    } else {
      alert('No stream key is configured yet. Paste your YouTube Stream Key into the box.');
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
        alert('✅ Maintenance mode disabled! You can now start streaming.');
      } catch (e) {
        alert(`Failed to disable maintenance mode: ${e.message}`);
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
    };

    if (cfgStreamKey.value.trim()) {
      patch.youtube.streamKey = cfgStreamKey.value.trim();
    }

    try {
      const res = await apiPut('/api/settings', patch);
      _currentSettings = res.settings;
      updateDeckStreamKeyBadge(res.settings);
      modalSettings.classList.remove('open');
      await refreshAll();

      if (patch.youtube?.streamKey) {
        alert('✅ Settings saved!\n\nYouTube stream key is active and verified.');
      }

      if (res.requiresRestart) {
        const isLive = statusText.textContent === 'RUNNING' || statusText.textContent === 'STARTING';
        if (isLive && confirm('Settings saved! You modified parameters that require an FFmpeg restart. Restart the live stream now to apply changes?')) {
          await apiPost('/api/stream/restart');
          await fetchStatus();
        }
      }
    } catch (err) {
      const detail = err.errors && err.errors.length > 0
        ? err.errors.join('\n• ')
        : (err.message || 'Validation error');
      alert(`Save failed:\n• ${detail}`);
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
