// Razorpay payment webhook. PRD §12, §14.
// Signature verification gates the route. Day 5: look up payment_link.id in Postgres,
// mark user paid, regenerate clean PDF, send via Twilio.
const express = require('express');
const { verifyWebhookSignature } = require('../payment/razorpay');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-razorpay-signature'];
  const ok = verifyWebhookSignature(req.body, sig);
  if (!ok) {
    req.log.warn('invalid razorpay signature');
    return res.status(403).send('invalid signature');
  }

  // TODO Day 5: parse JSON body, branch on event type (payment_link.paid), mark user paid,
  // regenerate clean PDF, send via Twilio.
  req.log.info('razorpay webhook verified (handler stub)');
  res.status(501).send('not implemented');
});

module.exports = router;
