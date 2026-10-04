const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const TASK_NAME = 'ContentBlockerAgentUninstall';

// Called when the dashboard sends an 'uninstall' command.
//
// The agent CANNOT stop/remove its own Windows service while it's running
// (Windows won't let a service delete itself mid-execution), so instead it
// launches a small helper script (uninstall-helper.bat) that waits for this
// process to exit, then uses NSSM to stop+remove the service. The helper is
// installed by setup.iss right next to the agent exe, alongside nssm.exe.
//
// How the helper is launched matters: a plain detached child of a service
// process can be killed together with the service's process tree when NSSM
// tears the service down. So the primary method is a one-shot Scheduled
// Task running as SYSTEM, which lives completely outside the service's
// process tree. If creating the task fails for any reason, we fall back to
// the old detached spawn.
//
// This "soft uninstall" stops the blocking service and clears the device's
// local identity. The program's files and its entry in "Add or remove
// programs" remain - removing those is done via the normal Windows
// uninstaller.
function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true }, (error) => resolve(!error));
  });
}

async function launchViaScheduler(helperPath) {
  const create =
    `schtasks /create /tn ${TASK_NAME} /sc once /st 00:00 /ru SYSTEM /rl HIGHEST /f ` +
    `/tr "\\"${helperPath}\\""`;
  if (!(await runCmd(create))) return false;
  return runCmd(`schtasks /run /tn ${TASK_NAME}`);
}

function launchDetached(helperPath, installDir) {
  const child = spawn('cmd.exe', ['/c', helperPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: installDir
  });
  child.unref();
}

async function selfUninstall() {
  const installDir = path.dirname(process.execPath);
  const helperPath = path.join(installDir, 'uninstall-helper.bat');

  cleanupIdentity();

  if (!fs.existsSync(helperPath)) {
    // Running outside of an installed copy (e.g. `node src/index.js`
    // during development) - nothing to hand off to.
    return;
  }

  let launched = false;
  try {
    launched = await launchViaScheduler(helperPath);
  } catch (e) {
    launched = false;
  }
  if (!launched) launchDetached(helperPath, installDir);
}

function cleanupIdentity() {
  try {
    fs.rmSync(config.DATA_DIR, { recursive: true, force: true });
  } catch (e) {
    // best-effort
  }
}

module.exports = { selfUninstall };
