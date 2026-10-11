#!/usr/bin/env node
/**
 * Reconcile settings and video display metadata with the pre-update snapshot.
 * Run after migrations and before starting the service:
 *   node scripts/restore-update-state.js /path/to/backups/update-<timestamp>.tar.gz
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJSON, writeJSON } from '../src/lib/atomic-json.js';
import { migrateSettings } from '../src/config-manager.js';
import PATHS from '../src/lib/paths.js';

const execFileAsync = promisify(execFile);
const archivePath = process.argv[2];

function isVideosIndex(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.videos));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
}

function hasUsefulTitle(value) {
  if (typeof value !== 'string' || value.trim() === '' || /^title unavailable$/i.test(value.trim())) return false;
  if (/^vid_[0-9a-f]{8}(?:\.[a-z0-9]+)?$/i.test(value.trim())) return false;
  return true;
}

async function readArchiveJson(member, members, validator) {
  const backupPrefix = member === 'config/settings.json'
    ? 'backups/settings.'
    : member === 'data/videos.json' ? 'backups/videos.' : null;
  const backups = backupPrefix
    ? [...members].filter(name => name.startsWith(backupPrefix) && name.endsWith('.json')).sort().reverse()
    : [];
  const candidates = [member, ...backups].filter(name => members.has(name));
  if (candidates.length === 0) return null;

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync('tar', ['-xOzf', archivePath, candidate], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      const value = JSON.parse(stdout);
      if (!validator || validator(value)) return value;
      lastError = new Error(`${candidate} has an invalid data structure`);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No valid ${member} was found in the pre-update archive${lastError ? `: ${lastError.message}` : ''}`);
}

async function restoreSettings(members) {
  const archived = await readArchiveJson('config/settings.json', members, isPlainObject);
  if (archived === null) {
    console.log('[STATE] No pre-update settings.json in archive; leaving settings untouched.');
    return;
  }

  const expected = migrateSettings(archived);
  const current = await readJSON(PATHS.settings, [], null);
  if (JSON.stringify(stableJson(current.data)) !== JSON.stringify(stableJson(expected))) {
    await writeJSON(PATHS.settings, expected, { mode: 0o600 });
    console.log('[STATE] Restored pre-update settings and applied schema-only migration.');
  } else {
    console.log('[STATE] Settings match the pre-update snapshot.');
  }
}

async function restoreVideoTitles(members) {
  const archived = await readArchiveJson('data/videos.json', members, isVideosIndex);
  if (archived === null) {
    console.log('[STATE] No pre-update videos.json in archive; leaving video catalog untouched.');
    return;
  }
  const currentRead = await readJSON(PATHS.videosIndex, [], null);
  const currentIsValid = isVideosIndex(currentRead.data);
  if (!currentIsValid && currentRead.source !== 'default') {
    console.log('[STATE] Current video catalog is unreadable; restoring the archived catalog.');
  }

  const current = currentIsValid
    ? currentRead.data
    : { schemaVersion: archived.schemaVersion ?? 1, videos: [] };
  const merged = new Map(current.videos.map(video => [video.id, { ...video }]));
  const titleFields = ['sourceTitle', 'label', 'originalName', 'videoTitle', 'title'];
  let changed = !currentIsValid;

  for (const prior of archived.videos) {
    if (!prior || typeof prior.id !== 'string') continue;
    const present = merged.get(prior.id);
    if (!present) {
      merged.set(prior.id, { ...prior });
      changed = true;
      continue;
    }

    for (const field of titleFields) {
      const oldValue = prior[field];
      if (!hasUsefulTitle(oldValue)) continue;
      if (present[field] !== oldValue) {
        present[field] = oldValue;
        changed = true;
      }
    }
  }

  if (!changed) {
    console.log('[STATE] Video titles match the pre-update snapshot.');
    return;
  }

  const output = {
    ...current,
    schemaVersion: current.schemaVersion ?? archived.schemaVersion ?? 1,
    updatedAt: new Date().toISOString(),
    videos: [...merged.values()],
  };
  await fs.mkdir(path.dirname(PATHS.videosIndex), { recursive: true });
  await writeJSON(PATHS.videosIndex, output, { mode: 0o600 });
  console.log(`[STATE] Reconciled ${archived.videos.length} pre-update video record(s); preserved display titles.`);
}

async function main() {
  if (!archivePath) throw new Error('Usage: node scripts/restore-update-state.js <pre-update-archive.tar.gz>');
  const resolvedArchive = path.resolve(archivePath);
  const { stdout } = await execFileAsync('tar', ['-tzf', resolvedArchive], { encoding: 'utf8' });
  const members = new Set(stdout.split(/\r?\n/).map(name => name.replace(/^\.\//, '')).filter(Boolean));

  await restoreSettings(members);
  await restoreVideoTitles(members);
}

main().catch(err => {
  console.error('[FATAL] Could not restore pre-update application state:', err.message);
  process.exitCode = 1;
});
