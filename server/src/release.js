// Looks up the newest published agent release on GitHub (cached) and streams
// its installer, so the dashboard can show "latest version" and offer a
// download without the admin having to open GitHub.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = process.env.GITHUB_REPO || 'moshehadasa0040-lang/new1';
const ASSET = 'ContentBlockerAgent-Setup.exe';
// GitHub allows only 60 anonymous API calls/hour per IP, so the lookup is cached. All agents ask
// THIS server instead of GitHub, so one lookup per cache period serves every computer.
const CACHE_MS = (Number(process.env.RELEASE_CACHE_SECONDS) || (process.env.GITHUB_TOKEN ? 30 : 120)) * 1000;

let cache = null; // { at, info }

function ghHeaders(extra = {}) {
  const h = { 'User-Agent': 'content-blocker-dashboard', ...extra };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function getLatest({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.info;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: ghHeaders({ Accept: 'application/vnd.github+json' }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(`github_${r.status}`);
    const rel = await r.json();
    const asset = (rel.assets || []).find((a) => a.name === ASSET);
    const shaAsset = (rel.assets || []).find((a) => a.name === `${ASSET}.sha256`);
    const version = String(rel.tag_name || '').replace(/^v/, '');
    // The SHA-256 of the installer, handed to the agents so they can verify the download.
    let sha256 = cache && cache.info.version === version ? cache.info.sha256 : '';
    if (!sha256 && shaAsset) {
      const r2 = await fetch(shaAsset.url, { headers: ghHeaders({ Accept: 'application/octet-stream' }), redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (r2.ok) sha256 = ((/[0-9a-fA-F]{64}/.exec(await r2.text()) || [])[0] || '').toLowerCase();
    }
    const info = {
      version,
      published_at: rel.published_at || '',
      size: asset ? asset.size : 0,
      assetUrl: asset ? asset.url : '',
      sha256
    };
    const isNew = !cache || cache.info.version !== version;
    cache = { at: Date.now(), info };
    // A new release: fetch the installer ONCE now, so the computers get it from this server's disk
    // and not (each) from GitHub - GitHub rate limits were the cause of "502" download failures.
    if (isNew && info.assetUrl && info.sha256) ensureInstallerFile(info).catch((e) => console.error('installer prefetch failed:', e.message));
    return info;
  } catch (e) {
    if (cache) return cache.info; // better a slightly old answer than none
    throw e;
  }
}

// Version known right now, without waiting for GitHub (used in every heartbeat answer: the
// agents learn about a new release within seconds of the server learning about it).
function peekLatestVersion() {
  if (!cache || Date.now() - cache.at >= CACHE_MS) getLatest().catch(() => {}); // refresh in the background
  return cache ? cache.info.version : '';
}

// The installer lives on this server's disk after the first download: every computer is then served
// from here, GitHub is asked once per release (not once per computer, retry and click).
const CACHE_DIR = path.join(os.tmpdir(), 'cb-installer-cache');
const inflight = new Map();

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function ensureInstallerFile(info) {
  const file = path.join(CACHE_DIR, `ContentBlockerAgent-Setup-${info.version}.exe`);
  try { if (info.size && fs.statSync(file).size === info.size) return Promise.resolve(file); } catch (e) { /* not cached yet */ }
  if (inflight.has(info.version)) return inflight.get(info.version);
  const p = (async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${file}.part-${process.pid}`;
    const r = await fetch(info.assetUrl, {
      headers: ghHeaders({ Accept: 'application/octet-stream' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(180000)
    });
    if (!r.ok || !r.body) throw new Error(`github_${r.status}`);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
    const okSize = !info.size || fs.statSync(tmp).size === info.size;
    const okHash = !info.sha256 || (await sha256File(tmp)) === info.sha256;
    if (!okSize || !okHash) { fs.rmSync(tmp, { force: true }); throw new Error('installer_verification_failed'); }
    fs.renameSync(tmp, file);
    // keep only the newest one on disk
    for (const f of fs.readdirSync(CACHE_DIR)) if (f !== path.basename(file)) fs.rmSync(path.join(CACHE_DIR, f), { force: true });
    return file;
  })().finally(() => inflight.delete(info.version));
  inflight.set(info.version, p);
  return p;
}

// Sends the installer of the latest release (from the disk cache; downloads it first if needed).
async function streamInstaller(res) {
  const info = await getLatest();
  if (!info.assetUrl) throw new Error('no_installer_in_release');
  const file = await ensureInstallerFile(info);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="ContentBlockerAgent-Setup-${info.version}.exe"`);
  res.setHeader('Content-Length', String(fs.statSync(file).size));
  await pipeline(fs.createReadStream(file), res);
}

// "1.13.10" > "1.13.9": numeric, part by part.
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// First agent version that understands the 'update' command. Older agents silently
// ignore unknown commands, so the dashboard must not offer the button for them.
const REMOTE_UPDATE_MIN = '1.13.12';

module.exports = { getLatest, peekLatestVersion, streamInstaller, cmpVersion, REMOTE_UPDATE_MIN };
