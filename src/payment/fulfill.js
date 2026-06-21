// Post-payment fulfilment. PRD §12, §5 Phase 5.
// Triggered by a verified `payment_link.paid` Razorpay webhook. Looks up the
// session by the phone hash carried in the link's notes, regenerates the clean
// (un-watermarked) PDF, and pushes it to the student over WhatsApp.
const { getSession, setSession, markPaymentProcessed, unmarkPaymentProcessed } = require('../store/redis');
const { deliverPdf } = require('../state/delivery');
const { sendWhatsApp } = require('../messaging/twilio');
const { STATES } = require('../state/states');
const logger = require('../logger');

const PAID_MESSAGE = 'Payment received ✓ Yeh raha aapka clean, ATS-readable resume — ab Naukri/LinkedIn sab isse properly parse karenge. All the best! 🎉';

// Returns { ok, ... }. Never throws for "expected" terminal cases (missing
// hash, expired session) — those are logged and acked so Razorpay stops
// retrying. Re-throws only on unexpected errors so the route returns 5xx and
// Razorpay retries (the dedupe lock is released first so the retry can run).
async function fulfillPayment({ phoneHash, paymentId, linkId }) {
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

    session.paid = true;
    session.razorpay_payment_id = paymentId;
    session.razorpay_payment_link_id = linkId || session.razorpay_payment_link_id;

    const delivery = await deliverPdf(session, phoneHash, { clean: true });
    session.state = STATES.PAID_COMPLETE;
    await setSession(phoneHash, session);

    if (!delivery || !delivery.signedUrl) {
      logger.error({ phoneHash: String(phoneHash).slice(0, 12), paymentId }, 'clean PDF generation failed post-payment');
      return { ok: true, sent: false, reason: 'clean_pdf_failed' };
    }

    if (!session.phone_from) {
      logger.warn({ phoneHash: String(phoneHash).slice(0, 12) }, 'no phone_from on session; clean PDF generated but not pushed');
      return { ok: true, sent: false, reason: 'no_phone_from' };
    }

    // Payment is already settled and the clean PDF stored. If the outbound push
    // fails (e.g. recipient never joined the sandbox), do NOT roll back — log
    // and ack. The student can re-fetch via the bot (state is PAID_COMPLETE).
    try {
      await sendWhatsApp({ to: session.phone_from, body: PAID_MESSAGE, mediaUrl: delivery.signedUrl });
      return { ok: true, sent: true };
    } catch (sendErr) {
      logger.error({ err: sendErr.message, phoneHash: String(phoneHash).slice(0, 12) }, 'clean PDF push failed (payment still settled)');
      return { ok: true, sent: false, reason: 'send_failed' };
    }
  } catch (e) {
    // Unexpected failure — release the lock so Razorpay's retry re-attempts.
    await unmarkPaymentProcessed(paymentId);
    throw e;
  }
}

module.exports = { fulfillPayment };
