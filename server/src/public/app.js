const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const deviceList = document.getElementById('device-list');
const searchInput = document.getElementById('search-input');
const deviceCount = document.getElementById('device-count');
let lastDevices = [];
let latestVersion = '';
let remoteUpdateMin = '1.13.12'; // first agent version that understands the update command

// "1.13.10" > "1.13.9": compare numerically, part by part.
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Version state of one computer: 'ok' | 'old' | 'unknown'.
// 'unknown' = the computer never reported its live version (it still runs an
// agent older than 1.13.8, which only told the server its version once, at
// registration - that number is stale, so it is not shown as fact).
function versionState(d) {
  if (!d.agent_version_at || !d.agent_version) return 'unknown';
  if (!latestVersion) return 'ok';
  return cmpVersion(d.agent_version, latestVersion) < 0 ? 'old' : 'ok';
}

async function loadLatest() {
  try {
    const r = await api('/api/admin/latest-release');
    latestVersion = r.version || '';
    if (r.remote_update_min) remoteUpdateMin = r.remote_update_min;
    const btn = document.getElementById('download-btn');
    if (btn && latestVersion) btn.textContent = `הורד את התוכנה (גרסה ${latestVersion})`;
  } catch (e) {
    // GitHub unreachable or session expired: keep the previous value.
  }
  renderDevices(lastDevices);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || 'request_failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Every button handler below used to just `await api(...)` with no
// try/catch. If that request failed for ANY reason - the admin session
// cookie expiring (24h maxAge, easy to hit if a dashboard tab is left
// open), a network hiccup, or a genuine server error - the click handler's
// promise rejected silently (an unhandled rejection in the console) and
// the button appeared to simply do nothing: no error, no explanation. That
// applied equally to every action, including "unlock"/"lock" and "בקש
// לוגים" - so a parent could click "פתח זמנית" or "בקש לוגים", get no
// feedback at all, and have no way to tell whether it worked, failed, or
// they just needed to wait. This wrapper makes every action either
// succeed visibly or fail visibly - never silently - and specifically
// detects an expired session (401) and sends the admin back to the login
// screen with an explanation, instead of leaving every button looking
// "broken" for a reason that has nothing to do with the feature itself.
async function runAction(fn) {
  try {
    await fn();
  } catch (e) {
    if (e.status === 401) {
      showLogin();
      const errorEl = document.getElementById('login-error');
      if (errorEl) errorEl.textContent = 'ההתחברות פגה - יש להתחבר מחדש.';
      return;
    }
    alert(`הפעולה נכשלה: ${e.message || 'שגיאה לא ידועה'}. נסה שוב.`);
  }
}

async function checkSession() {
  const { isAdmin } = await api('/api/admin/session');
  if (isAdmin) showDashboard();
  else showLogin();
}

function showLogin() {
  loginScreen.classList.remove('hidden');
  dashboardScreen.classList.add('hidden');
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
  loadDevices();
  loadLatest();
  setInterval(loadDevices, 10000); // refresh every 10s
  setInterval(loadLatest, 5 * 60 * 1000); // server caches it for 10 min anyway
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const password = document.getElementById('password-input').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    showDashboard();
  } catch (e) {
    errorEl.textContent = 'סיסמה שגויה';
  }
});

document.getElementById('updates-report-btn').addEventListener('click', openUpdatesReport);

document.getElementById('clear-logs-btn').addEventListener('click', () => runAction(async () => {
  if (!confirm('למחוק את כל הלוגים ששמורים בשרת, מכל המחשבים?\n(הלוגים במחשבים עצמם לא נמחקים, והם נמחקים בכל מקרה מעצמם אחרי 7 ימים)')) return;
  await api('/api/admin/logs', { method: 'DELETE' });
  await loadDevices();
}));

document.getElementById('clear-removed-btn').addEventListener('click', () => runAction(async () => {
  if (!confirm('לנקות את כל הרשימה \"הוסרו לאחרונה\"?')) return;
  await api('/api/admin/removed', { method: 'DELETE' });
  loadRemoved();
}));

