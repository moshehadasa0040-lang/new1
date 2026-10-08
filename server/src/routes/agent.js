const express = require('express');
const { nanoid } = require('nanoid');
const store = require('../store');
const { requireDevice } = require('../auth');
const release = require('../release');

const router = express.Router();

// The offline threshold: if a device hasn't sent a heartbeat in this many
// seconds, the dashboard will show it as offline (checked lazily on read).
const OFFLINE_AFTER_SECONDS = 90;

// An agent that is still behind the latest release this long after it was seen behind is "stuck":
// the server then asks it for its log by itself (no need to click anything).
const STUCK_AFTER_MS = 10 * 60 * 1000;
const AUTO_LOG_GAP_MS = 30 * 60 * 1000;   // not more often than this per computer
const AUTO_LOG_MAX_PER_EPISODE = 3;       // and at most this many times per stuck update
const SELF_UPDATE_MIN = '1.13.15';         // first agent version that updates itself from the heartbeat

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
// Sent by the agent after an update (see updater.js reportPending): how long it took.
function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '';
  if (sec < 60) return `${sec} שניות`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} דקות`;
}

router.post('/update-report', requireDevice, async (req, res) => {
  const b = req.body || {};
  const num = (v) => { const n = Number(v); return v !== null && v !== undefined && Number.isFinite(n) && n >= 0 && n < 86400 ? Math.round(n) : null; };
  const ver = (v) => (/^[0-9A-Za-z.+-]{1,32}$/.test(String(v || '')) ? String(v) : '');
  const rec = {
    at: new Date().toISOString(),
    from: ver(b.from),
    to: ver(b.to),
    result: b.result === 'success' ? 'success' : 'failed',
    trigger: b.trigger === 'auto' || b.trigger === 'dashboard' ? b.trigger : 'unknown',
    total_sec: num(b.totalSec),
    wait_sec: num(b.waitSec),
    download_sec: num(b.downloadSec),
    install_sec: num(b.installSec),
    gap_sec: num(b.gapSec), // how long the protection was off while the service restarted
    error: String(b.error || '').slice(0, 200)
  };
  await store.addUpdateRecord(req.device.id, rec);
  await store.upsertDevice(req.device.id, { last_update: JSON.stringify(rec) });
  const route = rec.from ? `${rec.from} ← ${rec.to}` : `גרסה ${rec.to}`;
  const parts = [];
  if (rec.download_sec !== null) parts.push(`הורדה ${fmtDuration(rec.download_sec)}`);
  if (rec.install_sec !== null) parts.push(`התקנה ${fmtDuration(rec.install_sec)}`);
  if (rec.gap_sec !== null) parts.push(`הפסקת הגנה ~${fmtDuration(rec.gap_sec)}`);
  if (rec.result === 'success') {
    const total = rec.total_sec !== null ? `זמן כולל ${fmtDuration(rec.total_sec)}` : '';
    await store.addEvent(req.device.id, `העדכון הושלם: ${route}${total ? ' · ' + total : ''}${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
  } else {
    await store.addEvent(req.device.id, `העדכון נכשל: ${route}${rec.error ? ' · ' + rec.error : ''}${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
  }
  res.json({ ok: true });
});

router.post('/heartbeat', requireDevice, async (req, res) => {
  const device = req.device;

  const fields = {
    status: 'online',
    last_seen: new Date().toISOString()
  };
  // Agents from 1.13.8 on report their real version on every heartbeat.
  // agent_version_at marks that the number is live (older records only hold
  // the version from the first registration, which goes stale after updates).
  const reported = String((req.body && req.body.agentVersion) || '').trim();
  if (/^[0-9A-Za-z.+-]{1,32}$/.test(reported) && (reported !== device.agent_version || !device.agent_version_at)) {
    fields.agent_version = reported;
    fields.agent_version_at = new Date().toISOString();
  }

  // Stuck-update detection: behind the newest release for too long -> ask for the log automatically.
  const latest = release.peekLatestVersion();
  const effective = fields.agent_version || device.agent_version || '';
  const nowMs = Date.now();
  let autoLogs = false;
  // A computer that was unreachable for a while (night-time network block, switched off) gets a fresh
  // start: the time it was away must not count as "stuck", it has not even had a chance to update yet.
  const awayMs = device.last_seen ? nowMs - new Date(device.last_seen).getTime() : 0;
  if (latest && effective && release.cmpVersion(effective, latest) < 0) {
    if (!device.outdated_since || awayMs > 5 * 60 * 1000) {
      fields.outdated_since = new Date().toISOString();
      fields.auto_logs_count = '0';
    } else if (
      release.cmpVersion(effective, SELF_UPDATE_MIN) >= 0 &&
      nowMs - new Date(device.outdated_since).getTime() > STUCK_AFTER_MS &&
      nowMs - (Number(device.auto_logs_ms) || 0) > AUTO_LOG_GAP_MS &&
      (Number(device.auto_logs_count) || 0) < AUTO_LOG_MAX_PER_EPISODE
    ) {
      autoLogs = true;
      fields.auto_logs_ms = String(nowMs);
      fields.auto_logs_count = String((Number(device.auto_logs_count) || 0) + 1);
    }
  } else if (latest && effective && (device.outdated_since || device.auto_logs_count)) {
    fields.outdated_since = '';
    fields.auto_logs_count = '0';
  }
  await store.upsertDevice(device.id, fields);
  if (autoLogs) {
    await store.queueCommand(device.id, 'send_logs', { reason: 'update_stuck' });
    await store.addEvent(device.id, `העדכון ל-${latest} לא הושלם כבר יותר מ-10 דקות - נשלח אוטומטית לוג מהמחשב (יופיע בכפתור "הצג לוג")`);
  }

  await store.ensureNumber(device);
  const commands = await store.drainPendingCommands(device.id);

  res.json({
    unlockedUntil: device.unlocked_until || null,
    // The agent shows this number in its tray icon menu / About window.
    deviceNumber: Number(device.number),
    // Newest published agent version (cached; never blocks the heartbeat on GitHub).
    latestVersion: release.peekLatestVersion(),
    commands
  });
});

// The agent downloads its updates from here instead of from GitHub: no GitHub rate limit
// (one lookup serves all computers) and it works on networks that filter GitHub.
router.get('/update-info', requireDevice, async (req, res) => {
  try {
    const i = await release.getLatest();
    res.json({ version: i.version, size: i.size, sha256: i.sha256, ready: !!(i.assetUrl && i.sha256) });
  } catch (e) {
    res.status(502).json({ error: 'github_unreachable' });
  }
});

router.get('/installer', requireDevice, async (req, res) => {
  try {
    await release.streamInstaller(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message || 'download_failed' });
    else res.destroy();
  }
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
  const { logs, reason } = req.body || {};
  const why = ['requested', 'update_stuck', 'update_failed'].includes(reason) ? reason : 'requested';
  // Every log starts with WHO it is from, so a pasted log can always be matched to its computer.
  const d = req.device;
  const header = `##### מחשב מספר ${d.number || '?'} | שם בדשבורד: ${d.name || '-'} | שם ברשת: ${d.hostname || '-'} | מזהה: ${String(d.id || '').slice(0, 8)} | גרסת סוכן: ${d.agent_version || '-'} #####\n\n`;
  await store.saveLogs(req.device.id, header + String(logs || '').slice(0, 100000), why);
  if (why !== 'requested') {
    await store.addEvent(req.device.id, why === 'update_failed' ? 'התקבל לוג אוטומטי אחרי עדכון שנכשל' : 'התקבל לוג אוטומטי מעדכון תקוע');
  }
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

module.exports = { router, OFFLINE_AFTER_SECONDS, STUCK_AFTER_MS };
