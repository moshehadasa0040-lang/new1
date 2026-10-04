const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const config = require('./config');
const identity = require('./identity');
const api = require('./api');
const blocker = require('./blocker');
const fileLock = require('./fileLock');
const logger = require('./logger');
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

// Support mode: the installer's uninstaller invokes the packaged exe with
// this flag, BEFORE deleting any files, so that locally-locked video files
// get their NTFS permissions restored even when someone uninstalls the
// normal way (Windows "Apps" settings / Add-Remove Programs) rather than
// through the dashboard's "uninstall" button. Without this, removing the
// software any other way would leave video files permanently locked -
// which would be a real problem for someone's own legitimate files.
if (process.argv.includes('--unlock-files')) {
  (async () => {
    try {
      await fileLock.unlockAllByScan();
    } catch (e) {
      // best-effort - don't let a scan failure block the uninstall
    }
    // Also removes the device from the dashboard entirely, instead of
    // leaving a stale "offline" card that someone has to notice and clean
    // up by hand. Uses whatever credentials were saved locally, if any.
    try {
      const state = identity.loadState();
      if (state && state.deviceId && state.deviceToken) {
        await api.unregister(state.deviceId, state.deviceToken);
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
    try {
      logger.log(`Agent v${require('../package.json').version}: --lock-files (installer mode) started.`);
      await fileLock.lockEverythingVerified();
    } catch (e) {
      logger.log(`--lock-files failed: ${e.message}`);
    }
    process.exit(0);
  })();
  return; // eslint-disable-line no-unreachable
}

let deviceId, deviceToken;
let temporaryUnlockTimer = null;
let appliedUnlockUntil = null; // dedup guard - avoid reapplying the same unlock on every heartbeat
let lockScanTimer = null;
let quickScanTimer = null;
let lastHeartbeatOk = null; // null = unknown yet; used to log only on state CHANGES
// Set the moment a remote 'uninstall' command starts. From then on, nothing
// (periodic lock scan, heartbeat, 401 re-registration) is allowed to
// re-lock files or re-register the device while the unlock sweep runs.
let uninstalling = false;

async function ensureRegistered() {
  let state = identity.loadState();
  if (state && state.deviceId && state.deviceToken) {
    return state;
  }
  const hardwareId = identity.getHardwareId();
  const { deviceId, deviceToken } = await api.register(hardwareId);
  state = { deviceId, deviceToken };
  identity.saveState(state);
  return state;
}

async function reLockNow() {
  appliedUnlockUntil = null;
  blocker.setBlocking(true);
  logger.log('Re-locking video files now.');
  const keepGoing = () => blocker.isBlocking();
  await fileLock.lockPriority(keepGoing, { force: true });
  await fileLock.lockAll(keepGoing, { force: true });
}

async function temporarilyUnlockNow() {
  blocker.setBlocking(false);
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
        const recentLogs = logger.getRecent(500);
        await api.sendLogs(deviceId, deviceToken, recentLogs);
      } catch (err) {
        logger.log(`Failed to upload logs: ${err.message}`);
      }
      break;
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
      blocker.setBlocking(false);
      blocker.stop();
      // Give an in-flight lockFile() a moment to finish so the sweep below
      // sees (and releases) it.
      await new Promise((r) => setTimeout(r, 2000));
      // Full sweep, not just tracked files - same reasoning as the
      // --unlock-files path used by the normal Windows uninstaller.
      try {
        await fileLock.unlockAllByScan();
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
        await api.unregister(deviceId, deviceToken);
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

async function heartbeatLoop() {
  if (uninstalling) return;
  try {
    const { unlockedUntil, commands } = await api.heartbeat(deviceId, deviceToken);
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
  }
}

async function main() {
  await ensureNssmExitPolicy();
  const state = await ensureRegistered();
  deviceId = state.deviceId;
  deviceToken = state.deviceToken;
  const version = require('../package.json').version;
  logger.log(`Agent v${version} starting. Device ID: ${deviceId}. Blocked extensions: ${config.MOVIE_EXTENSIONS.join(', ')}`);

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

  // 1) QUICK scan of user folders (Videos, Downloads, Desktop, Public...)
  //    runs immediately - seconds, not minutes - so files people actually
  //    use are locked right away.
  // 2) Then the slow full-drive scan runs in the background.
  // Neither blocks startup or the heartbeat.
  const keepGoing = () => blocker.isBlocking();
  fileLock
    .lockPriority(keepGoing)
    .then(() => fileLock.lockAll(keepGoing))
    .catch((err) => logger.log(`Initial file-lock scan failed: ${err.message}`));

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

  await heartbeatLoop();
  setInterval(heartbeatLoop, config.HEARTBEAT_INTERVAL_MS);
}

main().catch((err) => {
  logger.log(`Fatal agent error: ${err.message}`);
  process.exit(1);
});
