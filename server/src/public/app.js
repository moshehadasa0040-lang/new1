const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const deviceList = document.getElementById('device-list');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'request_failed');
  return res.json();
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

async function loadDevices() {
  const { devices } = await api('/api/admin/devices');
  renderDevices(devices);
}

function renderDevices(devices) {
  if (!devices.length) {
    deviceList.innerHTML = '<div class="empty-state">אין עדיין מחשבים רשומים. התקן את ה-agent על מחשב כדי שיופיע כאן.</div>';
    return;
  }

  deviceList.innerHTML = devices.map((d) => {
    const isOnline = d.status === 'online';
    const isUnlocked = d.unlocked_until && new Date(d.unlocked_until) > new Date();
    return `
      <div class="device-card" data-id="${d.id}">
        <div class="device-info">
          <div class="device-name">${escapeHtml(d.name)}</div>
          <div class="device-meta">
            ${d.hostname ? escapeHtml(d.hostname) + ' · ' : ''}
            נראה לאחרונה: ${d.last_seen ? new Date(d.last_seen).toLocaleString('he-IL') : 'מעולם לא'}
          </div>
        </div>
        <div>
          <span class="status-badge ${isOnline ? 'status-online' : 'status-offline'}">
            ${isOnline ? '● מחובר' : '○ מנותק'}
          </span>
          ${isUnlocked ? '<span class="status-badge status-unlocked">פתוח זמנית</span>' : ''}
        </div>
        <div class="device-actions">
          <button class="unlock-btn">פתח ל-15 דק'</button>
          ${isUnlocked ? '<button class="lock-btn secondary">נעל מיד</button>' : ''}
          <button class="uninstall-btn danger">הסר תוכנה</button>
          <button class="remove-btn secondary">מחק מהדשבורד</button>
        </div>
      </div>
    `;
  }).join('');

  deviceList.querySelectorAll('.device-card').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('.unlock-btn')?.addEventListener('click', async () => {
      const minutes = prompt('לכמה דקות לפתוח?', '15');
      if (!minutes) return;
      await api(`/api/admin/devices/${id}/unlock`, {
        method: 'POST',
        body: JSON.stringify({ minutes: Number(minutes) })
      });
      loadDevices();
    });
    card.querySelector('.lock-btn')?.addEventListener('click', async () => {
      await api(`/api/admin/devices/${id}/lock`, { method: 'POST' });
      loadDevices();
    });
    card.querySelector('.uninstall-btn')?.addEventListener('click', async () => {
      if (!confirm('להסיר את התוכנה לגמרי מהמחשב הזה?')) return;
      await api(`/api/admin/devices/${id}/uninstall`, { method: 'POST' });
      alert('פקודת הסרה נשלחה. היא תתבצע בפעם הבאה שהמחשב יתחבר.');
    });
    card.querySelector('.remove-btn')?.addEventListener('click', async () => {
      if (!confirm('למחוק את המחשב מהדשבורד? (זה לא מסיר את התוכנה בפועל)')) return;
      await api(`/api/admin/devices/${id}`, { method: 'DELETE' });
      loadDevices();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

checkSession();
