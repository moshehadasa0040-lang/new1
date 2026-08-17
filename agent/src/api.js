const axios = require('axios');
const os = require('os');
const config = require('./config');

function client(deviceId, deviceToken) {
  return axios.create({
    baseURL: config.SERVER_URL,
    timeout: 15000,
    headers: deviceId
      ? { 'X-Device-Id': deviceId, 'X-Device-Token': deviceToken }
      : {}
  });
}

async function register(hardwareId) {
  const res = await client().post('/api/agent/register', {
    hardwareId,
    hostname: os.hostname(),
    agentVersion: require('../package.json').version
  });
  return res.data; // { deviceId, deviceToken }
}

async function heartbeat(deviceId, deviceToken) {
  const res = await client(deviceId, deviceToken).post('/api/agent/heartbeat', {});
  return res.data; // { unlockedUntil, commands }
}

async function ack(deviceId, deviceToken, commandId, message) {
  await client(deviceId, deviceToken).post('/api/agent/ack', { commandId, message });
}

module.exports = { register, heartbeat, ack };
