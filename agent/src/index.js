// Must be set before the first fs/child_process call: the folder walk issues many
// parallel readdir() calls and the default libuv pool is only 4 threads.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const config = require('./config');
const identity = require('./identity');
const api = require('./api');
const blocker = require('./blocker');
const fileLock = require('./fileLock');
const watcher = require('./watcher');
const alerts = require('./alerts');
const updater = require('./updater');
const defender = require('./defender');
const health = require('./health');
const logger = require('./logger');
const statusFile = require('./status');
const { selfUninstall } = require('./uninstall');
const execAsync = promisify(exec);

// Self-heal for machines installed with v1.8.0 or earlier, whose NSSM
// service registration only has "AppExit Default Restart" with no
// exit-code-0 override. On those installs, the dashboard's remote
// "uninstall" command (which makes this process call process.exit(0) on
// itself, see applyCommand() below) gets undone: NSSM treats that self-exit
// as an unexpected crash and immediately restarts the agent, which then
// re-registers with the server (same hardware-derived ID) and can re-lock
// files before uninstall-helper.bat gets a chance to run "nssm stop". New
// installs get this set correctly at install time (see setup.iss), but
// existing installs won't pick that up until the service itself re-applies
// it - which is what this does, once, on every normal startup. Cheap and
// idempotent: if it's already set correctly this is a harmless no-op.
async function ensureNssmExitPolicy() {
  try {
    const nssmPath = path.join(path.dirname(process.execPath), 'nssm.exe');
    await execAsync(`"${nssmPath}" set ${config.SERVICE_NAME} AppExit 0 Exit`);
  } catch (e) {
    // Not running under NSSM (e.g. `node src/index.js` in dev), nssm.exe
    // missing, or not installed as this exact service name - not fatal,
    // the agent still runs fine either way.
  }
}

// One line for the dashboard's "removed recently" list.
function removalSummary(how, r) {
  if (!r) return `${how}: שחרור הקבצים לא הושלם או לא דווח - כדאי לבדוק ידנית`;
  return `${how}: שוחררו ${r.unlocked} קבצים, נותרו נעולים ${r.remaining}${r.remaining ? ' (!)' : ' - הכול שוחרר'}`;
}

// Support mode: the installer's uninstaller invokes the packaged exe with
// this flag, BEFORE deleting any files, so that locally-locked video files
// get their NTFS permissions restored even when someone uninstalls the
// normal way (Windows "Apps" settings / Add-Remove Programs) rather than
// through the dashboard's "uninstall" button. Without this, removing the
// software any other way would leave video files permanently locked -
// which would be a real problem for someone's own legitimate files.
if (process.argv.includes('--unlock-files')) {
  (async () => {
    let unlockResult = null;
    try {
      unlockResult = await fileLock.unlockAllByScan();
    } catch (e) {
      // best-effort - don't let a scan failure block the uninstall
    }
    // Also removes the device from the dashboard entirely, instead of
    // leaving a stale "offline" card that someone has to notice and clean
    // up by hand. Uses whatever credentials were saved locally, if any.
    try {
      const state = identity.loadState();
      if (state && state.deviceId && state.deviceToken) {
        await api.unregister(state.deviceId, state.deviceToken, removalSummary('הסרה דרך Windows', unlockResult));
      }
    } catch (e) {
      // Server unreachable, or already removed - not fatal, uninstall
      // continues regardless.
    }
    identity.clearState();
    process.exit(0);
  })();
  return; // eslint-disable-line no-unreachable
}

// Installer mode: the installer runs the packaged exe with this flag AFTER the
// files are copied and BEFORE the service is started, and waits for it. It
// does not exit until every video file has been locked and verified, so the
// installation itself only completes once blocking is actually in place.
if (process.argv.includes('--lock-files')) {
  (async () => {
    const startedAt = Date.now();
    const writeProgress = (phase) => {
      const p = fileLock.getProgress();
      statusFile.writeInstallProgress({
        phase: phase || p.phase,
        percent: phase === 'done' ? 100 : p.percent,
        drive: p.drive,
        drive_index: p.driveIndex,
        drive_count: p.driveCount,
        found: p.found,
        locked: p.locked,
        failed: p.failed,
        elapsed: Math.round((Date.now() - startedAt) / 1000),
        updated: new Date().toISOString()
      });
    };
    // The installer's splash window polls this file to show live progress.
    writeProgress('starting');
    const ticker = setInterval(() => writeProgress(), 700);
    let exitCode = 0;
    try {
      logger.log(`Agent v${require('../package.json').version}: --lock-files (installer mode) started.`);
      const result = await fileLock.lockEverythingVerified();
      if (result.failed > 0) exitCode = 2;
    } catch (e) {
      logger.log(`--lock-files failed: ${e.message}`);
      exitCode = 1;
    }
    clearInterval(ticker);
    writeProgress('done');
    process.exit(exitCode);
  })();
  return; // eslint-disable-line no-unreachable
}

