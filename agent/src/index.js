const config = require('./config');
const identity = require('./identity');
const api = require('./api');
const blocker = require('./blocker');
const fileLock = require('./fileLock');
const logger = require('./logger');
const { selfUninstall } = require('./uninstall');

// Support mode: the installer's uninstaller invokes the packaged exe with
// this flag, BEFORE deleting any files, so that locally-locked video files
// get their NTFS permissions restored even when someone uninstalls the
// normal way (Windows "Apps" settings / Add-Remove Programs) rather than
// through the dashboard's "uninstall" button. Without this, removing the
// software any other way would leave video files permanently locked -
// which would be a real problem for someone's own legitimate files.
if (process.argv.includes('--unlock-files')) {
  fileLock
    .unlockAll()
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // exit cleanly either way - this must
    // never block or fail the uninstall itself.
  return; // eslint-disable-line no-unreachable
}

let deviceId, deviceToken;
let temporaryUnlockTimer = null;

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
  blocker.setBlocking(true);
  await fileLock.lockAll();
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
  await temporarilyUnlockNow();
  temporaryUnlockTimer = setTimeout(reLockNow, msRemaining);
}

async function applyCommand(cmd) {
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
      logger.log('Uninstall command received - unlocking files, then stopping and removing service.');
      // Always restore file access before removing the software - we never
      // want to leave someone's files permanently inaccessible.
      await fileLock.unlockAll();
      await api.ack(deviceId, deviceToken, cmd.id, 'התוכנה הוסרה לפי בקשה מהדשבורד');
      await selfUninstall();
      process.exit(0);
      break;
    default:
      break;
  }
}

async function heartbeatLoop() {
  try {
    const { unlockedUntil, commands } = await api.heartbeat(deviceId, deviceToken);

    if (unlockedUntil && new Date(unlockedUntil) > new Date()) {
      await scheduleReLock(unlockedUntil);
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
    logger.log(`Heartbeat failed: ${err.message}`);
  }
}

async function main() {
  const state = await ensureRegistered();
  deviceId = state.deviceId;
  deviceToken = state.deviceToken;
  const version = require('../package.json').version;
  logger.log(`Agent v${version} starting. Device ID: ${deviceId}. Blocked extensions: ${config.MOVIE_EXTENSIONS.join(', ')}`);

  blocker.start();

  // Initial full scan+lock of existing video files - don't block startup
  // on this (it can take a while on a large disk), let it run in the
  // background while process-based blocking is already active.
  fileLock.lockAll().catch((err) => logger.log(`Initial file-lock scan failed: ${err.message}`));
  setInterval(() => {
    if (blocker.isBlocking()) {
      fileLock.lockAll().catch((err) => logger.log(`File-lock scan failed: ${err.message}`));
    }
  }, config.FILE_LOCK_SCAN_INTERVAL_MS);

  await heartbeatLoop();
  setInterval(heartbeatLoop, config.HEARTBEAT_INTERVAL_MS);
}

main().catch((err) => {
  logger.log(`Fatal agent error: ${err.message}`);
  process.exit(1);
});
