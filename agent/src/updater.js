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
//
// Manual check: the tray icon (runs in the user's session, cannot talk to this
// SYSTEM service directly) drops update-request.txt into the logs folder. The
// service polls for it, runs one check right away (ignoring the 6h retry
// back-off) and answers in update-result.txt, which the tray shows as a balloon.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const statusFile = require('./status');

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
    // axios' timeout only covers the response headers; without this a download that
    // stalls halfway would wait forever (the "update never finishes" symptom).
    let stall;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => res.data.destroy(new Error('download stalled (no data for 60 seconds)')), 60 * 1000);
    };
    arm();
    res.data.on('data', arm);
    res.data.pipe(out);
    res.data.on('error', (e) => { clearTimeout(stall); reject(e); });
    out.on('error', (e) => { clearTimeout(stall); reject(e); });
    out.on('finish', () => { clearTimeout(stall); resolve(); });
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

const REQUEST_FILE = path.join(config.LOG_DIR, 'update-request.txt');
const REQUEST_POLL_MS = 3000;
const MANUAL_MIN_GAP_MS = 10 * 1000; // GitHub's anonymous API limit is per IP, don't let a click-happy user burn it

// Short machine-readable reason for a failure; the tray turns it into Hebrew text.
function failureReason(e) {
  const status = e && e.response && e.response.status;
  if (status === 403 || status === 429) return 'ratelimit';
  if (status === 404) return 'notfound';
  const code = e && e.code;
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) return 'network';
  return 'other';
}

// Returns { result, current, latest?, reason?, message? } where result is one of:
// uptodate | updating | disabled | busy | incomplete | skipped | failed
// `manual` = asked for by a person: ignores the "already tried this version recently" back-off.
async function checkOnce({ isBusy, notify, manual = false, onProgress } = {}) {
  if (busy) return { result: 'busy', current: require('../package.json').version };
  busy = true;
  const current = require('../package.json').version;
  try {
    if (isBusy && isBusy()) return { result: 'busy', current };
    if (fs.existsSync(path.join(path.dirname(process.execPath), 'no-auto-update.txt'))) return { result: 'disabled', current };

    // Every GitHub call below uses only api.github.com, never github.com -
    // see the note in download() for why.
    const apiBase = `https://api.github.com/repos/${config.UPDATE_REPO}/releases/assets/`;
    const rel = await axios.get(`https://api.github.com/repos/${config.UPDATE_REPO}/releases/latest`, {
      timeout: 20000,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'content-blocker-agent' }
    });
    const latest = String(rel.data.tag_name || '').replace(/^v/, '');
    if (!isNewer(latest, current)) return { result: 'uptodate', current, latest };

    const exeAsset = (rel.data.assets || []).find((a) => a.name === ASSET);
    const shaAsset = (rel.data.assets || []).find((a) => a.name === `${ASSET}.sha256`);
    if (!exeAsset || !shaAsset) {
      logger.log(`Update ${latest} found but the release is missing the installer or its .sha256 - skipping.`);
      return { result: 'incomplete', current, latest };
    }
    // Only ever download assets that belong to this exact repo's releases.
    if (!String(exeAsset.url).startsWith(apiBase) || !String(shaAsset.url).startsWith(apiBase)) {
      logger.log('Update skipped: asset URL is not from the configured repository.');
      return { result: 'failed', current, latest, reason: 'other', message: 'asset URL is not from the configured repository' };
    }

    const state = readState();
    if (!manual && state.version === latest && Date.now() - (state.attemptedAt || 0) < RETRY_AFTER_MS) {
      return { result: 'skipped', current, latest };
    }

    logger.log(`Update available: ${current} -> ${latest}. Downloading...`);
    if (onProgress) { try { onProgress('downloading', { current, latest }); } catch (e) { /* ignore */ } }
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
    const installDir = path.dirname(process.execPath);
    const setupLog = path.join(UPDATE_DIR, 'setup.log');
    // The installer runs with a 10 minute limit. A silent Setup that hits a locked file
    // shows its error dialog in session 0 where nobody can click it, and would otherwise
    // wait forever - with the service already stopped, i.e. NO PROTECTION. After the
    // installer (finished, failed or killed) the service and the watchdog are always
    // started again; both are no-ops when the new installer already did it.
    const runInstaller =
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '${exePath}' ` +
      `-ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/LOG=${setupLog}' -PassThru; ` +
      `if (-not $p.WaitForExit(600000)) { & taskkill.exe /f /t /pid $p.Id | Out-Null; Get-Process | Where-Object { $_.Name -like 'ContentBlockerAgent-Setup*' } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 99 } else { exit $p.ExitCode }"`;
    fs.writeFileSync(bat, [
      '@echo off',
      `echo [updater] starting silent install of ${latest} >>"${logFile}"`,
      runInstaller,
      `echo [updater] installer exit code %errorlevel% - 0 is success, 99 means it hung for 10 minutes and was stopped >>"${logFile}"`,
      `sc start ContentBlockerAgent >nul 2>&1`,
      `schtasks /create /tn ContentBlockerWatchdog /sc minute /mo 1 /ru SYSTEM /rl HIGHEST /f /tr "\\"${path.join(installDir, 'watchdog.bat')}\\"" >nul 2>&1`,
      `del /f /q "${exePath}" >nul 2>&1`,
      `schtasks /delete /tn ${TASK_NAME} /f >nul 2>&1`,
      ''
    ].join('\r\n'));

    logger.log(`Update ${latest} verified (SHA-256 ok). Handing over to the installer - the service will restart.`);
    // Tell the tray BEFORE the installer stops this service (it won't be able to afterwards).
    if (onProgress) { try { onProgress('updating', { current, latest }); } catch (e) { /* ignore */ } }
    if (notify) { try { notify(`מעדכן את הסוכן מגרסה ${current} לגרסה ${latest}`); } catch (e) { /* ignore */ } }

    await run('schtasks.exe', ['/delete', '/tn', TASK_NAME, '/f']).catch(() => {});
    await run('schtasks.exe', ['/create', '/tn', TASK_NAME, '/sc', 'once', '/st', '23:59', '/ru', 'SYSTEM', '/rl', 'HIGHEST', '/f', '/tr', bat]);
    await run('schtasks.exe', ['/run', '/tn', TASK_NAME]);
    return { result: 'updating', current, latest };
  } catch (e) {
    logger.log(`Auto-update failed: ${e.message}`);
    return { result: 'failed', current, reason: failureReason(e), message: e.message };
  } finally {
    busy = false;
  }
}

