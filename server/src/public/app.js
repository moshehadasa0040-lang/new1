const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const deviceList = document.getElementById('device-list');
const searchInput = document.getElementById('search-input');
const deviceCount = document.getElementById('device-count');
let lastDevices = [];

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
  setInterval(loadDevices, 10000); // refresh every 10s
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
        <div>${escapeHtml(r.summary || 'לא דווח סיכום')}</div>
      </div>`;
    }).join('');
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
            ${d.agent_version ? 'גרסה ' + escapeHtml(d.agent_version) + ' · ' : ''}
            נראה לאחרונה: ${d.last_seen ? new Date(d.last_seen).toLocaleString('he-IL') : 'מעולם לא'}
          </div>
        </div>
        </div>
        <div>
          <span class="status-badge ${isOnline ? 'status-online' : 'status-offline'}">
            <span class="status-dot"></span>${isOnline ? 'מחובר' : 'מנותק'}
          </span>
          ${isUnlocked ? '<span class="status-badge status-unlocked">פתוח זמנית</span>' : ''}
        </div>
        <div class="device-actions">
          <button class="unlock-btn">פתח ל-15 דק'</button>
          <button class="rename-btn secondary">שנה שם</button>
          ${isUnlocked ? '<button class="lock-btn secondary">נעל מיד</button>' : ''}
          <button class="rules-btn secondary">ערוך רשימת חסימה</button>
          <button class="status-btn">בדיקת מצב מיידית</button>
          <button class="events-btn secondary">אירועים והתראות</button>
          <button class="logs-btn secondary">בקש לוגים</button>
          <button class="download-logs-btn secondary">הורד לוגים</button>
          <button class="uninstall-btn danger">הסר תוכנה</button>
          <button class="remove-btn secondary">מחק מהדשבורד</button>
        </div>
      </div>
    `;
  }).join('');

  deviceList.querySelectorAll('.device-card').forEach((card) => {
    const id = card.dataset.id;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

checkSession();
