#!/usr/bin/env node
/**
 * scripts/migrate.js — Schema migration and validation checker.
 *
 * Usage:
 *   node scripts/migrate.js
 *   node scripts/migrate.js --dry-run
 */

import fs from 'node:fs/promises';
import { readJSON, writeJSON } from '../src/lib/atomic-json.js';
import PATHS from '../src/lib/paths.js';

const dryRun = process.argv.includes('--dry-run');

async function checkAndMigrate(filePath, name, targetVersion) {
  try {
    const { data } = await readJSON(filePath, [], null);
    if (!data) {
      console.log(`[PASS] ${name}: File does not exist yet (clean state).`);
      return;
    }

    const currentVersion = data.schemaVersion ?? 0;
    if (currentVersion === targetVersion) {
      console.log(`[PASS] ${name}: Schema version ${currentVersion} is up to date.`);
      return;
    }

    console.log(`[MIGRATE] ${name}: Upgrading from v${currentVersion} to v${targetVersion}...`);
    if (!dryRun) {
      data.schemaVersion = targetVersion;
      await writeJSON(filePath, data);
      console.log(`[DONE] ${name}: Migrated successfully.`);
    } else {
      console.log(`[DRY-RUN] ${name}: Would migrate from v${currentVersion} to v${targetVersion}.`);
    }
  } catch (err) {
    console.error(`[ERROR] ${name}: Migration check failed:`, err.message);
  }
}

async function main() {
  console.log(`Running migration check (dryRun: ${dryRun})...\n`);

  await checkAndMigrate(PATHS.settings, 'config/settings.json', 1);
  await checkAndMigrate(PATHS.streamState, 'data/stream-state.json', 1);
  await checkAndMigrate(PATHS.bandwidthUsage, 'data/bandwidth-usage.json', 1);
  await checkAndMigrate(PATHS.videosIndex, 'data/videos.json', 1);

  // Auto-heal legacy settings: ensure allowTranscode is enabled and default modePreference is auto
  try {
    const { data } = await readJSON(PATHS.settings, [], null);
    if (data && data.stream) {
      let healed = false;
      if (data.stream.allowTranscode === undefined || data.stream.allowTranscode === false) {
        data.stream.allowTranscode = true;
        healed = true;
      }
      if (data.stream.modePreference === 'copy') {
        data.stream.modePreference = 'auto';
        healed = true;
      }
      if (healed) {
        if (!dryRun) {
          await writeJSON(PATHS.settings, data);
          console.log('[MIGRATE] config/settings.json: Auto-migrated to modePreference="auto" & allowTranscode=true.');
        } else {
          console.log('[DRY-RUN] config/settings.json: Would migrate to modePreference="auto" & allowTranscode=true.');
        }
      }
    }
  } catch (err) {
    console.error('[WARN] Failed to auto-migrate settings flags:', err.message);
  }

  // Clear any stale pre-flight errors in stream-state.json
  try {
    const { data: st } = await readJSON(PATHS.streamState, [], null);
    if (st) {
      let stateChanged = false;
      if (st.status === 'ERROR' && st.lastError && ['E_NEEDS_TRANSCODE', 'E_KEY_MISSING', 'E_NO_VIDEO', 'E_CONFIG_INVALID'].includes(st.lastError.code)) {
        st.lastError = null;
        st.status = 'STOPPED';
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
          console.log('[MIGRATE] data/stream-state.json: Cleared stale error/maintenance state.');
        } else {
          console.log('[DRY-RUN] data/stream-state.json: Would clear stale error/maintenance state.');
        }
      }
    }
  } catch (err) {
    console.error('[WARN] Failed to inspect stream-state.json:', err.message);
  }

  console.log('\nMigration check complete.');
}

main();
