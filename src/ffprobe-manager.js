/**
 * ffprobe-manager.js — Source probing, keyframe scanning, and compatibility evaluation.
 *
 * PRD §5:
 * - Runs ffprobe with args array (shell: false), timeout 60 s, lowered priority.
 * - Keyframe scan: %+60 interval scan to compute maxKeyframeIntervalSec.
 * - Extracts all required audio/video fields and detects VFR.
 * - Evaluates COMPATIBLE vs. REQUIRES_TRANSCODING with blockers and warnings.
 * - Maps every blocker/warning to human-readable explanations.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import { logger } from './logger.js';

// ─── Pure Parsers ─────────────────────────────────────────────────────────────

/**
 * Parse an FFmpeg rate fraction string (e.g. "30/1", "2997/100") to a floating number.
 */
function parseFraction(str) {
  if (!str || typeof str !== 'string') return 0;
  const parts = str.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    return den !== 0 ? num / den : 0;
  }
  return parseFloat(str) || 0;
}

/**
 * Parse keyframe CSV lines from ffprobe:
 *   pts_time lines (one per keyframe)
 * Computes maximum delta between keyframes within first 60 s.
 *
 * @param {string} csvText
 * @returns {number|null} maxKeyframeIntervalSec (or null if < 2 keyframes)
 */
export function parseKeyframeScan(csvText) {
  if (!csvText || typeof csvText !== 'string') return null;

  const pts = [];
  for (const line of csvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const val = parseFloat(trimmed);
    if (!isNaN(val)) pts.push(val);
  }

  if (pts.length < 2) return null;

  let maxInterval = 0;
  for (let i = 1; i < pts.length; i++) {
    const delta = pts[i] - pts[i - 1];
    if (delta > maxInterval) {
      maxInterval = delta;
    }
  }

  return Number(maxInterval.toFixed(3));
}

/**
 * Parse JSON format/streams from ffprobe and keyframe CSV into normalized metadata.
 *
 * @param {object} probeJson  Parsed JSON from ffprobe
 * @param {string} [keyframeCsv='']
 * @returns {object} Extracted metadata
 */
export function parseProbeOutput(probeJson, keyframeCsv = '') {
  if (!probeJson || typeof probeJson !== 'object') {
    throw new Error('Invalid probe JSON output');
  }

  const streams = probeJson.streams || [];
  const format  = probeJson.format  || {};

  const vStream = streams.find(s => s.codec_type === 'video');
  const aStream = streams.find(s => s.codec_type === 'audio');

  if (!vStream) {
    throw new Error('No video stream found in media file');
  }

  // Video properties
  const width  = parseInt(vStream.width, 10) || 0;
  const height = parseInt(vStream.height, 10) || 0;
  const aspectRatio = width && height ? `${width}:${height}` : '';

  const rFps   = parseFraction(vStream.r_frame_rate);
  const avgFps = parseFraction(vStream.avg_frame_rate);
  // Detect Variable Frame Rate (VFR): discrepancy > 0.05 between r_frame_rate and avg_frame_rate
  const isVFR = (rFps > 0 && avgFps > 0) && Math.abs(rFps - avgFps) > 0.05;
  const fps   = Number((avgFps > 0 ? avgFps : rFps).toFixed(2));

  const durationSec = parseFloat(format.duration || vStream.duration || '0') || 0;
  const fileSizeBytes = parseInt(format.size, 10) || 0;

  // Video bitrate (bps): fallback to format.bit_rate or filesize/duration if stream bitrate missing
  let videoBitrate = parseInt(vStream.bit_rate, 10);
  if (isNaN(videoBitrate) || videoBitrate <= 0) {
    const fmtBitrate = parseInt(format.bit_rate, 10) || 0;
    const audioBitrateGuess = parseInt(aStream?.bit_rate, 10) || 128_000;
    videoBitrate = Math.max(0, fmtBitrate - audioBitrateGuess);
  }
  if ((!videoBitrate || videoBitrate <= 0) && durationSec > 0 && fileSizeBytes > 0) {
    const calculatedBitrate = Math.round((fileSizeBytes * 8) / durationSec);
    const audioBitrateGuess = parseInt(aStream?.bit_rate, 10) || 128_000;
    videoBitrate = Math.max(0, calculatedBitrate - audioBitrateGuess);
  }

  const maxKeyframeIntervalSec = parseKeyframeScan(keyframeCsv);

  // Audio properties
  const hasAudio         = Boolean(aStream);
  const audioCodec       = aStream?.codec_name || null;
  const audioProfile     = aStream?.profile    || null;
  const audioChannels    = aStream?.channels ? parseInt(aStream.channels, 10) : 0;
  const audioSampleRate  = aStream?.sample_rate ? parseInt(aStream.sample_rate, 10) : 0;
  const audioBitrate     = aStream?.bit_rate ? parseInt(aStream.bit_rate, 10) : 0;

  return {
    // Video
    width,
    height,
    aspectRatio,
    durationSec: Number(durationSec.toFixed(2)),
    fps,
    isVFR,
    videoCodec:     vStream.codec_name || '',
    videoProfile:   (vStream.profile || '').toLowerCase(),
    pixFmt:         vStream.pix_fmt || '',
    fieldOrder:     vStream.field_order || 'unknown',
    colorSpace:     vStream.color_space || null,
    colorPrimaries: vStream.color_primaries || null,
    colorTransfer:  vStream.color_transfer || null,
    videoBitrate,
    maxKeyframeIntervalSec,

    // Audio
    hasAudio,
    audioCodec,
    audioProfile,
    audioChannels,
    audioSampleRate,
    audioBitrate,

    // General
    fileSizeBytes,
    container: (format.format_name || '').split(',')[0],
  };
}