document.getElementById('update-all-btn').addEventListener('click', () => runAction(async () => {
  if (!confirm('לשלוח בקשת עדכון לכל המחשבים המחוברים שאינם עדכניים?\nהם יתעדכנו בהפרש של כמה שניות זה מזה, ובכל אחד השירות יופעל מחדש לשניות ספורות.')) return;
  const r = await api('/api/admin/devices/update-outdated', { method: 'POST' });
  alert(`נשלחה בקשת עדכון ל-${r.queued} מחשבים (לגרסה ${r.latest}).`);
}));

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
});

// Also guarded by runAction: previously, if the session expired while the
// dashboard was sitting open, this silent-refresh call would throw every
// 10 seconds forever (unhandled rejection each time) and the device list
// would just quietly stop updating with no indication why.
async function loadDevices() {
  await runAction(async () => {
    const { devices } = await api('/api/admin/devices');
    lastDevices = devices;
    renderDevices(devices);
  });
  loadRemoved();
}

// Computers that removed the software (they disappear from the list above).
// Shows what the agent itself reported about the removal, e.g. "all files released".
async function loadRemoved() {
  try {
    const { removed } = await api('/api/admin/removed');
    const sec = document.getElementById('removed-section');
    const list = document.getElementById('removed-list');
    if (!sec || !list) return;
    sec.classList.toggle('hidden', !removed || !removed.length);
    list.innerHTML = (removed || []).slice(0, 10).map((r) => {
      const bad = /\(!\)|לא הושלם/.test(r.summary || '');
      return `<div class="removed-item ${bad ? 'removed-bad' : ''}">
        <strong>${escapeHtml(String(r.number || '?'))} · ${escapeHtml(r.name || r.hostname || '')}</strong>
        <span>${new Date(r.removed_at).toLocaleString('he-IL')}</span>
        <button class="removed-del secondary" data-at="${escapeHtml(r.removed_at)}">מחק</button>
        <div>${escapeHtml(r.summary || 'לא דווח סיכום')}</div>
      </div>`;
    }).join('');
    list.querySelectorAll('.removed-del').forEach((b) => b.addEventListener('click', () => runAction(async () => {
      await api(`/api/admin/removed?at=${encodeURIComponent(b.dataset.at)}`, { method: 'DELETE' });
      loadRemoved();
    })));
  } catch (e) {
    // the list is informational - ignore failures
  }
}

