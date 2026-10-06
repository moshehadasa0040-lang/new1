const redis = require('./db');

// ---------------------------------------------------------------------------
// Key layout in Redis:
//   device:{id}                 hash    - device fields
//   devices:index               set     - all device ids
//   device:{id}:pending_cmds    list    - ids of commands awaiting delivery
//   cmd:{id}                    hash    - a single command
//   cmd:seq                     string  - auto-increment counter for command ids
//   device:{id}:events          list    - recent event log (capped at 50)
//   devices:numbers             set     - short human-friendly numbers (1,2,3...) currently in use
// ---------------------------------------------------------------------------

const MAX_EVENTS = 50;

function deviceKey(id) {
  return `device:${id}`;
}

// --- Devices -----------------------------------------------------------------

async function getDevice(id) {
  const data = await redis.hgetall(deviceKey(id));
  if (!data || !data.id) return null;
  return data;
}

async function upsertDevice(id, fields) {
  await redis.hset(deviceKey(id), fields);
  await redis.sadd('devices:index', id);
}

// --- Short device numbers --------------------------------------------------
// Every device gets a small number (1, 2, 3...) shown in the dashboard AND in
// the tray icon's menu/About on that PC, so when someone says "please unlock
// computer 7" the admin knows exactly which card to press. The LOWEST free
// number is used, so numbers stay short and are reused after a computer is
// removed. SADD is atomic, so two computers registering at the same moment can
// never claim the same number.
async function claimNumber(id) {
  const key = deviceKey(id);
  for (let attempt = 0; attempt < 25; attempt++) {
    const taken = new Set((await redis.smembers('devices:numbers')).map(Number));
    let n = 1;
    while (taken.has(n)) n += 1;
    if ((await redis.sadd('devices:numbers', String(n))) === 1) {
      // HSETNX: if a parallel request already numbered this device, keep that
      // one and give ours back.
      if ((await redis.hsetnx(key, 'number', String(n))) === 1) return n;
      await redis.srem('devices:numbers', String(n));
      return Number(await redis.hget(key, 'number'));
    }
  }
  throw new Error('could_not_claim_device_number');
}

// Devices registered before numbers existed get theirs lazily, the first time
// they are read (heartbeat or dashboard list).
async function ensureNumber(device) {
  if (device && device.id && !device.number) {
    device.number = String(await claimNumber(device.id));
  }
  return device;
}

async function listDevices() {
  const ids = await redis.smembers('devices:index');
  if (!ids.length) return [];
  const pipeline = redis.pipeline();
  ids.forEach((id) => pipeline.hgetall(deviceKey(id)));
  const results = await pipeline.exec();
  const devices = results.map(([, data]) => data).filter((d) => d && d.id);
  for (const d of devices) await ensureNumber(d);
  return devices.sort((a, b) => Number(a.number) - Number(b.number));
}

async function deleteDevice(id) {
  const number = await redis.hget(deviceKey(id), 'number');
  const pendingIds = await redis.lrange(`device:${id}:pending_cmds`, 0, -1);
  const pipeline = redis.pipeline();
  pendingIds.forEach((cmdId) => pipeline.del(`cmd:${cmdId}`));
  pipeline.del(deviceKey(id));
  pipeline.del(`device:${id}:pending_cmds`);
  pipeline.del(`device:${id}:events`);
  pipeline.del(`device:${id}:logs`);
  pipeline.srem('devices:index', id);
  if (number) pipeline.srem('devices:numbers', number); // free the number for reuse
  await pipeline.exec();
}

// --- Commands ------------------------------------------------------------

async function queueCommand(deviceId, type, payload = {}) {
  const id = await redis.incr('cmd:seq');
  await redis.hset(`cmd:${id}`, {
    id: String(id),
    device_id: deviceId,
    type,
    payload: JSON.stringify(payload),
    status: 'pending',
    created_at: new Date().toISOString()
  });
  await redis.rpush(`device:${deviceId}:pending_cmds`, id);
  return id;
}

