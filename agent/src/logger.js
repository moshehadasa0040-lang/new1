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

// Returns the last `maxLines` lines of the log, for uploading to the
// dashboard on request (see 'send_logs' command in index.js).
function getRecent(maxLines = 300) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '(no log file yet)';
    let content = fs.readFileSync(LOG_FILE, 'utf8');
    let lines = content.split('\n').filter(Boolean);
    if (lines.length < maxLines * 3 && fs.existsSync(LOG_FILE_OLD)) {
      const older = fs.readFileSync(LOG_FILE_OLD, 'utf8').split('\n').filter(Boolean);
      lines = older.concat(lines);
    }
    // Keep the upload small: drop the very noisy per-file lines (they can be
    // thousands after a fresh install), summarise how many were dropped,
    // cut long lines, and cap the total size.
    const noise = /Could not lock:|owner not changed|\[lock\] /;
    let dropped = 0;
    const kept = [];
    for (const l of lines) {
      if (noise.test(l)) { dropped++; continue; }
      kept.push(l.length > 300 ? l.slice(0, 300) + '...' : l);
    }
    let out = kept.slice(-maxLines).join('\n');
    if (out.length > 150000) out = out.slice(-150000);
    if (dropped) out = `(${dropped} per-file lock lines omitted)\n` + out;
    return out;
  } catch (e) {
    return `(failed to read log file: ${e.message})`;
  }
}

module.exports = { log, getRecent, LOG_FILE };
