const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOG_FILE = path.join(config.LOG_DIR, 'agent.log');
const LOG_FILE_OLD = path.join(config.LOG_DIR, 'agent.old.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB - rotation trigger

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
    if (lines.length < maxLines && fs.existsSync(LOG_FILE_OLD)) {
      const older = fs.readFileSync(LOG_FILE_OLD, 'utf8').split('\n').filter(Boolean);
      lines = older.concat(lines);
    }
    return lines.slice(-maxLines).join('\n');
  } catch (e) {
    return `(failed to read log file: ${e.message})`;
  }
}

module.exports = { log, getRecent, LOG_FILE };
