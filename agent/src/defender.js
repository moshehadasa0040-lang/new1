'use strict';
// Best-effort Defender exclusions for the agent's own folders. Needed mainly for
// the auto-update path (updater.js): it downloads and silently runs a new
// installer under DATA_DIR\update, non-interactively, as SYSTEM. Without an
// exclusion Defender can quarantine or kill that run with nobody watching,
// leaving the old service stopped. This never touches detections that already
// fired, and never excludes anything outside the agent's own two folders.
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const logger = require('./logger');

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', args],
      { windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout));
  });
}

async function ensureExclusions() {
  const installDir = path.dirname(process.execPath);
  const q = (s) => s.replace(/'/g, "''");
  const cmds = [
    `Add-MpPreference -ExclusionPath '${q(installDir)}'`,
    `Add-MpPreference -ExclusionPath '${q(config.DATA_DIR)}'`,
    // Process exclusion (not just path) covers the exe wherever it's
    // currently running from, including the freshly-downloaded copy an
    // in-progress silent update launches from UPDATE_DIR before it moves
    // itself into installDir.
    `Add-MpPreference -ExclusionProcess '${q(process.execPath)}'`
  ];
  for (const cmd of cmds) {
    try {
      await run(cmd);
    } catch (e) {
      // Not fatal: Tamper Protection or a managed policy can block this; the
      // auto-update will simply keep retrying on its own schedule.
      logger.log(`Defender exclusion step failed (${cmd}): ${e.message}`);
      return;
    }
  }
  logger.log('Defender exclusions set for the agent folders and process (so silent auto-updates are not quarantined).');
}

module.exports = { ensureExclusions };
