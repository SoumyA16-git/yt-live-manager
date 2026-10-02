/**
 * test/unit/bandwidth-monitor.test.js — Unit tests for bandwidth-monitor.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  evaluateBandwidth,
  computeBandwidthForecast,
  getAlertLevelName,
  getBandwidthSummary,
} from '../../src/bandwidth-monitor.js';
import {
  loadUsage,
  recordEstimatedBytes,
  _setPathsForTest as _setUsagePaths,
} from '../../src/usage-manager.js';
import {
  loadSettings,
  saveSettings,
  _setPathsForTest as _setConfigPaths,
} from '../../src/config-manager.js';
import {
  loadState,
  getState,
  _setPathsForTest as _setStatePaths,
} from '../../src/state-manager.js';

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-bw-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('bandwidth-monitor — alert levels', () => {
  test('returns correct alert level name based on percentage', () => {
    assert.equal(getAlertLevelName(50), 'normal');
    assert.equal(getAlertLevelName(69.9), 'normal');
    assert.equal(getAlertLevelName(70), 'warning');
    assert.equal(getAlertLevelName(79.9), 'warning');
    assert.equal(getAlertLevelName(80), 'warning-strong');
    assert.equal(getAlertLevelName(89.9), 'warning-strong');
    assert.equal(getAlertLevelName(90), 'critical');
    assert.equal(getAlertLevelName(94.9), 'critical');
    assert.equal(getAlertLevelName(95), 'critical-protection');
    assert.equal(getAlertLevelName(99.9), 'critical-protection');
    assert.equal(getAlertLevelName(100), 'limit');
    assert.equal(getAlertLevelName(105), 'limit');
  });
});

describe('bandwidth-monitor — evaluation & safety lock', () => {
  test('evaluates usage, flags thresholds, and triggers safety lock at 100%', async () => {
    const sPath = path.join(tmpDir, 'cfg-settings.json');
    const uPath = path.join(tmpDir, 'usage-bw.json');
    const stPath = path.join(tmpDir, 'state-bw.json');
    const hPath  = path.join(tmpDir, 'hist-bw.json');
    const bDir   = path.join(tmpDir, 'backups-bw');

    _setConfigPaths(sPath, bDir);
    _setUsagePaths(uPath, bDir);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    // Configure safety limit: 100 GB (0.1 TB) for fast test numbers
    await saveSettings({
      bandwidth: {
        safetyLimitTB: 0.1,
        monthlyAllowanceTB: 0.2,
        unitBase: 1000,
        warningThresholds: [70, 80, 90, 95],
      },
    });

    await loadUsage({}, new Date('2026-10-01T00:00:00Z'));
    await loadState();

    // 100 GB safety limit = 100 * 1e9 = 100,000,000,000 bytes
    // Accrue 75 GB -> 75% -> triggers 70% warning threshold
    const bytes75GB = 75 * 1e9;
    recordEstimatedBytes(bytes75GB, 3600, 0);

    const r1 = await evaluateBandwidth({ now: new Date('2026-10-02T00:00:00Z') });
    assert.equal(r1.alertLevel, 'warning');
    assert.equal(r1.pctOfSafety, 75);
    assert.equal(r1.lockTriggered, false);

    // Accrue another 30 GB -> total 105 GB (105% of safety limit)
    let callbackCalled = false;
    recordEstimatedBytes(30 * 1e9, 1800, 0);

    const r2 = await evaluateBandwidth({
      now: new Date('2026-10-02T12:00:00Z'),
      onLimitReached: async (info) => {
        callbackCalled = true;
        assert.equal(info.periodId, '2026-10');
      },
    });

    assert.equal(r2.lockTriggered, true);
    assert.equal(r2.alertLevel, 'limit');
    assert.ok(r2.pctOfSafety >= 100);
    assert.equal(callbackCalled, true);

    // Verify stream-state was updated to BANDWIDTH_LIMIT_REACHED
    const st = getState();
    assert.equal(st.status, 'BANDWIDTH_LIMIT_REACHED');
    assert.equal(st.desiredState, 'stopped');
    assert.equal(st.bandwidthLock.active, true);
    assert.equal(st.bandwidthLock.periodId, '2026-10');
  });
});

describe('bandwidth-monitor — forecasting', () => {
  test('computes projected usage and remaining safe hours', async () => {
    const sPath = path.join(tmpDir, 'cfg-forecast.json');
    const uPath = path.join(tmpDir, 'usage-forecast.json');
    const stPath = path.join(tmpDir, 'state-forecast.json');
    const hPath  = path.join(tmpDir, 'hist-forecast.json');
    const bDir   = path.join(tmpDir, 'backups-forecast');

    _setConfigPaths(sPath, bDir);
    _setUsagePaths(uPath, bDir);
    _setStatePaths(stPath, hPath, bDir);

    await loadSettings();
    await loadUsage({}, new Date('2026-10-01T00:00:00Z'));
    await loadState();

    // Default settings: 8 Mbps, 9 TB safety limit
    // 5 days into period, 500 GB used
    recordEstimatedBytes(500 * 1e9, 5000, 0);
    const now = new Date('2026-10-06T00:00:00Z');

    const forecast = computeBandwidthForecast(now);
    assert.ok(forecast.remainingSafeGB > 0);
    assert.ok(forecast.remainingSafeHours > 0);
    assert.ok(forecast.remainingSafeDays > 0);
    assert.ok(forecast.summarySentence.includes('estimated safe remaining streaming time'));
  });
});