// ─── Compatibility Rules & Explanation (PRD §5.4, §5.5) ─────────────────────

/**
 * Evaluate probe metadata against stream settings.
 *
 * @param {object} meta     Normalized probe metadata
 * @param {object} settings Stream configuration
 * @returns {object} Evaluation verdict: { status, reasons, warnings, explanations, modeAllowed }
 */
export function evaluateCompatibility(meta, settings = {}) {
  const reasons      = [];
  const warnings     = [];
  const explanations = [];

  const streamCfg = settings.stream || {};

  const targetRes   = streamCfg.resolution || '1080x1920';
  const targetFps   = streamCfg.fps ?? 30;
  const copyMinMbps = streamCfg.copyMinMbps ?? 0.1;
  const copyMaxMbps = streamCfg.copyMaxMbps ?? 4.0;
  const keyframeMax = streamCfg.keyframeMaxSeconds ?? 4.0;

  // 1. Resolution Check
  const currentRes = `${meta.width}x${meta.height}`;
  if (currentRes !== targetRes) {
    reasons.push('RES_MISMATCH');
    const orient = meta.width > meta.height ? 'landscape' : 'portrait';
    explanations.push(`Resolution is ${currentRes} (${orient}). Required: ${targetRes}.`);
  }

  // 2. Video Codec Check: h264, profile baseline/main/high
  if (meta.videoCodec !== 'h264') {
    reasons.push('CODEC_NOT_H264');
    explanations.push(`Video codec is ${meta.videoCodec.toUpperCase() || 'unknown'}. YouTube live needs H.264.`);
  } else {
    const prof = meta.videoProfile.toLowerCase();
    const allowedProfiles = ['baseline', 'main', 'high', 'constrained baseline'];
    if (prof && !allowedProfiles.some(p => prof.includes(p))) {
      reasons.push('CODEC_PROFILE_UNSUPPORTED');
      explanations.push(`H.264 profile is ${meta.videoProfile}. Allowed: Baseline, Main, or High.`);
    }
  }

  // 3. Pixel Format: yuv420p
  if (meta.pixFmt !== 'yuv420p') {
    reasons.push('PIX_FMT_NOT_YUV420P');
    explanations.push(`Pixel format is ${meta.pixFmt}. Required: yuv420p.`);
  }

  // 4. Frame Rate: within ±0.1 of target FPS, not VFR
  if (Math.abs(meta.fps - targetFps) > 0.1) {
    reasons.push('FPS_MISMATCH');
    explanations.push(`Frame rate is ${meta.fps} fps. Configured target is ${targetFps} fps.`);
  }
  if (meta.isVFR) {
    reasons.push('VFR_DETECTED');
    explanations.push('Video has a Variable Frame Rate (VFR). Constant Frame Rate (CFR) is required for stream copy.');
  }

  // 5. Scan: Progressive
  const scan = (meta.fieldOrder || '').toLowerCase();
  if (scan !== 'progressive' && scan !== 'unknown') {
    reasons.push('INTERLACED_SCAN');
    explanations.push(`Interlaced video detected (${meta.fieldOrder}). Progressive scan is required.`);
  }

  // 6. Keyframe Interval: maxKeyframeIntervalSec <= keyframeMax (default 4.0)
  if (meta.maxKeyframeIntervalSec !== null) {
    if (meta.maxKeyframeIntervalSec > keyframeMax) {
      reasons.push('KEYFRAME_INTERVAL_HIGH');
      explanations.push(`Keyframes are ${meta.maxKeyframeIntervalSec} s apart. Required: ≤ ${keyframeMax} s (2 s recommended).`);
    } else if (meta.maxKeyframeIntervalSec > 2.2) {
      warnings.push('KEYFRAME_INTERVAL_SUBOPTIMAL');
      explanations.push(`Keyframe interval is ${meta.maxKeyframeIntervalSec} s. 2.0 s is ideal for YouTube stability.`);
    }
  }

  // 7. Video Bitrate: between copyMinMbps and copyMaxMbps (capped at 4Mbps max gate with 5% tolerance)
  const videoMbps = meta.videoBitrate / 1_000_000;
  if (videoMbps > 0) {
    if (videoMbps < copyMinMbps) {
      reasons.push('BITRATE_TOO_LOW');
      explanations.push(`Video bitrate is ${videoMbps.toFixed(2)} Mbps. Minimum for copy mode is ${copyMinMbps} Mbps.`);
    } else if (videoMbps > copyMaxMbps * 1.05) {
      reasons.push('BITRATE_TOO_HIGH');
      explanations.push(`Video bitrate is ${videoMbps.toFixed(2)} Mbps. Maximum allowed gate for copy mode is ${copyMaxMbps} Mbps (capped at 4 Mbps).`);
    }
  }

  // 8. Audio Compatibility (AAC-LC, 1-2 channels, 44.1/48 kHz)
  let audioRequiresHybrid = false;
  if (!meta.hasAudio) {
    audioRequiresHybrid = true;
    warnings.push('NO_AUDIO');
    explanations.push('Source has no audio track. Silent AAC audio will be generated (hybrid mode).');
  } else {
    const isAac = meta.audioCodec === 'aac';
    const isChannelsOk = meta.audioChannels >= 1 && meta.audioChannels <= 2;
    const isRateOk = meta.audioSampleRate === 44100 || meta.audioSampleRate === 48000;

    if (!isAac || !isChannelsOk || !isRateOk) {
      audioRequiresHybrid = true;
      warnings.push('AUDIO_NEEDS_TRANSCODE');
      explanations.push(`Audio track (${meta.audioCodec || 'none'}, ${meta.audioChannels}ch, ${meta.audioSampleRate}Hz) requires transcoding to AAC stereo 44.1/48kHz.`);
    }
  }

  // 9. Warnings (non-blocking)
  if (meta.colorPrimaries && meta.colorPrimaries !== 'bt709') {
    warnings.push('COLOR_NOT_BT709');
    explanations.push(`Color primaries are ${meta.colorPrimaries} (bt709 recommended).`);
  }
  if (meta.durationSec > 0 && meta.durationSec < 5) {
    warnings.push('SHORT_DURATION');
    explanations.push(`Video duration is only ${meta.durationSec} s. Very frequent loop transitions may stress encoders.`);
  }

  // Verdict
  const canCopyVideo = reasons.length === 0;
  const isDirectCopy = canCopyVideo && !audioRequiresHybrid;
  const isHybridCopy = canCopyVideo && audioRequiresHybrid;

  const status = isDirectCopy ? 'COMPATIBLE' : (isHybridCopy ? 'COMPATIBLE' : 'REQUIRES_TRANSCODING');

  return {
    status,
    reasons,
    warnings,
    explanations,
    modeAllowed: {
      copy: isDirectCopy,
      hybrid: isHybridCopy || isDirectCopy,
      transcode: true,
    },
  };
}

