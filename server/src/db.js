const Redis = require('ioredis');

// Aiven gives you a "Service URI" that looks like:
//   rediss://default:PASSWORD@host:port
// The double 's' in "rediss" means TLS - ioredis detects that from the
// scheme automatically, so no extra config is needed.
//
// Set this as REDIS_URL in your environment (locally via .env, on Render
// via the service's Environment tab).
const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error('Missing REDIS_URL environment variable. Copy the "Service URI" from your Aiven Valkey/Redis console.');
  process.exit(1);
}

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  // Aiven's certs are publicly trusted, but this keeps things working even
  // if Node's CA bundle ever disagrees with Aiven's chain.
  tls: REDIS_URL.startsWith('rediss://') ? {} : undefined
});

redis.on('error', (err) => console.error('Redis connection error:', err.message));
redis.on('connect', () => console.log('Connected to Redis/Valkey.'));

module.exports = redis;
