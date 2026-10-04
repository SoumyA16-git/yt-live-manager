/**
 * youtube-api-manager.js — YouTube Data API v3 liveBroadcasts & liveStreams lifecycle manager.
 *
 * Controls and verifies YouTube broadcast lifecycle without browser or manual interaction:
 * - OAuth2 token refresh via client credentials (env vars: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN).
 * - Resolves liveStream by matching RTMPS streamKey against stream.cdn.ingestionInfo.streamName.
 * - Resolves bound liveBroadcast resource for the liveStream.
 * - Handles enableAutoStart:
 *     If true: monitors YouTube automated transition to 'live'.
 *     If false: explicitly invokes liveBroadcasts.transition(broadcastStatus='live').
 * - Handles auto-recycle / completed broadcasts by creating and binding a fresh broadcast when needed.
 * - Telemetry: tracks streamStatus (active/ready) and lifeCycleStatus (live/ready/testing/complete).
 */

import { redact, setSecret } from './lib/redact.js';
import { logger } from './logger.js';

// ─── Module State ─────────────────────────────────────────────────────────────

let _clientId = process.env.YOUTUBE_CLIENT_ID || '';
let _clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';
let _refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || '';

let _cachedAccessToken = null;
let _tokenExpiresAt = 0;

let _currentStreamId = null;
let _currentBroadcastId = null;
let _currentStreamStatus = 'unknown';
let _currentHealthStatus = 'unknown';
let _currentLifeCycleStatus = 'unknown';
let _lastCheckedAt = null;
let _lastApiError = null;

// ─── Configuration & Initialization ──────────────────────────────────────────

/**
 * Initialize or update YouTube API credentials.
 * Credentials are automatically registered with redact() to prevent leaking in logs.
 *
 * @param {object} [envConfig={}]
 */
export function initYouTubeApi(envConfig = {}) {
  _clientId = envConfig.YOUTUBE_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID || _clientId;
  _clientSecret = envConfig.YOUTUBE_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET || _clientSecret;
  _refreshToken = envConfig.YOUTUBE_REFRESH_TOKEN || process.env.YOUTUBE_REFRESH_TOKEN || _refreshToken;

  if (_clientId) setSecret(_clientId);
  if (_clientSecret) setSecret(_clientSecret);
  if (_refreshToken) setSecret(_refreshToken);

  const configured = Boolean(_clientId && _clientSecret && _refreshToken);
  if (configured) {
    logger.info('youtube_api.initialized', 'YouTube Data API v3 integration configured with OAuth2 credentials');
  }
  return configured;
}

export function isYouTubeApiConfigured() {
  return Boolean(_clientId && _clientSecret && _refreshToken);
}

// ─── OAuth2 Token Management ──────────────────────────────────────────────────

/**
 * Obtain a valid Google OAuth2 access token, refreshing if necessary.
 *
 * @returns {Promise<string>}
 */
