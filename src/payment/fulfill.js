// Post-payment fulfilment. PRD §12, §5 Phase 5.
// Triggered by a verified `payment_link.paid` Razorpay webhook. Looks up the
// session by the phone hash carried in the link's notes, regenerates the clean
// (un-watermarked) PDF, and pushes it to the student over WhatsApp.
const { getSession, setSession, markPaymentProcessed, unmarkPaymentProcessed } = require('../store/redis');
const { deliverPdf } = require('../state/delivery');
const { sendWhatsApp } = require('../messaging/twilio');
const { STATES } = require('../state/states');
const { logEvent } = require('../telemetry/events');
const logger = require('../logger');

const PAID_MESSAGE = 'Payment received ✓ Yeh raha aapka clean, ATS-readable resume — ab Naukri/LinkedIn sab isse properly parse karenge. Koi change chahiye? Type "edit" — aapke paas 3 edits hain. All the best! 🎉';

// Returns { ok, ... } for terminal cases that a retry can't help (missing
// hash/paymentId, expired session, no delivery address) — these are acked so
// Razorpay stops retrying. Throws on any DELIVERY failure (PDF gen or outbound
// send): the dedupe lock is released first, so the route returns 5xx and
// Razorpay's retry re-runs fulfilment and re-attempts delivery.
//
// Ordering invariant: payment truth (`paid=true`) is persisted BEFORE any
// delivery work, so no delivery failure can ever roll a settled payment back.
// `state=PAID_COMPLETE` is set only AFTER the PDF is actually delivered, so a
// student whose delivery is still being retried isn't told "already sent".
// `deps.send` is injectable so tests can exercise delivery/failure paths
// without hitting Twilio; production calls pass nothing and use the real sender.
async function fulfillPayment({ phoneHash, paymentId, linkId }, deps = {}) {
  const send = deps.send || sendWhatsApp;
  if (!phoneHash) {
    logger.warn({ paymentId }, 'fulfillPayment: no phone_hash in notes');
    return { ok: false, reason: 'no_phone_hash' };
  }
  if (!paymentId) {
    logger.warn({ phoneHash: String(phoneHash).slice(0, 12) }, 'fulfillPayment: no paymentId');
    return { ok: false, reason: 'no_payment_id' };
  }

  // Idempotency — first webhook delivery wins.
  const fresh = await markPaymentProcessed(paymentId);
  if (!fresh) {
    logger.info({ paymentId }, 'duplicate razorpay webhook ignored');
    return { ok: true, duplicate: true };
  }

  try {
    const session = await getSession(phoneHash);
    if (!session) {
      // Session TTL is 24h; payment almost always lands within minutes. If it
      // expired, we can't regenerate (no rewritten resume). Terminal — ack it.
      logger.warn({ phoneHash: String(phoneHash).slice(0, 12), paymentId }, 'fulfillPayment: session expired');
      return { ok: false, reason: 'session_expired' };
    }

    // Point of no return: record the payment BEFORE attempting delivery so a
    // later failure can never undo it.
    session.paid = true;
    session.razorpay_payment_id = paymentId;
    session.razorpay_payment_link_id = linkId || session.razorpay_payment_link_id;
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'payment_succeeded', state: session.state, payload: { amount: 49 }, userFields: { paid: true } });

    if (!session.phone_from) {
      // No address to deliver to; a retry won't help until the student messages
      // the bot again (which re-captures phone_from). Terminal — ack. Payment
      // stands; the clean PDF will be generated on their next interaction.
      logger.warn({ phoneHash: String(phoneHash).slice(0, 12) }, 'no phone_from on session; payment settled, delivery deferred');
      return { ok: true, sent: false, reason: 'no_phone_from' };
    }

    // Delivery. Any failure here throws → outer catch releases the dedupe lock
    // → route 5xx → Razorpay retries → delivery re-attempted. Payment already
    // persisted above, so it is never rolled back.
    const delivery = await deliverPdf(session, phoneHash, { clean: true });
    if (!delivery || !delivery.signedUrl) {
      throw new Error('clean PDF generation failed post-payment');
    }
    await send({ to: session.phone_from, body: PAID_MESSAGE, mediaUrl: delivery.signedUrl });

    // Delivered — only now mark the conversation complete.
    session.state = STATES.PAID_COMPLETE;
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'clean_pdf_delivered', state: STATES.PAID_COMPLETE });
    return { ok: true, sent: true };
  } catch (e) {
    // Delivery failure — release the lock so Razorpay's retry re-attempts.
    // Payment state was already persisted and is intentionally NOT rolled back.
    await unmarkPaymentProcessed(paymentId);
    logger.error({ err: e.message, phoneHash: String(phoneHash).slice(0, 12), paymentId }, 'delivery failed; lock released for retry (payment settled)');
    throw e;
  }
}

module.exports = { fulfillPayment };
