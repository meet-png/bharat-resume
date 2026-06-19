// Razorpay Payment Links + webhook verification. PRD §12.
// TODO Day 5:
//   createPaymentLink({ userId }) → POST /v1/payment_links, ₹49 (4900 paise),
//     callback_url = `${BASE_URL}/payment-success`, return { id, short_url }.
//   verifyWebhookSignature(rawBody, signatureHeader) → HMAC-SHA256 w/ RAZORPAY_WEBHOOK_SECRET.

async function createPaymentLink(_args) {
  throw new Error('createPaymentLink not implemented (Day 5)');
}

function verifyWebhookSignature(_rawBody, _signature) {
  throw new Error('verifyWebhookSignature not implemented (Day 5)');
}

module.exports = { createPaymentLink, verifyWebhookSignature };
