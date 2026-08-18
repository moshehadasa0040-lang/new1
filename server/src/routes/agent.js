const express = require('express');
const { nanoid } = require('nanoid');
const store = require('../store');
const { requireDevice } = require('../auth');

const router = express.Router();

// The offline threshold: if a device hasn't sent a heartbeat in this many
// seconds, the dashboard will show it as offline (checked lazily on read).
const OFFLINE_AFTER_SECONDS = 90;

// POST /api/agent/register
// Called once, the first time the agent starts on a new machine.
// Body: { hardwareId: string, hostname: string, agentVersion: string }
// Returns: { deviceId, deviceToken }  -> the agent must store these locally
router.post('/register', async (req, res) => {
  const { hardwareId, hostname, agentVersion } = req.body || {};
  if (!hardwareId) return res.status(400).json({ error: 'hardwareId_required' });

  // Re-registration with the same hardware id (e.g. agent reinstalled but
  // somehow kept no local state) reuses the existing device instead of
  // creating a duplicate "ghost" device.
  const existing = await store.getDevice(hardwareId);
  if (existing) {
    await store.upsertDevice(hardwareId, {
      status: 'online',
      last_seen: new Date().toISOString(),
      hostname: hostname || existing.hostname || '',
      agent_version: agentVersion || existing.agent_version || ''
    });
    return res.json({ deviceId: hardwareId, deviceToken: existing.device_token });
  }

  const deviceToken = nanoid(32);
  await store.upsertDevice(hardwareId, {
    id: hardwareId,
    device_token: deviceToken,
    name: hostname || 'מחשב חדש',
    hostname: hostname || '',
    status: 'online',
    last_seen: new Date().toISOString(),
    unlocked_until: '',
    agent_version: agentVersion || '',
    created_at: new Date().toISOString()
  });
  await store.addEvent(hardwareId, 'המכשיר נרשם לראשונה');

  res.json({ deviceId: hardwareId, deviceToken });
});

// POST /api/agent/heartbeat
// Called periodically (e.g. every 30-60s) by the agent.
// Returns any pending commands and the current lock state.
router.post('/heartbeat', requireDevice, async (req, res) => {
  const device = req.device;

  await store.upsertDevice(device.id, {
    status: 'online',
    last_seen: new Date().toISOString()
  });

  const commands = await store.drainPendingCommands(device.id);

  res.json({
    unlockedUntil: device.unlocked_until || null,
    commands
  });
});

// POST /api/agent/ack
// The agent confirms a command was executed (e.g. uninstall completed just
// before the process exits).
router.post('/ack', requireDevice, async (req, res) => {
  const { commandId, message } = req.body || {};
  if (commandId) {
    await store.markCommandDone(commandId);
  }
  if (message) {
    await store.addEvent(req.device.id, message);
  }
  res.json({ ok: true });
});

// POST /api/agent/logs
// The agent uploads its recent local log lines here, in response to a
// 'send_logs' command queued from the dashboard.
router.post('/logs', requireDevice, async (req, res) => {
  const { logs } = req.body || {};
  await store.saveLogs(req.device.id, logs || '');
  res.json({ ok: true });
});

module.exports = { router, OFFLINE_AFTER_SECONDS };