export async function getAccessToken() {
  if (!isYouTubeApiConfigured()) {
    throw Object.assign(new Error('YouTube API is not configured with OAuth2 credentials'), {
      code: 'E_YOUTUBE_API_NOT_CONFIGURED',
    });
  }

  // Use cached token if valid for at least 2 more minutes
  if (_cachedAccessToken && Date.now() < _tokenExpiresAt - 120000) {
    return _cachedAccessToken;
  }

  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const params = new URLSearchParams({
    client_id: _clientId,
    client_secret: _clientSecret,
    refresh_token: _refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    _lastApiError = `Token refresh failed (${res.status}): ${errText}`;
    logger.error('youtube_api.token_error', `Failed to refresh OAuth2 access token: ${res.status}`);
    throw Object.assign(new Error(`OAuth token refresh failed (${res.status})`), { code: 'E_OAUTH_TOKEN_FAILED' });
  }

  const data = await res.json();
  _cachedAccessToken = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  setSecret(_cachedAccessToken);

  logger.debug('youtube_api.token_refreshed', 'OAuth2 access token successfully refreshed');
  return _cachedAccessToken;
}

/**
 * Execute an authenticated YouTube Data API v3 request.
 *
 * @param {string} endpoint API endpoint relative to base or full URL
 * @param {object} [options={}] fetch options
 */
async function youtubeFetch(endpoint, options = {}) {
  const token = await getAccessToken();
  const url = endpoint.startsWith('http') ? endpoint : `https://www.googleapis.com/youtube/v3/${endpoint}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    let parsedJson = null;
    try {
      parsedJson = JSON.parse(errBody);
    } catch {
      parsedJson = null;
    }

    const gError = parsedJson?.error;
    const errorCode = gError?.code || res.status;
    const rawMessage = gError?.message || errBody || res.statusText;
    const safeMessage = redact(String(rawMessage));
    const firstDetail = Array.isArray(gError?.errors) && gError.errors[0] ? gError.errors[0] : null;
    const errorReason = firstDetail?.reason || 'unknown';
    const errorDomain = firstDetail?.domain || 'unknown';
    const errorsList = Array.isArray(gError?.errors)
      ? gError.errors.map(e => ({
          reason: redact(String(e.reason || 'unknown')),
          domain: redact(String(e.domain || 'unknown')),
          message: redact(String(e.message || '')),
        }))
      : [{ reason: errorReason, domain: errorDomain, message: safeMessage }];

    // Derive human-readable API operation from endpoint
    const cleanEndpoint = redact(endpoint);
    let operation = cleanEndpoint.split('?')[0];
    if (operation.startsWith('liveStreams') && (!options.method || options.method === 'GET')) {
      operation = 'liveStreams.list';
    } else if (operation.startsWith('liveBroadcasts/transition')) {
      operation = 'liveBroadcasts.transition';
    } else if (operation.startsWith('liveBroadcasts/bind')) {
      operation = 'liveBroadcasts.bind';
    } else if (operation.startsWith('liveBroadcasts') && options.method === 'POST') {
      operation = 'liveBroadcasts.insert';
    } else if (operation.startsWith('liveBroadcasts') && (!options.method || options.method === 'GET')) {
      operation = 'liveBroadcasts.list';
    }

    const logFields = {
      operation,
      endpoint: cleanEndpoint,
      httpStatus: res.status,
      errorCode,
      errorMessage: safeMessage,
      errorReason,
      errorDomain,
      errors: errorsList,
    };

    logger.error(
      'youtube_api.request_failed',
      `YouTube API call failed [${res.status}] on ${operation} (${cleanEndpoint}): reason=${errorReason}, domain=${errorDomain}, message=${safeMessage}`,
      logFields
    );

    const formattedSummary = `YouTube API request failed [${res.status}]: operation=${operation}, reason=${errorReason}, domain=${errorDomain}, message="${safeMessage}"`;
    _lastApiError = formattedSummary;

    const err = new Error(formattedSummary);
    err.status = res.status;
    err.code = errorCode;
    err.reason = errorReason;
    err.domain = errorDomain;
    err.operation = operation;
    err.safeMessage = safeMessage;
    err.details = safeMessage;
    throw err;
  }

  return res.json();
}

// ─── Stream & Broadcast Resolution ────────────────────────────────────────────

/**
 * Resolve liveStream resource associated with the given stream key.
 *
 * @param {string} streamKey
 * @returns {Promise<{ id: string, streamStatus: string, healthStatus: string, title: string }|null>}
 */
export async function resolveLiveStreamByStreamKey(streamKey) {
  if (!streamKey || !isYouTubeApiConfigured()) return null;

  try {
    const cleanKey = streamKey.trim();
    let pageToken = '';
    let pageCount = 0;
    const maxPages = 10; // safety ceiling (up to 500 streams)

    do {
      pageCount++;
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const data = await youtubeFetch(`liveStreams?part=id,snippet,status,cdn&mine=true&maxResults=50${pageParam}`);
      const items = data.items || [];

      const matched = items.find(s => s.cdn?.ingestionInfo?.streamName === cleanKey);

      if (matched) {
        _currentStreamId = matched.id;
        _currentStreamStatus = matched.status?.streamStatus || 'unknown';
        _currentHealthStatus = matched.status?.healthStatus?.status || 'unknown';
        _lastCheckedAt = new Date().toISOString();

        logger.info('youtube_api.stream_resolved', `Resolved YouTube liveStream ID ${matched.id} (status: ${_currentStreamStatus})`);
        return {
          id: matched.id,
          streamStatus: _currentStreamStatus,
          healthStatus: _currentHealthStatus,
          title: matched.snippet?.title || '',
        };
      }

      pageToken = data.nextPageToken || '';
    } while (pageToken && pageCount < maxPages);

    logger.warn('youtube_api.stream_not_found', `No liveStream resource matched the configured stream key across ${pageCount} pages`);
    return null;
  } catch (err) {
    _lastApiError = err.message;
    return null;
  }
}

/**
 * Get current status of a liveStream resource.
 *
 * @param {string} streamId
 * @returns {Promise<{ streamStatus: string, healthStatus: string }>}
 */
export async function getLiveStreamStatus(streamId) {
  if (!streamId || !isYouTubeApiConfigured()) {
    return { streamStatus: 'unknown', healthStatus: 'unknown' };
  }

  try {
    const data = await youtubeFetch(`liveStreams?part=id,status&id=${encodeURIComponent(streamId)}`);
    const item = (data.items || [])[0];
    if (item) {
      _currentStreamStatus = item.status?.streamStatus || 'unknown';
      _currentHealthStatus = item.status?.healthStatus?.status || 'unknown';
      _lastCheckedAt = new Date().toISOString();
      return { streamStatus: _currentStreamStatus, healthStatus: _currentHealthStatus };
    }
  } catch (err) {
    _lastApiError = err.message;
  }
  return { streamStatus: _currentStreamStatus, healthStatus: _currentHealthStatus };
}

/**
 * Resolve liveBroadcast bound to the given streamId.
 * Paginates and prioritizes active/live > testing > ready broadcasts.
 * Correctly identifies when all bound broadcasts are completed.
 *
 * @param {string} streamId
 * @returns {Promise<{ id: string, title: string, lifeCycleStatus: string, enableAutoStart: boolean, enableAutoStop: boolean, isComplete?: boolean }|null>}
 */
export async function resolveBoundBroadcast(streamId) {
  if (!streamId || !isYouTubeApiConfigured()) return null;

  try {
    let pageToken = '';
    let pageCount = 0;
    const maxPages = 5;
    const allBound = [];

    do {
      pageCount++;
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const data = await youtubeFetch(`liveBroadcasts?part=id,snippet,status,contentDetails&broadcastType=all&mine=true&maxResults=50${pageParam}`);
      const items = data.items || [];

      // Filter broadcasts bound to this streamId
      const bound = items.filter(b => b.contentDetails?.boundStreamId === streamId);
      for (const item of bound) {
        if (!allBound.some(b => b.id === item.id)) {
          allBound.push(item);
        }
      }

      // Check if an active, testing, or ready broadcast was found in this page
      const foundActive = allBound.find(b => b.status?.lifeCycleStatus === 'live')
        || allBound.find(b => b.status?.lifeCycleStatus === 'testing')
        || allBound.find(b => b.status?.lifeCycleStatus === 'ready');

      if (foundActive) {
        _currentBroadcastId = foundActive.id;
        _currentLifeCycleStatus = foundActive.status?.lifeCycleStatus || 'unknown';
        _lastCheckedAt = new Date().toISOString();

        logger.info('youtube_api.broadcast_resolved', `Resolved bound YouTube broadcast ID ${foundActive.id} (status: ${_currentLifeCycleStatus}, autoStart: ${Boolean(foundActive.contentDetails?.enableAutoStart)})`);
        return {
          id: foundActive.id,
          title: foundActive.snippet?.title || '',
          lifeCycleStatus: _currentLifeCycleStatus,
          enableAutoStart: Boolean(foundActive.contentDetails?.enableAutoStart),
          enableAutoStop: Boolean(foundActive.contentDetails?.enableAutoStop),
          enableMonitorStream: Boolean(foundActive.contentDetails?.monitorStream?.enableMonitorStream),
          isComplete: false,
        };
      }

      pageToken = data.nextPageToken || '';
    } while (pageToken && pageCount < maxPages);

    // If no active/testing/ready broadcast was found, check if a completed broadcast is bound
    const completed = allBound.find(b => b.status?.lifeCycleStatus === 'complete');
    if (completed) {
      _currentBroadcastId = completed.id;
      _currentLifeCycleStatus = 'complete';
      _lastCheckedAt = new Date().toISOString();
      return {
        id: completed.id,
        title: completed.snippet?.title || '',
        lifeCycleStatus: 'complete',
        enableAutoStart: Boolean(completed.contentDetails?.enableAutoStart),
        enableAutoStop: Boolean(completed.contentDetails?.enableAutoStop),
        enableMonitorStream: Boolean(completed.contentDetails?.monitorStream?.enableMonitorStream),
        isComplete: true,
      };
    }

    return null;
  } catch (err) {
    _lastApiError = err.message;
    return null;
  }
}

/**
 * Transition a liveBroadcast to a new lifecycle status (e.g., 'live').
 *
 * @param {string} broadcastId
 * @param {'live'|'testing'|'complete'} [targetStatus='live']
 * @returns {Promise<{ id: string, lifeCycleStatus: string }>}
 */
export async function transitionBroadcast(broadcastId, targetStatus = 'live') {
  if (!broadcastId || !isYouTubeApiConfigured()) {
    throw new Error('Broadcast ID or API credentials missing');
  }

  logger.info('youtube_api.transitioning', `Transitioning YouTube broadcast ${broadcastId} to '${targetStatus}'`);
  const data = await youtubeFetch(
    `liveBroadcasts/transition?broadcastStatus=${encodeURIComponent(targetStatus)}&id=${encodeURIComponent(broadcastId)}&part=id,status`,
    { method: 'POST' }
  );

  const status = data.status?.lifeCycleStatus || targetStatus;
  _currentLifeCycleStatus = status;
  _lastCheckedAt = new Date().toISOString();
  logger.info('youtube_api.transition_complete', `YouTube broadcast ${broadcastId} lifeCycleStatus is now '${status}'`);
  return { id: broadcastId, lifeCycleStatus: status };
}

/**
 * Automatically generate YouTube live broadcast title in the required production format:
 * Chinese Street Food Live Streaming Mochi "DD-MM-YYYY" "hh:mm AM/PM"
 * Computed in Asia/Kolkata timezone (IST, UTC+5:30) at stream start moment.
 *
 * @param {Date|string|number} [date=new Date()]
 * @returns {string} Formatted broadcast title
 */
export function generateBroadcastTitle(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);

  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const day = (m.day || '01').padStart(2, '0');
  const month = (m.month || '01').padStart(2, '0');
  const year = m.year || '2026';
  const hour = (m.hour || '12').padStart(2, '0');
  const minute = (m.minute || '00').padStart(2, '0');
  const period = (m.dayPeriod || 'AM').toUpperCase();

  return `Chinese Street Food Live Streaming Mochi "${day}-${month}-${year}" "${hour}:${minute} ${period}"`;
}

/**
 * Create a fresh liveBroadcast and bind it to the specified streamId.
 * Used during auto-recycle when the previous broadcast is closed ('complete').
 *
 * @param {object} opts
 * @param {string} opts.streamId
 * @param {string} [opts.title]
 * @param {boolean} [opts.enableAutoStart=false]
 * @param {boolean} [opts.enableAutoStop=true]
 * @param {boolean} [opts.enableMonitorStream=false]
 * @returns {Promise<{ id: string, title: string, lifeCycleStatus: string, enableAutoStart: boolean, enableAutoStop: boolean, enableMonitorStream: boolean }>}
 */
export async function createAndBindBroadcast({
  streamId,
  title = '',
  enableAutoStart = false,
  enableAutoStop = true,
  enableMonitorStream = false,
}) {
  if (!streamId || !isYouTubeApiConfigured()) {
    throw new Error('streamId and configured API required to create broadcast');
  }

  const broadcastTitle = title || generateBroadcastTitle(new Date());
  logger.info('youtube_api.creating_broadcast', `Creating new liveBroadcast: "${broadcastTitle}" (monitorStream=${enableMonitorStream}, autoStart=${enableAutoStart}, autoStop=${enableAutoStop})`, {
    monitorStream: enableMonitorStream,
    autoStart: enableAutoStart,
    autoStop: enableAutoStop,
  });

  // 1. Create broadcast resource
  const created = await youtubeFetch('liveBroadcasts?part=snippet,status,contentDetails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snippet: {
        title: broadcastTitle,
        scheduledStartTime: new Date().toISOString(),
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        monitorStream: {
          enableMonitorStream,
        },
        enableAutoStart,
        enableAutoStop,
        recordFromStart: true,
      },
    }),
  });

  const broadcastId = created.id;

  // 2. Bind broadcast to the reusable liveStream
  logger.info('youtube_api.binding_broadcast', `Binding broadcast ${broadcastId} to stream ${streamId}`);
  const bound = await youtubeFetch(
    `liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}&part=id,contentDetails,status`,
    { method: 'POST' }
  );

  _currentBroadcastId = broadcastId;
  _currentLifeCycleStatus = bound?.status?.lifeCycleStatus || 'ready';
  _lastCheckedAt = new Date().toISOString();

  return {
    id: broadcastId,
    title: broadcastTitle,
    lifeCycleStatus: _currentLifeCycleStatus,
    enableAutoStart,
    enableAutoStop,
    enableMonitorStream,
  };
}

// ─── Automated Broadcast Lifecycle Verification ───────────────────────────────

/**
 * Autonomous lifecycle transition after FFmpeg start:
 * 1. Wait for streamStatus to become 'active'.
 * 2. Resolve bound broadcast (or create new one if completed).
 * 3. If enableAutoStart is false (or hasn't transitioned), invoke transition('live').
 * 4. Verify lifeCycleStatus becomes 'live'.
 *
 * @param {object} opts
 * @param {string} opts.streamKey
 * @param {string} [opts.title]
 * @param {number} [opts.streamTimeoutSec=45]
 * @param {number} [opts.liveTimeoutSec=30]
 * @returns {Promise<{ success: boolean, liveStreamId: string, broadcastId: string, streamStatus: string, lifeCycleStatus: string }>}
 */
export async function manageBroadcastLifecycleOnStart({
  streamKey,
  title = '',
  streamTimeoutSec = 45,
  liveTimeoutSec = 30,
}) {
  if (!isYouTubeApiConfigured()) {
    return {
      success: true,
      unmanaged: true,
      streamStatus: 'unmanaged',
      lifeCycleStatus: 'unmanaged',
    };
  }

  // 1. Resolve liveStream by streamKey
  const stream = await resolveLiveStreamByStreamKey(streamKey);
  if (!stream) {
    logger.warn('youtube_api.lifecycle_aborted', 'Could not resolve liveStream for streamKey; proceeding in unmanaged mode');
    return { success: false, reason: 'STREAM_KEY_NOT_MATCHED' };
  }

  // 2. Poll until streamStatus === 'active'
  logger.info('youtube_api.waiting_stream_active', `Waiting for YouTube ingest to mark stream ${stream.id} active (up to ${streamTimeoutSec}s)...`);
  const streamStart = Date.now();
  let streamStatus = stream.streamStatus;

  while (streamStatus !== 'active' && Date.now() - streamStart < streamTimeoutSec * 1000) {
    await new Promise(r => setTimeout(r, 2000));
    const st = await getLiveStreamStatus(stream.id);
    streamStatus = st.streamStatus;
    if (streamStatus === 'active') break;
  }

  if (streamStatus !== 'active') {
    logger.warn('youtube_api.stream_active_timeout', `YouTube ingest stream ${stream.id} not marked active after ${streamTimeoutSec}s (status: ${streamStatus})`);
  } else {
    logger.info('youtube_api.stream_active', `YouTube ingest stream ${stream.id} is ACTIVE!`);
  }

  // 3. Resolve bound broadcast
  let broadcast = await resolveBoundBroadcast(stream.id);

  // If API error occurred while querying broadcast, do NOT create a new broadcast blindly!
  if (!broadcast && _lastApiError) {
    logger.warn('youtube_api.broadcast_lookup_error', `API error during broadcast resolution: ${_lastApiError}`);
    return { success: false, streamStatus, reason: `API_ERROR: ${_lastApiError}` };
  }

  // If no broadcast or already completed, create a new broadcast and bind to reusable stream
  if (!broadcast || broadcast.lifeCycleStatus === 'complete' || broadcast.isComplete) {
    logger.info('youtube_api.creating_fresh_broadcast', 'No active or ready broadcast bound; creating fresh broadcast...');
    broadcast = await createAndBindBroadcast({
      streamId: stream.id,
      title,
      enableAutoStart: false,
      enableAutoStop: true,
      enableMonitorStream: false,
    });
  }

  // 4. If broadcast is already 'live', we're done
  if (broadcast.lifeCycleStatus === 'live') {
    logger.info('youtube_api.broadcast_live', `YouTube broadcast ${broadcast.id} is confirmed LIVE!`);
    return {
      success: true,
      liveStreamId: stream.id,
      broadcastId: broadcast.id,
      streamStatus,
      lifeCycleStatus: 'live',
    };
  }

  // 5. Handle Transition (auto-start wait if broadcast has enableAutoStart === true)
  if (broadcast.enableAutoStart) {
    // Wait up to autoStartMaxWait for YouTube auto-start
    const autoStartMaxWait = Math.min(30, liveTimeoutSec) * 1000;
    logger.info('youtube_api.waiting_autostart', `Broadcast ${broadcast.id} has enableAutoStart=true; awaiting auto-transition (up to ${autoStartMaxWait / 1000}s)...`);
    const autoStartBegin = Date.now();
    while (Date.now() - autoStartBegin < autoStartMaxWait) {
      await new Promise(r => setTimeout(r, 2000));
      const bCheck = await resolveBoundBroadcast(stream.id);
      if (bCheck && (!broadcast.id || bCheck.id === broadcast.id || (bCheck.lifeCycleStatus !== 'complete' && !bCheck.isComplete))) {
        broadcast = bCheck;
        _currentLifeCycleStatus = bCheck.lifeCycleStatus;
      }
      if (bCheck && bCheck.lifeCycleStatus === 'live') {
        logger.info('youtube_api.autostart_succeeded', `Broadcast ${bCheck.id} auto-started to LIVE!`);
        return {
          success: true,
          liveStreamId: stream.id,
          broadcastId: bCheck.id,
          streamStatus,
          lifeCycleStatus: 'live',
        };
      }
    }
    logger.warn('youtube_api.autostart_fallback', `Broadcast ${broadcast.id} did not auto-transition within ${autoStartMaxWait / 1000}s; attempting explicit transition...`);
  }

  // 6. Explicit Transition to LIVE if not already LIVE
  if (broadcast.lifeCycleStatus !== 'live' && _currentLifeCycleStatus !== 'live') {
    if (broadcast.lifeCycleStatus === 'testing' || _currentLifeCycleStatus === 'testing') {
      logger.info('youtube_api.transition_testing_to_live', `Broadcast ${broadcast.id} is in 'testing'; transitioning to 'live'`);
      try {
        const transitioned = await transitionBroadcast(broadcast.id, 'live');
        if (transitioned.lifeCycleStatus === 'live') {
          logger.info('youtube_api.transition_verified', `Broadcast ${broadcast.id} explicitly transitioned to LIVE!`);
        }
      } catch (err) {
        logger.warn('youtube_api.transition_warn', `Transition from testing to live returned error: ${err.message}`);
      }
    } else if (broadcast.enableMonitorStream) {
      // Existing broadcast created in YouTube Studio with monitorStream enabled:
      // Must follow READY -> TESTING -> LIVE flow
      logger.info('youtube_api.transition_with_monitor', `Broadcast ${broadcast.id} has monitorStream=true; transitioning through 'testing' to 'live'`);
      try {
        await transitionBroadcast(broadcast.id, 'testing');
        const transitioned = await transitionBroadcast(broadcast.id, 'live');
        if (transitioned.lifeCycleStatus === 'live') {
          logger.info('youtube_api.transition_verified', `Broadcast ${broadcast.id} explicitly transitioned to LIVE via testing!`);
        }
      } catch (err) {
        logger.warn('youtube_api.transition_warn', `Testing transition workflow returned error: ${err.message}; checking status...`);
      }
    } else {
      // Unattended production flow: monitorStream is disabled (or false)
      // Transition directly READY -> LIVE
      try {
        const transitioned = await transitionBroadcast(broadcast.id, 'live');
        if (transitioned.lifeCycleStatus === 'live') {
          logger.info('youtube_api.transition_verified', `Broadcast ${broadcast.id} explicitly transitioned to LIVE!`);
        }
      } catch (err) {
        logger.warn('youtube_api.transition_warn', `Transition to live returned error: ${err.message}; checking testing fallback...`);
        if (err.message.includes('invalidTransition') || err.message.includes('redundantTransition') || err.message.includes('testing')) {
          try {
            await transitionBroadcast(broadcast.id, 'testing');
            await transitionBroadcast(broadcast.id, 'live');
          } catch (innerErr) {
            logger.warn('youtube_api.transition_testing_failed', `Fallback testing transition failed: ${innerErr.message}`);
          }
        }
      }
    }
  }

  // 7. Final poll for 'live' status
  const livePollStart = Date.now();
  let lifeCycleStatus = _currentLifeCycleStatus;
  while (lifeCycleStatus !== 'live' && Date.now() - livePollStart < liveTimeoutSec * 1000) {
    await new Promise(r => setTimeout(r, 2000));
    const bCheck = await resolveBoundBroadcast(stream.id);
    if (bCheck && (!broadcast.id || bCheck.id === broadcast.id || (bCheck.lifeCycleStatus !== 'complete' && !bCheck.isComplete))) {
      broadcast = bCheck;
      lifeCycleStatus = bCheck.lifeCycleStatus;
      _currentLifeCycleStatus = lifeCycleStatus;
    }
    if (lifeCycleStatus === 'live') break;
  }

  const isLive = lifeCycleStatus === 'live';
  if (isLive) {
    logger.info('youtube_api.lifecycle_success', `Stream & Broadcast fully verified: Stream is ACTIVE and Broadcast is LIVE (${broadcast.id})`);
  } else {
    logger.warn('youtube_api.lifecycle_incomplete', `Broadcast ${broadcast.id} current status is '${lifeCycleStatus}'`);
  }

  return {
    success: isLive,
    liveStreamId: stream.id,
    broadcastId: broadcast.id,
    streamStatus,
    lifeCycleStatus,
    reason: isLive ? null : `Broadcast failed to reach LIVE status (current: ${lifeCycleStatus})`,
  };
}

// ─── Status Getter ────────────────────────────────────────────────────────────

export function getYouTubeLiveApiState() {
  return {
    configured: isYouTubeApiConfigured(),
    liveStreamId: _currentStreamId,
    broadcastId: _currentBroadcastId,
    streamStatus: _currentStreamStatus,
    healthStatus: _currentHealthStatus,
    lifeCycleStatus: _currentLifeCycleStatus,
    isBroadcastLive: _currentLifeCycleStatus === 'live',
    lastCheckedAt: _lastCheckedAt,
    lastError: _lastApiError,
  };
}

export function _resetStateForTest() {
  _clientId = '';
  _clientSecret = '';
  _refreshToken = '';
  _cachedAccessToken = null;
  _tokenExpiresAt = 0;
  _currentStreamId = null;
  _currentBroadcastId = null;
  _currentStreamStatus = 'unknown';
  _currentHealthStatus = 'unknown';
  _currentLifeCycleStatus = 'unknown';
  _lastCheckedAt = null;
  _lastApiError = null;
}
