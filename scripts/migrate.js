#!/usr/bin/env node
/**
 * scripts/migrate.js — Schema migration and validation checker.
 *
 * Usage:
 *   node scripts/migrate.js
 *   node scripts/migrate.js --dry-run
 */

import path from 'node:path';
import { readJSON, writeJSON, listBackups } from '../src/lib/atomic-json.js';
import { syncDiskVideos } from '../src/video-manager.js';
import { loadSettings, migrateSettings, SCHEMA_VERSION } from '../src/config-manager.js';
import PATHS from '../src/lib/paths.js';

const dryRun = process.argv.includes('--dry-run');

async function checkAndMigrate(filePath, name, targetVersion, migrateFn = null) {
  try {
    const backupPaths = await listBackups(PATHS.backups, path.basename(filePath, '.json'));
    const { data, source, error } = await readJSON(filePath, backupPaths, null);
    if (!data) {
      if (source === 'default' && error?.code === 'ENOENT') {
        console.log(`[PASS] ${name}: File does not exist yet (clean state).`);
        return;
      }
      throw error || new Error('File is unreadable and no valid backup was found');
    }

    if (source === 'backup' && !dryRun) {
      await writeJSON(filePath, data, { mode: 0o600 });
      console.log(`[RESTORE] ${name}: Restored from a valid application backup.`);
    }

    const currentVersion = data.schemaVersion ?? 0;
    const migrated = migrateFn ? migrateFn(data) : { ...data, schemaVersion: targetVersion };
    if (currentVersion === targetVersion && JSON.stringify(migrated) === JSON.stringify(data)) {
      console.log(`[PASS] ${name}: Schema version ${currentVersion} is up to date.`);
      return;
    }

    console.log(`[MIGRATE] ${name}: Updating from v${currentVersion} to v${targetVersion}...`);
    if (!dryRun) {
      await writeJSON(filePath, migrated);
      console.log(`[DONE] ${name}: Migrated successfully.`);
    } else {
      console.log(`[DRY-RUN] ${name}: Would update to schema version ${targetVersion}.`);
    }
  } catch (err) {
    console.error(`[ERROR] ${name}: Migration check failed:`, err.message);
    throw err;
  }
}

async function main() {
  console.log(`Running migration check (dryRun: ${dryRun})...\n`);

  await checkAndMigrate(PATHS.settings, 'config/settings.json', SCHEMA_VERSION, migrateSettings);
  // Video synchronization reads the active stream configuration for compatibility
  // checks and playlist activation. The migration CLI must initialize it too.
  await loadSettings();
  await checkAndMigrate(PATHS.streamState, 'data/stream-state.json', 1);
  await checkAndMigrate(PATHS.bandwidthUsage, 'data/bandwidth-usage.json', 1);
  await checkAndMigrate(PATHS.videosIndex, 'data/videos.json', 1);

  // Auto-sync and discover video files on disk into data/videos.json
  try {
    if (!dryRun) {
      const synced = await syncDiskVideos();
      console.log(`[MIGRATE] Video Library: Synced ${synced.length} video(s) from disk.`);
    } else {
      console.log('[DRY-RUN] Video Library: Would sync and discover videos from disk.');
    }
  } catch (err) {
    console.error('[WARN] Failed to auto-sync videos from disk:', err.message);
    throw err;
  }

  // Clear any stale pre-flight errors or reconnecting loops in stream-state.json
  try {
    const { data: st } = await readJSON(PATHS.streamState, [], null);
    if (st) {
      let stateChanged = false;
      if (st.status === 'ERROR' || st.status === 'RECONNECTING') {
        st.lastError = null;
        st.status = 'STOPPED';
        st.reconnect = null;
        stateChanged = true;
      }
      // If maintenance mode was left active from previous update/script run, clear it
      if (st.maintenance?.active && (st.maintenance.source === 'update' || st.status === 'MAINTENANCE')) {
        st.maintenance = null;
        if (st.status === 'MAINTENANCE') st.status = 'STOPPED';
        stateChanged = true;
      }
      if (stateChanged) {
        if (!dryRun) {
          await writeJSON(PATHS.streamState, st);
          console.log('[MIGRATE] data/stream-state.json: Cleared stale error/reconnecting state.');
        } else {
          console.log('[DRY-RUN] data/stream-state.json: Would clear stale error/reconnecting state.');
        }
      }
    }
  } catch (err) {
    console.error('[WARN] Failed to inspect stream-state.json:', err.message);
  }

  console.log('\nMigration check complete.');
}

main().catch(err => {
  console.error('[FATAL] Migration aborted:', err.message);
  process.exitCode = 1;
});
