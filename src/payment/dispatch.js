// Mode-aware fulfillment dispatcher. The Cashfree/Razorpay webhook route calls
// THIS, which peeks at the session (or the paylink notes as a fallback) to
// decide whether to run build-mode fulfillment (v1) or rate-mode fulfillment
// (v2).
//
// Three signals, checked in order:
//   1. session.mode === 'rate'                — primary
//   2. session.state starts with 'RATE_'      — belt: mode may have been
//                                               cleared but state still
//                                               carries the intent
//   3. notes.flow === 'rate'                  — braces: paylink note we set
//                                               at link creation, survives
//                                               even if session TTL expired
//
// If none match, dispatch to v1 (safer default — protects any pre-v2 sessions
// still in flight).

const { getSession } = require('../store/redis');
const { fulfillPayment } = require('./fulfill');
const { fulfillRatePayment } = require('../rate/fulfill');
const logger = require('../logger');

async function fulfillPaymentByMode({ phoneHash, paymentId, linkId, notes = {} }, deps = {}) {
  let session = null;
  try {
    session = await getSession(phoneHash);
  } catch (e) {
    logger.warn({ err: e.message, phoneHash: String(phoneHash || '').slice(0, 12) }, 'dispatch: session lookup failed; will fall back to notes');
  }
  const isRate =
    (session && session.mode === 'rate') ||
    (session && typeof session.state === 'string' && session.state.startsWith('RATE_')) ||
    (notes && notes.flow === 'rate');

  if (isRate) {
    logger.info({
      phoneHash: String(phoneHash).slice(0, 12),
      via: (session && session.mode === 'rate') ? 'session.mode'
         : (session && String(session.state || '').startsWith('RATE_')) ? 'session.state'
         : 'notes.flow',
      state: session?.state,
    }, 'dispatch: rate-mode fulfillment');
    return fulfillRatePayment({ phoneHash, paymentId, linkId }, deps);
  }
  logger.info({ phoneHash: String(phoneHash || '').slice(0, 12), mode: session?.mode || 'unknown', state: session?.state }, 'dispatch: build-mode fulfillment');
  return fulfillPayment({ phoneHash, paymentId, linkId }, deps);
}

module.exports = { fulfillPaymentByMode };
