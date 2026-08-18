const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execAsync = promisify(exec);
const config = require('./config');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Real, OS-level video file blocking.
//
// Killing known player processes (blocker.js) only stops named apps - anyone
// can rename an .exe, or install a player that isn't on the list, and play
// the file anyway. This module instead denies read access to the video
// FILES themselves at the NTFS permission level, via `icacls`. That means
// it doesn't matter what application tries to open the file, or what it's
// called - Windows itself refuses the read, before any player ever gets a
// chance to run.
//
// Scope and honest limitations (see README for the full explanation):
//   - Only covers local video files on this machine's own drives (fixed +
//     removable/USB). It cannot stop browser-based streaming (YouTube,
//     Netflix, etc.) - there's no local file to restrict in that case.
//   - Denies the BUILTIN\Users and Authenticated Users groups specifically -
//     not local Administrators or SYSTEM. A user with local Administrator
//     rights on the same machine can always reclaim access (take
//     ownership) - no software running as a normal Windows service can
//     prevent that; it's a fundamental property of how Windows permissions
//     work, not a limitation of this code.
// ---------------------------------------------------------------------------

const LOCKED_FILES_PATH = path.join(config.DATA_DIR, 'locked-files.json');

// SIDs (locale-independent, unlike group names):
//   S-1-5-32-545 = BUILTIN\Users (standard local user accounts)
//   S-1-5-11     = Authenticated Users (covers domain accounts too)
const DENY_SIDS = ['*S-1-5-32-545', '*S-1-5-11'];

function loadLockedSet() {
  try {
    if (fs.existsSync(LOCKED_FILES_PATH)) {
      return new Set(JSON.parse(fs.readFileSync(LOCKED_FILES_PATH, 'utf8')));
    }
  } catch (e) {
    // corrupt/missing state file - start fresh
  }
  return new Set();
}

function saveLockedSet(set) {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCKED_FILES_PATH, JSON.stringify([...set]));
  } catch (e) {
    logger.log(`Failed to persist locked-files state: ${e.message}`);
  }
}

let lockedFiles = loadLockedSet();

// --- Drive + file discovery -------------------------------------------------

async function getScannableDrives() {
  // DriveType 2 = removable (USB), 3 = fixed local disk. Deliberately
  // excludes network drives (4) - we don't want to mutate permissions on a
  // shared network resource other people might depend on.
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | Select-Object -ExpandProperty DeviceID"'
    );
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    logger.log(`Drive enumeration failed: ${e.message}`);
    return [];
  }
}

async function findVideoFiles(drive) {
  const includeList = config.MOVIE_EXTENSIONS.map((ext) => `*${ext}`).join(',');
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-ChildItem -Path '${drive}\\' -Recurse -File -Include ${includeList} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"`,
      { maxBuffer: 1024 * 1024 * 32 }
    );
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    logger.log(`Scan failed on ${drive}: ${e.message}`);
    return [];
  }
}

// --- Locking / unlocking individual files -----------------------------------

function denyArgs() {
  return DENY_SIDS.map((sid) => `/deny "${sid}:(R)"`).join(' ');
}

function removeDenyArgs() {
  return DENY_SIDS.map((sid) => `/remove:d "${sid}"`).join(' ');
}

async function lockFile(filePath) {
  try {
    await execAsync(`icacls "${filePath}" ${denyArgs()} /Q`);
    lockedFiles.add(filePath);
    return true;
  } catch (e) {
    // File may be in use, deleted mid-scan, or otherwise inaccessible -
    // not fatal, just skip it and continue with the rest.
    return false;
  }
}

async function unlockFile(filePath) {
  try {
    await execAsync(`icacls "${filePath}" ${removeDenyArgs()} /Q`);
  } catch (e) {
    // If the file no longer exists, there's nothing to unlock - fine.
  }
  lockedFiles.delete(filePath);
}

// --- Bulk operations ---------------------------------------------------------

// Scans all drives for video files and locks every one found. Safe to call
// repeatedly (e.g. on a timer) - already-locked files are just re-locked
// (a no-op in practice), and this is how newly added/copied video files
// get caught without needing a live filesystem watcher on every drive.
async function lockAll() {
  const drives = await getScannableDrives();
  let total = 0;
  for (const drive of drives) {
    const files = await findVideoFiles(drive);
    for (const file of files) {
      const ok = await lockFile(file);
      if (ok) total += 1;
    }
  }
  saveLockedSet(lockedFiles);
  if (total > 0) logger.log(`File-lock scan: ${total} video file(s) locked across ${drives.length} drive(s).`);
  return total;
}

// Reverses every lock this agent has ever applied (tracked in
// locked-files.json). Used for temporary unlock, and MUST be called before
// uninstall - we never want to leave a user's files permanently
// inaccessible after the software is removed.
async function unlockAll() {
  const files = [...lockedFiles];
  for (const file of files) {
    await unlockFile(file);
  }
  saveLockedSet(lockedFiles);
  if (files.length > 0) logger.log(`Unlocked ${files.length} previously-locked video file(s).`);
  return files.length;
}

module.exports = { lockAll, unlockAll };
