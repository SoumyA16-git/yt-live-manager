/**
 * test/unit/scheduler.test.js — Unit tests for scheduler.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLocalTimeInZone,
  isInsideWindow,
} from '../../src/scheduler.js';

describe('scheduler — getLocalTimeInZone', () => {
  test('accurately extracts day of week and minutes in Asia/Kolkata (+5:30)', () => {
    // 2026-10-02T00:00:00Z is 05:30 AM in Asia/Kolkata (Friday)
    const d = new Date('2026-10-02T00:00:00Z');
    const local = getLocalTimeInZone(d, 'Asia/Kolkata');
    assert.equal(local.dayOfWeek, 'fri');
    assert.equal(local.hour, 5);
    assert.equal(local.minute, 30);
    assert.equal(local.minutes, 5 * 60 + 30);
  });
});

describe('scheduler — isInsideWindow', () => {
  const normalWindow = [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', stop: '17:00' },
  ];

  test('normal intraday window', () => {
    // Monday at 12:00 UTC (12:00 in UTC timezone)
    const inTime = new Date('2026-10-05T12:00:00Z'); // 2026-10-05 is Monday
    assert.equal(isInsideWindow(inTime, normalWindow, 'UTC'), true);

    // Monday before start at 08:30 UTC
    const beforeTime = new Date('2026-10-05T08:30:00Z');
    assert.equal(isInsideWindow(beforeTime, normalWindow, 'UTC'), false);

    // Monday after stop at 17:30 UTC
    const afterTime = new Date('2026-10-05T17:30:00Z');
    assert.equal(isInsideWindow(afterTime, normalWindow, 'UTC'), false);

    // Saturday at 12:00 UTC (day not in days array)
    const weekendTime = new Date('2026-10-10T12:00:00Z'); // Saturday
    assert.equal(isInsideWindow(weekendTime, normalWindow, 'UTC'), false);
  });

  const overnightWindow = [
    { days: ['mon'], start: '22:00', stop: '04:00' },
  ];

  test('overnight window across midnight boundary', () => {
    // Monday at 23:00 UTC (same day after start)
    const monNight = new Date('2026-10-05T23:00:00Z');
    assert.equal(isInsideWindow(monNight, overnightWindow, 'UTC'), true);

    // Tuesday at 02:00 UTC (next day morning before stop)
    const tueMorning = new Date('2026-10-06T02:00:00Z');
    assert.equal(isInsideWindow(tueMorning, overnightWindow, 'UTC'), true);

    // Tuesday at 05:00 UTC (next day after stop)
    const tueAfter = new Date('2026-10-06T05:00:00Z');
    assert.equal(isInsideWindow(tueAfter, overnightWindow, 'UTC'), false);

    // Wednesday at 02:00 UTC (not following a scheduled start day)
    const wedMorning = new Date('2026-10-07T02:00:00Z');
    assert.equal(isInsideWindow(wedMorning, overnightWindow, 'UTC'), false);
  });
});
