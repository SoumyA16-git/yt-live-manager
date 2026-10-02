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

  console.log('\nMigration check complete.');
}

main();
