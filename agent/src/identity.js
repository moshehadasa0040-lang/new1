const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const config = require('./config');

const STATE_FILE = path.join(config.DATA_DIR, 'device.json');

// Derives a stable hardware identifier from the Windows Machine GUID
// (registry), falling back to a random id if it can't be read (e.g. non-
// Windows dev environment). This is what stays stable across agent
// reinstalls but changes on a true OS reinstall/format - which is exactly
// the "format = looks like a new/removed device" behavior requested.
function getHardwareId() {
  try {
    const output = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: 'utf8' }
    );
    const match = output.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i);
    if (match) {
      return crypto.createHash('sha256').update(match[1]).digest('hex').slice(0, 32);
    }
  } catch (e) {
    // Not on Windows, or registry unavailable - fall through.
  }
  return crypto.createHash('sha256').update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 32);
}

function ensureDataDir() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

function loadState() {
  ensureDataDir();
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return null;
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (e) {
    // best-effort
  }
}

// Reads the friendly name the installer asked for (see setup.iss), written
// as UTF-16LE text (with BOM) next to the agent exe at install time -
// that's what Inno Setup's SaveStringToFile produces in "Unicode" mode,
// needed so Hebrew names don't get corrupted (Inno has no native UTF-8
// writer, and ANSI mode uses the system codepage instead). Returns null if
// absent (e.g. running via `node src/index.js` during development, or an
// older install that predates this feature) - callers should fall back to
// the OS hostname in that case.
function getCustomDeviceName() {
  try {
    const filePath = path.join(path.dirname(process.execPath), 'device-name.txt');
    if (fs.existsSync(filePath)) {
      let name = fs.readFileSync(filePath, 'utf16le');
      name = name.replace(/^\uFEFF/, '').trim(); // strip BOM if present
      if (name) return name;
    }
  } catch (e) {
    // best-effort
  }
  return null;
}

module.exports = { getHardwareId, loadState, saveState, clearState, getCustomDeviceName };
