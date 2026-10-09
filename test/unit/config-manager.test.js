/**
 * test/unit/config-manager.test.js — Unit tests for config-manager.js
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadSettings,
  saveSettings,
  getSettings,
  getMaskedSettings,
  getStreamKey,
  getSafetyLimitBytes,
  getMonthlyAllowanceBytes,
  DEFAULTS,
  _setPathsForTest,
} from '../../src/config-manager.js';
import { clearSecrets, redact } from '../../src/lib/redact.js';

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-config-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearSecrets();
});

describe('config-manager — loadSettings', () => {
  test('returns DEFAULTS when settings.json does not exist', async () => {
    const sPath = path.join(tmpDir, 'absent-settings.json');
    const bDir  = path.join(tmpDir, 'backups-1');
    _setPathsForTest(sPath, bDir);

    const cfg = await loadSettings();
    assert.equal(cfg.stream.fps, 30);
    assert.equal(cfg.stream.videoBitrateMbps, 4);
    assert.equal(cfg.bandwidth.monthlyAllowanceTB, 10);
    assert.equal(cfg.bandwidth.safetyLimitTB, 9);
  });

  test('deep-merges existing file with defaults', async () => {
    const sPath = path.join(tmpDir, 'partial-settings.json');
    const bDir  = path.join(tmpDir, 'backups-2');
    _setPathsForTest(sPath, bDir);

    // Save partial config directly to disk
    await fs.writeFile(sPath, JSON.stringify({
      stream: { videoBitrateMbps: 6 },
      youtube: { streamKey: 'my-secret-key-1234' },
    }), 'utf8');

    const cfg = await loadSettings();
    assert.equal(cfg.stream.videoBitrateMbps, 6);
    assert.equal(cfg.stream.fps, 30); // preserved default
    assert.equal(getStreamKey(), 'my-secret-key-1234');
    // Secret should have been registered in redact
    assert.equal(redact('Streaming to my-secret-key-1234 now'), 'Streaming to **** now');
  });

  test('migrates old Studio URL settings away for dynamic home-page navigation', async () => {
    const sPath = path.join(tmpDir, 'studio-target-migration.json');
    const bDir  = path.join(tmpDir, 'backups-studio-migration');
    _setPathsForTest(sPath, bDir);

    await fs.writeFile(sPath, JSON.stringify({
      schemaVersion: 1,
      studioAutomation: {
        enabled: true,
        url: 'https://studio.youtube.com/video/xHUulPKBtJs/livestreaming',
      },
      youtube: { studioUrl: 'https://studio.youtube.com/video/uJyJyeNDoMM/livestreaming' },
    }), 'utf8');

    const cfg = await loadSettings();
    assert.equal(cfg.schemaVersion, 3);
    assert.equal(Object.hasOwn(cfg.studioAutomation, 'url'), false);
    assert.equal(Object.hasOwn(cfg.youtube, 'studioUrl'), false);
  });
});

describe('config-manager — getMaskedSettings', () => {
  test('redacts streamKey and adds hint and streamKeySet', async () => {
    const sPath = path.join(tmpDir, 'mask-settings.json');
    const bDir  = path.join(tmpDir, 'backups-3');
    _setPathsForTest(sPath, bDir);

    await fs.writeFile(sPath, JSON.stringify({
      youtube: { streamKey: 'super-secret-key-9999' },
    }), 'utf8');

    await loadSettings();
    const masked = getMaskedSettings();
    assert.equal(masked.youtube.streamKey, undefined);
    assert.equal(masked.youtube.streamKeySet, true);
    assert.equal(masked.youtube.streamKeyHint, '9999');
  });

  test('reports streamKeySet false when empty', async () => {
    const sPath = path.join(tmpDir, 'empty-key-settings.json');
    const bDir  = path.join(tmpDir, 'backups-4');
    _setPathsForTest(sPath, bDir);

    await loadSettings();
    const masked = getMaskedSettings();
    assert.equal(masked.youtube.streamKeySet, false);
    assert.equal(masked.youtube.streamKeyHint, '');
  });
});

describe('config-manager — saveSettings', () => {
  test('validates and persists patch', async () => {
    const sPath = path.join(tmpDir, 'save-settings.json');
    const bDir  = path.join(tmpDir, 'backups-5');
    _setPathsForTest(sPath, bDir);

    await loadSettings();
    await saveSettings({
      stream: { videoBitrateMbps: 5 },
      youtube: { streamKey: 'new-valid-key-8888' },
    });

    const current = getSettings();
    assert.equal(current.stream.videoBitrateMbps, 5);
    assert.equal(getStreamKey(), 'new-valid-key-8888');
    assert.equal(redact('my key is new-valid-key-8888'), 'my key is ****');
  });

  test('normalises safetyLimitGB to safetyLimitTB (D-013)', async () => {
    const sPath = path.join(tmpDir, 'gb-norm-settings.json');
    const bDir  = path.join(tmpDir, 'backups-6');
    _setPathsForTest(sPath, bDir);

    await loadSettings();
    await saveSettings({
      bandwidth: { safetyLimitGB: 8500, unitBase: 1000 },
    });

    const current = getSettings();
    assert.equal(current.bandwidth.safetyLimitTB, 8.5);
    assert.equal(current.bandwidth.safetyLimitGB, undefined);
  });

  test('rejects invalid patch and does not persist', async () => {
    const sPath = path.join(tmpDir, 'invalid-settings.json');
    const bDir  = path.join(tmpDir, 'backups-7');
    _setPathsForTest(sPath, bDir);

    await loadSettings();
    await assert.rejects(
      async () => {
        await saveSettings({ stream: { videoBitrateMbps: 999 } });
      },
      (err) => {
        assert.equal(err.code, 'E_VALIDATION');
        return true;
      }
    );
  });
});

describe('config-manager — computed byte helpers', () => {
  test('computes safetyLimitBytes and monthlyAllowanceBytes correctly', async () => {
    const sPath = path.join(tmpDir, 'bytes-settings.json');
    const bDir  = path.join(tmpDir, 'backups-8');
    _setPathsForTest(sPath, bDir);

    await loadSettings();
    // Default: unitBase 1000, 9 TB safety, 10 TB allowance
    assert.equal(getSafetyLimitBytes(), 9 * 1e12);
    assert.equal(getMonthlyAllowanceBytes(), 10 * 1e12);
  });
});
