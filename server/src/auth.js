const store = require('./store');

// --- Admin auth (dashboard) -------------------------------------------------
// Simple password-based session login. Set ADMIN_PASSWORD in your environment.
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'not_authenticated' });
}

// --- Agent auth (device <-> server) ----------------------------------------
// Every request from an installed agent must include:
//   X-Device-Id:    the device's unique id
//   X-Device-Token: the secret token issued at registration
async function requireDevice(req, res, next) {
  const deviceId = req.header('X-Device-Id');
  const token = req.header('X-Device-Token');
  if (!deviceId || !token) {
    return res.status(401).json({ error: 'missing_credentials' });
  }
  const device = await store.getDevice(deviceId);
  if (!device || device.device_token !== token) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.device = device;
  next();
}

module.exports = { requireAdmin, requireDevice };
