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
// ONE `tasklist` call per tick (instead of one taskkill process per blocked name),
// so the check can run every second without hurting the machine. `taskkill` is
// only started for names that are actually running.
let scanning = false;
function scanAndKill() {
  if (!blocking || !currentBlockList.length || scanning) return;
  scanning = true;
  exec('tasklist /FO CSV /NH', { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (listErr, stdout) => {
    scanning = false;
    if (listErr || !blocking) return;
    const running = new Set();
    for (const line of String(stdout).split(/\r?\n/)) {
      const m = /^"([^"]+)"/.exec(line);
      if (m) running.add(m[1].toLowerCase());
    }
    currentBlockList.forEach((processName) => {
      if (!running.has(processName.toLowerCase())) return;
      exec(`taskkill /IM "${processName}" /F`, { windowsHide: true }, (error) => {
        if (!error) logger.log(`Blocked and closed: ${processName}`);
      });
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

