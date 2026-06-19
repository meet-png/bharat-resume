// Upstash Redis session store. PRD §13.3.
// Keys: session:{phone_hash} (24h), jd:{sha256(url)} (24h), ratelimit:{phone_hash} (60s, max 30 req).
const Redis = require('ioredis');
const { config } = require('../config');

let client = null;

function getClient() {
  if (client) return client;
  if (!config.REDIS_URL) throw new Error('REDIS_URL not set');
  client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  return client;
}

const SESSION_TTL_SEC = 24 * 60 * 60;

async function getSession(phoneHash) {
  const raw = await getClient().get(`session:${phoneHash}`);
  return raw ? JSON.parse(raw) : null;
}

async function setSession(phoneHash, session) {
  await getClient().set(
    `session:${phoneHash}`,
    JSON.stringify(session),
    'EX',
    SESSION_TTL_SEC,
  );
}

module.exports = { getClient, getSession, setSession, SESSION_TTL_SEC };
