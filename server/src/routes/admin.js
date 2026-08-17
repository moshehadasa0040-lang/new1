const express = require('express');
const store = require('../store');
const { requireAdmin } = require('../auth');
const { OFFLINE_AFTER_SECONDS } = require('./agent');

const router = express.Router();

// --- Login / logout ---------------------------------------------------------
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'server_missing_admin_password_env' });
  }
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'wrong_password' });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// --- Device list -------------------------------------------------------------
// Marks a device offline (in the response only) if its last heartbeat is
// older than OFFLINE_AFTER_SECONDS - this is what lets the dashboard show
// "offline" promptly after a format/removal, without a background cron job.
router.get('/devices', requireAdmin, async (req, res) => {
  const rows = await store.listDevices();
  const now = Date.now();
  const devices = rows.map((d) => {
    const lastSeenMs = d.last_seen ? new Date(d.last_seen).getTime() : 0;
    const staleFor = (now - lastSeenMs) / 1000;
    const status = staleFor > OFFLINE_AFTER_SECONDS ? 'offline' : d.status;
    return { ...d, status };
  });
  res.json({ devices });
});

router.get('/devices/:id/events', requireAdmin, async (req, res) => {
  const events = await store.listEvents(req.params.id);
  res.json({ events });
});

// --- Rename ------------------------------------------------------------------
router.post('/devices/:id/rename', requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name_required' });
  await store.upsertDevice(req.params.id, { name });
  res.json({ ok: true });
});

// --- Temporary unlock ----------------------------------------------------
// minutes: how long blocking should be suspended for.
router.post('/devices/:id/unlock', requireAdmin, async (req, res) => {
  const minutes = Number(req.body?.minutes) || 15;
  const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();

  await store.upsertDevice(req.params.id, { unlocked_until: until });
  await store.queueCommand(req.params.id, 'unlock', { until });
  await store.addEvent(req.params.id, `נפתח זמנית ל-${minutes} דקות`);
  res.json({ ok: true, until });
});

// Re-lock immediately (cancel a temporary unlock early).
router.post('/devices/:id/lock', requireAdmin, async (req, res) => {
  await store.upsertDevice(req.params.id, { unlocked_until: '' });
  await store.queueCommand(req.params.id, 'lock');
  await store.addEvent(req.params.id, 'ננעל מחדש ידנית');
  res.json({ ok: true });
});

// --- Uninstall -----------------------------------------------------------
// Queues an uninstall command; the agent picks it up on its next heartbeat,
// removes itself, and the device will then simply stop sending heartbeats
// (dashboard will show it as offline; use "remove" below to delete it).
router.post('/devices/:id/uninstall', requireAdmin, async (req, res) => {
  await store.queueCommand(req.params.id, 'uninstall');
  await store.addEvent(req.params.id, 'התבקשה הסרת התוכנה');
  res.json({ ok: true });
});

// --- Remove from dashboard -------------------------------------------------
router.delete('/devices/:id', requireAdmin, async (req, res) => {
  await store.deleteDevice(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
