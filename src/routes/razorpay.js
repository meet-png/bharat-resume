// Razorpay payment webhook. PRD §12, §14.
// Signature verification gates the route (raw body required for HMAC). On a
// verified `payment_link.paid` event we fulfil: regenerate the clean PDF and
// push it to the student. Idempotent against Razorpay's retries.
const express = require('express');
const { verifyWebhookSignature } = require('../payment/razorpay');
const { fulfillPayment } = require('../payment/fulfill');

const router = express.Router();

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

  try {
    const result = await fulfillPayment({ phoneHash, paymentId, linkId });
    return res.status(200).json(result);
  } catch (e) {
    req.log.error({ err: e.message }, 'fulfillPayment failed');
    return res.status(500).send('processing error');
  }
});

module.exports = router;
