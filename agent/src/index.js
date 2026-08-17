const config = require('./config');
const identity = require('./identity');
const api = require('./api');
const blocker = require('./blocker');
const { selfUninstall } = require('./uninstall');

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

function scheduleReLock(untilIso) {
  clearTimeout(temporaryUnlockTimer);
  const msRemaining = new Date(untilIso).getTime() - Date.now();
  if (msRemaining <= 0) {
    blocker.setBlocking(true);
    return;
  }
  blocker.setBlocking(false);
  temporaryUnlockTimer = setTimeout(() => {
    blocker.setBlocking(true);
  }, msRemaining);
}

async function applyCommand(cmd) {
  switch (cmd.type) {
    case 'unlock':
      scheduleReLock(cmd.payload.until);
      break;
    case 'lock':
      clearTimeout(temporaryUnlockTimer);
      blocker.setBlocking(true);
      break;
    case 'update_rules':
      if (cmd.payload && cmd.payload.blockedProcesses) {
        blocker.setBlockList(cmd.payload.blockedProcesses);
      }
      break;
    case 'uninstall':
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
      scheduleReLock(unlockedUntil);
    }

    for (const cmd of commands) {
      await applyCommand(cmd);
    }
  } catch (err) {
    // Network hiccup / server temporarily down - just try again next cycle.
    console.error('Heartbeat failed:', err.message);
  }
}

async function main() {
  const state = await ensureRegistered();
  deviceId = state.deviceId;
  deviceToken = state.deviceToken;

  blocker.start();
  await heartbeatLoop();
  setInterval(heartbeatLoop, config.HEARTBEAT_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal agent error:', err);
  process.exit(1);
});
