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
import { evaluateCompatibility } from '../src/ffprobe-manager.js';
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
      if (data.stream.copyMinMbps === undefined || data.stream.copyMinMbps > 0.1) {
        data.stream.copyMinMbps = 0.1;
        healed = true;
      }
      if (data.stream.copyMaxMbps === undefined || data.stream.copyMaxMbps > 4.5) {
        data.stream.copyMaxMbps = 4.0;
        healed = true;
      }
      if (data.stream.keyframeMaxSeconds === undefined || data.stream.keyframeMaxSeconds < 6.0) {
        data.stream.keyframeMaxSeconds = 6.0;
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

  // Re-evaluate video compatibility in data/videos.json with latest rules/settings
  try {
    const { data: vData } = await readJSON(PATHS.videosIndex, [], null);
    const { data: sData } = await readJSON(PATHS.settings, [], null);
    if (vData && Array.isArray(vData.videos) && vData.videos.length > 0) {
      let vUpdated = false;
      const settings = sData || {};
      for (const v of vData.videos) {
        if (v.probe) {
          const fresh = evaluateCompatibility(v.probe, settings);
          if (v.compatibility?.status !== fresh.status ||
              JSON.stringify(v.compatibility?.reasons) !== JSON.stringify(fresh.reasons)) {
            v.compatibility = fresh;
            vUpdated = true;
          }
        }
      }
      if (vUpdated) {
        if (!dryRun) {
          await writeJSON(PATHS.videosIndex, vData);
          console.log('[MIGRATE] data/videos.json: Re-evaluated video compatibility with updated rules (Stream-Copy Ready).');
        } else {
          console.log('[DRY-RUN] data/videos.json: Would re-evaluate video compatibility with updated rules.');
        }
      }
    }
  } catch (err) {
    console.error('[WARN] Failed to re-evaluate videos.json in migration:', err.message);
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

main();
