const logger = require('./logger');

// ---------------------------------------------------------------------------
// Tamper alerts: things the dashboard owner should know about (a lock that
// somebody removed, an unknown program that was force-closed, ...).
// They are written to the local log with an [ALERT] prefix and, when the
// server is reachable, sent as an event (shown in the dashboard's "אירועים").
// The same message is not repeated more than once per DEDUPE_MS.
// ---------------------------------------------------------------------------

const DEDUPE_MS = 10 * 60 * 1000;
const lastSent = new Map();
let sender = null; // async (message) => void, set by index.js once registered
const backlog = [];

function setSender(fn) {
  sender = fn;
  while (backlog.length && sender) {
    const m = backlog.shift();
    lastSent.delete(m); // it was only remembered, never actually sent
    report(m, { noLog: true });
  }
}

function report(message, opts = {}) {
  if (!opts.noLog) logger.log(`[ALERT] ${message}`);
  const now = Date.now();
  if ((lastSent.get(message) || 0) > now - DEDUPE_MS) return;
  lastSent.set(message, now);
  if (lastSent.size > 500) for (const [k, t] of lastSent) if (t < now - DEDUPE_MS) lastSent.delete(k);
  if (!sender) {
    if (backlog.length < 50) backlog.push(message);
    return;
  }
  Promise.resolve()
    .then(() => sender(`⚠ ${message}`))
    .catch((e) => logger.log(`[alerts] could not send: ${e.message}`));
}

module.exports = { report, setSender };
