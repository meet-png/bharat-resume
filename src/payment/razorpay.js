// Razorpay Payment Links + webhook verification. PRD §12.
// Signature verification implemented now (security-critical) even though the rest
// of the payment flow is Day 5. Razorpay signs webhook payloads with HMAC-SHA256
// using RAZORPAY_WEBHOOK_SECRET; we compute the same and timingSafeEqual.
const crypto = require('crypto');
const { config } = require('../config');

// TODO Day 5: createPaymentLink → POST /v1/payment_links, ₹49 (4900 paise),
//   callback_url = `${BASE_URL}/payment-success`, return { id, short_url }.
async function createPaymentLink(_args) {
  throw new Error('createPaymentLink not implemented (Day 5)');
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

module.exports = { createPaymentLink, verifyWebhookSignature };
