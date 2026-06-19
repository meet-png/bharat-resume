// Razorpay payment webhook. PRD §12, §14.
// TODO Day 5: verify HMAC-SHA256 signature with RAZORPAY_WEBHOOK_SECRET, look up
// payment_link.id in Postgres, mark user paid, regenerate clean PDF, send via Twilio.
const express = require('express');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), (req, res) => {
  req.log.warn('razorpay webhook hit — not implemented (Day 5)');
  res.status(501).send('not implemented');
});

module.exports = router;
