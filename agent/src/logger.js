const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOG_FILE = path.join(config.LOG_DIR, 'agent.log');
const LOG_FILE_OLD = path.join(config.LOG_DIR, 'agent.old.log');
const MAX_LOG_BYTES = 1024 * 1024; // 1MB - rotation trigger

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(config.LOG_DIR, { recursive: true });
    // Rotation: keep ONE previous file (agent.old.log) instead of throwing
    // history away, so a problem that happened shortly before rotation is
    // still visible.
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      try { fs.rmSync(LOG_FILE_OLD, { force: true }); } catch (e) { /* ignore */ }
      fs.renameSync(LOG_FILE, LOG_FILE_OLD);
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // best-effort - never let logging itself crash the agent
  }
  console.log(message);
}

// Returns a SHORT, useful excerpt of the log for uploading to the dashboard (send_logs command).
// Only the last 24 hours, and none of the routine noise: per-file lock lines, the every-10-minutes
// "scan started/found/finished" lines, permission (ACL) dumps, "No tasks are running", long lists
// of extensions/programs. Repeated lines are folded into one line with a counter.
const NOISE = [
  /Could not lock:|owner not changed|\[lock\] /,
  /^\s*(BUILTIN|NT AUTHORITY|APPLICATION PACKAGE AUTHORITY)\\/,
  /\(I\)\((F|RX)\)/,
  /Successfully processed \d+ files/,
  /^INFO: No tasks are running/,
  /Full scan (started|finished)|Drive [A-Z]:: (found \d+ video|newly locked 0,)/,
  /Defender exclusions set|\[watch\] Watching|Blocking is ON at startup|Running as:/
];

function lineTime(l) {
  let m = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/.exec(l);
  if (m) return new Date(m[1]).getTime();
  m = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\] installer:/.exec(l); // installer writes local time
  if (m) return new Date(`${m[1]}T${m[2]}`).getTime();
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
// Computer's own clock: 08.10.2026 11:25:47 (the same clock the installer lines use)
function fmtLocal(ms) {
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const fmtShort = (ms) => fmtLocal(ms).replace(/^(\d\d\.\d\d)\.\d{4} /, '$1 ');

// sinceMs: only lines from this moment on (used for update problems: from just before the attempt).
function getRecent(maxLines = 150, hours = 24, sinceMs = null) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '(no log file yet)';
    let lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length < maxLines * 3 && fs.existsSync(LOG_FILE_OLD)) {
      lines = fs.readFileSync(LOG_FILE_OLD, 'utf8').split('\n').filter(Boolean).concat(lines);
    }
    const cutoff = sinceMs || Date.now() - hours * 3600 * 1000;
    let omitted = 0;
    let last = Date.now();
    const groups = new Map();   // folded text -> { line, count, firstTs, lastTs }
    const order = [];
    for (let l of lines) {
      const t = lineTime(l);
      if (t !== null) last = t;
      if (last < cutoff) { omitted++; continue; }
      if (NOISE.some((re) => re.test(l))) { omitted++; continue; }
      l = l.replace(/Blocked extensions:.*$/, '').replace(/(Blocker started\.) Watching:.*$/, '$1');
      if (l.length > 240) l = l.slice(0, 240) + '...';
      const key = l.replace(/^\[[^\]]*\]\s*/, '').replace(/\d{2,}/g, '#');
      const g = groups.get(key);
      if (g) { g.count++; g.lastTs = last; } else {
        const rec = { line: l, count: 1, firstTs: last, lastTs: last };
        groups.set(key, rec); order.push(rec);
      }
    }
    // Show every timestamp in the computer's local time as [DD.MM HH:MM:SS].
    const localize = (l) => l
      .replace(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/, (m, iso) => `[${fmtShort(new Date(iso).getTime())}]`)
      .replace(/^\[(\d{4})-(\d\d)-(\d\d) (\d\d:\d\d:\d\d)\] installer:/, '[$3.$2 $4] installer:');
    const hhmm = (ts) => fmtShort(ts).slice(6);
    let out = order.map((g) => (g.count > 1 ? `${localize(g.line)}  (x${g.count}, ${hhmm(g.firstTs)}-${hhmm(g.lastTs)})` : localize(g.line)));
    out = out.slice(-maxLines);
    let text = out.join('\n');
    if (text.length > 40000) text = text.slice(-40000);
    const scope = sinceMs ? `from ${fmtLocal(sinceMs)}` : `last ${hours}h`;
    return (omitted ? `(${omitted} routine/old lines omitted - ${scope} shown)\n` : '') + text;
  } catch (e) {
    return `(could not read log: ${e.message})`;
  }
}

module.exports = { log, getRecent, fmtLocal, LOG_FILE };
