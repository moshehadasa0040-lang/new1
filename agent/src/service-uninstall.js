const { Service } = require('node-windows');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const svc = new Service({
  name: 'ContentBlockerAgent',
  script: path.join(__dirname, 'index.js')
});

svc.on('uninstall', () => {
  console.log('Service uninstalled.');
  try {
    fs.rmSync(config.DATA_DIR, { recursive: true, force: true });
  } catch (e) {}
  process.exit(0);
});

svc.uninstall();