// Fetches all pending commands for a device and marks them delivered.
// Called on every agent heartbeat.
//
// Pops items one at a time (LPOP) instead of the old approach of reading
// the whole list with LRANGE and then wiping it with a single DEL. That
// older approach had a real race: if an admin action (unlock/lock/
// send_logs/update_rules/uninstall - anything that calls queueCommand,
// i.e. RPUSH) landed in the brief window between the LRANGE snapshot and
// the DEL, the newly-pushed command id got wiped out by that DEL without
// ever being read or returned to the agent - it looked "sent" from the
// dashboard (the admin API call succeeded) but the device would never
// receive or execute it, with no error anywhere to explain why. LPOP only
// ever removes what actually existed in the list at the moment it's
// called, so anything an admin queues concurrently is simply left for the
// next heartbeat's drain instead of being silently discarded.
async function drainPendingCommands(deviceId) {
  const key = `device:${deviceId}:pending_cmds`;
  const count = await redis.llen(key);
  if (!count) return [];

  const popPipeline = redis.pipeline();
  for (let i = 0; i < count; i++) popPipeline.lpop(key);
  const popped = await popPipeline.exec();
  const ids = popped.map(([, id]) => id).filter(Boolean);
  if (!ids.length) return [];

  const pipeline = redis.pipeline();
  ids.forEach((id) => pipeline.hgetall(`cmd:${id}`));
  const results = await pipeline.exec();
  const commands = results.map(([, data]) => data).filter(Boolean);

  if (commands.length) {
    const markPipeline = redis.pipeline();
    commands.forEach((cmd) => {
      markPipeline.hset(`cmd:${cmd.id}`, { status: 'delivered', delivered_at: new Date().toISOString() });
    });
    await markPipeline.exec();
  }

  return commands.map((cmd) => ({ ...cmd, payload: JSON.parse(cmd.payload || '{}') }));
}

async function markCommandDone(commandId) {
  await redis.hset(`cmd:${commandId}`, { status: 'done' });
}

// --- Events ----------------------------------------------------------------

async function addEvent(deviceId, message) {
  const entry = JSON.stringify({ message, created_at: new Date().toISOString() });
  await redis.lpush(`device:${deviceId}:events`, entry);
  await redis.ltrim(`device:${deviceId}:events`, 0, MAX_EVENTS - 1);
}

async function listEvents(deviceId) {
  const raw = await redis.lrange(`device:${deviceId}:events`, 0, MAX_EVENTS - 1);
  return raw.map((e) => JSON.parse(e));
}

// --- Removed devices ---------------------------------------------------------
// When an agent removes itself it is deleted from the device list; this short
// list keeps the last removals (with the agent's own verification summary) so
// the owner can still see that the removal went through cleanly.

async function addRemoval(entry) {
  await redis.lpush('removed_devices', JSON.stringify(entry));
  await redis.ltrim('removed_devices', 0, 29);
}

async function listRemovals() {
  const raw = await redis.lrange('removed_devices', 0, 29);
  return raw.map((e) => JSON.parse(e));
}

// --- Logs --------------------------------------------------------------------
// The agent only uploads logs when asked (via a queued 'send_logs' command),
// so we just keep the single most recent upload per device rather than a
// growing history.

async function saveLogs(deviceId, content) {
  await redis.hset(`device:${deviceId}:logs`, {
    content,
    updated_at: new Date().toISOString()
  });
}

async function getLogs(deviceId) {
  const data = await redis.hgetall(`device:${deviceId}:logs`);
  if (!data || !data.content) return null;
  return data;
}

module.exports = {
  getDevice,
  ensureNumber,
  upsertDevice,
  listDevices,
  deleteDevice,
  queueCommand,
  drainPendingCommands,
  markCommandDone,
  addEvent,
  listEvents,
  saveLogs,
  getLogs,
  addRemoval,
  listRemovals
};
