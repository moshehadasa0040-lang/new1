const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Called when the dashboard sends an 'uninstall' command.
//
// The agent CANNOT stop/remove its own Windows service while it's running
// (Windows won't let a service delete itself mid-execution), so instead it
// launches a small detached helper script that waits for this process to
// exit, then uses NSSM to stop+remove the service. The helper script
// (uninstall-helper.bat) is installed by setup.iss right next to the agent
// exe, alongside nssm.exe.
//
// This "soft uninstall" stops the blocking service and clears the device's
// local identity (so it won't re-register as the same device). The
// program's files and its entry in "Add or remove programs" remain - for a
// full cleanup, the user (or the agent, next time, via re-running the
// installer's uninstaller) can remove those too. This is intentional: the
// dashboard's "uninstall" button turns the blocker off, which is the part
// that matters for the parent, without risking a half-finished file
// deletion race against the running process.
async function selfUninstall() {
  return new Promise((resolve) => {
    const installDir = path.dirname(process.execPath);
    const helperPath = path.join(installDir, 'uninstall-helper.bat');

    cleanupIdentity();

    if (!fs.existsSync(helperPath)) {
      // Running outside of an installed copy (e.g. `node src/index.js`
      // during development) - nothing to hand off to.
      return resolve();
    }

    const child = spawn('cmd.exe', ['/c', helperPath], {
      detached: true,
      stdio: 'ignore',
      cwd: installDir
    });
    child.unref();
    resolve();
  });
}

function cleanupIdentity() {
  try {
    fs.rmSync(config.DATA_DIR, { recursive: true, force: true });
  } catch (e) {
    // best-effort
  }
}

module.exports = { selfUninstall };
