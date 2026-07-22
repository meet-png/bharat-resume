// Mode-aware fulfillment dispatcher. The Cashfree webhook route calls THIS,
// which peeks at the session to decide whether to run build-mode fulfillment
// (v1: regen clean PDF from session.resume_json_rewritten) or rate-mode
// fulfillment (v2: improve → render → deliver PDF + audit report).
//
// Fallback: if the session is missing OR mode isn't set, dispatch to v1
// (safer default — protects any pre-v2 sessions still in flight).
//
// Both delegate functions handle their own idempotency (markPaymentProcessed)
// and error contract. This dispatcher just picks which one to call.

const { getSession } = require('../store/redis');
const { fulfillPayment } = require('./fulfill');
const { fulfillRatePayment } = require('../rate/fulfill');
const logger = require('../logger');

async function fulfillPaymentByMode({ phoneHash, paymentId, linkId }, deps = {}) {
  let session = null;
  try {
    session = await getSession(phoneHash);
  } catch (e) {
    logger.warn({ err: e.message, phoneHash: String(phoneHash || '').slice(0, 12) }, 'dispatch: session lookup failed; defaulting to build fulfill');
  }
  // Rate-mode signals (either has to be true to route to rate):
  //   session.mode === 'rate'                    — explicit
  //   session.state starts with 'RATE_'          — belt-and-braces (mode may
  //                                                have been cleared but state
  //                                                still carries the intent)
  const isRate = session && (
    session.mode === 'rate' ||
    (typeof session.state === 'string' && session.state.startsWith('RATE_'))
  );

  if (isRate) {
    logger.info({ phoneHash: String(phoneHash).slice(0, 12), mode: 'rate', state: session.state }, 'dispatch: rate-mode fulfillment');
    return fulfillRatePayment({ phoneHash, paymentId, linkId }, deps);
  }
  logger.info({ phoneHash: String(phoneHash || '').slice(0, 12), mode: session?.mode || 'unknown', state: session?.state }, 'dispatch: build-mode fulfillment');
  return fulfillPayment({ phoneHash, paymentId, linkId }, deps);
}

module.exports = { fulfillPaymentByMode };