let deviceId, deviceToken;
let temporaryUnlockTimer = null;
let appliedUnlockUntil = null; // dedup guard - avoid reapplying the same unlock on every heartbeat
let lockScanTimer = null;
let quickScanTimer = null;
let deepSweepTimer = null;
let lastHeartbeatOk = null; // null = unknown yet; used to log only on state CHANGES
// Set the moment a remote 'uninstall' command starts. From then on, nothing
// (periodic lock scan, heartbeat, 401 re-registration) is allowed to
// re-lock files or re-register the device while the unlock sweep runs.
let uninstalling = false;

// When the service is stopped for an update (nssm sends Ctrl+C), leave a time stamp: the NEW
// agent subtracts it from its own start time to report how long the protection was off.
['SIGINT', 'SIGTERM', 'SIGBREAK'].forEach((sig) => {
  process.on(sig, () => {
    try {
      fs.mkdirSync(path.dirname(updater.STOP_FILE), { recursive: true });
      fs.writeFileSync(updater.STOP_FILE, String(Date.now()));
    } catch (e) { /* ignore */ }
    process.exit(0);
  });
});
// Short human-friendly computer number assigned by the server (1, 2, 3...).
// Shown in the tray icon menu / About so people can say "computer 7" when
// asking for an unlock. The server is the source of truth; we cache it.
let deviceNumber = null;

function rememberDeviceNumber(num) {
  const n = Number(num);
  if (!Number.isInteger(n) || n <= 0 || n === deviceNumber) return;
  if (deviceNumber !== null) logger.log(`Computer number changed: ${deviceNumber} -> ${n}`);
  else logger.log(`This computer's number in the dashboard: ${n}`);
  deviceNumber = n;
  try {
    const state = identity.loadState();
    if (state) identity.saveState({ ...state, deviceNumber: n });
  } catch (e) {
    // best-effort
  }
}

async function ensureRegistered() {
  let state = identity.loadState();
  if (state && state.deviceId && state.deviceToken) {
    // Cached number from the last run, so the tray can show it even before the
    // first heartbeat (or while the server is unreachable). The next heartbeat
    // corrects it if the server changed it.
    if (state.deviceNumber) deviceNumber = Number(state.deviceNumber) || null;
    return state;
  }
  const hardwareId = identity.getHardwareId();
  const { deviceId, deviceToken, deviceNumber: num } = await api.register(hardwareId);
  state = { deviceId, deviceToken, deviceNumber: num || null };
  identity.saveState(state);
  rememberDeviceNumber(num);
  return state;
}

// Snapshot for the tray icon (see agent/ui/tray.ps1). Rewritten on every
// heartbeat result, on every state change and every 15s, so the tray can tell
// "alive" from "service stopped" by how fresh `updated` is.
function writeCurrentStatus(extra = {}) {
  const blocking = blocker.isBlocking();
  const scan = fileLock.getLastFullScan();
  statusFile.writeStatus({
    updated: new Date().toISOString(),
    version: require('../package.json').version,
    device_name: identity.getCustomDeviceName() || os.hostname(),
    device_id: deviceId || '',
    device_number: deviceNumber || '',
    blocking: blocking ? 1 : 0,
    unlocked_until: !blocking && appliedUnlockUntil ? appliedUnlockUntil : '',
    server_ok: lastHeartbeatOk === false ? 0 : 1,
    locked_count: fileLock.getLockedCount(),
    last_full_scan: scan.at || '',
    dashboard_url: config.SERVER_URL,
    ...extra
  });
}

async function reLockNow() {
  appliedUnlockUntil = null;
  blocker.setBlocking(true);
  logger.log('Re-locking video files now.');
  const keepGoing = () => blocker.isBlocking();
  await fileLock.lockPriority(keepGoing, { force: true });
  writeCurrentStatus();
  await fileLock.lockAll(keepGoing, { force: true });
  await fileLock.lockDisguised(keepGoing, { force: true });
}

