// ---------------------------------------------------------------------------
// Central configuration for the agent.
// ---------------------------------------------------------------------------

module.exports = {
  // Name of the Windows service NSSM registers the agent under. Must match
  // {#MyServiceName} in agent/installer/setup.iss and the name used in
  // uninstall-helper.bat - kept here too so agent code (see index.js's
  // NSSM AppExit self-heal check) doesn't need its own hardcoded copy.
  SERVICE_NAME: 'ContentBlockerAgent',

  // URL of your deployed dashboard server (live on Render).
  SERVER_URL: process.env.CB_SERVER_URL || 'https://new1-q4bb.onrender.com',

  // How often the agent talks to the server (ms).
  HEARTBEAT_INTERVAL_MS: 45 * 1000,

  // How often the agent scans and kills blocked processes (ms).
  BLOCK_SCAN_INTERVAL_MS: 3 * 1000,

  // How often the agent re-scans all drives for video files to lock at the
  // OS permission level (ms). This is a heavier operation than the process
  // scan above (it walks the filesystem), so it runs far less often - it
  // exists mainly to catch newly copied/downloaded video files.
  FILE_LOCK_SCAN_INTERVAL_MS: 3 * 60 * 1000,

  // Where the agent stores its local state (device id/token, cache of rules).
  DATA_DIR: 'C:\\ProgramData\\ContentBlockerAgent',

  // Human-readable logs. Deliberately in a normal, easy-to-find folder
  // (Public Documents) so it's possible to see exactly what the agent did
  // without digging through ProgramData. The installer and the agent both
  // write here; NSSM's stdout/stderr capture files go here too.
  LOG_DIR: 'C:\\Users\\Public\\Documents\\ContentBlockerLogs',

  // QUICK scan: only the user-profile folders (Videos, Downloads, Desktop,
  // Public ...). That's where nearly all real video files live and it takes
  // seconds, instead of the minutes a whole-drive scan needs. It runs
  // immediately at startup and then often, so a file is locked within
  // moments - not only after the slow full scan finishes.
  PRIORITY_ROOTS: [(process.env.SystemDrive || 'C:') + require('path').sep + 'Users'],
  FILE_LOCK_QUICK_INTERVAL_MS: 30 * 1000,

  // How many icacls processes to run in parallel while locking.
  LOCK_CONCURRENCY: 4,

  // Never lock files under these folders: they belong to Windows / installed
  // programs (sample clips, help videos, game assets...) and denying "Users"
  // read access there can break the OS or applications. (Unlocking on
  // uninstall still covers everything, to be safe.)
  EXCLUDED_PATH_PREFIXES: [
    (process.env.SystemRoot || 'C:\\Windows') + require('path').sep,
    (process.env.ProgramFiles || 'C:\\Program Files') + require('path').sep,
    (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)') + require('path').sep,
    'C:\\ProgramData\\ContentBlockerAgent\\'
  ],

  // Process names (as shown in Task Manager / tasklist) that are blocked
  // whenever the device is locked. Extend this list as needed - it's also
  // overridable per-device from the server via an 'update_rules' command.
  DEFAULT_BLOCKED_PROCESSES: [
    'vlc.exe',
    'wmplayer.exe',
    'mpc-hc.exe',
    'mpc-hc64.exe',
    'mpv.exe',
    'PotPlayerMini.exe',
    'PotPlayerMini64.exe',
    'kmplayer.exe',
    'GOM.exe',
    'smplayer.exe',
    // Windows' built-in video app ("Movies & TV" / Films & TV) - this is
    // very likely what's actually installed and used on most Windows 10/11
    // machines by default, more so than any third-party player above.
    'Video.UI.exe',
    'MediaPlayer.exe'
  ],
  // NOT included by default: chrome.exe / msedge.exe / firefox.exe, etc.
  // Most streaming today happens inside a browser tab, which no process
  // name above can catch - but blocking a whole browser process also
  // blocks all other browsing, email, etc. That's a much bigger decision
  // than "block movies", so it's intentionally left as an opt-in: add
  // browser process names via the dashboard's "ערוך רשימת חסימה" button
  // if that trade-off is acceptable for your situation. See README.

  // File extensions considered "movie files". These are what actually get
  // their NTFS permissions locked down (see fileLock.js) - this is the real
  // enforcement mechanism, not just a label for logging.
  MOVIE_EXTENSIONS: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.webm']
};
