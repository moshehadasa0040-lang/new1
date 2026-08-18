const { exec } = require('child_process');
const config = require('./config');
const logger = require('./logger');

let currentBlockList = [...config.DEFAULT_BLOCKED_PROCESSES];
let blocking = true; // false while temporarily unlocked
let scanTimer = null;

function setBlockList(list) {
  if (Array.isArray(list) && list.length) {
    currentBlockList = list;
    logger.log(`Block list updated: ${list.join(', ')}`);
  }
}

function getBlockList() {
  return [...currentBlockList];
}

function setBlocking(enabled) {
  blocking = enabled;
  logger.log(enabled ? 'Blocking enabled' : 'Blocking temporarily disabled (unlock)');
}

function isBlocking() {
  return blocking;
}

// Kills any running process whose name matches the block list.
// Uses the built-in `taskkill` - no external dependencies needed.
function scanAndKill() {
  if (!blocking || !currentBlockList.length) return;
  currentBlockList.forEach((processName) => {
    exec(`taskkill /IM "${processName}" /F`, (error) => {
      // No error means taskkill actually found and killed a matching
      // process - that's the only case worth logging. "Not found" errors
      // are the normal, expected outcome most of the time.
      if (!error) {
        logger.log(`Blocked and closed: ${processName}`);
      }
    });
  });
}

function start() {
  if (scanTimer) return;
  logger.log(`Blocker started. Watching: ${currentBlockList.join(', ')}`);
  scanTimer = setInterval(scanAndKill, config.BLOCK_SCAN_INTERVAL_MS);
}

function stop() {
  clearInterval(scanTimer);
  scanTimer = null;
}

module.exports = { setBlockList, getBlockList, setBlocking, isBlocking, start, stop, scanAndKill };