async function temporarilyUnlockNow() {
  blocker.setBlocking(false);
  writeCurrentStatus();
  await fileLock.unlockAll();
}

async function scheduleReLock(untilIso) {
  clearTimeout(temporaryUnlockTimer);
  const msRemaining = new Date(untilIso).getTime() - Date.now();
  if (msRemaining <= 0) {
    await reLockNow();
    return;
  }
  appliedUnlockUntil = untilIso;
  await temporarilyUnlockNow();
  temporaryUnlockTimer = setTimeout(reLockNow, msRemaining);
}

async function applyCommand(cmd) {
  logger.log(`Command received from dashboard: ${cmd.type}${cmd.payload && cmd.payload.until ? ' (until ' + cmd.payload.until + ')' : ''}`);
  switch (cmd.type) {
    case 'unlock':
      await scheduleReLock(cmd.payload.until);
      break;
    case 'lock':
      clearTimeout(temporaryUnlockTimer);
      await reLockNow();
      break;
    case 'update_rules':
      if (cmd.payload && cmd.payload.blockedProcesses) {
        blocker.setBlockList(cmd.payload.blockedProcesses);
      }
      break;
    case 'send_logs':
      try {
        const status = await health.collect().catch((e) => `בדיקת המצב נכשלה: ${e.message}`);
        const recentLogs = `${status}\n\n=== לוג אחרון ===\n${logger.getRecent(500)}`;
        await api.sendLogs(deviceId, deviceToken, recentLogs);
      } catch (err) {
        logger.log(`Failed to upload logs: ${err.message}`);
      }
      break;
    case 'update': {
      // "Update agent" button in the dashboard. Runs in the background: a download can
      // take minutes and the heartbeat must keep going meanwhile (otherwise the
      // computer would show as offline). delaySec spreads out "update all" requests so
      // 30 computers do not hit GitHub's anonymous rate limit at the same second.
      const delayMs = Math.max(0, Math.min(Number(cmd.payload && cmd.payload.delaySec) || 0, 3600)) * 1000;
      const requestedAt = Date.now(); // for the report: how long from the click until it is done
      const say = (m) => api.ack(deviceId, deviceToken, cmd.id, m).catch((e) => logger.log(`Ack failed: ${e.message}`));
      setTimeout(async () => {
        try {
          const r = await updater.checkOnce({
            isBusy: () => uninstalling,
            manual: true,
            requestedAt,
            getAuth,
            // Reported BEFORE the installer stops this service - afterwards it cannot.
            onProgress: (stage, info) => { if (stage === 'updating') say(updater.describeResult({ result: 'updating', ...info })); }
          });
          logger.log(`Update requested from the dashboard: ${r.result}${r.message ? ' - ' + r.message : ''}`);
          if (r.result !== 'updating') await say(updater.describeResult(r));
        } catch (e) {
          logger.log(`Update from the dashboard crashed: ${e.message}`);
        }
      }, delayMs);
      break;
    }
    case 'uninstall':
      logger.log('Uninstall command received - unlocking files (full scan), then stopping and removing service.');
      // Stop EVERYTHING that could re-lock files before the sweep starts.
      // Previously blocker.isBlocking() stayed true during the (slow) sweep,
      // so the 3-minute lock scan could re-lock files that were already
      // released - and since locked-files.json is deleted right after, no
      // one would ever unlock them again.
      uninstalling = true;
      clearTimeout(temporaryUnlockTimer);
      clearInterval(lockScanTimer);
      clearInterval(quickScanTimer);
      clearInterval(deepSweepTimer);
      watcher.stop();
      blocker.setBlocking(false);
      blocker.stop();
      // Give an in-flight lockFile() a moment to finish so the sweep below
      // sees (and releases) it.
      await new Promise((r) => setTimeout(r, 2000));
      // Full sweep, not just tracked files - same reasoning as the
      // --unlock-files path used by the normal Windows uninstaller.
      let unlockResult = null;
      try {
        unlockResult = await fileLock.unlockAllByScan();
      } catch (e) {
        logger.log(`Unlock sweep failed: ${e.message}`);
      }
      // Ack must never abort the uninstall: the command was already popped
      // from the server queue, so a network failure here would otherwise
      // leave the agent running (and blocking again) with no way to retry.
      try {
        await api.ack(deviceId, deviceToken, cmd.id, 'התוכנה הוסרה לפי בקשה מהדשבורד');
      } catch (e) {
        logger.log(`Ack failed (continuing uninstall): ${e.message}`);
      }
      // Remove the device from the dashboard too, right before this
      // process exits - otherwise it would just sit there forever showing
      // "offline" after the software is already gone.
      try {
        await api.unregister(deviceId, deviceToken, removalSummary('הסרה מהדשבורד', unlockResult));
      } catch (e) {
        // not fatal - proceed with the actual uninstall regardless
      }
      await selfUninstall();
      process.exit(0);
      break;
    default:
      break;
  }
}

