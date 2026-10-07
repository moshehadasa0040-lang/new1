const express = require('express');
const crypto = require('crypto');
const store = require('../store');
const { requireAdmin } = require('../auth');
const { OFFLINE_AFTER_SECONDS } = require('./agent');
const release = require('../release');

const router = express.Router();

// --- Login / logout ---------------------------------------------------------
// Very small in-memory brute-force guard: max 10 failed attempts per IP per
// 15 minutes. (Resets on server restart - fine for a single small instance.)
const failedLogins = new Map();
const MAX_FAILED = 10;
const WINDOW_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'server_missing_admin_password_env' });
  }
  const now = Date.now();
  const rec = failedLogins.get(req.ip);
  if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_FAILED) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  if (typeof password !== 'string' || !safeEqual(password, process.env.ADMIN_PASSWORD)) {
    if (!rec || now - rec.first >= WINDOW_MS) {
      failedLogins.set(req.ip, { first: now, count: 1 });
    } else {
      rec.count += 1;
    }
    return res.status(401).json({ error: 'wrong_password' });
  }
  failedLogins.delete(req.ip);
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

// --- Latest agent version + installer download ---------------------------------
router.get('/latest-release', requireAdmin, async (req, res) => {
  try {
    const { version, published_at, size } = await release.getLatest();
    res.json({ version, published_at, size, remote_update_min: release.REMOTE_UPDATE_MIN });
  } catch (e) {
    res.status(502).json({ error: 'github_unreachable' });
  }
});

router.get('/installer', requireAdmin, async (req, res) => {
  try {
    await release.streamInstaller(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message || 'download_failed' });
    else res.destroy();
  }
});

// --- "Update agent" button -----------------------------------------------------
// The agent picks the command up on its next heartbeat, checks GitHub, downloads +
// verifies (SHA-256) + installs, and writes the outcome to the device's event list.
function canRemoteUpdate(d) {
  return !!(d.agent_version_at && d.agent_version && release.cmpVersion(d.agent_version, release.REMOTE_UPDATE_MIN) >= 0);
}

// All online computers that are behind the latest release. Spaced 15s apart so they
// do not hit GitHub's anonymous API limit (60/hour per IP) at the same moment.
router.post('/devices/update-outdated', requireAdmin, async (req, res) => {
  let latest;
  try { latest = (await release.getLatest()).version; } catch (e) { return res.status(502).json({ error: 'github_unreachable' }); }
  const now = Date.now();
  const rows = await store.listDevices();
  const targets = rows.filter((d) =>
    canRemoteUpdate(d) &&
    release.cmpVersion(d.agent_version, latest) < 0 &&
    d.last_seen && (now - new Date(d.last_seen).getTime()) / 1000 <= OFFLINE_AFTER_SECONDS
  );
  let i = 0;
  for (const d of targets) {
    await store.queueCommand(d.id, 'update', { delaySec: i * 15 });
    await store.addEvent(d.id, `התבקש עדכון הסוכן לגרסה ${latest} (עדכון קבוצתי)`);
    i += 1;
  }
  res.json({ ok: true, queued: targets.length, latest });
});

router.post('/devices/:id/update', requireAdmin, async (req, res) => {
  await store.queueCommand(req.params.id, 'update', { delaySec: 0 });
  await store.addEvent(req.params.id, 'התבקש עדכון הסוכן מהדשבורד');
  res.json({ ok: true });
});

router.get('/removed', requireAdmin, async (req, res) => {
  res.json({ removed: await store.listRemovals() });
});

router.get('/devices/:id/events', requireAdmin, async (req, res) => {
  const events = await store.listEvents(req.params.id);
  res.json({ events });
});

// --- Rename ------------------------------------------------------------------
router.post('/devices/:id/rename', requireAdmin, async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!(await store.getDevice(req.params.id))) return res.status(404).json({ error: 'not_found' });
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

// --- Logs --------------------------------------------------------------------
// Queues a request; the agent uploads its log on its next heartbeat.
router.post('/devices/:id/request-logs', requireAdmin, async (req, res) => {
  await store.queueCommand(req.params.id, 'send_logs');
  res.json({ ok: true });
});

router.get('/devices/:id/logs', requireAdmin, async (req, res) => {
  const logs = await store.getLogs(req.params.id);
  res.json({ logs });
});

// --- Update blocked process list --------------------------------------------
router.post('/devices/:id/update-rules', requireAdmin, async (req, res) => {
  const { blockedProcesses } = req.body || {};
  if (!Array.isArray(blockedProcesses) || !blockedProcesses.length) {
    return res.status(400).json({ error: 'blockedProcesses_required' });
  }
  await store.queueCommand(req.params.id, 'update_rules', { blockedProcesses });
  await store.addEvent(req.params.id, `רשימת החסימה עודכנה: ${blockedProcesses.join(', ')}`);
  res.json({ ok: true });
});

// --- Remove from dashboard -------------------------------------------------
router.delete('/devices/:id', requireAdmin, async (req, res) => {
  await store.deleteDevice(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
