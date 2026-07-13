// Payment provider dispatch. Router imports createPaymentLink from here so
// swapping providers is one env flip (PAYMENT_PROVIDER=razorpay|cashfree).
// Webhook routes stay provider-specific — signature verification and payload
// shapes differ enough that a common route would just be branching noise.
const { config } = require('../config');
const razorpay = require('./razorpay');
const cashfree = require('./cashfree');

function activeProvider() {
  return config.PAYMENT_PROVIDER === 'razorpay' ? razorpay : cashfree;
}

async function createPaymentLink(args) {
  return activeProvider().createPaymentLink(args);
}

module.exports = { createPaymentLink, activeProvider };
