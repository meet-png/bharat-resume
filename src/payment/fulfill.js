// Post-payment fulfilment. PRD §12, §5 Phase 5.
// Triggered by a verified `payment_link.paid` Razorpay webhook. Looks up the
// session by the phone hash carried in the link's notes, regenerates the clean
// (un-watermarked) PDF, and pushes it to the student over WhatsApp.
const { getSession, setSession, markPaymentProcessed, unmarkPaymentProcessed } = require('../store/redis');
const { deliverPdf } = require('../state/delivery');
const { sendWhatsApp } = require('../messaging');
const { STATES } = require('../state/states');
const { logEvent } = require('../telemetry/events');
const logger = require('../logger');

// Post-payment delivery is two outbound messages (design call 2026-07-15):
//   Msg 1 — clean PDF (media) + acknowledgement + coaching (improvement
//           suggestions + interview topics from the Reviewer agent).
//   Msg 2 — a separate lightweight caution + rating micro-survey.
// Splitting keeps each message scannable; the coaching stays anchored to the
// PDF, and the rating ask lands as its own beat so it doesn't get lost in a
// wall of text.
function buildPaidCoachingMessage(session) {
  const lines = [];
  lines.push(`Payment received ✓ Yeh raha aapka clean, ATS-readable resume — Naukri/LinkedIn ab isse properly parse karenge. 🎉`);

  const suggestions = Array.isArray(session.ats_suggestions) ? session.ats_suggestions : [];
  const topics = Array.isArray(session.interview_topics) ? session.interview_topics : [];

  if (suggestions.length > 0) {
    lines.push('');
    lines.push(`💡 _To sharpen it further:_`);
    for (const s of suggestions) lines.push(`  • ${s}`);
  }
  if (topics.length > 0) {
    lines.push('');
    lines.push(`🎯 _Interview prep — hot topics based on your resume + JD:_`);
    for (const t of topics) lines.push(`  • ${t}`);
  }

  lines.push('');
  lines.push(`✏️ "edit" — aapke paas 3 edits hain.`);
  return lines.join('\n');
}

function buildCautionRatingMessage(session) {
  const lines = [];
  lines.push(`⚠️ _Zaroor: PDF khol ke poora resume review kar lo bhejne se pehle — koi fact / metric / date galat lage to "edit" bolke fix karo._`);
  if (!session.rating) {
    lines.push('');
    lines.push(`⭐ _Reply 1-5 to rate this resume — 30 seconds, helps us improve fast._`);
  }
  return lines.join('\n');
}

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
    session.payment_id = paymentId;
    session.payment_link_id = linkId || session.payment_link_id;
    // Legacy field names kept while old sessions age out (24h TTL). Safe to
    // remove after Cashfree cutover has been live > 24h.
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
    // Msg 1 — clean PDF + coaching. This is the primary delivery: the message
    // that must succeed to consider the payment "delivered". A throw here
    // releases the dedupe lock and Razorpay retries.
    await send({ to: session.phone_from, body: buildPaidCoachingMessage(session), mediaUrl: delivery.signedUrl });

    // Msg 2 — separate caution + rating. Wrapped in its own try so a failure
    // here doesn't trigger a webhook retry (the PDF + coaching already landed;
    // re-sending would double-deliver the PDF). Best-effort follow-up.
    try {
      await send({ to: session.phone_from, body: buildCautionRatingMessage(session) });
    } catch (e) {
      logger.warn({ err: e.message, phoneHash: String(phoneHash).slice(0, 12), paymentId }, 'caution+rating follow-up failed (non-fatal)');
    }

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
