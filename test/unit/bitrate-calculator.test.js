/**
 * test/unit/bitrate-calculator.test.js — Verification against PRD §6.3 reference table.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  totalMbps,
  bytesPerSecond,
  gbPerHour,
  gbPerDay,
  gbPer30Days,
  tbPer30Days,
  withOverhead,
  calculateBitrateMetrics,
  formatBytes,
} from '../../src/bitrate-calculator.js';

describe('bitrate-calculator — §6.3 Reference Table Verification', () => {
  test('6 Mbps video + 128 kbps audio', () => {
    const m = calculateBitrateMetrics({
      videoBitrateMbps: 6,
      audioBitrateKbps: 128,
      overheadPercent: 10,
      unitBase: 1000,
    });

    assert.equal(m.totalMbps.toFixed(3), '6.128');
    assert.equal(m.payload.gbPerHour.toFixed(3), '2.758');
    assert.equal(m.payload.gbPerDay.toFixed(2), '66.18');
    assert.equal(Math.round(m.payload.gbPer30Days), 1985);
    assert.equal(m.payload.tbPer30Days.toFixed(3), '1.985');
    assert.equal(m.withOverhead.tbPer30Days.toFixed(3), '2.184');
  });

  test('8 Mbps video + 128 kbps audio (PRD Default)', () => {
    const m = calculateBitrateMetrics({
      videoBitrateMbps: 8,
      audioBitrateKbps: 128,
      overheadPercent: 10,
      unitBase: 1000,
    });

    assert.equal(m.totalMbps.toFixed(3), '8.128');
    assert.equal(m.payload.gbPerHour.toFixed(3), '3.658');
    assert.equal(m.payload.gbPerDay.toFixed(2), '87.78');
    assert.equal(Math.round(m.payload.gbPer30Days), 2633);
    assert.equal(m.payload.tbPer30Days.toFixed(3), '2.633');
    assert.equal(m.withOverhead.tbPer30Days.toFixed(3), '2.897');
  });

  test('10 Mbps video + 128 kbps audio', () => {
    const m = calculateBitrateMetrics({
      videoBitrateMbps: 10,
      audioBitrateKbps: 128,
      overheadPercent: 10,
      unitBase: 1000,
    });

    assert.equal(m.totalMbps.toFixed(3), '10.128');
    assert.equal(m.payload.gbPerHour.toFixed(3), '4.558');
    assert.equal(m.payload.gbPerDay.toFixed(2), '109.38');
    assert.equal(Math.round(m.payload.gbPer30Days), 3281);
    assert.equal(m.payload.tbPer30Days.toFixed(3), '3.281');
    assert.equal(m.withOverhead.tbPer30Days.toFixed(3), '3.610');
  });
});

describe('bitrate-calculator — unitBase variations (1000 vs 1024)', () => {
  test('unitBase = 1024 produces GiB/TiB scaling', () => {
    const m1000 = calculateBitrateMetrics({ videoBitrateMbps: 8, unitBase: 1000 });
    const m1024 = calculateBitrateMetrics({ videoBitrateMbps: 8, unitBase: 1024 });

    assert.equal(m1000.payload.tbPer30Days, m1000.payload.gbPer30Days / 1000);
    assert.equal(m1024.payload.tbPer30Days, m1024.payload.gbPer30Days / 1024);
  });
});

describe('bitrate-calculator — formatBytes', () => {
  test('formats bytes with correct units and decimals', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(500), '500.00 B');
    assert.equal(formatBytes(1.5 * 1e9, 1000), '1.50 GB');
    assert.equal(formatBytes(2.5 * 1e12, 1000), '2.50 TB');
    assert.equal(formatBytes(2 * Math.pow(1024, 4), 1024), '2.00 TiB');
  });
});
