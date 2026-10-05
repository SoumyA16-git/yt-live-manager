/**
 * lib/paths.js — Single source of truth for all filesystem paths.
 *
 * All paths are resolved once at startup from APP_ROOT (env) or derived
 * from this file's location. No other module constructs paths independently.
 *
 * PRD §17.1: "lib/paths.js — All paths, resolved once from APP_ROOT."
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Production: APP_ROOT set by systemd EnvironmentFile.
// Development: derived from this file's location (3 levels up from src/lib/).
const APP_ROOT = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const r = (...segments) => path.join(APP_ROOT, ...segments);

const PATHS = {
  root: APP_ROOT,

  // Directories
  config:          r('config'),
  data:            r('data'),
  videos:          r('videos'),
  videosIncoming:  r('videos', '.incoming'),
  logs:            r('logs'),
  backups:         r('backups'),
  scripts:         r('scripts'),
  public:          r('public'),

  // Config files
  settings:        r('config', 'settings.json'),
  settingsExample: r('config', 'settings.example.json'),

  // Data files
  streamState:     r('data', 'stream-state.json'),
  bandwidthUsage:       r('data', 'bandwidth-usage.json'),
  streamHistory:        r('data', 'stream-history.json'),
  videosIndex:          r('data', 'videos.json'),
  ffmpegLock:           r('data', 'ffmpeg.lock'),
  loopConcat:           r('data', 'loop.ffconcat'),
  loopConcatHorizontal: r('data', 'loop_horizontal.ffconcat'),
  loopConcatVertical:   r('data', 'loop_vertical.ffconcat'),

  // Log file
  appLog:          r('logs', 'app.log'),
};

export default PATHS;
