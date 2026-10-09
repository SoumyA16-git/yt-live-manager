import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function getFormattedDateTime(timeZone = 'Asia/Kolkata', mockDate = new Date()) {
  const dFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const tFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  const dateStr = dFormatter.format(mockDate).replace(/\//g, '-');
  const timeStr = tFormatter.format(mockDate).replace(/[\u202f\xa0]/g, ' ');
  return { dateStr, timeStr, full: `${dateStr} ${timeStr}` };
}

function cleanBaseTitle(title) {
  if (!title) return '';
  let str = title.trim();

  for (let pass = 0; pass < 3; pass++) {
    const prev = str;
    str = str
      .replace(/[\s\-_|•:]*(\d{1,4}[-/]\d{1,2}[-/]\d{2,4})([\s\u202f,]+(\d{1,2}:\d{2}(:\d{2})?([\s\u202f]*(AM|PM|am|pm))?))?[\s\-_|•:]*$/i, '')
      .replace(/[\s\-_|•:]*(\d{1,2}:\d{2}(:\d{2})?([\s\u202f]*(AM|PM|am|pm))?)[\s\-_|•:]*$/i, '')
      .replace(/[\s\-_|•:]*(\d{1,4}[-/]\d{1,2}[-/]\d{2,4})[\s\-_|•:]*$/i, '')
      .trim();
    if (str === prev) break;
  }

  return str.trim();
}

function constructFinalTitle(base, dateTimeFull) {
  let cleaned = cleanBaseTitle(base) || 'Live Stream';
  const dateSuffix = ` ${dateTimeFull}`;
  const maxBaseLen = Math.max(10, 100 - dateSuffix.length);
  if (cleaned.length > maxBaseLen) {
    cleaned = cleaned.substring(0, maxBaseLen).trim();
  }
  return `${cleaned}${dateSuffix}`.trim().slice(0, 100);
}

describe('YouTube Studio Title Cleaning and Formatting', () => {
  test('strips single date and 12-hour AM/PM time with space', () => {
    const input = 'Chinese Street Food Live Streaming Mochi 09-10-2026 07:15 PM';
    assert.equal(cleanBaseTitle(input), 'Chinese Street Food Live Streaming Mochi');
  });

  test('strips date and time with narrow no-break space (\\u202f)', () => {
    const input = 'Chinese Street Food Live Streaming Mochi 09-10-2026 07:15\u202fPM';
    assert.equal(cleanBaseTitle(input), 'Chinese Street Food Live Streaming Mochi');
  });

  test('strips date and time with seconds', () => {
    const input = '24/7 Lo-Fi Chill Beats 09-10-2026 07:15:30 PM';
    assert.equal(cleanBaseTitle(input), '24/7 Lo-Fi Chill Beats');
  });

  test('strips 24-hour time format', () => {
    const input = 'Gaming Live Stream 09-10-2026 19:45';
    assert.equal(cleanBaseTitle(input), 'Gaming Live Stream');
  });

  test('strips slashes in date format (DD/MM/YYYY)', () => {
    const input = 'Live Stream 09/10/2026 07:15 PM';
    assert.equal(cleanBaseTitle(input), 'Live Stream');
  });

  test('strips ISO date format (YYYY-MM-DD)', () => {
    const input = 'Live Stream 2026-10-09 07:15 PM';
    assert.equal(cleanBaseTitle(input), 'Live Stream');
  });

  test('strips pipe delimiter before date and time', () => {
    const input = 'My Live Channel | 09-10-2026 07:15 PM';
    assert.equal(cleanBaseTitle(input), 'My Live Channel');
  });

  test('strips dash delimiter before date and time', () => {
    const input = 'My Live Channel - 09-10-2026 07:15 PM';
    assert.equal(cleanBaseTitle(input), 'My Live Channel');
  });

  test('strips multiple accumulated dates from failed previous sessions', () => {
    const accumulated = 'Street Food 07-10-2026 05:00 PM 08-10-2026 06:30 AM 09-10-2026 07:15 PM';
    assert.equal(cleanBaseTitle(accumulated), 'Street Food');
  });

  test('preserves title when no date/time is present', () => {
    const input = 'Relaxing Sleep Music 4K';
    assert.equal(cleanBaseTitle(input), 'Relaxing Sleep Music 4K');
  });

  test('constructFinalTitle strictly enforces 100 character maximum', () => {
    const longBase = 'This is an extremely long title that exceeds YouTube limits when date and time are appended to it completely';
    const dt = getFormattedDateTime('Asia/Kolkata');
    const finalTitle = constructFinalTitle(longBase, dt.full);

    assert.ok(finalTitle.length <= 100, `Title length must be <= 100, got ${finalTitle.length}`);
    assert.ok(finalTitle.endsWith(dt.full), `Title must end with date/time "${dt.full}"`);
  });

  test('getFormattedDateTime returns clean time without non-breaking spaces', () => {
    const dt = getFormattedDateTime('Asia/Kolkata');
    assert.ok(!dt.timeStr.includes('\u202f'), 'timeStr must not contain narrow no-break space');
    assert.ok(!dt.full.includes('\u202f'), 'full must not contain narrow no-break space');
    assert.match(dt.dateStr, /^\d{2}-\d{2}-\d{4}$/, 'dateStr must match DD-MM-YYYY');
  });
});
