const fs = require('fs');
const path = require('path');
const config = require('./config');

// Small key=value text files in the logs folder (C:\Users\Public\Documents\
// ContentBlockerLogs). They are for the user-facing windows - the tray icon
// and the installer's progress splash - which run in the user's session and
// cannot talk to the SYSTEM service directly. Plain ASCII keys, UTF-8 values,
// written atomically (temp file + rename) so a reader never sees half a file.
// NEVER put secrets (device token) in here: this folder is readable by every
// user on the PC.
function writeKv(fileName, values) {
  try {
    fs.mkdirSync(config.LOG_DIR, { recursive: true });
    const target = path.join(config.LOG_DIR, fileName);
    const tmp = target + '.tmp';
    const body = Object.entries(values)
      .map(([k, v]) => `${k}=${String(v == null ? '' : v).replace(/[\r\n]+/g, ' ')}`)
      .join('\n');
    fs.writeFileSync(tmp, body + '\n', 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    // best-effort: a status file must never crash the agent
  }
}

const writeStatus = (values) => writeKv('status.txt', values);
const writeInstallProgress = (values) => writeKv('install-progress.txt', values);
// Answer to a "check for update now" request made from the tray icon.
const writeUpdateResult = (values) => writeKv('update-result.txt', values);

module.exports = { writeStatus, writeInstallProgress, writeUpdateResult };
