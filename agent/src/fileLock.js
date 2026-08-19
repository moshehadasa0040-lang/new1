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
    // Setting $ErrorActionPreference globally (not just -ErrorAction on
    // the cmdlet itself) is needed here: in practice, "Access is denied"
    // errors hit while RECURSING INTO a protected system folder (e.g.
    // System Volume Information) can still surface as a terminating error
    // that kills the whole pipeline and makes powershell.exe exit non-zero
    // - even with -ErrorAction SilentlyContinue on Get-ChildItem itself.
    // That previously caused the entire scan to come back completely
    // empty (0 files) if it hit even ONE inaccessible folder anywhere on
    // the whole drive - which is exactly what happened during a real
    // uninstall attempt (logged as "Access is denied", followed by
    // "unlocked 0 video file(s)"). The try/catch + explicit `exit 0`
    // below guarantee the process always exits cleanly and returns
    // whatever it already found, instead of discarding all of it over a
    // single inaccessible subfolder.
    const psScript =
      "$ErrorActionPreference = 'SilentlyContinue'; " +
      `try { Get-ChildItem -Path '${drive}\\' -Recurse -File -Include ${includeList} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName } catch {} ` +
      'exit 0';
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${psScript}"`, {
      maxBuffer: 1024 * 1024 * 32
    });
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

async function lockFile(filePath) {
  // Skip files we already believe are locked - re-running icacls /deny on
  // an already-denied file doesn't update anything in place, it just adds
  // ANOTHER explicit deny entry for the same account. After enough repeat
  // scans (this runs every 3 minutes, for as long as the agent is
  // installed) the same file can end up with a pile of duplicate deny
  // entries, which turned out to be exactly why /remove:d later failed to
  // fully restore access - see unlockFile() below.
  if (lockedFiles.has(filePath)) return true;
  try {
    await execAsync(`icacls "${filePath}" ${denyArgs()} /Q`);
    lockedFiles.add(filePath);
    saveLockedSet(lockedFiles); // persist immediately, not just at the end
    // of the whole scan - so a service stop mid-scan doesn't lose track of
    // files already locked in that same scan.
    return true;
  } catch (e) {
    // File may be in use, deleted mid-scan, or otherwise inaccessible -
    // not fatal, just skip it and continue with the rest.
    return false;
  }
}

async function unlockFile(filePath) {
  try {
    // /reset restores this file's permissions to whatever it inherits
    // from its parent folder, wiping out EVERY explicit entry we've ever
    // added to it - including any duplicate deny entries that piled up
    // from repeated lock cycles (see lockFile() above). Far more reliable
    // than /remove:d, which only removes entries it can find an exact
    // match for and can leave residual duplicates behind, causing "Access
    // Denied" even after we believed the file was fully unlocked.
    await execAsync(`icacls "${filePath}" /reset /Q`);
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
//
// `shouldContinue` is checked before locking EACH individual file, not just
// once at the start. A full-drive scan can take a minute or more - without
// this, a scan that started while blocking was on would keep locking files
// for its entire duration even if the admin unlocked the device moments
// after the scan began, silently undoing the unlock once the (already
// in-flight) scan finished. Pass `() => blocker.isBlocking()` from the
// caller so an unlock mid-scan takes effect within a single file's worth of
// delay, not a full scan's worth.
async function lockAll(shouldContinue = () => true) {
  const drives = await getScannableDrives();
  let total = 0;
  for (const drive of drives) {
    if (!shouldContinue()) {
      logger.log('File-lock scan stopped early: unlocked mid-scan.');
      break;
    }
    const files = await findVideoFiles(drive);
    for (const file of files) {
      if (!shouldContinue()) {
        logger.log('File-lock scan stopped early: unlocked mid-scan.');
        saveLockedSet(lockedFiles);
        return total;
      }
      const ok = await lockFile(file);
      if (ok) total += 1;
    }
  }
  saveLockedSet(lockedFiles);
  if (total > 0) logger.log(`File-lock scan: ${total} video file(s) locked across ${drives.length} drive(s).`);
  return total;
}

// Reverses every lock this agent has ever applied (tracked in
// locked-files.json). Used for temporary unlock (fast - only touches known
// locked files).
async function unlockAll() {
  const files = [...lockedFiles];
  for (const file of files) {
    await unlockFile(file);
  }
  saveLockedSet(lockedFiles);
  if (files.length > 0) logger.log(`Unlocked ${files.length} previously-locked video file(s).`);
  return files.length;
}

// Full sweep, independent of local tracking: re-scans every drive for
// video files and removes the deny ACEs from EVERY one found, regardless
// of whether our local locked-files.json knows about it. Also unlocks
// every TRACKED file as a safety net first - belt and suspenders: if the
// scan itself fails for any reason (a real failure mode seen in practice -
// a single inaccessible system folder anywhere on the drive can abort the
// whole recursive scan and return zero results), the tracked files still
// get unlocked regardless.
//
// Used specifically for uninstall, instead of the tracked unlockAll()
// above alone - tracking can have gaps of its own (e.g. a brand new file
// nobody has scanned yet), and uninstall is exactly the one moment where
// "we might have missed one" is unacceptable: it's the last chance to
// restore someone's access to their own files. Slower than unlockAll(),
// but that's fine here - it only runs once, on the way out.
async function unlockAllByScan() {
  const trackedCount = await unlockAll();

  const drives = await getScannableDrives();
  let total = 0;
  for (const drive of drives) {
    const files = await findVideoFiles(drive);
    for (const file of files) {
      await unlockFile(file);
      total += 1;
    }
  }
  saveLockedSet(lockedFiles);
  logger.log(
    `Uninstall sweep: unlocked ${total} video file(s) across ${drives.length} drive(s) (plus ${trackedCount} from tracked state).`
  );
  return total + trackedCount;
}

module.exports = { lockAll, unlockAll, unlockAllByScan };
