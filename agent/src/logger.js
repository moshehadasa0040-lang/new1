const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOG_FILE = path.join(config.DATA_DIR, 'agent.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB - simple rotation trigger

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    // Simple rotation: if the file grew too large, drop it and start fresh
    // rather than growing unbounded on a machine that runs for months.
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      fs.writeFileSync(LOG_FILE, '');
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // best-effort - never let logging itself crash the agent
  }
  console.log(message);
}

// Returns the last `maxLines` lines of the log file, for uploading to the
// dashboard on request (see 'send_logs' command in index.js).
function getRecent(maxLines = 300) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '(no log file yet)';
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } catch (e) {
    return `(failed to read log file: ${e.message})`;
  }
}

module.exports = { log, getRecent };