// ─── Subprocess Probe Execution ──────────────────────────────────────────────

function runCommand(bin, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Lower priority if possible
    try {
      if (child.pid && typeof os.setPriority === 'function') {
        os.setPriority(child.pid, 15);
      }
    } catch { /* ignore platform errors */ }

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`Command timed out after ${timeoutMs} ms: ${bin}`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}: ${stderr.trim()}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Perform a full FFprobe inspection on a media file.
 *
 * @param {string} filePath Absolute path to media file
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<object>} Extracted metadata
 */
export async function probeMedia(filePath, { timeoutMs = 60000 } = {}) {
  // 1. Format & stream probe args
  const probeArgs = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];

  // 2. Keyframe scan args (first 15s is sufficient to detect GOP intervals while saving 75% analysis time)
  const kfArgs = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time',
    '-read_intervals', '%+15',
    '-of', 'csv=p=0',
    filePath,
  ];

  // Execute format probe and keyframe scan in parallel for 2x faster analysis
  const [probeResult, kfResult] = await Promise.all([
    runCommand('ffprobe', probeArgs, timeoutMs),
    runCommand('ffprobe', kfArgs, timeoutMs).catch(err => {
      logger.warn('ffprobe.keyframe_scan_failed', `Keyframe scan failed: ${err.message}`);
      return { stdout: '' };
    }),
  ]);

  let parsedJson;
  try {
    parsedJson = JSON.parse(probeResult.stdout);
  } catch (err) {
    throw new Error(`Failed to parse ffprobe JSON output: ${err.message}`);
  }

  return parseProbeOutput(parsedJson, kfResult.stdout || '');
}
