'use strict';
// Keeps the computer tidy so the agent never fills the disk: leftover installers and old logs
// are deleted. Runs shortly after start and then every 6 hours. Never touches anything that
// the running agent or a rollback needs (agent.log, the *.old files next to the exe).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const UPDATE_DIR = path.join(config.DATA_DIR, 'update');

function removeOld(dir, test, maxAgeMs) {
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const name of names) {
    if (!test(name)) continue;
    const f = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) { fs.rmSync(f, { force: true }); n += 1; }
    } catch (e) { /* in use or already gone */ }
  }
  return n;
}

function runOnce() {
  let n = 0;
  // Downloaded installers that were never cleaned up (failed update); a running update is minutes old.
  n += removeOld(UPDATE_DIR, (f) => /^ContentBlockerAgent-Setup.*\.exe$/i.test(f), 2 * HOUR);
  n += removeOld(UPDATE_DIR, (f) => /^setup\.log$/i.test(f), 7 * DAY);
  // The rotated-out previous agent log.
  n += removeOld(config.LOG_DIR, (f) => /^agent\.old\.log$/i.test(f), 7 * DAY);
  n += removeOld(config.LOG_DIR, (f) => /\.tmp$/i.test(f), DAY);
  if (n) logger.log(`Cleanup: removed ${n} old file(s).`);
}

function start() {
  setTimeout(runOnce, 2 * 60 * 1000);
  setInterval(runOnce, 6 * HOUR);
}

module.exports = { start, runOnce };
