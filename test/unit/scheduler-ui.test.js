/**
 * test/unit/scheduler-ui.test.js — Regression test for scheduler slot polling behavior.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_JS_PATH = path.resolve(__dirname, '../../public/js/dashboard.js');

describe('scheduler UI — slot persistence guard against background polling', () => {
  test('dashboard.js contains _schedSlotsInitialized and _schedSlotsDirty flags', () => {
    const code = fs.readFileSync(DASHBOARD_JS_PATH, 'utf-8');
    assert.ok(code.includes('let _schedSlotsInitialized = false;'), 'Missing _schedSlotsInitialized declaration');
    assert.ok(code.includes('let _schedSlotsDirty = false;'), 'Missing _schedSlotsDirty declaration');
  });

  test('renderScheduler protects schedSlotsContainer from being cleared during background polls', () => {
    const code = fs.readFileSync(DASHBOARD_JS_PATH, 'utf-8');
    assert.ok(code.includes('const shouldBuildSlots = !_schedSlotsInitialized || forceSlots;'), 'Missing shouldBuildSlots guard');
    assert.ok(code.includes('if (schedSlotsContainer && shouldBuildSlots && !isEditingSlot)'), 'schedSlotsContainer must be protected by shouldBuildSlots and activeElement check');
  });

  test('addNewStreamingSlot marks _schedSlotsInitialized and _schedSlotsDirty', () => {
    const code = fs.readFileSync(DASHBOARD_JS_PATH, 'utf-8');
    const addFnIdx = code.indexOf('function addNewStreamingSlot(');
    assert.ok(addFnIdx > -1, 'Missing addNewStreamingSlot function');
    const fnBody = code.slice(addFnIdx, addFnIdx + 200);
    assert.ok(fnBody.includes('_schedSlotsInitialized = true;'), 'addNewStreamingSlot must set _schedSlotsInitialized');
    assert.ok(fnBody.includes('_schedSlotsDirty = true;'), 'addNewStreamingSlot must set _schedSlotsDirty');
  });

  test('saveSchedulerSettings passes forceSlots: true to renderScheduler on success', () => {
    const code = fs.readFileSync(DASHBOARD_JS_PATH, 'utf-8');
    assert.ok(code.includes('renderScheduler(res.scheduler, { forceSlots: true, forceInputs: true });'), 'saveSchedulerSettings must pass forceSlots: true and forceInputs: true');
  });
});
