// ---------------------------------------------------------------------------
// Central configuration for the agent.
// ---------------------------------------------------------------------------

module.exports = {
  // URL of your deployed dashboard server (Render URL once you deploy it).
  SERVER_URL: process.env.CB_SERVER_URL || 'https://your-app.onrender.com',

  // How often the agent talks to the server (ms).
  HEARTBEAT_INTERVAL_MS: 45 * 1000,

  // How often the agent scans and kills blocked processes (ms).
  BLOCK_SCAN_INTERVAL_MS: 3 * 1000,

  // Where the agent stores its local state (device id/token, cache of rules).
  DATA_DIR: 'C:\\ProgramData\\ContentBlockerAgent',

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
    'smplayer.exe'
  ],

  // File extensions considered "movie files" for local blocking heuristics
  // (used only for informational/logging purposes in this skeleton - actual
  // file-open blocking requires a shell extension / filter driver, noted in
  // the README).
  MOVIE_EXTENSIONS: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv']
};
