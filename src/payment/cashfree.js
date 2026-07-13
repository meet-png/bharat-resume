// Cashfree Payments — Payment Links API + webhook signature verify.
// Switched to as primary provider 2026-07-08 after Razorpay KYC rejection.
// Shape-compatible with src/payment/razorpay.js so src/payment/index.js can
// dispatch by config.PAYMENT_PROVIDER.
//
// Docs: https://docs.cashfree.com/reference/pg-create-payment-link
// Webhook signing: base64(HMAC-SHA256(timestamp + rawBody, secret)); the
// timestamp is delivered in the x-webhook-timestamp header — signing timestamp
// + body defeats replay of a captured payload with an old body.
const crypto = require('crypto');
const { config } = require('../config');
const { getClient } = require('../store/redis');
const logger = require('../logger');

// Redis key + TTL for the link_id → phone_hash mapping. Written at link
// creation, read by the webhook route as a fallback when the PAYMENT_SUCCESS
// event doesn't carry link_notes/order_tags. 48h > link expiry + retry window.
const LINK_MAP_TTL_SEC = 48 * 60 * 60;
const LINK_MAP_KEY = (linkId) => `cashfree:link:${linkId}`;

const UNLOCK_AMOUNT_INR = 49;
const API_VERSION = '2023-08-01';

function apiBase() {
  return config.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function requireKeys() {
  if (!config.CASHFREE_APP_ID || !config.CASHFREE_SECRET_KEY) {
    throw new Error('CASHFREE_APP_ID / CASHFREE_SECRET_KEY not set');
  }
}

// Strip any 'whatsapp:' prefix and normalise to E.164 (+91XXXXXXXXXX). Cashfree
// accepts both plain 10-digit and full E.164; E.164 is unambiguous for non-IN
// test numbers so we send that shape.
function normalisePhone(raw) {
  if (!raw) return null;
  let p = String(raw).trim();
  if (p.startsWith('whatsapp:')) p = p.slice('whatsapp:'.length);
  p = p.replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return p;
  if (p.length === 10) return '+91' + p;
  if (p.length === 12 && p.startsWith('91')) return '+' + p;
  return p.startsWith('+') ? p : '+' + p;
}

// Creates a ₹49 Cashfree Payment Link. Phone HASH goes in link_notes (mirrors
// the Razorpay flow — the webhook uses it to map back to a session without
// putting PII in Cashfree's dashboard). Real phone/name/email go in
// customer_details because Cashfree requires them for the link.
// Returns { id, short_url } — same shape router.js expects from either provider.
async function createPaymentLink({ phoneHash, phone, name, email }) {
  if (!phoneHash) throw new Error('createPaymentLink: phoneHash required');
  requireKeys();

  const customerPhone = normalisePhone(phone);
  if (!customerPhone) throw new Error('createPaymentLink: customer phone required by Cashfree');

  // Unique per merchant, stable-enough for retries: hash-fragment + timestamp.
  const linkId = `br_${String(phoneHash).slice(0, 12)}_${Date.now()}`;

  const body = {
    link_id: linkId,
    link_amount: UNLOCK_AMOUNT_INR,
    link_currency: 'INR',
    link_purpose: 'BHARAT RESUME - clean ATS-readable PDF unlock',
    customer_details: {
      customer_name: (name && String(name).slice(0, 64)) || 'Bharat Resume Student',
      customer_email: (email && String(email).slice(0, 128)) || 'unknown@bharatresume.in',
      customer_phone: customerPhone,
    },
    link_notify: { send_sms: false, send_email: false },
    link_meta: {
      notify_url: `${config.BASE_URL}/webhook/cashfree`,
      return_url: `${config.BASE_URL}/payment-success`,
    },
    link_notes: { phone_hash: String(phoneHash) },
    link_auto_reminders: false,
  };

  const res = await fetch(`${apiBase()}/links`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-version': API_VERSION,
      'x-client-id': config.CASHFREE_APP_ID,
      'x-client-secret': config.CASHFREE_SECRET_KEY,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

  if (!res.ok) {
    const err = new Error(`cashfree link create failed: ${res.status}`);
    err.statusCode = res.status;
    err.cfCode = data && (data.code || data.error_code);
    err.cfDesc = data && (data.message || data.error_description);
    throw err;
  }

  const linkUrl = data.link_url || data.link_url_https;
  if (!linkUrl) throw new Error('cashfree link create: no link_url in response');

  // Persist link_id → phone_hash so the webhook can map back even when
  // Cashfree doesn't carry link_notes into PAYMENT_SUCCESS_WEBHOOK's order_tags.
  // This is a fallback — link_notes/order_tags on the payload is still tried
  // first. TTL is generous (48h) so a Cashfree retry after a Railway outage
  // still resolves. Failure to write is logged but not fatal: the primary
  // path (order_tags) may still work.
  try {
    await getClient().set(LINK_MAP_KEY(data.link_id), String(phoneHash), 'EX', LINK_MAP_TTL_SEC);
  } catch (e) {
    logger.warn({ err: e.message, linkId: data.link_id }, 'link→phone_hash mapping write failed (fallback only)');
  }

  logger.info({ id: data.link_id, phoneHash: String(phoneHash).slice(0, 12) }, 'cashfree payment link created');
  return { id: data.link_id, short_url: linkUrl };
}

// Reverse-lookup phone_hash by link_id. Used by the webhook route when the
// event payload doesn't include link_notes/order_tags. Returns null on miss
// (session likely expired, or link created before this code shipped).
async function getPhoneHashByLinkId(linkId) {
  if (!linkId) return null;
  try {
    return await getClient().get(LINK_MAP_KEY(linkId));
  } catch (e) {
    logger.warn({ err: e.message, linkId }, 'link→phone_hash mapping read failed');
    return null;
  }
}

// Cashfree signs webhooks with base64(HMAC-SHA256(timestamp + rawBody, secret)).
// Both header values are required; a missing/mismatched pair is a hard reject.
// Timing-safe comparison. Raw body must be exact bytes as delivered (route uses
// express.raw()).
function verifyWebhookSignature(rawBody, signatureHeader, timestampHeader) {
  if (!config.CASHFREE_WEBHOOK_SECRET) {
    if (config.NODE_ENV === 'production') {
      throw new Error('CASHFREE_WEBHOOK_SECRET missing in production');
    }
    return false;
  }
  if (!signatureHeader || !timestampHeader) return false;

  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const signed = Buffer.concat([Buffer.from(String(timestampHeader)), raw]);
  const expected = crypto
    .createHmac('sha256', config.CASHFREE_WEBHOOK_SECRET)
    .update(signed)
    .digest('base64');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  createPaymentLink,
  verifyWebhookSignature,
  normalisePhone,
  getPhoneHashByLinkId,
  UNLOCK_AMOUNT_INR,
};
