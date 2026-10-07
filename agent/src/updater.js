'use strict';
// Auto-update: every ~30 min the agent asks GitHub for the latest Release of this
// repo. If it is newer than the running version, it downloads the installer,
// checks its SHA-256 (published next to it by the build), and runs it silently.
//
// The installer stops THIS service while it replaces the files, and NSSM kills the
// service's child processes when it stops. So the installer is not started from
// here directly: a one-shot scheduled task (run as SYSTEM) starts a small .bat that
// runs it, so it survives the service being stopped.
//
// Kill switch: create a file named no-auto-update.txt next to the agent exe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const ASSET = 'ContentBlockerAgent-Setup.exe';
const TASK_NAME = 'ContentBlockerUpdate';
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000; // don't retry the same failed version more often than this
const UPDATE_DIR = path.join(config.DATA_DIR, 'update');
const STATE_FILE = path.join(UPDATE_DIR, 'state.json');

let busy = false;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeState(state) {
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) { /* best effort */ }
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${path.basename(file)} ${err.message} ${String(stderr || '').trim()}`.trim()));
      resolve(String(stdout || ''));
    });
  });
}

async function download(url, dest, expectedSize) {
  // Accept: application/octet-stream makes the GitHub REST *asset* endpoint
  // (api.github.com/repos/.../releases/assets/<id>, as opposed to the
  // browser-facing github.com/.../releases/download/... link) respond with a
  // redirect straight to the CDN that actually holds the file - without the
  // request ever touching github.com itself. Some networks (e.g. a filtered
  // computer-lab connection) allow api.github.com and the CDN domain but
  // block github.com outright, which breaks the browser_download_url link
  // but not this one.
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'content-blocker-agent', Accept: 'application/octet-stream' }
  });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.data.pipe(out);
    res.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
  if (expectedSize && fs.statSync(dest).size !== expectedSize) {
    throw new Error(`downloaded size ${fs.statSync(dest).size} != expected ${expectedSize}`);
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function checkOnce({ isBusy, notify } = {}) {
  if (busy) return;
  busy = true;
  try {
    if (isBusy && isBusy()) return;
    if (fs.existsSync(path.join(path.dirname(process.execPath), 'no-auto-update.txt'))) return;

    const current = require('../package.json').version;
    // Every GitHub call below uses only api.github.com, never github.com -
    // see the note in download() for why.
    const apiBase = `https://api.github.com/repos/${config.UPDATE_REPO}/releases/assets/`;
    const rel = await axios.get(`https://api.github.com/repos/${config.UPDATE_REPO}/releases/latest`, {
      timeout: 20000,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'content-blocker-agent' }
    });
    const latest = String(rel.data.tag_name || '').replace(/^v/, '');
    if (!isNewer(latest, current)) return;

    const exeAsset = (rel.data.assets || []).find((a) => a.name === ASSET);
    const shaAsset = (rel.data.assets || []).find((a) => a.name === `${ASSET}.sha256`);
    if (!exeAsset || !shaAsset) {
      logger.log(`Update ${latest} found but the release is missing the installer or its .sha256 - skipping.`);
      return;
    }
    // Only ever download assets that belong to this exact repo's releases.
    if (!String(exeAsset.url).startsWith(apiBase) || !String(shaAsset.url).startsWith(apiBase)) {
      logger.log('Update skipped: asset URL is not from the configured repository.');
      return;
    }

    const state = readState();
    if (state.version === latest && Date.now() - (state.attemptedAt || 0) < RETRY_AFTER_MS) return;

    logger.log(`Update available: ${current} -> ${latest}. Downloading...`);
    writeState({ version: latest, attemptedAt: Date.now() });
    fs.mkdirSync(UPDATE_DIR, { recursive: true });

    const shaText = (await axios.get(shaAsset.url, {
      timeout: 20000, responseType: 'text',
      headers: { 'User-Agent': 'content-blocker-agent', Accept: 'application/octet-stream' }
    })).data;
    const expectedHash = (/[0-9a-fA-F]{64}/.exec(String(shaText)) || [])[0];
    if (!expectedHash) throw new Error('could not read the SHA-256 file');

    const exePath = path.join(UPDATE_DIR, `ContentBlockerAgent-Setup-${latest}.exe`);
    await download(exeAsset.url, exePath, exeAsset.size);
    const actual = await sha256File(exePath);
    if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
      fs.rmSync(exePath, { force: true });
      throw new Error('SHA-256 mismatch - the download is corrupt, not installing it');
    }

    const bat = path.join(UPDATE_DIR, 'apply-update.bat');
    const logFile = logger.LOG_FILE;
    // NOTE: a space before ">>" matters - "0>>" would be read as a handle redirect.
    fs.writeFileSync(bat, [
      '@echo off',
      `echo [updater] starting silent install of ${latest} >>"${logFile}"`,
      `"${exePath}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOG="${path.join(UPDATE_DIR, 'setup.log')}"`,
      `echo [updater] installer exit code %errorlevel% >>"${logFile}"`,
      `del /f /q "${exePath}" >nul 2>&1`,
      `schtasks /delete /tn ${TASK_NAME} /f >nul 2>&1`,
      ''
    ].join('\r\n'));

    logger.log(`Update ${latest} verified (SHA-256 ok). Handing over to the installer - the service will restart.`);
    if (notify) { try { notify(`מעדכן את הסוכן מגרסה ${current} לגרסה ${latest}`); } catch (e) { /* ignore */ } }

    await run('schtasks.exe', ['/delete', '/tn', TASK_NAME, '/f']).catch(() => {});
    await run('schtasks.exe', ['/create', '/tn', TASK_NAME, '/sc', 'once', '/st', '23:59', '/ru', 'SYSTEM', '/rl', 'HIGHEST', '/f', '/tr', bat]);
    await run('schtasks.exe', ['/run', '/tn', TASK_NAME]);
  } catch (e) {
    logger.log(`Auto-update failed: ${e.message}`);
  } finally {
    busy = false;
  }
}

function start(opts) {
  setTimeout(() => {
    checkOnce(opts);
    setInterval(() => checkOnce(opts), config.UPDATE_CHECK_INTERVAL_MS);
  }, config.UPDATE_FIRST_CHECK_DELAY_MS);
}

module.exports = { start, checkOnce, isNewer, parseVersion };
