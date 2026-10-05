import fs from 'node:fs';
import PATHS from '../src/lib/paths.js';
import { loadSettings, getSettings } from '../src/config-manager.js';
import { loadState, saveState, getState } from '../src/state-manager.js';

async function main() {
  const settingsFile = PATHS.settings;
  if (fs.existsSync(settingsFile)) {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (raw.scheduler?.autoRecycle) {
      delete raw.scheduler.autoRecycle.maxSessionMinutes;
      raw.scheduler.autoRecycle.enabled = true;
      raw.scheduler.autoRecycle.maxSessionHours = 8;
      raw.scheduler.autoRecycle.pauseMinutes = 1;
      raw.scheduler.autoRecycle.resumeBookmark = false;
    }
    raw.stream = raw.stream || {};
    raw.stream.autoResume = false;
    fs.writeFileSync(settingsFile, JSON.stringify(raw, null, 2), 'utf8');
  }

  await loadSettings();
  await loadState();

  await saveState({
    desiredState: 'stopped',
    status: 'STOPPED',
    recyclingUntil: null,
  });

  console.log('Production defaults configured cleanly:');
  const currentSettings = getSettings();
  console.log('Stream Mode:', currentSettings.stream?.mode);
  console.log('Auto-Recycle:', currentSettings.scheduler?.autoRecycle);
  console.log('State desiredState:', getState().desiredState);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
