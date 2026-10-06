const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const blocker = require('./blocker');
const fileLock = require('./fileLock');
const watcher = require('./watcher');

// ---------------------------------------------------------------------------
// "Status check": a human-readable report of the machine's protection state,
// sent to the dashboard together with the recent log (see 'send_logs' in index.js).
// Every check is read-only. ✔ = fine, ✘ = a problem, ⚠ = worth a look / optional.
// ---------------------------------------------------------------------------

const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const SERVICE = config.SERVICE_NAME;

function run(exe, args) {
  return new Promise((resolve) => {
    execFile(path.join(SYS, exe), args, { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout || '') })
    );
  });
}

async function collect() {
  const lines = [];
  let problems = 0;
  const ok = (t) => lines.push(`✔ ${t}`);
  const bad = (t) => {
    problems += 1;
    lines.push(`✘ ${t}`);
  };
  const warn = (t) => lines.push(`⚠ ${t}`);

  // Service state (Windows' view of it).
  const sc = await run('sc.exe', ['query', SERVICE]);
  const state = /STATE\s*:\s*\d+\s+(\w+)/i.exec(sc.out);
  if (state && state[1].toUpperCase() === 'RUNNING') ok(`השירות ${SERVICE} רץ`);
  else bad(`השירות ${SERVICE} לא במצב RUNNING (${state ? state[1] : 'לא נמצא'})`);

  // Watchdog task that restarts the service.
  const task = await run('schtasks.exe', ['/query', '/tn', 'ContentBlockerWatchdog']);
  if (task.ok) ok('משימת השחזור (Watchdog) קיימת');
  else bad('משימת השחזור (Watchdog) לא קיימת - אם השירות ייעצר הוא לא יחזור לבד');

  // Safe Mode registration.
  const sbMin = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot\\Minimal\\${SERVICE}`]);
  const sbNet = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot\\Network\\${SERVICE}`]);
  if (sbMin.ok && sbNet.ok) ok('רישום Safe Mode קיים');
  else bad('רישום Safe Mode חסר');

  // Program restrictions (optional - the installer task "srp").
  const srp = await run('reg.exe', ['query', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Safer\\CodeIdentifiers\\0\\Paths']);
  const srpRules = srp.ok ? srp.out.split(/\r?\n/).filter((l) => /\\Paths\\\{/i.test(l)).length : 0;
  if (srpRules > 0) ok(`חסימת הרצת תוכנות (SRP) פעילה: ${srpRules} כללים`);
  else warn('חסימת הרצת תוכנות (SRP) לא מוגדרת - נגן נייד שהורד עלול לרוץ');

  // Spot-check a sample of locked files: is our deny entry still on them?
  let sample = null;
  try {
    sample = await fileLock.verifySample(10);
  } catch (e) {
    warn(`בדיקת מדגם נעילות נכשלה: ${e.message}`);
  }
  if (sample) {
    if (sample.checked === 0) warn('אין עדיין קבצים נעולים במעקב');
    else if (sample.unlocked > 0 && blocker.isBlocking()) bad(`במדגם של ${sample.checked} קבצים, ${sample.unlocked} איבדו את הנעילה`);
    else ok(`מדגם נעילות תקין (${sample.checked} נבדקו, ${sample.gone} כבר לא קיימים)`);
  }

  // Blocking state, watcher, scans.
  if (blocker.isBlocking()) ok('החסימה פעילה');
  else warn('החסימה כבויה כרגע (פתיחה זמנית)');
  const w = watcher.status();
  if (!config.REALTIME_WATCH) warn('האזנה בזמן אמת כבויה בהגדרות');
  else if (w.drives.length) ok(`האזנה בזמן אמת על: ${w.drives.join(', ')}`);
  else bad('האזנה בזמן אמת לא פעילה על אף כונן');

  // Recent problems in the log.
  const recent = logger.getRecent(500).split('\n');
  const count = (re) => recent.filter((l) => re.test(l)).length;
  const alertsN = count(/\[ALERT\]/);
  const errN = count(/failed|error|Could not/i);
  if (alertsN > 0) warn(`${alertsN} התראות בלוג האחרון`);
  if (errN > 0) warn(`${errN} שורות עם שגיאה/כשל בלוג האחרון (ראה למטה)`);
  if (!alertsN && !errN) ok('אין שגיאות בלוג האחרון');

  const scan = fileLock.getLastFullScan();
  const head = [
    problems === 0 ? '=== הכול תקין ===' : `=== נמצאו ${problems} בעיות ===`,
    `גרסה ${require('../package.json').version} | ${os.hostname()} | Windows ${os.release()} | פעיל ${Math.round(os.uptime() / 3600)} שעות מאז אתחול`,
    `קבצים נעולים במעקב: ${fileLock.getLockedCount()} | סריקה מלאה אחרונה: ${scan && scan.at ? scan.at : 'עדיין לא'}`,
    ''
  ];
  return head.concat(lines).join('\n');
}

module.exports = { collect };
