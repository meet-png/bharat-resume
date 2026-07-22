// Razorpay Payment Links + webhook verification. PRD §12.
// Signature verification implemented Day 1 (security-critical); link creation +
// fulfilment added Day 5.2. Razorpay signs webhook payloads with HMAC-SHA256
// using RAZORPAY_WEBHOOK_SECRET; we compute the same and timingSafeEqual.
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { config } = require('../config');
const logger = require('../logger');

// ₹49 unlock for the clean, ATS-readable PDF (PRD §12).
const UNLOCK_AMOUNT_PAISE = 4900;

let rzpClient = null;
function getRzp() {
  if (rzpClient) return rzpClient;
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set');
  }
  rzpClient = new Razorpay({
    key_id: config.RAZORPAY_KEY_ID,
    key_secret: config.RAZORPAY_KEY_SECRET,
  });
  return rzpClient;
}

// Creates a ₹49 Razorpay Payment Link. The phone hash (NOT the raw number) is
// stored in `notes` so the webhook can map the payment back to a session
// without putting PII in Razorpay's dashboard. Caller can pass additional
// `notes` (string values only — Razorpay rejects non-strings) — used by
// v2 rate mode to mark `flow: 'rate'` so the webhook dispatcher has a
// belt-and-braces signal even if session state is somehow stale.
// Returns { id, short_url }.
async function createPaymentLink({ phoneHash, notes: extraNotes } = {}) {
  if (!phoneHash) throw new Error('createPaymentLink: phoneHash required');
  const rzp = getRzp();
  // Merge caller notes on top of phone_hash. All values stringified because
  // Razorpay's notes field only accepts strings — a non-string value gets
  // the whole request rejected. phone_hash always wins if a caller tries
  // to overwrite it.
  const notes = { phone_hash: String(phoneHash) };
  if (extraNotes && typeof extraNotes === 'object') {
    for (const [k, v] of Object.entries(extraNotes)) {
      if (k === 'phone_hash') continue;
      if (v == null) continue;
      notes[k] = String(v);
    }
  }
  const link = await rzp.paymentLink.create({
    amount: UNLOCK_AMOUNT_PAISE,
    currency: 'INR',
    description: 'BHARAT RESUME - clean ATS-readable PDF unlock',
    notes,
    callback_url: `${config.BASE_URL}/payment-success`,
    callback_method: 'get',
    reminder_enable: false,
  });
  logger.info({ id: link.id, phoneHash: String(phoneHash).slice(0, 12), notesKeys: Object.keys(notes) }, 'razorpay payment link created');
  return { id: link.id, short_url: link.short_url };
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!config.RAZORPAY_WEBHOOK_SECRET) {
    if (config.NODE_ENV === 'production') {
      throw new Error('RAZORPAY_WEBHOOK_SECRET missing in production');
    }
    return false;
  }
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  let b;
  try {
    b = Buffer.from(String(signatureHeader), 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { createPaymentLink, verifyWebhookSignature, UNLOCK_AMOUNT_PAISE };
