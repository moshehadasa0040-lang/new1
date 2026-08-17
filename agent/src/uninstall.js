const { Service } = require('node-windows');
const fs = require('fs');
const config = require('./config');
const path = require('path');

// Removes the Windows service and local data. Called when the dashboard
// sends an 'uninstall' command. The installer (Inno Setup) also ships a
// standalone uninstaller for the case where someone removes the software
// directly from "Add or remove programs" - see installer/setup.iss.
async function selfUninstall() {
  return new Promise((resolve) => {
    const svc = new Service({
      name: 'ContentBlockerAgent',
      script: path.join(__dirname, 'index.js')
    });

    svc.on('uninstall', () => {
      cleanupDataDir();
      resolve();
    });

    svc.on('alreadyuninstalled', () => {
      cleanupDataDir();
      resolve();
    });

    try {
      svc.uninstall();
    } catch (e) {
      // Service might not be registered (e.g. running via `node src/index.js`
      // directly during development) - just clean up local files.
      cleanupDataDir();
      resolve();
    }
  });
}

function cleanupDataDir() {
  try {
    fs.rmSync(config.DATA_DIR, { recursive: true, force: true });
  } catch (e) {
    // best-effort
  }
}

module.exports = { selfUninstall };
