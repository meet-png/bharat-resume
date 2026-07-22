// Razorpay payment webhook. PRD §12, §14.
// Signature verification gates the route (raw body required for HMAC). On a
// verified `payment_link.paid` event we fulfil: regenerate the clean PDF and
// push it to the student. Idempotent against Razorpay's retries.
const express = require('express');
const { verifyWebhookSignature, UNLOCK_AMOUNT_PAISE } = require('../payment/razorpay');
const { fulfillPaymentByMode } = require('../payment/dispatch');

const router = express.Router();

// Server-side amount check. HMAC prevents outsider forgery, but a MITM'd
// client could theoretically swap the paylink URL before it reaches the
// student for one with a smaller amount. Razorpay reports both the LINK
// amount and the PAYMENT amount — the payment amount is the ground truth
// of what the student actually paid. Reject if it doesn't match ₹49 exactly.
function verifyAmountPaise(amountPaise, currency) {
  if (currency && String(currency).toUpperCase() !== 'INR') return { ok: false, why: `currency=${currency}` };
  const n = Number(amountPaise);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, why: 'amount not finite/positive' };
  if (n !== UNLOCK_AMOUNT_PAISE) return { ok: false, why: `paise=${n} !== ${UNLOCK_AMOUNT_PAISE}` };
  return { ok: true };
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['x-razorpay-signature'];
  const ok = verifyWebhookSignature(req.body, sig);
  if (!ok) {
    req.log.warn('invalid razorpay signature');
    return res.status(403).send('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  } catch {
    req.log.warn('razorpay webhook: bad JSON');
    return res.status(400).send('bad json');
  }

  const event = payload && payload.event;
  if (event !== 'payment_link.paid') {
    req.log.info({ event }, 'razorpay event ignored (not payment_link.paid)');
    return res.status(200).send('ignored');
  }

  const linkEntity = (payload.payload && payload.payload.payment_link && payload.payload.payment_link.entity) || {};
  const paymentEntity = (payload.payload && payload.payload.payment && payload.payload.payment.entity) || {};
  const phoneHash = linkEntity.notes && linkEntity.notes.phone_hash;
  const paymentId = paymentEntity.id || linkEntity.id;
  const linkId = linkEntity.id;
  const notes = linkEntity.notes || null; // includes v2 rate-mode flow marker
  // Prefer the payment.entity.amount (ground truth of what the student paid);
  // fall back to the link amount if payment isn't in the payload.
  const paidAmount = paymentEntity.amount != null ? paymentEntity.amount : linkEntity.amount;
  const paidCurrency = paymentEntity.currency || linkEntity.currency || 'INR';

  const amountCheck = verifyAmountPaise(paidAmount, paidCurrency);
  if (!amountCheck.ok) {
    req.log.error({
      linkId, paymentId,
      phoneHash: phoneHash ? String(phoneHash).slice(0, 12) : null,
      paidAmount, paidCurrency,
      why: amountCheck.why,
    }, 'razorpay webhook: amount mismatch — refusing to fulfil');
    return res.status(200).send('amount mismatch');
  }

  try {
    const result = await fulfillPaymentByMode({ phoneHash, paymentId, linkId, notes });
    return res.status(200).json(result);
  } catch (e) {
    req.log.error({ err: e.message }, 'fulfillment failed');
    return res.status(500).send('processing error');
  }
});

module.exports = router;