// The server tells us the newest version in every heartbeat answer, so a new release is picked up
// within about a minute without every computer polling GitHub. The random delay spreads a whole
// computer room over a minute instead of all downloading in the same second; the
// "Update agent" button in the dashboard skips it.
let autoUpdateSeen = '';
function maybeAutoUpdate(latestVersion) {
  if (!latestVersion || uninstalling || latestVersion === autoUpdateSeen) return;
  if (!updater.isNewer(latestVersion, require('../package.json').version)) return;
  autoUpdateSeen = latestVersion; // once per version; failures are retried by the 30-minute check
  const delayMs = Math.floor(Math.random() * 45 * 1000);
  logger.log(`Server reports version ${latestVersion} - checking for the update in ${Math.round(delayMs / 1000)}s.`);
  setTimeout(() => {
    updater.checkOnce({ isBusy: () => uninstalling, notify: (m) => alerts.report(m), getAuth }).catch(() => {});
  }, delayMs);
}

const getAuth = () => ({ deviceId, deviceToken });

async function heartbeatLoop() {
  if (uninstalling) return;
  try {
    const { unlockedUntil, commands, deviceNumber: num, latestVersion } = await api.heartbeat(deviceId, deviceToken);
    rememberDeviceNumber(num);
    if (lastHeartbeatOk !== true) {
      logger.log(lastHeartbeatOk === false ? 'Server connection restored (heartbeat OK).' : 'First heartbeat OK - connected to server.');
      lastHeartbeatOk = true;
    }

    // The server also reports the current unlock deadline on every
    // heartbeat (not just via the one-time 'unlock' command) so that if
    // the agent process restarts mid-unlock (crash, reboot), it picks the
    // active unlock back up instead of defaulting to locked. Only actually
    // re-apply it if it's a NEW deadline we haven't already scheduled for -
    // otherwise every single heartbeat during a 15-minute unlock window
    // would redundantly re-run the whole unlock flow.
    if (unlockedUntil && new Date(unlockedUntil) > new Date()) {
      if (appliedUnlockUntil !== unlockedUntil) {
        await scheduleReLock(unlockedUntil);
      }
    } else {
      appliedUnlockUntil = null;
    }

    for (const cmd of commands) {
      await applyCommand(cmd);
    }
    maybeAutoUpdate(latestVersion);
    writeCurrentStatus();
  } catch (err) {
    if (err.response && err.response.status === 401) {
      // Our locally-saved device id/token is no longer recognized by the
      // server - most likely the device was deleted from the dashboard, or
      // the server's data store was reset. Rather than fail forever with
      // the same stale credentials, wipe local identity and register as a
      // (functionally) new device on the next heartbeat.
      logger.log('Server rejected credentials (401) - re-registering as a new device.');
      identity.clearState();
      try {
        const state = await ensureRegistered();
        deviceId = state.deviceId;
        deviceToken = state.deviceToken;
        logger.log(`Re-registered. New device ID: ${deviceId}`);
      } catch (reregisterErr) {
        logger.log(`Re-registration failed: ${reregisterErr.message}`);
      }
      return;
    }
    // Network hiccup / server temporarily down - just try again next cycle.
    // Logged once per outage (not every 45s) to keep the log readable.
    if (lastHeartbeatOk !== false) {
      logger.log(`Heartbeat failed (will keep retrying): ${err.message}`);
    }
    lastHeartbeatOk = false;
    writeCurrentStatus();
  }
}