// Instant status check: asks the computer for its health report + recent log
// (it answers within the next ~20s heartbeat) and shows it in a window.
function openModal(title, text) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><h3></h3><div class="modal-status"></div><pre class="modal-body" dir="auto"></pre>
    <div class="modal-actions"><button class="copy-btn secondary">העתק</button><button class="close-btn">סגור</button></div></div>`;
  overlay.querySelector('h3').textContent = title;
  const body = overlay.querySelector('.modal-body');
  const statusEl = overlay.querySelector('.modal-status');
  body.textContent = text || '';
  let open = true;
  const close = () => { open = false; overlay.remove(); };
  overlay.querySelector('.close-btn').addEventListener('click', close);
  overlay.querySelector('.copy-btn').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(body.textContent));
  document.body.appendChild(overlay);
  return {
    isOpen: () => open,
    setStatus: (t) => { statusEl.textContent = t; },
    setText: (t) => { statusEl.textContent = ''; body.textContent = t; }
  };
}

async function checkStatus(id) {
  const dev = lastDevices.find((x) => x.id === id);
  const modal = openModal(`בדיקת מצב - ${dev ? dev.name : id}`, '');
  modal.setStatus('מבקש בדיקה מהמחשב...');
  try {
    const before = await api(`/api/admin/devices/${id}/logs`).catch(() => ({}));
    const prevAt = before && before.logs ? before.logs.updated_at : null;
    await api(`/api/admin/devices/${id}/request-logs`, { method: 'POST' });
    for (let i = 1; i <= 30; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!modal.isOpen()) return;
      const res = await api(`/api/admin/devices/${id}/logs`).catch(() => ({}));
      if (res && res.logs && res.logs.updated_at && res.logs.updated_at !== prevAt) {
        modal.setText(res.logs.content);
        return;
      }
      modal.setStatus(`ממתין לתשובה מהמחשב... ${i * 3} שניות`);
    }
    modal.setText('המחשב לא ענה תוך 90 שניות. ייתכן שהוא כבוי, מנותק מהאינטרנט, או שהשירות לא רץ.');
  } catch (e) {
    modal.setText(`שגיאה: ${e.message}`);
  }
}

// Typing in the search box filters by computer number, name or Windows name.
// Search matches the number exactly first ("7" finds computer 7, not 17).
searchInput?.addEventListener('input', () => renderDevices(lastDevices));

function filterDevices(devices) {
  const q = (searchInput?.value || '').trim().toLowerCase();
  if (!q) return devices;
  const exact = devices.filter((d) => String(d.number) === q.replace(/^#/, ''));
  if (exact.length) return exact;
  return devices.filter((d) =>
    String(d.number).includes(q.replace(/^#/, '')) ||
    (d.name || '').toLowerCase().includes(q) ||
    (d.hostname || '').toLowerCase().includes(q)
  );
}

function renderDevices(allDevices) {
  if (deviceCount) deviceCount.textContent = allDevices.length ? `${allDevices.length} מחשבים` : '';
  renderVersionSummary(allDevices);
  const devices = filterDevices(allDevices);
  if (allDevices.length && !devices.length) {
    deviceList.innerHTML = '<div class="empty-state">לא נמצא מחשב שמתאים לחיפוש.</div>';
    return;
  }
  if (!devices.length) {
    deviceList.innerHTML = '<div class="empty-state">אין עדיין מחשבים רשומים. התקן את ה-agent על מחשב כדי שיופיע כאן.</div>';
    return;
  }

  deviceList.innerHTML = devices.map((d) => {
    const isOnline = d.status === 'online';
    const isUnlocked = d.unlocked_until && new Date(d.unlocked_until) > new Date();
    return `
      <div class="device-card" data-id="${d.id}">
        <div class="device-head">
          <div class="device-number" title="מספר המחשב - מוצג גם באייקון בצד המחשב">${escapeHtml(String(d.number || '?'))}</div>
        <div class="device-info">
          <div class="device-name">${escapeHtml(d.name)}</div>
          <div class="device-meta">
            ${d.hostname ? escapeHtml(d.hostname) + ' · ' : ''}
            ${versionBadge(d)}
            נראה לאחרונה: ${d.last_seen ? new Date(d.last_seen).toLocaleString('he-IL') : 'מעולם לא'}
          </div>
          ${lastUpdateLine(d)}
        </div>
        </div>
        <div>
          <span class="status-badge ${isOnline ? 'status-online' : 'status-offline'}">
            <span class="status-dot"></span>${isOnline ? 'מחובר' : 'מנותק'}
          </span>
          ${isUnlocked ? '<span class="status-badge status-unlocked">פתוח זמנית</span>' : ''}
          ${d.update_stuck ? '<span class="status-badge status-stuck" title="המחשב לא התעדכן כבר יותר מ-10 דקות. נשלח אליו לוג אוטומטית.">העדכון תקוע</span>' : ''}
        </div>
        <div class="device-actions">
          <button class="unlock-btn">פתח ל-15 דק'</button>
          <button class="rename-btn secondary">שנה שם</button>
          ${isUnlocked ? '<button class="lock-btn secondary">נעל מיד</button>' : ''}
          <button class="rules-btn secondary">ערוך רשימת חסימה</button>
          <button class="update-btn ${versionState(d) === 'old' ? '' : 'secondary'}" ${supportsRemoteUpdate(d) ? '' : 'disabled title="גרסה זו עדיין לא תומכת בעדכון מרחוק. היא תתעדכן לבד בבדיקה האוטומטית, או בהתקנה ידנית."'}>עדכן סוכן</button>
          <button class="status-btn">בדיקת מצב מיידית</button>
          <button class="events-btn secondary">אירועים והתראות</button>
          <button class="logs-btn secondary">בקש לוגים</button>
          <button class="view-logs-btn secondary">הצג לוג${d.logs_at ? ' (' + (d.logs_reason && d.logs_reason !== 'requested' ? 'אוטומטי · ' : '') + new Date(d.logs_at).toLocaleString('he-IL') + ')' : ''}</button>
          <button class="download-logs-btn secondary">הורד לוגים</button>
          <button class="delete-logs-btn secondary">מחק לוג</button>
          <button class="uninstall-btn danger">הסר תוכנה</button>
          <button class="remove-btn secondary">מחק מהדשבורד</button>
        </div>
      </div>
    `;
  }).join('');

  deviceList.querySelectorAll('.device-card').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('.update-btn')?.addEventListener('click', () => runAction(async () => {
      const d = lastDevices.find((x) => x.id === id);
      const offline = d && d.status !== 'online';
      if (!confirm('לעדכן את הסוכן במחשב הזה לגרסה האחרונה?\nההגנה ממשיכה לפעול בזמן ההתקנה, והשירות יופעל מחדש לשניות ספורות.' + (offline ? '\n\nהמחשב מנותק כרגע, העדכון יתבצע כשיתחבר.' : ''))) return;
      await api(`/api/admin/devices/${id}/update`, { method: 'POST' });
      alert('בקשת העדכון נשלחה. המחשב יקבל אותה תוך כדקה. התוצאה תופיע ב"אירועים והתראות", והגרסה החדשה בכרטיס אחרי כמה דקות.');
    }));
    card.querySelector('.rename-btn')?.addEventListener('click', () => runAction(async () => {
      const current = lastDevices.find((x) => x.id === id);
      const name = prompt('שם חדש למחשב (למשל: "סלון" או "החדר של דני"):', current ? current.name : '');
      if (!name || !name.trim()) return;
      await api(`/api/admin/devices/${id}/rename`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() })
      });
      await loadDevices();
    }));
    card.querySelector('.unlock-btn')?.addEventListener('click', () => runAction(async () => {
      const minutes = prompt('לכמה דקות לפתוח?', '15');
      if (!minutes) return;
      await api(`/api/admin/devices/${id}/unlock`, {
        method: 'POST',
        body: JSON.stringify({ minutes: Number(minutes) })
      });
      loadDevices();
    }));
    card.querySelector('.lock-btn')?.addEventListener('click', () => runAction(async () => {
      await api(`/api/admin/devices/${id}/lock`, { method: 'POST' });
      loadDevices();
    }));
    card.querySelector('.rules-btn')?.addEventListener('click', () => runAction(async () => {
      const current = prompt(
        'רשימת תהליכים לחסימה, מופרדים בפסיק (למשל: vlc.exe,chrome.exe):',
        'vlc.exe,mpc-hc64.exe,mpc-be64.exe,mpv.exe,PotPlayerMini64.exe,Video.UI.exe'
      );
      if (!current) return;
      const blockedProcesses = current.split(',').map((s) => s.trim()).filter(Boolean);
      await api(`/api/admin/devices/${id}/update-rules`, {
        method: 'POST',
        body: JSON.stringify({ blockedProcesses })
      });
      alert('הרשימה תתעדכן בפעם הבאה שהמחשב יתחבר (עד דקה).');
    }));
    card.querySelector('.status-btn')?.addEventListener('click', () => checkStatus(id));
    card.querySelector('.events-btn')?.addEventListener('click', () => runAction(async () => {
      const { events } = await api(`/api/admin/devices/${id}/events`);
      if (!events || !events.length) {
        alert('אין אירועים להצגה.');
        return;
      }
      alert(events.slice(0, 20).map((e) => `${new Date(e.created_at).toLocaleString('he-IL')}  ${e.message}`).join('\n'));
    }));
    card.querySelector('.logs-btn')?.addEventListener('click', () => runAction(async () => {
      await api(`/api/admin/devices/${id}/request-logs`, { method: 'POST' });
      alert('בקשת לוגים נשלחה. המתן כדקה, ואז לחץ "הורד לוגים".');
    }));
    card.querySelector('.view-logs-btn')?.addEventListener('click', () => runAction(async () => {
      const { logs } = await api(`/api/admin/devices/${id}/logs`);
      if (!logs || !logs.content) { alert('אין לוג שמור למחשב הזה. לחץ \"בקש לוגים\" והמתן כדקה.'); return; }
      const why = logs.reason === 'update_stuck' ? 'נשלח אוטומטית: העדכון תקוע' : logs.reason === 'update_failed' ? 'נשלח אוטומטית: העדכון נכשל' : 'לפי בקשה';
      const dev = lastDevices.find((x) => x.id === id);
      const modal = openModal(`לוג - ${dev ? dev.name : id}`, logs.content);
      modal.setStatus(`${why} · התקבל ${new Date(logs.updated_at).toLocaleString('he-IL')}`);
    }));
    card.querySelector('.delete-logs-btn')?.addEventListener('click', () => runAction(async () => {
      if (!confirm('למחוק את הלוג השמור של המחשב הזה מהשרת?')) return;
      await api(`/api/admin/devices/${id}/logs`, { method: 'DELETE' });
      await loadDevices();
    }));
    card.querySelector('.download-logs-btn')?.addEventListener('click', () => runAction(async () => {
      const { logs } = await api(`/api/admin/devices/${id}/logs`);
      if (!logs || !logs.content) {
        alert('אין עדיין לוגים. לחץ קודם "בקש לוגים" והמתן כדקה.');
        return;
      }
      const blob = new Blob([logs.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${id}-logs.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }));
    card.querySelector('.uninstall-btn')?.addEventListener('click', () => runAction(async () => {
      if (!confirm('להסיר את התוכנה לגמרי מהמחשב הזה?')) return;
      await api(`/api/admin/devices/${id}/uninstall`, { method: 'POST' });
      alert('פקודת הסרה נשלחה. היא תתבצע בפעם הבאה שהמחשב יתחבר.');
    }));
    card.querySelector('.remove-btn')?.addEventListener('click', () => runAction(async () => {
      if (!confirm('למחוק את המחשב מהדשבורד? (זה לא מסיר את התוכנה בפועל)')) return;
      await api(`/api/admin/devices/${id}`, { method: 'DELETE' });
      loadDevices();
    }));
  });
}

// 95 -> "1:35 דק'", 40 -> "40 שנ'"; null/undefined -> "-"
function fmtDur(sec) {
  if (sec === null || sec === undefined) return '-';
  if (sec < 60) return `${sec} שנ'`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} דק'`;
}

function lastUpdateLine(d) {
  if (!d.last_update) return '';
  let r;
  try { r = JSON.parse(d.last_update); } catch (e) { return ''; }
  const when = r.at ? new Date(r.at).toLocaleString('he-IL') : '';
  const route = r.from ? `${escapeHtml(r.from)} ← ${escapeHtml(r.to)}` : `גרסה ${escapeHtml(r.to)}`;
  if (r.result === 'success') {
    return `<div class="update-line">עדכון אחרון: ${route} · הצליח · ${fmtDur(r.total_sec !== null ? r.total_sec : r.install_sec)}${r.total_sec !== null && r.install_sec !== null ? ` (התקנה ${fmtDur(r.install_sec)})` : ''}${r.gap_sec !== null && r.gap_sec !== undefined ? ` · הגנה הופסקה ~${fmtDur(r.gap_sec)}` : ''} · ${when}</div>`;
  }
  return `<div class="update-line update-failed">עדכון אחרון נכשל: ${route}${r.error ? ' · ' + escapeHtml(r.error) : ''} · ${when}</div>`;
}

async function openUpdatesReport() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><h3>דוח עדכונים</h3><div class="modal-status">טוען...</div>
    <div class="report-scroll"></div><div class="modal-actions"><button class="close-btn">סגור</button></div></div>`;
  overlay.querySelector('.close-btn').addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
  const statusEl = overlay.querySelector('.modal-status');
  const box = overlay.querySelector('.report-scroll');
  try {
    const { rows, stats } = await api('/api/admin/update-report');
    statusEl.textContent = '';
    if (!rows.length) {
      box.innerHTML = '<div class="report-stats">עדיין אין נתוני עדכון. הנתונים נאספים מכל מחשב שמתעדכן לגרסה 1.13.14 ומעלה (ומחשב שהותקן ידנית מדווח את זמן ההתקנה).</div>';
      return;
    }
    const stat = `<div class="report-stats">הצליחו: <b>${stats.success}</b> · נכשלו: <b>${stats.failed}</b>` +
      (stats.avg_total_sec !== null ? ` · זמן כולל ממוצע: <b>${fmtDur(stats.avg_total_sec)}</b>` : '') +
      (stats.avg_install_sec !== null ? ` · התקנה ממוצעת: <b>${fmtDur(stats.avg_install_sec)}</b>` : '') +
      (stats.slowest ? ` · האיטי ביותר: ${escapeHtml(stats.slowest.device_name)} (${fmtDur(stats.slowest.total_sec)})` : '') + '</div>';
    const trig = { auto: 'אוטומטי', dashboard: 'מהדשבורד', unknown: 'ידני / לא ידוע' };
    const trs = rows.map((r) => `<tr>
      <td>${escapeHtml(r.device_name)}</td>
      <td>${r.from ? escapeHtml(r.from) + ' ← ' : ''}${escapeHtml(r.to)}</td>
      <td>${r.result === 'success' ? 'הצליח' : '<span style="color:#a32d2d">נכשל</span>' + (r.error ? ' · ' + escapeHtml(r.error) : '')}</td>
      <td>${fmtDur(r.total_sec)}</td><td>${fmtDur(r.download_sec)}</td><td>${fmtDur(r.install_sec)}</td><td>${r.gap_sec === null || r.gap_sec === undefined ? '-' : fmtDur(r.gap_sec)}</td>
      <td>${trig[r.trigger] || ''}</td><td>${new Date(r.at).toLocaleString('he-IL')}</td></tr>`).join('');
    box.innerHTML = stat + `<table class="report-table"><thead><tr><th>מחשב</th><th>גרסה</th><th>תוצאה</th><th>זמן כולל</th><th>הורדה</th><th>התקנה</th><th>הפסקת הגנה</th><th>הופעל</th><th>מתי</th></tr></thead><tbody>${trs}</tbody></table>`;
  } catch (e) {
    statusEl.textContent = 'לא הצלחתי לטעון את הדוח';
  }
}