function writeResult(result, extra = {}) {
  statusFile.writeUpdateResult({
    result,
    current: require('../package.json').version,
    ...extra,
    at: new Date().toISOString()
  });
}

// Answers "check for update now" requests dropped by the tray icon.
function watchRequests(opts) {
  let handling = false;
  let lastRunAt = 0;
  let lastMtime = 0;
  setInterval(async () => {
    if (handling) return;
    let mtime;
    try { mtime = fs.statSync(REQUEST_FILE).mtimeMs; } catch (e) { return; } // no request
    // If the file could not be deleted, don't answer the same request over and over.
    if (mtime === lastMtime) { try { fs.rmSync(REQUEST_FILE, { force: true }); } catch (e) { /* ignore */ } return; }
    lastMtime = mtime;
    handling = true;
    try {
      try { fs.rmSync(REQUEST_FILE, { force: true }); } catch (e) { /* ignore */ }
      if (Date.now() - lastRunAt < MANUAL_MIN_GAP_MS) {
        writeResult('busy', { reason: 'toofast' });
        return;
      }
      lastRunAt = Date.now();
      logger.log('Manual update check requested from the tray icon.');
      writeResult('checking');
      const r = await checkOnce({
        ...opts,
        manual: true,
        onProgress: (stage, info) => writeResult(stage, { latest: info.latest })
      });
      if (r.result === 'uptodate') logger.log(`Manual update check: already up to date (running ${r.current}, latest release ${r.latest}).`);
      else if (r.result !== 'updating') logger.log(`Manual update check finished: ${r.result}${r.message ? ' - ' + r.message : ''}`);
      // 'updating' was already announced by onProgress, right before the installer takes the service down.
      if (r.result !== 'updating') writeResult(r.result, { latest: r.latest || '', reason: r.reason || '', message: r.message || '' });
    } catch (e) {
      logger.log(`Manual update check crashed: ${e.message}`);
      writeResult('failed', { reason: 'other', message: e.message });
    } finally {
      handling = false;
    }
  }, REQUEST_POLL_MS);
}

function start(opts) {
  watchRequests(opts);
  setTimeout(() => {
    checkOnce(opts);
    setInterval(() => checkOnce(opts), config.UPDATE_CHECK_INTERVAL_MS);
  }, config.UPDATE_FIRST_CHECK_DELAY_MS);
}

// Hebrew one-liner for the dashboard's event list ("update the agent" button).
function describeResult(r) {
  const why = {
    ratelimit: 'GitHub הגביל זמנית את מספר הבדיקות מהרשת (נסו שוב בעוד כמה דקות)',
    notfound: 'לא נמצאה גרסה מפורסמת במאגר',
    network: 'אין חיבור ל-GitHub מהמחשב',
    other: r.message || 'שגיאה לא ידועה'
  };
  switch (r.result) {
    case 'uptodate': return `עדכון הסוכן: אין עדכון חדש, גרסה ${r.current} היא העדכנית ביותר`;
    case 'updating': return `עדכון הסוכן: מעדכן מגרסה ${r.current} לגרסה ${r.latest} (ההגנה תופסק לכמה שניות)`;
    case 'disabled': return 'עדכון הסוכן: העדכון האוטומטי כבוי במחשב הזה (קיים הקובץ no-auto-update.txt)';
    case 'busy': return 'עדכון הסוכן: המחשב עסוק כרגע (עדכון או הסרה מתבצעים), נסו שוב בעוד רגע';
    case 'incomplete': return `עדכון הסוכן: גרסה ${r.latest} פורסמה אבל קובץ ההתקנה שלה עדיין לא מלא ב-GitHub`;
    case 'skipped': return `עדכון הסוכן: דולג (גרסה ${r.latest})`;
    default: return `עדכון הסוכן נכשל: ${why[r.reason] || why.other}`;
  }
}

module.exports = { start, checkOnce, isNewer, parseVersion, describeResult };
