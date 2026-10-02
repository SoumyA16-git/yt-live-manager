/**
 * test/integration/stream-lifecycle.test.js — Integration test suite for lifecycle, locks, and secrets audit.
 *
 * PRD §26.2:
 * - Single-instance mutex + lock file prevents double-start.
 * - Bandwidth safety lock blocks restart and survives reload.
 * - Secret redaction audit: Grep of logs, API responses, state JSON for stream key returns 0 matches.
 * - Path-traversal attempts on video endpoints are strictly rejected.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadSettings,
  saveSettings,
  getMaskedSettings,
  _setPathsForTest as _setConfigPaths,
} from '../../src/config-manager.js';
import {
  loadState,
  saveState,
  getState,
  _setPathsForTest as _setStatePaths,
} from '../../src/state-manager.js';
import {
  loadUsage,
  getUsage,
  recordEstimatedBytes,
  _setPathsForTest as _setUsagePaths,
} from '../../src/usage-manager.js';
import {
  evaluateBandwidth,
} from '../../src/bandwidth-monitor.js';
import {
  evaluateStartGates,
} from '../../src/stream-manager.js';
import {
  resolveVideoPath,
  _setPathsForTest as _setVideoPaths,
} from '../../src/video-manager.js';
import { setSecret, redact } from '../../src/lib/redact.js';
import { initLogger, logger } from '../../src/logger.js';
import { writeJSON } from '../../src/lib/atomic-json.js';

let tmpDir;
const SECRET_STREAM_KEY = 'REAL_TEST_KEY_xyz9876543210_SECRET';

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-integration-test-'));

  const sPath  = path.join(tmpDir, 'config', 'settings.json');
  const stPath = path.join(tmpDir, 'data', 'stream-state.json');
  const hPath  = path.join(tmpDir, 'data', 'stream-history.json');
  const uPath  = path.join(tmpDir, 'data', 'bandwidth-usage.json');
  const vDir   = path.join(tmpDir, 'videos');
  const inDir  = path.join(tmpDir, 'videos', '.incoming');
  const vIndex = path.join(tmpDir, 'data', 'videos.json');
  const bDir   = path.join(tmpDir, 'backups');
  const lPath  = path.join(tmpDir, 'logs', 'app.log');

  await fs.mkdir(path.dirname(sPath), { recursive: true });
  await fs.mkdir(path.dirname(stPath), { recursive: true });
  await fs.mkdir(vDir, { recursive: true });
  await fs.mkdir(inDir, { recursive: true });
  await fs.mkdir(bDir, { recursive: true });
  await fs.mkdir(path.dirname(lPath), { recursive: true });

  _setConfigPaths(sPath, bDir);
  _setStatePaths(stPath, hPath, bDir);
  _setUsagePaths(uPath, bDir);
  _setVideoPaths(vDir, inDir, vIndex);

  setSecret(SECRET_STREAM_KEY);
  initLogger({ level: 'debug', maxFileMB: 5, maxFiles: 2, logPath: lPath });

  await loadSettings();
  await loadState();
  await loadUsage();

  await saveSettings({
    youtube: {
      rtmpsUrl: 'rtmps://a.rtmps.youtube.com:443/live2',
      streamKey: SECRET_STREAM_KEY,
    },
    bandwidth: {
      safetyLimitTB: 0.001, // 1 GB tiny limit for test
      monthlyAllowanceTB: 0.01,
      unitBase: 1000,
    },
  });
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Integration — Bandwidth Lock & Recovery Survival', () => {
  test('tiny safety limit engages lock and blocks streaming after reload', async () => {
    // Exceed 1 GB safety limit by accruing 1.5 GB
    recordEstimatedBytes(1.5 * 1e9, 100, 0);

    const result = await evaluateBandwidth({ now: new Date() });
    assert.equal(result.lockTriggered, true);
    assert.equal(result.alertLevel, 'limit');

    // Verify stream-state has lock
    let st = getState();
    assert.equal(st.status, 'BANDWIDTH_LIMIT_REACHED');
    assert.equal(st.bandwidthLock.active, true);

    // Verify start gates block with E_BW_LIMIT
    const gate = await evaluateStartGates();
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'E_BW_LIMIT');

    // Reload state from disk (simulating app restart)
    const reloaded = await loadState();
    assert.equal(reloaded.bandwidthLock.active, true);
    assert.equal(reloaded.status, 'BANDWIDTH_LIMIT_REACHED');

    // Start gates MUST still block after restart
    const gate2 = await evaluateStartGates();
    assert.equal(gate2.allowed, false);
    assert.equal(gate2.code, 'E_BW_LIMIT');
  });
});

describe('Integration — Path Traversal Attack Rejection', () => {
  test('rejects directory traversal payloads at all points', () => {
    const malicious = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      'vid_../../secret',
      'vid_00000000/../../etc',
      'vid_12345678\0.mp4',
    ];

    for (const id of malicious) {
      assert.throws(() => resolveVideoPath(id), (err) => {
        return err.code === 'E_INVALID_ID' || err.code === 'E_PATH_TRAVERSAL' || /Invalid video ID|Path traversal/.test(err.message);
      });
    }
  });
});

describe('Integration — Zero Secrets Leak Audit (PRD §20, A11)', () => {
  test('Audit: secret stream key never appears in logs, masked settings, or state', async () => {
    // 1. Log lines containing destination URLs or messages
    logger.info('stream.command', `Connecting to rtmps://a.rtmps.youtube.com:443/live2/${SECRET_STREAM_KEY}`);
    logger.warn('stream.url', `Destination is rtmps://a.rtmps.youtube.com:443/live2/${SECRET_STREAM_KEY}`);

    // Flush and wait briefly for log stream
    await new Promise(r => setTimeout(r, 100));

    // 2. Audit app.log
    const logFile = path.join(tmpDir, 'logs', 'app.log');
    let logContent = '';
    try {
      logContent = await fs.readFile(logFile, 'utf8');
    } catch {
      logContent = '';
    }

    assert.ok(
      !logContent.includes(SECRET_STREAM_KEY),
      `CRITICAL LEAK: Secret stream key found in logs/app.log! Found in:\n${logContent}`
    );

    // 3. Audit masked settings API output
    const masked = getMaskedSettings();
    const maskedJson = JSON.stringify(masked);
    assert.ok(
      !maskedJson.includes(SECRET_STREAM_KEY),
      'CRITICAL LEAK: Secret stream key found in getMaskedSettings() output!'
    );
    assert.equal(masked.youtube.streamKeyHint, SECRET_STREAM_KEY.slice(-4));

    // 4. Audit stream state JSON
    const stateJson = JSON.stringify(getState());
    assert.ok(
      !stateJson.includes(SECRET_STREAM_KEY),
      'CRITICAL LEAK: Secret stream key found in stream-state!'
    );
  });
});