function supportsRemoteUpdate(d) {
  return !!(d.agent_version_at && d.agent_version && cmpVersion(d.agent_version, remoteUpdateMin) >= 0);
}

function versionBadge(d) {
  const st = versionState(d);
  if (st === 'unknown') return '<span class="ver-badge ver-unknown" title="המחשב עדיין לא דיווח גרסה. הוא ידווח אחרי העדכון האוטומטי הבא.">גרסה לא ידועה</span> · ';
  if (st === 'old') return `<span class="ver-badge ver-old" title="הגרסה האחרונה היא ${escapeHtml(latestVersion)}">גרסה ${escapeHtml(d.agent_version)} · לא עדכני</span> · `;
  return `<span class="ver-badge ver-ok">גרסה ${escapeHtml(d.agent_version)} · עדכני</span> · `;
}

function renderVersionSummary(devices) {
  const el = document.getElementById('version-summary');
  if (!el) return;
  if (!devices.length) { el.textContent = ''; return; }
  const count = { ok: 0, old: 0, unknown: 0 };
  devices.forEach((d) => { count[versionState(d)] += 1; });
  const parts = [];
  if (latestVersion) parts.push(`הגרסה האחרונה: <b>${escapeHtml(latestVersion)}</b>`);
  parts.push(`<span class="ver-badge ver-ok">${count.ok} עדכניים</span>`);
  if (count.old) parts.push(`<span class="ver-badge ver-old">${count.old} לא עדכניים</span>`);
  if (count.unknown) parts.push(`<span class="ver-badge ver-unknown">${count.unknown} טרם דיווחו גרסה</span>`);
  el.innerHTML = parts.join(' ');
  const btn = document.getElementById('update-all-btn');
  if (btn) {
    const n = devices.filter((d) => d.status === 'online' && supportsRemoteUpdate(d) && versionState(d) === 'old').length;
    btn.classList.toggle('hidden', n === 0);
    btn.textContent = `עדכן את כל המחשבים הלא עדכניים (${n})`;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

checkSession();
