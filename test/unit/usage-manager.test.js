/**
 * test/unit/usage-manager.test.js — Unit tests for usage-manager.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  computePeriodInfo,
  loadUsage,
  getUsage,
  recordProgressBytes,
  recordEstimatedBytes,
  setManualOffsetBytes,
  setManualOciReported,
  getEffectiveUsedBytes,
  evaluatePeriodRollover,
  flushUsage,
  resetProcessBaseline,
  _setPathsForTest,
} from '../../src/usage-manager.js';

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-usage-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('usage-manager — computePeriodInfo', () => {
  test('standard UTC day 1 reset', () => {
    const d = new Date('2026-10-15T12:00:00Z');
    const { periodId } = computePeriodInfo(d, { resetDay: 1, resetHour: 0, timezone: 'UTC' });
    assert.equal(periodId, '2026-10');
  });

  test('before mid-month resetDay falls back to previous month', () => {
    const d = new Date('2026-10-14T23:59:59Z');
    const { periodId } = computePeriodInfo(d, { resetDay: 15, resetHour: 0, timezone: 'UTC' });
    assert.equal(periodId, '2026-09');
  });

  test('on or after mid-month resetDay belongs to current month', () => {
    const d = new Date('2026-10-15T00:00:00Z');
    const { periodId } = computePeriodInfo(d, { resetDay: 15, resetHour: 0, timezone: 'UTC' });
    assert.equal(periodId, '2026-10');
  });

  test('year boundary wrap around in January before resetDay', () => {
    const d = new Date('2026-01-05T00:00:00Z');
    const { periodId } = computePeriodInfo(d, { resetDay: 10, resetHour: 0, timezone: 'UTC' });
    assert.equal(periodId, '2025-12');
  });
});

describe('usage-manager — byte recording and baseline tracking', () => {
  test('tracks FFmpeg progress total_size deltas', async () => {
    const uPath = path.join(tmpDir, 'usage-progress.json');
    const bDir  = path.join(tmpDir, 'bk-progress');
    _setPathsForTest(uPath, bDir);

    await loadUsage({}, new Date('2026-10-01T00:00:00Z'));

    // First emission sets baseline
    recordProgressBytes(100_000, 1, 10);
    assert.equal(getUsage().estimatedBytes, 0);

    // Second emission adds delta (150_000 - 100_000 = 50_000) + 10% overhead (5_000)
    recordProgressBytes(150_000, 1, 10);
    assert.equal(getUsage().estimatedBytes, 50_000);
    assert.equal(getUsage().overheadBytes, 5_000);
    assert.equal(getEffectiveUsedBytes(), 55_000);

    // Baseline drop resets baseline, adds nothing
    recordProgressBytes(20_000, 1, 10);
    assert.equal(getUsage().estimatedBytes, 50_000);

    // Next emission adds from new baseline
    recordProgressBytes(40_000, 1, 10);
    assert.equal(getUsage().estimatedBytes, 70_000);
    assert.equal(getUsage().overheadBytes, 7_000);
  });

  test('fallback bitrate estimation adds directly', async () => {
    const uPath = path.join(tmpDir, 'usage-fallback.json');
    const bDir  = path.join(tmpDir, 'bk-fallback');
    _setPathsForTest(uPath, bDir);

    await loadUsage({}, new Date('2026-10-01T00:00:00Z'));
    recordEstimatedBytes(10_000, 5, 10);

    const u = getUsage();
    assert.equal(u.estimatedBytes, 10_000);
    assert.equal(u.overheadBytes, 1_000);
    assert.equal(u.streamingSeconds, 5);
  });

  test('manual offset adjust adjusts effective bytes', async () => {
    const uPath = path.join(tmpDir, 'usage-offset.json');
    const bDir  = path.join(tmpDir, 'bk-offset');
    _setPathsForTest(uPath, bDir);

    await loadUsage({}, new Date('2026-10-01T00:00:00Z'));
    recordEstimatedBytes(100_000, 10, 10);
    // Base: 100k + 10k overhead = 110k
    assert.equal(getEffectiveUsedBytes(), 110_000);

    setManualOffsetBytes(15_000);
    assert.equal(getEffectiveUsedBytes(), 125_000);

    setManualOffsetBytes(-20_000);
    assert.equal(getEffectiveUsedBytes(), 90_000);
  });
});

describe('usage-manager — period rollover and clock guards', () => {
  test('rolls over when month changes and archives previous period', async () => {
    const uPath = path.join(tmpDir, 'usage-rollover.json');
    const bDir  = path.join(tmpDir, 'bk-rollover');
    _setPathsForTest(uPath, bDir);

    await loadUsage({}, new Date('2026-10-01T00:00:00Z'));
    recordEstimatedBytes(500_000, 100, 10);

    // Same period — no rollover
    const r1 = await evaluatePeriodRollover({}, new Date('2026-10-15T00:00:00Z'));
    assert.equal(r1.rolledOver, false);
    assert.equal(getUsage().periodId, '2026-10');

    // Next month — rollover triggers!
    const r2 = await evaluatePeriodRollover({}, new Date('2026-11-01T00:00:00Z'));
    assert.equal(r2.rolledOver, true);
    assert.equal(r2.oldPeriodId, '2026-10');
    assert.equal(r2.newPeriodId, '2026-11');

    const u = getUsage();
    assert.equal(u.periodId, '2026-11');
    assert.equal(u.estimatedBytes, 0);
    assert.equal(u.history.length, 1);
    assert.equal(u.history[0].periodId, '2026-10');
    assert.equal(u.history[0].estimatedBytes, 500_000);
  });

  test('monotonic guard prevents backward clock jump from rolling over', async () => {
    const uPath = path.join(tmpDir, 'usage-monotonic.json');
    const bDir  = path.join(tmpDir, 'bk-monotonic');
    _setPathsForTest(uPath, bDir);

    await loadUsage({}, new Date('2026-10-01T00:00:00Z'));
    recordEstimatedBytes(200_000, 50, 10);

    // Clock set backwards to September
    const r = await evaluatePeriodRollover({}, new Date('2026-09-15T00:00:00Z'));
    assert.equal(r.rolledOver, false);
    assert.equal(getUsage().periodId, '2026-10');
    assert.equal(getUsage().estimatedBytes, 200_000);
  });

  test('clock sanity check flags backward jump > 1h', async () => {
    const uPath = path.join(tmpDir, 'usage-sanity.json');
    const bDir  = path.join(tmpDir, 'bk-sanity');
    _setPathsForTest(uPath, bDir);

    await loadUsage({}, new Date('2026-10-01T12:00:00Z'));
    const lastSeenAt = new Date('2026-10-01T12:00:00Z').toISOString();

    // 2 hours behind lastSeenAt
    const badTime = new Date('2026-10-01T10:00:00Z');
    const r = await evaluatePeriodRollover({}, badTime, lastSeenAt);
    assert.equal(r.clockError, true);
    assert.equal(r.rolledOver, false);
  });
});
