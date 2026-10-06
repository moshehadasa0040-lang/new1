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
// Body: { hardwareId, hostname, deviceName, agentVersion }
// Returns: { deviceId, deviceToken }  -> the agent must store these locally
router.post('/register', async (req, res) => {
  const { hardwareId, hostname, deviceName, agentVersion } = req.body || {};
  if (!hardwareId) return res.status(400).json({ error: 'hardwareId_required' });

  // Re-registration with the same hardware id (e.g. agent reinstalled but
  // somehow kept no local state) reuses the existing device instead of
  // creating a duplicate "ghost" device. Deliberately does NOT touch
  // `name` here - if the admin already renamed it in the dashboard, we
  // don't want every restart to silently overwrite that.
  const existing = await store.getDevice(hardwareId);
  if (existing) {
    await store.upsertDevice(hardwareId, {
      status: 'online',
      last_seen: new Date().toISOString(),
      hostname: hostname || existing.hostname || '',
      agent_version: agentVersion || existing.agent_version || ''
    });
    await store.ensureNumber(existing);
    return res.json({ deviceId: hardwareId, deviceToken: existing.device_token, deviceNumber: Number(existing.number) });
  }

  const deviceToken = nanoid(32);
  await store.upsertDevice(hardwareId, {
    id: hardwareId,
    device_token: deviceToken,
    // Prefer the friendly name entered during installation, if provided,
    // over the raw Windows computer name.
    name: (deviceName && deviceName.trim()) || hostname || 'מחשב חדש',
    hostname: hostname || '',
    status: 'online',
    last_seen: new Date().toISOString(),
    unlocked_until: '',
    agent_version: agentVersion || '',
    created_at: new Date().toISOString()
  });
  const deviceNumber = await store.ensureNumber({ id: hardwareId });
  await store.addEvent(hardwareId, `המכשיר נרשם לראשונה (מחשב מספר ${deviceNumber.number})`);

  res.json({ deviceId: hardwareId, deviceToken, deviceNumber: Number(deviceNumber.number) });
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

  await store.ensureNumber(device);
  const commands = await store.drainPendingCommands(device.id);

  res.json({
    unlockedUntil: device.unlocked_until || null,
    // The agent shows this number in its tray icon menu / About window.
    deviceNumber: Number(device.number),
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

// POST /api/agent/unregister
// Called by the agent itself right before it removes itself from a
// machine (both the normal Windows uninstall path and the dashboard's
// remote 'uninstall' command) - deletes the device from the dashboard
// entirely, instead of leaving a stale "offline" entry behind forever
// that someone would otherwise have to notice and clean up by hand.
router.post('/unregister', requireDevice, async (req, res) => {
  try {
    const d = req.device;
    await store.addRemoval({
      number: d.number || '',
      name: d.name || '',
      hostname: d.hostname || '',
      summary: String((req.body && req.body.summary) || '').slice(0, 500),
      removed_at: new Date().toISOString()
    });
  } catch (e) {
    // history is a nice-to-have, never block the removal
  }
  await store.deleteDevice(req.device.id);
  res.json({ ok: true });
});

module.exports = { router, OFFLINE_AFTER_SECONDS };
