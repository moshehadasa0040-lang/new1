const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
// Called directly (no cmd.exe in between): file names with Hebrew letters,
// '&', '%', '^' or quotes pass through untouched, as real UTF-16 arguments.
const ICACLS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
const config = require('./config');
const logger = require('./logger');
const alerts = require('./alerts');

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
// Locked files are owned by SYSTEM (S-1-5-18), see lockFile().
const OWNER_SID = '*S-1-5-18';

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

function hasMovieExt(fileName) {
  const lower = fileName.toLowerCase();
  return config.MOVIE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isExcluded(filePath) {
  const lower = filePath.toLowerCase();
  return config.EXCLUDED_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

// --- Content detection ---------------------------------------------------------
// Identifies a video by its first bytes, so a file renamed to .txt / .dll / .jpg
// (or one with no extension, or a download still called .crdownload / .part) is
// still recognised. Needs only a few bytes, so even tiny clips are caught.

// ISO-BMFF ("ftyp") brands that are images or audio - must NOT be treated as video.
const NON_VIDEO_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis', 'crx ', 'M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
const ASF_GUID = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');

function isVideoHeader(b) {
  const n = b.length;
  if (n < 12) return false;
  // MP4 / MOV / 3GP / M4V ...
  if (b.toString('latin1', 4, 8) === 'ftyp') return !NON_VIDEO_BRANDS.has(b.toString('latin1', 8, 12));
  const at4 = b.toString('latin1', 4, 8);
  if (at4 === 'moov' || at4 === 'mdat') return true; // old QuickTime
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // Matroska / WebM
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'AVI ') return true; // AVI
  if (n >= 16 && b.subarray(0, 16).equals(ASF_GUID)) return true; // WMV / ASF
  if (b[0] === 0x46 && b[1] === 0x4c && b[2] === 0x56 && b[3] === 0x01) return true; // FLV
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) return true; // MPEG PS / video
  if (b.toString('latin1', 0, 4) === '.RMF') return true; // RealMedia
  if (n >= 389) {
    if (b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return true; // MPEG-TS
    if (b[4] === 0x47 && b[196] === 0x47 && b[388] === 0x47) return true; // M2TS
  }
  return false;
}

async function sniffIsVideo(filePath) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(config.SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return isVideoHeader(buf.subarray(0, bytesRead));
  } catch (e) {
    return false; // unreadable (already locked, in use, gone) - nothing to decide here
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// path -> "mtimeMs:size" of files already checked and found NOT to be video, so
// repeated sweeps / change events don't re-read unchanged files.
const sniffCache = new Map();
function rememberNotVideo(file, st) {
  if (sniffCache.size > 500000) sniffCache.clear();
  sniffCache.set(file, `${st.mtimeMs}:${st.size}`);
}
function seenNotVideo(file, st) {
  return sniffCache.get(file) === `${st.mtimeMs}:${st.size}`;
}

// Finds every video file under `root` by walking the folder tree IN NODE
// (fs.readdir), not by parsing the text output of `dir` / PowerShell.
//
// Why: the text-output approach broke on non-ASCII names. On a Hebrew system
// `dir` prints in the OEM code page, `chcp 65001` didn't take effect for the
// piped output of a service, and every path with Hebrew letters came back as
// garbage ("?????") - so ~40% of the files in a real install log could never
// be locked ("The system cannot find the path specified"). fs.readdir returns
// proper Unicode strings, no code page involved.
//
// Folders that can't be read are skipped. Junctions/symlinks are NOT
// followed (avoids loops such as "Application Data"). Options:
//   skipExcluded  - don't descend into Windows / Program Files (default true;
//                   the unlock sweep passes false so it covers everything)
//   skipDirNames  - folder names (case-insensitive) to skip, e.g. 'appdata'
//   others        - optional array; files WITHOUT a video extension are pushed here
//                   (used by the content sweep)
async function findVideoFiles(root, opts = {}) {
  const skipExcluded = opts.skipExcluded !== false;
  const skipNames = new Set((opts.skipDirNames || []).map((n) => n.toLowerCase()));
  const start = root.endsWith(path.sep) ? root : root + path.sep;
  const found = [];
  const stack = [start];
  const MAX_PARALLEL = 12;
  let running = 0;
  let rootError = null;

  await new Promise((resolve) => {
    const pump = () => {
      while (running < MAX_PARALLEL && stack.length) {
        const dir = stack.pop();
        running += 1;
        fs.promises
          .readdir(dir, { withFileTypes: true })
          .then((entries) => {
            for (const entry of entries) {
              if (entry.isDirectory()) {
                if (skipNames.has(entry.name.toLowerCase())) continue;
                const next = dir + entry.name + path.sep;
                if (skipExcluded && isExcluded(next)) continue;
                stack.push(next);
              } else if (entry.isFile()) {
                if (hasMovieExt(entry.name)) found.push(dir + entry.name);
                else if (opts.others && opts.others.length < 400000) opts.others.push(dir + entry.name);
              }
            }
          })
          .catch((e) => {
            if (dir === start) rootError = e;
          })
          .finally(() => {
            running -= 1;
            pump();
          });
      }
      if (running === 0 && stack.length === 0) resolve();
    };
    pump();
  });

  if (rootError) logger.log(`Could not read ${start}: ${rootError.message}`);
  return found;
}

// Quick-scan roots: every real user profile on this PC (minus the
// template/system ones). AppData is skipped by the caller - it is huge, full
// of app caches, and nobody keeps their movies there; the full scan still
// covers it.
async function getQuickRoots() {
  const usersDir = config.PRIORITY_ROOTS[0];
  try {
    const entries = await fs.promises.readdir(usersDir + path.sep, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !['default', 'default user', 'all users'].includes(e.name.toLowerCase()))
      .map((e) => usersDir + path.sep + e.name);
  } catch (e) {
    logger.log(`Could not list ${usersDir}: ${e.message}`);
    return [usersDir];
  }
}

// --- Locking / unlocking individual files -----------------------------------

// icacls arguments as an ARRAY (execFile, no shell): one entry per token.
// Returning a string here would be spread character-by-character into argv.
function denyArgs() {
  const args = [];
  for (const sid of DENY_SIDS) args.push('/deny', `${sid}:(R)`);
  return args;
}

// Live progress, read by the installer's splash window (via install-progress.txt,
// written in index.js --lock-files mode). `percent` only ever goes up.
const progress = { phase: 'idle', drive: '', driveIndex: 0, driveCount: 0, found: 0, locked: 0, failed: 0, percent: 0 };
function bump(p) {
  if (p > progress.percent) progress.percent = Math.min(100, Math.round(p));
}
function getProgress() {
  return { ...progress };
}

const inFlight = new Set();
// Files whose lock attempt failed most recently (used by the installer's retry step).
const failedFiles = new Set();

// Returns 'already' | 'locked' | 'failed' (and the failure reason via cb).
async function lockFile(filePath, onFail) {
  // Skip files we already believe are locked - re-running icacls /deny on
  // an already-denied file just piles up duplicate deny entries, which is
  // what once made /remove:d fail to fully restore access (see unlockFile).
  if (lockedFiles.has(filePath)) return 'already';
  // Quick and full scans can overlap; never lock the same file twice at once.
  if (inFlight.has(filePath)) return 'already';
  inFlight.add(filePath);
  try {
    // /setowner SYSTEM first: the OWNER of a file can always rewrite its permissions,
    // even as a standard user (icacls /reset, Properties > Security). Without this a
    // child who downloaded the video (= owner) could remove our deny entry himself.
    // Both operations in ONE icacls call; if the owner change is refused for any reason,
    // fall back to the deny-only call so the file is still locked.
    try {
      await execFileAsync(ICACLS, [filePath, '/setowner', OWNER_SID, ...denyArgs(), '/Q'], { windowsHide: true });
    } catch (e1) {
      await execFileAsync(ICACLS, [filePath, ...denyArgs(), '/Q'], { windowsHide: true });
      logger.log(`[lock] owner not changed (deny only): ${filePath}`);
    }
    lockedFiles.add(filePath);
    return 'locked';
  } catch (e) {
    const reason = String((e && (e.stderr || e.stdout || e.message)) || 'unknown').trim().split(/\r?\n/)[0];
    if (onFail) onFail(filePath, reason);
    return 'failed';
  } finally {
    inFlight.delete(filePath);
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
    await execFileAsync(ICACLS, [filePath, '/reset', '/Q'], { windowsHide: true });
  } catch (e) {
    // If the file no longer exists, there's nothing to unlock - fine.
  }
  lockedFiles.delete(filePath);
}

// --- Bulk operations ---------------------------------------------------------

// Locks a list of files with a small worker pool. `shouldContinue` is
// checked before EACH file so an admin "unlock" mid-scan takes effect within
// one file's worth of delay (pass () => blocker.isBlocking()).
async function lockFiles(files, shouldContinue, label, range) {
  let idx = 0;
  let done = 0;
  let locked = 0;
  let failed = 0;
  let sinceSave = 0;
  const failLogged = { n: 0 };
  const onFail = (file, reason) => {
    failed += 1;
    failedFiles.add(file);
    if (failLogged.n < 10) {
      failLogged.n += 1;
      logger.log(`[${label}] Could not lock: ${file} -> ${reason}`);
    }
  };
  const targets = files.filter((f) => !isExcluded(f));
  async function worker() {
    while (idx < targets.length) {
      if (!shouldContinue()) return;
      const file = targets[idx++];
      const result = await lockFile(file, onFail);
      done += 1;
      if (result === 'locked') progress.locked += 1;
      else if (result === 'failed') progress.failed += 1;
      if (range && targets.length > 0) bump(range[0] + ((range[1] - range[0]) * done) / targets.length);
      if (result === 'locked') {
        failedFiles.delete(file);
        locked += 1;
        sinceSave += 1;
        // Persist regularly (not only at the end) so a service stop
        // mid-scan doesn't lose track of files already locked.
        if (sinceSave >= 20) {
          sinceSave = 0;
          saveLockedSet(lockedFiles);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: config.LOCK_CONCURRENCY }, worker));
  saveLockedSet(lockedFiles);
  return { locked, failed, considered: targets.length, skipped: files.length - targets.length };
}

let lastFullScan = { found: 0, locked: 0, failed: 0 };
let lastFullScanAt = null;

const scanState = {
  quick: { running: false, pending: false },
  full: { running: false, pending: false },
  deep: { running: false, pending: false }
};

async function doQuickScan(shouldContinue) {
  const started = Date.now();
  progress.phase = 'quick';
  bump(2);
  const all = new Set();
  for (const root of await getQuickRoots()) {
    if (!shouldContinue()) break;
    for (const f of await findVideoFiles(root, { skipDirNames: ['appdata'] })) all.add(f);
  }
  const files = [...all];
  progress.found += files.length;
  bump(10);
  const r = await lockFiles(files, shouldContinue, 'quick', [10, 25]);
  bump(25);
  // The quick scan runs every ~30s - only log when something happened, so
  // the log stays readable.
  if (r.locked > 0 || r.failed > 0) {
    logger.log(
      `Quick scan (user folders): found ${files.length}, newly locked ${r.locked}, failed ${r.failed} (${((Date.now() - started) / 1000).toFixed(1)}s).`
    );
  }
  return r.locked;
}

// Keeps the "already locked" bookkeeping honest. Without this, a tracked path
// stays "locked" forever even if the file was DELETED (stale entry), or was
// deleted and a NEW file was created/restored/copied at the same path (the
// new file has no deny entry, but the old record made us skip it), or
// somebody reset the permissions by hand. Each tracked file is checked: gone
// -> forget it; deny entry missing -> forget it so the scan below re-locks it.
async function reconcileTracked(shouldContinue) {
  const tracked = [...lockedFiles];
  let gone = 0;
  let reset = 0;
  await mapPool(tracked, config.LOCK_CONCURRENCY, async (file) => {
    if (!shouldContinue()) return;
    const state = await fileState(file);
    if (state === 'gone') {
      lockedFiles.delete(file);
      gone += 1;
    } else if (state === 'unlocked') {
      lockedFiles.delete(file);
      reset += 1;
    }
  });
  if (gone > 0 || reset > 0) {
    saveLockedSet(lockedFiles);
    logger.log(
      `Reconcile: ${gone} tracked file(s) no longer exist (forgotten), ${reset} had lost their lock (will be re-locked).`
    );
    if (reset > 0) alerts.report(`${reset} נעילות של סרטונים הוסרו ידנית ונעשתה נעילה מחדש`);
  }
}

async function doFullScan(shouldContinue) {
  const started = Date.now();
  await reconcileTracked(shouldContinue);
  const drives = await getScannableDrives();
  logger.log(`Full scan started on ${drives.length} drive(s): ${drives.join(', ') || '(none found)'}`);
  let totalLocked = 0;
  let totalFailed = 0;
  let totalFound = 0;
  progress.phase = 'scan';
  progress.driveCount = drives.length;
  for (let di = 0; di < drives.length; di++) {
    const drive = drives[di];
    if (!shouldContinue()) {
      logger.log('Full scan stopped early: unlocked mid-scan.');
      break;
    }
    const span = 65 / drives.length;
    const base = 25 + di * span;
    progress.drive = drive;
    progress.driveIndex = di + 1;
    progress.phase = 'scan';
    bump(base);
    const t0 = Date.now();
    const files = await findVideoFiles(drive);
    totalFound += files.length;
    progress.found += files.length;
    progress.phase = 'lock';
    bump(base + span * 0.35);
    logger.log(`Drive ${drive}: found ${files.length} video file(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    const r = await lockFiles(files, shouldContinue, 'full', [base + span * 0.35, base + span]);
    totalLocked += r.locked;
    totalFailed += r.failed;
    logger.log(
      `Drive ${drive}: newly locked ${r.locked}, failed ${r.failed}, skipped (system/program folders) ${r.skipped}.`
    );
  }
  logger.log(
    `Full scan finished in ${((Date.now() - started) / 1000).toFixed(1)}s: found ${totalFound}, newly locked ${totalLocked}, failed ${totalFailed}, total tracked locked files now ${lockedFiles.size}.`
  );
  lastFullScan = { found: totalFound, locked: totalLocked, failed: totalFailed };
  lastFullScanAt = new Date().toISOString();
  return totalLocked;
}

// Content sweep of the user folders: finds videos hiding behind another extension.
async function sniffCandidates(files, shouldContinue) {
  const hits = [];
  await mapPool(files, 8, async (f) => {
    if (!shouldContinue() || lockedFiles.has(f)) return;
    let st;
    try {
      st = await fs.promises.stat(f);
    } catch (e) {
      return;
    }
    if (!st.isFile() || st.size < config.SNIFF_MIN_FILE_BYTES || seenNotVideo(f, st)) return;
    if (await sniffIsVideo(f)) hits.push(f);
    else rememberNotVideo(f, st);
  });
  return hits;
}

async function doDeepSweep(shouldContinue) {
  const started = Date.now();
  let checked = 0;
  const all = [];
  for (const root of await getQuickRoots()) {
    if (!shouldContinue()) break;
    const others = [];
    await findVideoFiles(root, { skipDirNames: config.DEEP_SWEEP_SKIP_DIRS, others });
    checked += others.length;
    all.push(...(await sniffCandidates(others, shouldContinue)));
  }
  const r = await lockFiles(all, shouldContinue, 'deep', null);
  if (r.locked > 0 || r.failed > 0) {
    logger.log(
      `Content sweep: ${checked} other file(s) checked, ${all.length} disguised video(s) found, newly locked ${r.locked}, failed ${r.failed} (${((Date.now() - started) / 1000).toFixed(1)}s).`
    );
  }
  return r.locked;
}

// --- Single-file entry points (used by the real-time watcher) ----------------

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveLockedSet(lockedFiles);
  }, 2000);
}

// Locks one file if it is a video (by extension or by content).
// Returns 'locked' | 'already' | 'failed' | 'skip' | 'gone'.
async function lockIfVideo(filePath, opts = {}) {
  if (lockedFiles.has(filePath) || isExcluded(filePath)) return 'already';
  let isVideo = hasMovieExt(filePath);
  // opts.extOnly: do not read file contents (used for noisy folders such as AppData).
  if (!isVideo && opts.extOnly) return 'skip';
  if (!isVideo) {
    let st;
    try {
      st = await fs.promises.stat(filePath);
    } catch (e) {
      return 'gone';
    }
    if (!st.isFile() || st.size < config.SNIFF_MIN_FILE_BYTES || seenNotVideo(filePath, st)) return 'skip';
    isVideo = await sniffIsVideo(filePath);
    if (!isVideo) {
      rememberNotVideo(filePath, st);
      return 'skip';
    }
  }
  const r = await lockFile(filePath, (f, reason) => logger.log(`[watch] Could not lock: ${f} -> ${reason}`));
  if (r === 'locked') {
    logger.log(`[watch] Locked immediately: ${filePath}`);
    scheduleSave();
  }
  return r;
}

// A drive that just appeared (USB stick plugged in): lock what is on it right away.
async function lockDrive(drive, shouldContinue = () => true) {
  const files = await findVideoFiles(drive);
  const r = await lockFiles(files, shouldContinue, 'drive', null);
  logger.log(`New drive ${drive}: found ${files.length} video file(s), newly locked ${r.locked}, failed ${r.failed}.`);
  return r.locked;
}

// Guarded runner: never two scans of the same kind at once (a slow full
// scan used to be re-launched by the timer on top of itself). A periodic
// call that finds a scan already running is simply skipped; an explicit
// call (opts.force - e.g. re-lock after a temporary unlock) is remembered
// and re-run as soon as the current one ends, so it is never lost.
async function runScan(kind, fn, shouldContinue, opts = {}) {
  const st = scanState[kind];
  if (st.running) {
    if (opts.force) st.pending = true;
    return 0;
  }
  st.running = true;
  let total = 0;
  try {
    do {
      st.pending = false;
      total += await fn(shouldContinue);
    } while (st.pending && shouldContinue());
  } catch (e) {
    logger.log(`${kind} scan error: ${e.message}`);
  } finally {
    st.running = false;
  }
  return total;
}

// Fast: user-profile folders only. Run at startup, and every ~30s.
function lockPriority(shouldContinue = () => true, opts = {}) {
  return runScan('quick', doQuickScan, shouldContinue, opts);
}

// Content-based sweep of the user folders (videos renamed to another extension).
function lockDisguised(shouldContinue = () => true, opts = {}) {
  return runScan('deep', doDeepSweep, shouldContinue, opts);
}

// Slow but complete: every fixed/removable drive.
function lockAll(shouldContinue = () => true, opts = {}) {
  return runScan('full', doFullScan, shouldContinue, opts);
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
  const trackedBefore = [...lockedFiles];
  const trackedCount = await unlockAll();

  const drives = await getScannableDrives();
  const everything = new Set(trackedBefore);
  let total = 0;
  for (const drive of drives) {
    const files = await findVideoFiles(drive, { skipExcluded: false });
    logger.log(`Unlock sweep: drive ${drive} has ${files.length} video file(s) to restore.`);
    for (const file of files) {
      await unlockFile(file);
      everything.add(file);
      total += 1;
    }
  }
  saveLockedSet(lockedFiles);
  logger.log(
    `Uninstall sweep: unlocked ${total} video file(s) across ${drives.length} drive(s) (plus ${trackedCount} from tracked state).`
  );

  // VERIFY - don't just assume. Re-read each file's permissions; anything
  // that still carries our deny entry gets reset again (up to 3 rounds).
  // The uninstall only continues once this has finished, so a failure to
  // restore a file is at least visible in the log instead of silent.
  let remaining = [...everything];
  for (let round = 1; round <= 3; round++) {
    const stillLocked = [];
    await mapPool(remaining, config.LOCK_CONCURRENCY, async (file) => {
      if ((await fileState(file)) === 'locked') stillLocked.push(file);
    });
    remaining = stillLocked;
    if (remaining.length === 0) break;
    logger.log(`Verify round ${round}: ${remaining.length} file(s) still locked - retrying unlock.`);
    await mapPool(remaining, config.LOCK_CONCURRENCY, unlockFile);
  }
  saveLockedSet(lockedFiles);
  if (remaining.length === 0) {
    logger.log(`UNLOCK VERIFIED: all ${everything.size} video file(s) are accessible again.`);
  } else {
    logger.log(`UNLOCK INCOMPLETE: ${remaining.length} file(s) could not be restored, e.g. ${remaining.slice(0, 5).join(' | ')}`);
  }
  return { unlocked: total + trackedCount, remaining: remaining.length };
}

// --- Verification helpers ----------------------------------------------------

// Returns 'locked' | 'unlocked' | 'gone'.
//
// Why not just parse `icacls`? Because WHO is asking matters: our deny entry
// covers the Users group, and an elevated administrator (e.g. the installer
// or uninstaller) is a member of Users - for that process even READING the
// ACL of a locked file fails with "Access is denied". The SYSTEM service is
// not in Users, so it reads fine. So:
//   - icacls works  -> look for our DENY entry
//   - icacls fails  -> the file is either gone (ENOENT) or unreadable to us
//                      because it IS locked (EACCES/EPERM)
function fileState(file) {
  return execFileAsync(ICACLS, [file], { windowsHide: true, encoding: 'utf8' })
    .then(({ stdout }) => (/\(DENY\)/i.test(stdout) ? 'locked' : 'unlocked'))
    .catch(() => {
      try {
        fs.lstatSync(file);
        return 'locked'; // exists, but we can't even read its ACL
      } catch (e) {
        return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'gone' : 'locked';
      }
    });
}

async function mapPool(items, concurrency, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const item = items[idx++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

// Used by the INSTALLER (agent --lock-files): locks every video file on every
// drive and does not return until it has been verified, so the installation
// is not "finished" while movies are still playable. Steps: quick scan of the
// user folders, full scan of all drives, then verify every tracked file really
// has the deny entry and re-lock any that don't. Failures are logged and the
// function still returns (an unlockable file must not hang the installer
// forever) - the running service keeps retrying them every scan afterwards.
async function lockEverythingVerified() {
  const keepGoing = () => true;
  failedFiles.clear();
  logger.log('Install: locking ALL video files before finishing installation...');
  progress.phase = 'quick';
  await lockPriority(keepGoing, { force: true });
  await lockAll(keepGoing, { force: true });
  await lockDisguised(keepGoing, { force: true });

  // Retry ONLY the files that failed (no re-scan), up to 2 more times.
  let toRetry = [...failedFiles];
  progress.phase = 'retry';
  bump(90);
  for (let attempt = 1; attempt <= 2 && toRetry.length > 0; attempt++) {
    logger.log(`Install: retry ${attempt} for ${toRetry.length} file(s) that failed to lock.`);
    const still = [];
    await mapPool(toRetry, config.LOCK_CONCURRENCY, async (file) => {
      const r = await lockFile(file);
      if (r === 'failed' && (await fileState(file)) !== 'gone') still.push(file);
    });
    toRetry = still;
  }

  // Verify every tracked file really carries the deny entry.
  progress.phase = 'verify';
  bump(94);
  let repaired = 0;
  const missing = [];
  await mapPool([...lockedFiles], config.LOCK_CONCURRENCY, async (file) => {
    const r = await fileState(file);
    if (r === 'gone') lockedFiles.delete(file); // file was deleted
    else if (r === 'unlocked') missing.push(file);
  });
  for (const file of missing) lockedFiles.delete(file);
  await mapPool(missing, config.LOCK_CONCURRENCY, async (file) => {
    if ((await lockFile(file)) === 'locked') repaired += 1;
  });
  saveLockedSet(lockedFiles);

  const failed = toRetry.length + (missing.length - repaired);
  bump(99);
  let resultLine;
  if (failed === 0) {
    resultLine = 'OK';
    logger.log(
      `INSTALL LOCK COMPLETE: ${lockedFiles.size} video file(s) locked and verified` +
        (repaired ? ` (${repaired} repaired during verification)` : '') +
        '.'
    );
  } else {
    resultLine = `INCOMPLETE ${failed}`;
    logger.log(
      `INSTALL LOCK INCOMPLETE: ${lockedFiles.size} video file(s) locked, but ${failed} could NOT be locked, e.g. ${toRetry
        .slice(0, 5)
        .join(' | ')}`
    );
  }
  // The installer reads this marker after the service starts and tells the
  // person if the lock was not complete (instead of silently claiming success).
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(config.DATA_DIR, 'install-lock-result.txt'), resultLine);
  } catch (e) {
    logger.log(`Could not write install-lock-result.txt: ${e.message}`);
  }
  return { locked: lockedFiles.size, failed };
}

function getLockedCount() {
  return lockedFiles.size;
}
function getLastFullScan() {
  return { ...lastFullScan, at: lastFullScanAt };
}

module.exports = {
  lockAll,
  lockPriority,
  lockDisguised,
  lockIfVideo,
  lockDrive,
  getScannableDrives,
  isVideoHeader,
  sniffIsVideo,
  isExcluded,
  lockEverythingVerified,
  unlockAll,
  unlockAllByScan,
  getProgress,
  getLockedCount,
  getLastFullScan,
  findVideoFiles
};
