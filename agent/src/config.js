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
  HEARTBEAT_INTERVAL_MS: 20 * 1000, // also how fast a dashboard command (status check, lock, unlock) reaches the PC

  // How often the agent scans and kills blocked processes (ms).
  BLOCK_SCAN_INTERVAL_MS: 1000,

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
    // Players that are (almost) only for video. Players that are also normal music /
    // picture apps (Windows Media Player, the new Media Player) are deliberately NOT
    // closed by name: they cannot open a locked video anyway, so music keeps working.
    'vlc.exe',
    'mpc-hc.exe',
    'mpc-hc64.exe',
    'mpc-be.exe',
    'mpc-be64.exe',
    'mpv.exe',
    'PotPlayerMini.exe',
    'PotPlayerMini64.exe',
    'PotPlayer.exe',
    'kmplayer.exe',
    'GOM.exe',
    'smplayer.exe',
    'ffplay.exe',
    'ffmpeg.exe',
    'HandBrake.exe',
    'Stremio.exe',
    'QuickTimePlayer.exe',
    'RealPlayer.exe',
    'DivXPlayer.exe',
    // Windows' built-in video app ("Movies & TV" / Films & TV).
    'Video.UI.exe'
  ],  // NOT included by default: chrome.exe / msedge.exe / firefox.exe, etc.
  // Most streaming today happens inside a browser tab, which no process
  // name above can catch - but blocking a whole browser process also
  // blocks all other browsing, email, etc. That's a much bigger decision
  // than "block movies", so it's intentionally left as an opt-in: add
  // browser process names via the dashboard's "ערוך רשימת חסימה" button
  // if that trade-off is acceptable for your situation. See README.

  // File extensions considered "movie files". These are what actually get
  // their NTFS permissions locked down (see fileLock.js) - this is the real
  // enforcement mechanism, not just a label for logging.
  // ('.ts' and '.mod' are deliberately NOT here: TypeScript sources etc. Real MPEG-TS
  // video is still caught by the content check, see fileLock.sniffIsVideo.)
  MOVIE_EXTENSIONS: [
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.webm',
    '.3gp', '.3g2', '.vob', '.rm', '.rmvb', '.mts', '.m2ts', '.ogv', '.f4v', '.asf', '.divx'
  ],

  // --- Near-real-time protection (agent/src/watcher.js) -----------------------
  // Listens to Windows' own file-change notifications (ReadDirectoryChangesW,
  // via fs.watch) on every fixed/removable drive, so a new or renamed video is
  // locked within ~a second instead of waiting for the next periodic scan.
  REALTIME_WATCH: true,
  WATCH_DEBOUNCE_MS: 40,
  // How often to look for newly plugged-in drives (USB) to start watching.
  WATCH_DRIVE_REFRESH_MS: 20 * 1000,

  // --- Closing whoever already has a freshly locked video open ---------------
  // A lock does not affect a handle that was opened BEFORE it. So right after
  // locking a file, ask Windows (Restart Manager) which processes still hold it
  // and close those that run in a user session - whatever their name (a player
  // that is not on the block list, a renamed exe). Processes below, services
  // (session 0, e.g. antivirus) and the agent itself are never touched.
  KILL_FILE_HOLDERS: true,
  HOLDER_RECHECK_DELAY_MS: 1500, // let a browser/copy tool finish and close its own handle first
  PROTECTED_PROCESSES: [
    'explorer.exe', 'dllhost.exe', 'taskhostw.exe', 'sihost.exe', 'runtimebroker.exe',
    'searchindexer.exe', 'searchprotocolhost.exe', 'searchhost.exe', 'shellexperiencehost.exe',
    'startmenuexperiencehost.exe', 'applicationframehost.exe', 'ctfmon.exe', 'smartscreen.exe',
    'msmpeng.exe', 'onedrive.exe', 'dropbox.exe',
    'cmd.exe', 'powershell.exe', 'conhost.exe', 'wt.exe',
    // Browsers: they hold a file while DOWNLOADING it; killing them on every
    // finished download would be far worse than the problem. (Local playback in
    // a browser is still stopped because the file itself is locked.)
    'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'iexplore.exe'
  ],

  // --- Content detection (renamed / disguised videos) -------------------------
  // Files are identified by their first bytes, not only by extension. No size
  // threshold other than "big enough to contain a header".
  SNIFF_BYTES: 4096,
  SNIFF_MIN_FILE_BYTES: 12,
  // Deep content sweep of the user profile folders (finds videos renamed to
  // .txt/.dll/.jpg ...). Results are cached by (mtime,size), so repeats are cheap.
  DEEP_SWEEP_INTERVAL_MS: 10 * 60 * 1000,
  DEEP_SWEEP_SKIP_DIRS: ['appdata', 'node_modules', '.git']
};