async function main() {
  await ensureNssmExitPolicy();
  const state = await ensureRegistered();
  deviceId = state.deviceId;
  deviceToken = state.deviceToken;
  const version = require('../package.json').version;
  logger.log(`Agent v${version} starting. Device ID: ${deviceId}. Blocked extensions: ${config.MOVIE_EXTENSIONS.join(', ')}`);

  // If watchdog.bat just resumed us from a PAUSED state (something else on
  // this machine paused the service - the agent itself never does), it left
  // a marker line in the log right before restarting us. Surface that on the
  // dashboard so it's visible without having to check each machine by hand.
  // Read-only: this only reports, it never touches the other service.
  try {
    const tail = fs.readFileSync(logger.LOG_FILE, 'utf8').split('\n').slice(-20);
    const pausedLine = tail.reverse().find((l) => l.includes('[watchdog] Service was PAUSED'));
    if (pausedLine) {
      alerts.report(`השירות הושהה על ידי תוכנה אחרת במחשב (לא על ידי הסוכן) וחזר לפעול אוטומטית: ${pausedLine.trim()}`);
    }
  } catch (e) { /* log file may not exist yet on first-ever run */ }

  // Diagnostics: who the service runs as matters - locking files needs
  // SYSTEM / administrator rights.
  try {
    const { stdout } = await execAsync('whoami');
    logger.log(`Running as: ${stdout.trim()} | exe: ${process.execPath} | logs: ${logger.LOG_FILE}`);
  } catch (e) {
    logger.log(`whoami failed: ${e.message}`);
  }
  logger.log(`Blocking is ${blocker.isBlocking() ? 'ON' : 'OFF'} at startup. Previously tracked locked files: see locked-files.json.`);

  blocker.start();

  // Best-effort, runs once per startup; see defender.js for why this exists.
  defender.ensureExclusions().catch(() => {});

  // 1) QUICK scan of user folders (Videos, Downloads, Desktop, Public...)
  //    runs immediately - seconds, not minutes - so files people actually
  //    use are locked right away.
  // 2) Then the slow full-drive scan runs in the background.
  // Neither blocks startup or the heartbeat.
  const keepGoing = () => blocker.isBlocking();
  fileLock
    .lockPriority(keepGoing)
    .then(() => fileLock.lockAll(keepGoing))
    .then(() => fileLock.lockDisguised(keepGoing))
    .catch((err) => logger.log(`Initial file-lock scan failed: ${err.message}`));

  // Near-real-time: react to new/renamed files within about a second (see watcher.js).
  if (config.REALTIME_WATCH) watcher.start();

  // Tamper alerts go to the dashboard as events (needs a registered device).
  alerts.setSender(async (message) => {
    if (!deviceId || !deviceToken) throw new Error('not registered yet');
    await api.ack(deviceId, deviceToken, undefined, message);
  });

  // Quick re-scan every ~30s catches newly created/copied videos fast; the
  // full scan every 3 min catches everything else. Both are guarded inside
  // fileLock so a slow scan is never started on top of itself.
  quickScanTimer = setInterval(() => {
    if (!uninstalling && blocker.isBlocking()) {
      fileLock.lockPriority(keepGoing).catch((err) => logger.log(`Quick scan failed: ${err.message}`));
    }
  }, config.FILE_LOCK_QUICK_INTERVAL_MS);
  lockScanTimer = setInterval(() => {
    if (!uninstalling && blocker.isBlocking()) {
      fileLock.lockAll(keepGoing).catch((err) => logger.log(`File-lock scan failed: ${err.message}`));
    }
  }, config.FILE_LOCK_SCAN_INTERVAL_MS);

  // Content sweep (videos renamed to another extension), cached so repeats are cheap.
  deepSweepTimer = setInterval(() => {
    if (!uninstalling && blocker.isBlocking()) {
      fileLock.lockDisguised(keepGoing).catch((err) => logger.log(`Content sweep failed: ${err.message}`));
    }
  }, config.DEEP_SWEEP_INTERVAL_MS);

  writeCurrentStatus();
  await heartbeatLoop();
  setInterval(heartbeatLoop, config.HEARTBEAT_INTERVAL_MS);
  // Self-update from the latest GitHub Release (see updater.js).
  updater.start({ isBusy: () => uninstalling, notify: (m) => alerts.report(m), getAuth });
  // Update report for the dashboard (how long the last update took / why it failed).
  const sendUpdateReport = (rep) => api.updateReport(deviceId, deviceToken, rep);
  setTimeout(() => updater.reportPending(sendUpdateReport).catch(() => {}), 5 * 1000);
  setInterval(() => { if (!uninstalling) updater.reportPending(sendUpdateReport).catch(() => {}); }, 60 * 1000);
  // Keeps `updated` fresh so the tray icon can tell the service is alive.
  setInterval(() => {
    if (!uninstalling) writeCurrentStatus();
  }, 15 * 1000);
}

main().catch((err) => {
  logger.log(`Fatal agent error: ${err.message}`);
  process.exit(1);
});
