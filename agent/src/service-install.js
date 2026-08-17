// Registers the agent as a Windows service that starts automatically on
// boot and restarts itself if it crashes. This is what makes the blocker
// resistant to a normal user just closing the app / logging off.
const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'ContentBlockerAgent',
  description: 'Local content blocking agent, managed via the web dashboard.',
  script: path.join(__dirname, 'index.js'),
  // Restart automatically if the process ever exits unexpectedly.
  wait: 2,
  grow: 0.25,
  maxRestarts: 60
});

svc.on('install', () => {
  console.log('Service installed. Starting...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('Service is already installed.');
});

svc.on('start', () => {
  console.log('Service started.');
});

svc.install();
