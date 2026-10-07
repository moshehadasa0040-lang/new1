// Looks up the newest published agent release on GitHub (cached) and streams
// its installer, so the dashboard can show "latest version" and offer a
// download without the admin having to open GitHub.
const { Readable } = require('stream');

const REPO = process.env.GITHUB_REPO || 'moshehadasa0040-lang/new1';
const ASSET = 'ContentBlockerAgent-Setup.exe';
const CACHE_MS = 10 * 60 * 1000; // GitHub allows only 60 anonymous API calls/hour per IP

let cache = null; // { at, info }

function ghHeaders(extra = {}) {
  const h = { 'User-Agent': 'content-blocker-dashboard', ...extra };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function getLatest() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.info;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: ghHeaders({ Accept: 'application/vnd.github+json' }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(`github_${r.status}`);
    const rel = await r.json();
    const asset = (rel.assets || []).find((a) => a.name === ASSET);
    const info = {
      version: String(rel.tag_name || '').replace(/^v/, ''),
      published_at: rel.published_at || '',
      size: asset ? asset.size : 0,
      assetUrl: asset ? asset.url : ''
    };
    cache = { at: Date.now(), info };
    return info;
  } catch (e) {
    if (cache) return cache.info; // better a slightly old answer than none
    throw e;
  }
}

// Pipes the installer of the latest release into the HTTP response.
async function streamInstaller(res) {
  const info = await getLatest();
  if (!info.assetUrl) throw new Error('no_installer_in_release');
  const r = await fetch(info.assetUrl, {
    headers: ghHeaders({ Accept: 'application/octet-stream' }),
    redirect: 'follow'
  });
  if (!r.ok || !r.body) throw new Error(`github_${r.status}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="ContentBlockerAgent-Setup-${info.version}.exe"`);
  const len = r.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  Readable.fromWeb(r.body).pipe(res);
}

module.exports = { getLatest, streamInstaller };
