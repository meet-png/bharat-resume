// Upstash Redis session store. PRD §13.3.
// Keys: session:{phone_hash} (24h), jd:{sha256(url)} (24h), ratelimit:{phone_hash} (60s window, max 30 req).
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
  client.on('error', (err) => {
    // Pino redact in logger.js covers Buffer payloads; ioredis errors include the
    // command but not the URL, so this is safe to forward.
    require('../logger').error({ err: err.message }, 'redis error');
  });
  return client;
}

const SESSION_TTL_SEC = 24 * 60 * 60;
const RATELIMIT_WINDOW_SEC = 60;
const RATELIMIT_MAX = 30;

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

async function deleteSession(phoneHash) {
  await getClient().del(`session:${phoneHash}`);
}

// Payment idempotency (PRD §12). Razorpay retries webhooks on non-2xx, so the
// same payment_id can arrive multiple times. First writer wins: returns true
// only the first time a given payment is seen. 7-day TTL covers all retries.
const PAYMENT_DEDUPE_TTL_SEC = 7 * 24 * 60 * 60;

async function markPaymentProcessed(paymentId) {
  const res = await getClient().set(`razorpay_paid:${paymentId}`, '1', 'EX', PAYMENT_DEDUPE_TTL_SEC, 'NX');
  return res === 'OK';
}

// Releases the dedupe lock so a failed fulfilment can be retried by Razorpay.
async function unmarkPaymentProcessed(paymentId) {
  await getClient().del(`razorpay_paid:${paymentId}`);
}

// Returns { allowed, count, resetInSec }.
async function checkRateLimit(phoneHash) {
  const key = `ratelimit:${phoneHash}`;
  const c = getClient();
  const count = await c.incr(key);
  if (count === 1) await c.expire(key, RATELIMIT_WINDOW_SEC);
  const ttl = await c.ttl(key);
  return { allowed: count <= RATELIMIT_MAX, count, resetInSec: ttl };
}

module.exports = {
  getClient,
  getSession,
  setSession,
  deleteSession,
  markPaymentProcessed,
  unmarkPaymentProcessed,
  checkRateLimit,
  SESSION_TTL_SEC,
  RATELIMIT_WINDOW_SEC,
  RATELIMIT_MAX,
};
