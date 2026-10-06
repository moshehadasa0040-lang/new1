const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const fileLock = require('./fileLock');
const blocker = require('./blocker');
const holders = require('./holders');

// ---------------------------------------------------------------------------
// Near-real-time protection.
//
// Windows tells a process, within milliseconds, when a file is created, renamed
// or changed anywhere on a drive (ReadDirectoryChangesW - this is what fs.watch
// uses on Windows). We listen on every fixed/removable drive, and the moment a
// path appears we check it (extension, or - for any other name - its first
// bytes) and lock it, then immediately close any known player.
//
// This shrinks the gap between "a video shows up" and "it is locked" from the
// periodic-scan interval (30s - 3min) to roughly a second. It is NOT a kernel
// driver: it reacts right after the file appears, it cannot stop the very first
// open. The periodic scans stay as a backstop - Windows can drop notifications
// when a burst of changes overflows its buffer.
// ---------------------------------------------------------------------------

const watchers = new Map(); // "C:" -> FSWatcher
const pending = new Map(); // full path -> 'rename' | 'change'
const negativeUntil = new Map(); // full path -> ms timestamp (recently checked, not a video)
const WORKERS = 4;
let drainTimer = null;
let refreshTimer = null;
let running = false;
let firstRefresh = true;

function ignored(full) {
  const lower = full.toLowerCase();
  if (fileLock.isExcluded(full)) return true;
  if (lower.startsWith(config.LOG_DIR.toLowerCase())) return true; // our own log writes
  if (lower.includes('\\$recycle.bin\\') || lower.includes('\\system volume information\\')) return true;
  return false;
}

function onEvent(root, evt, filename) {
  if (!running || !filename || !blocker.isBlocking()) return;
  const full = path.join(root, filename.toString());
  if (ignored(full)) return;
  // 'rename' (created / renamed / deleted) is the stronger signal - keep it.
  if (pending.get(full) !== 'rename') pending.set(full, evt);
  if (!drainTimer) drainTimer = setTimeout(drain, config.WATCH_DEBOUNCE_MS);
}

async function drain() {
  drainTimer = null;
  const batch = [...pending.entries()];
  pending.clear();
  let idx = 0;
  const lockedNow = [];

  async function worker() {
    while (idx < batch.length) {
      if (!running || !blocker.isBlocking()) return;
      const [file, evt] = batch[idx++];
      // A file that is being written keeps firing 'change'; don't re-read it constantly.
      if (evt === 'change' && (negativeUntil.get(file) || 0) > Date.now()) continue;
      try {
        // Noisy folders (AppData: browser/app caches change constantly): decide by extension
      // only, do not open and read every changed file there.
      const lowerFile = file.toLowerCase();
      const noisy = config.DEEP_SWEEP_SKIP_DIRS.some((d) => lowerFile.includes('\\' + d + '\\'));
      const r = await fileLock.lockIfVideo(file, { extOnly: noisy });
        if (r === 'locked') lockedNow.push(file);
        else if (r === 'skip') negativeUntil.set(file, Date.now() + 5000);
      } catch (e) {
        logger.log(`[watch] error on ${file}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));

  // Something was just locked: whoever had it open may still be playing it,
  // so close the known players right now instead of waiting for the next tick.
  if (lockedNow.length) {
    blocker.scanAndKill();
    // ...and anything else (a player that is not on the list) that still has it open.
    holders.releaseSoon(lockedNow);
  }

  if (negativeUntil.size > 20000) {
    const now = Date.now();
    for (const [k, t] of negativeUntil) if (t < now) negativeUntil.delete(k);
  }
  if (pending.size && !drainTimer) drainTimer = setTimeout(drain, config.WATCH_DEBOUNCE_MS);
}

function watchDrive(drive) {
  const root = drive + '\\';
  try {
    const w = fs.watch(root, { recursive: true, persistent: true }, (evt, name) => onEvent(root, evt, name));
    w.on('error', (e) => {
      logger.log(`[watch] watcher on ${drive} failed: ${e.message} (will retry)`);
      try {
        w.close();
      } catch (err) {
        // already closed
      }
      watchers.delete(drive);
    });
    watchers.set(drive, w);
    logger.log(`[watch] Watching ${drive} for new video files.`);
  } catch (e) {
    logger.log(`[watch] Could not watch ${drive}: ${e.message}`);
  }
}

// Starts watchers for drives that appeared, stops them for drives that left.
async function refreshDrives() {
  if (!running) return;
  const drives = await fileLock.getScannableDrives();
  for (const d of drives) {
    if (watchers.has(d)) continue;
    watchDrive(d);
    // The very first refresh happens at startup, where the normal scans already run.
    // Later ones are real "drive plugged in" events.
    if (!firstRefresh && watchers.has(d) && blocker.isBlocking()) {
      fileLock.lockDrive(d, () => running && blocker.isBlocking()).catch((e) => logger.log(`[watch] lockDrive ${d}: ${e.message}`));
    }
  }
  for (const [d, w] of watchers) {
    if (drives.includes(d)) continue;
    try {
      w.close();
    } catch (e) {
      // ignore
    }
    watchers.delete(d);
    logger.log(`[watch] Drive ${d} is gone - stopped watching it.`);
  }
  firstRefresh = false;
}

function start() {
  if (running) return;
  running = true;
  firstRefresh = true;
  refreshDrives().catch((e) => logger.log(`[watch] start failed: ${e.message}`));
  refreshTimer = setInterval(() => {
    refreshDrives().catch((e) => logger.log(`[watch] refresh failed: ${e.message}`));
  }, config.WATCH_DRIVE_REFRESH_MS);
}

function stop() {
  running = false;
  clearInterval(refreshTimer);
  refreshTimer = null;
  clearTimeout(drainTimer);
  drainTimer = null;
  pending.clear();
  holders.stop();
  for (const w of watchers.values()) {
    try {
      w.close();
    } catch (e) {
      // ignore
    }
  }
  watchers.clear();
}

function status() {
  return { running, drives: [...watchers.keys()] };
}

module.exports = { start, stop, status };
