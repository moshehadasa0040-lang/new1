const { exec } = require('child_process');
const config = require('./config');

let currentBlockList = [...config.DEFAULT_BLOCKED_PROCESSES];
let blocking = true; // false while temporarily unlocked
let scanTimer = null;

function setBlockList(list) {
  if (Array.isArray(list) && list.length) {
    currentBlockList = list;
  }
}

function setBlocking(enabled) {
  blocking = enabled;
}

function isBlocking() {
  return blocking;
}

// Kills any running process whose name matches the block list.
// Uses the built-in `taskkill` - no external dependencies needed.
function scanAndKill() {
  if (!blocking || !currentBlockList.length) return;
  currentBlockList.forEach((processName) => {
    exec(`taskkill /IM "${processName}" /F`, () => {
      // Errors (process not found) are expected most of the time - ignored.
    });
  });
}

function start() {
  if (scanTimer) return;
  scanTimer = setInterval(scanAndKill, config.BLOCK_SCAN_INTERVAL_MS);
}

function stop() {
  clearInterval(scanTimer);
  scanTimer = null;
}

module.exports = { setBlockList, setBlocking, isBlocking, start, stop, scanAndKill };
