const redis = require('./db');

// ---------------------------------------------------------------------------
// Key layout in Redis:
//   device:{id}                 hash    - device fields
//   devices:index               set     - all device ids
//   device:{id}:pending_cmds    list    - ids of commands awaiting delivery
//   cmd:{id}                    hash    - a single command
//   cmd:seq                     string  - auto-increment counter for command ids
//   device:{id}:events          list    - recent event log (capped at 50)
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

async function listDevices() {
  const ids = await redis.smembers('devices:index');
  if (!ids.length) return [];
  const pipeline = redis.pipeline();
  ids.forEach((id) => pipeline.hgetall(deviceKey(id)));
  const results = await pipeline.exec();
  return results
    .map(([, data]) => data)
    .filter((d) => d && d.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function deleteDevice(id) {
  const pendingIds = await redis.lrange(`device:${id}:pending_cmds`, 0, -1);
  const pipeline = redis.pipeline();
  pendingIds.forEach((cmdId) => pipeline.del(`cmd:${cmdId}`));
  pipeline.del(deviceKey(id));
  pipeline.del(`device:${id}:pending_cmds`);
  pipeline.del(`device:${id}:events`);
  pipeline.del(`device:${id}:logs`);
  pipeline.srem('devices:index', id);
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
  upsertDevice,
  listDevices,
  deleteDevice,
  queueCommand,
  drainPendingCommands,
  markCommandDone,
  addEvent,
  listEvents,
  saveLogs,
  getLogs
};
