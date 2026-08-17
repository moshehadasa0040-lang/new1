require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');

const { router: agentRoutes } = require('./routes/agent');
const adminRoutes = require('./routes/admin');
const redis = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'change-this-secret-in-production'],
    maxAge: 24 * 60 * 60 * 1000
  })
);

app.use('/api/agent', agentRoutes);
app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  // Confirms the Aiven Redis/Valkey connection works before accepting traffic.
  await redis.ping();
  app.listen(PORT, () => console.log(`Dashboard server listening on port ${PORT}`));
}

start().catch((err) => {
  console.error('Failed to connect to Redis:', err.message);
  process.exit(1);
});
