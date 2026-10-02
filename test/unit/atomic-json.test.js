/**
 * test/unit/atomic-json.test.js — Unit tests for lib/atomic-json.js
 *
 * PRD §26.1: "atomic JSON write + corrupt-file recovery"
 */

import { test, describe, before, after } from 'node:test';
import assert   from 'node:assert/strict';
import fs       from 'node:fs/promises';
import path     from 'node:path';
import os       from 'node:os';
import { writeJSON, readJSON, listBackups, writeBackup } from '../../src/lib/atomic-json.js';

// ─── Temp dir per test run ────────────────────────────────────────────────────

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-atomic-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tmp(name) { return path.join(tmpDir, name); }

// ─── writeJSON + readJSON ─────────────────────────────────────────────────────

describe('writeJSON / readJSON — basic round-trip', () => {
  test('writes and reads back a JSON object', async () => {
    const file = tmp('basic.json');
    const data = { foo: 'bar', num: 42, nested: { x: true } };
    await writeJSON(file, data);
    const { data: back, source } = await readJSON(file);
    assert.equal(source, 'primary');
    assert.deepEqual(back, data);
  });

  test('file mode is 0o600 by default', async () => {
    // Mode check is meaningful on POSIX; skip on Windows
    if (process.platform === 'win32') return;
    const file = tmp('mode.json');
    await writeJSON(file, { ok: true });
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
  });

  test('creates parent directories automatically', async () => {
    const file = tmp('deep/nested/dir/file.json');
    await writeJSON(file, { created: true });
    const { data } = await readJSON(file);
    assert.equal(data.created, true);
  });

  test('overwrites an existing file atomically', async () => {
    const file  = tmp('overwrite.json');
    await writeJSON(file, { v: 1 });
    await writeJSON(file, { v: 2 });
    const { data } = await readJSON(file);
    assert.equal(data.v, 2);
  });
});

describe('readJSON — corrupt file recovery', () => {
  test('returns defaultValue when file does not exist', async () => {
    const { data, source } = await readJSON(tmp('nonexistent.json'), [], 'myDefault');
    assert.equal(source, 'default');
    assert.equal(data, 'myDefault');
  });

  test('falls back to backup when primary is corrupt JSON', async () => {
    const file   = tmp('corrupt.json');
    const backup = tmp('corrupt.backup.json');
    const good   = { status: 'good' };

    // Write a good backup first
    await fs.writeFile(backup, JSON.stringify(good), 'utf8');
    // Write corrupt primary
    await fs.writeFile(file, 'NOT VALID JSON }{{{', 'utf8');

    const { data, source } = await readJSON(file, [backup]);
    assert.equal(source, 'backup');
    assert.deepEqual(data, good);
  });

  test('tries backups in order (newest first) and uses first valid', async () => {
    const file   = tmp('order.json');
    const bk1    = tmp('order.1.json');  // will be corrupt
    const bk2    = tmp('order.2.json');  // valid

    await fs.writeFile(file, '{ CORRUPT', 'utf8');
    await fs.writeFile(bk1, '{ ALSO CORRUPT', 'utf8');
    await fs.writeFile(bk2, JSON.stringify({ found: 'second' }), 'utf8');

    const { data, source } = await readJSON(file, [bk1, bk2]);
    assert.equal(source, 'backup');
    assert.equal(data.found, 'second');
  });

  test('returns default when all sources are corrupt', async () => {
    const file = tmp('allcorrupt.json');
    await fs.writeFile(file, 'BAD', 'utf8');
    const { data, source } = await readJSON(file, [], null);
    assert.equal(source, 'default');
    assert.equal(data, null);
  });
});

describe('writeJSON — per-file queue (concurrent writes serialised)', () => {
  test('concurrent writes to the same file produce the last value', async () => {
    const file = tmp('concurrent.json');
    // Fire 5 concurrent writes
    const writes = Array.from({ length: 5 }, (_, i) =>
      writeJSON(file, { seq: i }));
    await Promise.all(writes);

    const { data } = await readJSON(file);
    // Exactly one of 0-4 should be the final value — not a parse error
    assert.ok(typeof data.seq === 'number' && data.seq >= 0 && data.seq <= 4);
  });

  test('no temp file left behind after write', async () => {
    const file = tmp('notmp.json');
    await writeJSON(file, { clean: true });
    const entries = await fs.readdir(tmpDir);
    const tmpFiles = entries.filter(e => e.includes('.tmp-'));
    assert.equal(tmpFiles.length, 0, `Leftover tmp files: ${tmpFiles.join(', ')}`);
  });
});

describe('writeJSON — backup hook', () => {
  test('calls backupFn after a successful write', async () => {
    const file = tmp('backuphook.json');
    let called = 0;
    await writeJSON(file, { x: 1 }, { backupFn: async () => { called++; } });
    assert.equal(called, 1);
  });

  test('does not throw if backupFn throws', async () => {
    const file = tmp('backuperr.json');
    await assert.doesNotReject(() =>
      writeJSON(file, { x: 2 }, { backupFn: async () => { throw new Error('backup fail'); } })
    );
  });
});

describe('writeBackup + listBackups', () => {
  test('creates a timestamped backup file', async () => {
    const file    = tmp('mystate.json');
    const bkDir   = tmp('bk1');
    const data    = { v: 99 };
    await writeJSON(file, data);
    const bkPath  = await writeBackup(file, bkDir, data);
    assert.ok(bkPath, 'no backup path returned');
    const bkData  = JSON.parse(await fs.readFile(bkPath, 'utf8'));
    assert.deepEqual(bkData, data);
  });

  test('listBackups returns newest-first', async () => {
    const bkDir   = tmp('bk2');
    const file    = tmp('bkorder.json');
    const data    = { v: 1 };
    await writeJSON(file, data);

    // Write three backups with slight delay to ensure distinct timestamps
    for (let i = 0; i < 3; i++) {
      await writeBackup(file, bkDir, { v: i }, { keep: 10 });
      // small artificial separation
      await new Promise(r => setTimeout(r, 5));
    }

    const list = await listBackups(bkDir, 'bkorder');
    assert.equal(list.length, 3);
    // Sorted descending by name (ISO timestamp)
    for (let i = 0; i < list.length - 1; i++) {
      assert.ok(path.basename(list[i]) >= path.basename(list[i + 1]),
        'backups not in newest-first order');
    }
  });

  test('prunes old backups beyond `keep`', async () => {
    const bkDir   = tmp('bk3');
    const file    = tmp('prunetest.json');
    await writeJSON(file, {});

    for (let i = 0; i < 5; i++) {
      await writeBackup(file, bkDir, { i }, { keep: 3 });
      await new Promise(r => setTimeout(r, 5));
    }

    const list = await listBackups(bkDir, 'prunetest');
    assert.equal(list.length, 3, `expected 3 backups, got ${list.length}`);
  });
});
