const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const blocker = require('./blocker');

// ---------------------------------------------------------------------------
// Closes whoever still has a just-locked video open.
//
// Denying read access does not affect a handle opened BEFORE the deny was added:
// a player that already opened the file keeps playing. Here we ask Windows'
// Restart Manager (the same API installers use to see "which app is using this
// file") for the processes holding each file, and close the ones that run in a
// user session. Protected names, services (session 0) and ourselves are skipped.
// ---------------------------------------------------------------------------

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const LIST_FILE = path.join(config.DATA_DIR, 'holders-list.txt');

const CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class RMHolders
{
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint handle, int flags, string key);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint handle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint handle, uint nFiles, string[] files,
        uint nApps, RM_UNIQUE_PROCESS[] apps, uint nServices, string[] services);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint handle, out uint needed, ref uint count,
        [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);

    static void Chunk(string[] files, List<string> result)
    {
        uint h;
        if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return;
        try
        {
            if (RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null) != 0) return;
            uint needed = 0, count = 0, reasons = 0;
            int res = RmGetList(h, out needed, ref count, null, ref reasons);
            if (res == 234 && needed > 0)
            {
                RM_PROCESS_INFO[] info = new RM_PROCESS_INFO[needed];
                count = needed;
                res = RmGetList(h, out needed, ref count, info, ref reasons);
                if (res == 0)
                {
                    for (int i = 0; i < count; i++)
                    {
                        int pid = info[i].Process.dwProcessId;
                        string name = "";
                        int session = -1;
                        try
                        {
                            System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById(pid);
                            name = p.ProcessName + ".exe";
                            session = p.SessionId;
                        }
                        catch (Exception) { }
                        string line = pid + "|" + name + "|" + session;
                        if (!result.Contains(line)) result.Add(line);
                    }
                }
            }
        }
        finally { RmEndSession(h); }
    }

    public static List<string> Find(string[] files)
    {
        List<string> result = new List<string>();
        for (int i = 0; i < files.Length; i += 100)
        {
            int n = Math.Min(100, files.Length - i);
            string[] chunk = new string[n];
            Array.Copy(files, i, chunk, 0, n);
            try { Chunk(chunk, result); } catch (Exception) { }
        }
        return result;
    }
}
`;

// The script is passed with -EncodedCommand, so the machine's PowerShell
// execution policy (which only governs script FILES) does not matter.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CSHARP}
'@
$files = @(Get-Content -LiteralPath $env:CB_HOLDERS_LIST -Encoding UTF8 | Where-Object { $_ })
[RMHolders]::Find([string[]]$files) | ForEach-Object { Write-Output $_ }
`;
const ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

function runFinder(files) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
      fs.writeFileSync(LIST_FILE, files.join('\n'), 'utf8');
    } catch (e) {
      logger.log(`[holders] cannot write list: ${e.message}`);
      return resolve([]);
    }
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED],
      { windowsHide: true, timeout: 60000, env: { ...process.env, CB_HOLDERS_LIST: LIST_FILE }, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          logger.log(`[holders] lookup failed: ${String(stderr || err.message).trim().split(/\r?\n/)[0]}`);
          return resolve([]);
        }
        const out = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^(\d+)\|([^|]*)\|(-?\d+)$/.exec(line.trim());
          if (m) out.push({ pid: Number(m[1]), name: m[2], session: Number(m[3]) });
        }
        resolve(out);
      }
    );
  });
}

function kill(pid) {
  return new Promise((resolve) => execFile(TASKKILL, ['/PID', String(pid), '/F'], { windowsHide: true }, (e) => resolve(!e)));
}

const queue = new Set();
let timer = null;
let busy = false;

async function drainQueue() {
  if (busy) {
    // A lookup is running; try again a bit later with whatever has accumulated.
    timer = setTimeout(() => {
      timer = null;
      drainQueue();
    }, 1000);
    return;
  }
  timer = null;
  const files = [...queue].slice(0, 300);
  files.forEach((f) => queue.delete(f));
  if (!files.length || !blocker.isBlocking()) return;
  busy = true;
  try {
    const protectedNames = new Set(config.PROTECTED_PROCESSES.map((n) => n.toLowerCase()));
    const holders = await runFinder(files);
    for (const h of holders) {
      if (h.pid <= 4 || h.pid === process.pid) continue; // System / ourselves
      if (h.session <= 0) continue; // services (session 0) and unknown: never
      if (!h.name) continue; // could not identify it - never kill blindly
      if (protectedNames.has(h.name.toLowerCase())) continue;
      if (!blocker.isBlocking()) break;
      const ok = await kill(h.pid);
      logger.log(`[holders] ${ok ? 'Closed' : 'Could not close'} ${h.name || 'pid ' + h.pid} (pid ${h.pid}) - it still had a locked video open.`);
    }
  } catch (e) {
    logger.log(`[holders] error: ${e.message}`);
  } finally {
    busy = false;
    if (queue.size && !timer) timer = setTimeout(drainQueue, config.HOLDER_RECHECK_DELAY_MS);
  }
}

// Called with files that were just locked. Waits a moment (a browser or copy tool
// that is finishing a download closes its own handle by then) and then closes
// whoever is still holding them.
function releaseSoon(files) {
  if (!config.KILL_FILE_HOLDERS || !files || !files.length) return;
  files.forEach((f) => queue.add(f));
  if (!timer) timer = setTimeout(drainQueue, config.HOLDER_RECHECK_DELAY_MS);
}

function stop() {
  clearTimeout(timer);
  timer = null;
  queue.clear();
}

module.exports = { releaseSoon, stop, _ENCODED_FOR_TESTS: ENCODED, _PS_SCRIPT_FOR_TESTS: PS_SCRIPT };
