// Cashfree Payments webhook. PRD §12, §14 (adapted 2026-07-08 / 07-09).
// Signature verification gates the route. Raw body is required for HMAC —
// express.raw() feeds it in as a Buffer.
//
// Cashfree fires two families of events for a paid link:
//   - PAYMENT_LINK_EVENT (link_status: PAID) — carries link_notes with our
//     phone_hash. Preferred, but not offered on every account tier.
//   - PAYMENT_SUCCESS_WEBHOOK — order-level. Fired on every completed payment.
//     May or may not carry order_tags with our phone_hash depending on how
//     Cashfree propagates link_notes → order.order_tags on their side.
//
// This route handles both. Meet's account only exposes success payment in the
// dashboard, so PAYMENT_SUCCESS_WEBHOOK is the active path in production.
// phone_hash resolution order:
//   1. data.link_notes.phone_hash        (PAYMENT_LINK_EVENT)
//   2. data.order.order_tags.phone_hash  (PAYMENT_SUCCESS_WEBHOOK, if propagated)
//   3. Redis lookup by link_id/order_id  (always written at link create)
// If all three fail, we 500 so Cashfree retries — buying us time to inspect
// the payload shape in logs.
const express = require('express');
const { verifyWebhookSignature, getPhoneHashByLinkId, UNLOCK_AMOUNT_INR } = require('../payment/cashfree');
const { fulfillPaymentByMode } = require('../payment/dispatch');

const router = express.Router();

// Server-side amount check. HMAC prevents outsider forgery, but does NOT
// prevent a MITM'd client from swapping the paylink URL for one with a
// smaller amount before it reaches the student. If Cashfree ever offers
// a way for a paylink to be paid at a different amount than we set, this
// check catches it. Rejects the fulfilment (returns 200 so we don't get
// stuck in a retry storm; the payment is logged for manual review).
function verifyAmountInr(amount, currency) {
  if (currency && String(currency).toUpperCase() !== 'INR') return { ok: false, why: `currency=${currency}` };
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, why: 'amount not finite/positive' };
  if (Math.abs(n - UNLOCK_AMOUNT_INR) > 0.001) return { ok: false, why: `amount=${n} !== ${UNLOCK_AMOUNT_INR}` };
  return { ok: true };
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['x-webhook-signature'];
  const ts = req.headers['x-webhook-timestamp'];
  const ok = verifyWebhookSignature(req.body, sig, ts);
  if (!ok) {
    req.log.warn('invalid cashfree signature');
    return res.status(403).send('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  } catch {
    req.log.warn('cashfree webhook: bad JSON');
    return res.status(400).send('bad json');
  }

  const type = payload && payload.type;
  const data = (payload && payload.data) || {};

  let phoneHash = null;
  let linkId = null;
  let paymentId = null;
  let notes = null; // link_notes / order_tags — includes flow marker for v2 rate mode
  let paidAmount = null;
  let paidCurrency = 'INR';

  if (type === 'PAYMENT_LINK_EVENT') {
    // Link-level event. Only 'PAID' triggers fulfilment; other statuses
    // (EXPIRED / CANCELLED / PARTIALLY_PAID / USER_ATTEMPTED_TO_PAY) are acked.
    if (data.link_status !== 'PAID') {
      req.log.info({ type, linkStatus: data.link_status }, 'cashfree PAYMENT_LINK_EVENT ignored (not PAID)');
      return res.status(200).send('ignored');
    }
    linkId = data.link_id;
    phoneHash = (data.link_notes && data.link_notes.phone_hash) || null;
    notes = data.link_notes || null;
    paymentId = (data.order && (data.order.transaction_id || data.order.order_id)) || linkId;
    paidAmount = data.link_amount_paid != null ? data.link_amount_paid : data.link_amount;
    paidCurrency = data.link_currency || 'INR';
  } else if (type === 'PAYMENT_SUCCESS_WEBHOOK') {
    // Order-level event. Cashfree fires this for every completed payment
    // including link payments. payment_status can be SUCCESS or FAILED —
    // only SUCCESS triggers fulfilment.
    const status = data.payment && data.payment.payment_status;
    if (status !== 'SUCCESS') {
      req.log.info({ type, paymentStatus: status }, 'cashfree PAYMENT_SUCCESS_WEBHOOK ignored (not SUCCESS)');
      return res.status(200).send('ignored');
    }
    // When a Payment Link creates an order, Cashfree sets order_id = link_id.
    // If that changes we still have Redis as a fallback keyed on link_id.
    linkId = data.order && data.order.order_id;
    phoneHash = (data.order && data.order.order_tags && data.order.order_tags.phone_hash) || null;
    notes = (data.order && data.order.order_tags) || null;
    paymentId = (data.payment && (data.payment.cf_payment_id || data.payment.payment_id)) || linkId;
    paidAmount = (data.payment && (data.payment.payment_amount != null ? data.payment.payment_amount : data.payment.amount))
                 || (data.order && data.order.order_amount);
    paidCurrency = (data.payment && data.payment.payment_currency) || (data.order && data.order.order_currency) || 'INR';
  } else {
    // Any other event Cashfree may forward (settlement, dispute, refund, etc.)
    // — we don't act on these; ack so retries stop.
    req.log.info({ type }, 'cashfree event ignored (unhandled type)');
    return res.status(200).send('ignored');
  }

  // Redis fallback if the payload didn't carry phone_hash. Written at link
  // creation, so every link generated by the current code has this mapping.
  if (!phoneHash && linkId) {
    phoneHash = await getPhoneHashByLinkId(linkId);
    if (phoneHash) req.log.info({ linkId }, 'cashfree phone_hash resolved via redis fallback');
  }

  if (!phoneHash) {
    // No way to route this payment to a session. Log the payload keys (never
    // secrets) so we can diagnose what Cashfree actually sent. Return 200 —
    // retrying won't help without a hash.
    req.log.error({
      type,
      linkId,
      paymentId,
      dataKeys: Object.keys(data),
      orderKeys: data.order ? Object.keys(data.order) : null,
    }, 'cashfree webhook: could not resolve phone_hash');
    return res.status(200).send('unresolvable');
  }

  // Server-side amount check — fires AFTER phone_hash resolution so we can log
  // the affected student. Rejecting fulfilment on a bad amount is 200-acked
  // (not 5xx) so we don't stampede Cashfree with retries; the payment is
  // recorded on Cashfree's dashboard for manual reconciliation.
  const amountCheck = verifyAmountInr(paidAmount, paidCurrency);
  if (!amountCheck.ok) {
    req.log.error({
      type, linkId, paymentId,
      phoneHash: String(phoneHash).slice(0, 12),
      paidAmount, paidCurrency,
      why: amountCheck.why,
    }, 'cashfree webhook: amount mismatch — refusing to fulfil');
    return res.status(200).send('amount mismatch');
  }

  try {
    // paymentId is the dedupe key. cf_payment_id (from success events) and
    // transaction_id (from link events) can differ for the same underlying
    // payment — that's a theoretical duplicate-fulfilment risk if BOTH event
    // types were subscribed. Meet's account only exposes success payment, so
    // this doesn't happen in practice.
    const result = await fulfillPaymentByMode({ phoneHash, paymentId: String(paymentId), linkId, notes });
    return res.status(200).json(result);
  } catch (e) {
    req.log.error({ err: e.message }, 'fulfillment failed');
    return res.status(500).send('processing error');
  }
});

module.exports = router;
