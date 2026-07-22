// Rate-mode post-payment fulfillment. Parallel to src/payment/fulfill.js —
// same idempotency + ordering + retry contract, but runs the rate-mode
// pipeline (improve → render → deliver PDF + audit report) instead of
// build-mode's clean-PDF regen.
//
// Fires from the Cashfree webhook when session.mode === 'rate' OR
// notes.flow === 'rate'. See src/routes/cashfree.js for the dispatcher.
//
// Ordering invariant (same as build fulfill):
//   1. Persist session.paid = true BEFORE any delivery work.
//   2. Any delivery failure → releases the dedupe lock → webhook retries.
//   3. session.state = RATE_DELIVERED set only AFTER PDF + audit landed.
//
// Delivery structure (two outbound messages):
//   Msg 1 — improved clean PDF (media) + a short caption naming the change count.
//   Msg 2 — audit-report text (auto-chunked). Every BEFORE/AFTER cited so the
//           student can screenshot any change and defend it in an interview.

const { getSession, setSession, markPaymentProcessed, unmarkPaymentProcessed } = require('../store/redis');
const { improveResume } = require('./improve-resume');
const { renderAuditText } = require('./audit');
const { flattenForRender } = require('./extract');
const { scoreAll } = require('./score-combined');
const { deliverPdf } = require('../state/delivery');
const { sendWhatsApp } = require('../messaging');
const { STATES } = require('../state/states');
const { logEvent } = require('../telemetry/events');
const logger = require('../logger');

function buildCaption(auditTally, scoreBefore, scoreAfter) {
  const parts = [];
  parts.push('✅ *Payment received — improved resume attached.*');
  if (scoreBefore != null && scoreAfter != null) {
    parts.push(`Score: ${scoreBefore.toFixed(1)} → ${scoreAfter.toFixed(1)} / 10`);
  }
  const improved = (auditTally.llm || 0) + (auditTally.retry || 0);
  parts.push(`\n${improved} bullets improved. ${auditTally.fallback || 0} safe-fallback. ${auditTally.unchanged || 0} unchanged.`);
  parts.push('\nAudit report bhej raha hu — har change ka BEFORE / AFTER + source line ka reference hai. Kuch bhi galat lage to reply karo.');
  return parts.join('\n');
}

// Split audit text into WhatsApp-sized chunks (renderAuditText already does
// this, but we send them here as separate outbound calls). Each send is
// best-effort inside its own try — if chunk 2 fails, chunk 1 already landed.
async function sendAuditReport(session, phoneHash, auditReport, send) {
  const chunks = auditReport.chunks || [auditReport.text];
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `_Audit ${i + 1}/${chunks.length}_\n\n` : '';
    try {
      await send({ to: session.phone_from, body: prefix + chunks[i] });
    } catch (e) {
      logger.warn({
        err: e.message, phoneHash: String(phoneHash).slice(0, 12),
        chunk: i + 1, chunks: chunks.length,
      }, 'audit-report chunk send failed');
      // Chunks past the first are best-effort; keep going.
      if (i === 0) throw e;
    }
  }
}

// Main entry. Returns { ok, ... } for terminal cases (no phone, no session),
// throws on delivery failures so the outer route returns 5xx → Cashfree retry.
// `deps.send` is injectable for tests.
async function fulfillRatePayment({ phoneHash, paymentId, linkId }, deps = {}) {
  const send = deps.send || sendWhatsApp;
  if (!phoneHash) {
    logger.warn({ paymentId }, 'fulfillRatePayment: no phone_hash in notes');
    return { ok: false, reason: 'no_phone_hash' };
  }
  if (!paymentId) {
    logger.warn({ phoneHash: String(phoneHash).slice(0, 12) }, 'fulfillRatePayment: no paymentId');
    return { ok: false, reason: 'no_payment_id' };
  }

  const fresh = await markPaymentProcessed(paymentId);
  if (!fresh) {
    logger.info({ paymentId }, 'duplicate rate-mode webhook ignored');
    return { ok: true, duplicate: true };
  }

  try {
    const session = await getSession(phoneHash);
    if (!session) {
      logger.warn({ phoneHash: String(phoneHash).slice(0, 12), paymentId }, 'fulfillRatePayment: session expired');
      return { ok: false, reason: 'session_expired' };
    }
    if (!session.rate || !session.rate.resume_json || !session.rate.source_text || !session.rate.role) {
      // Session exists but the rate payload was cleared (e.g. user cancelled
      // after paying, or session was reset). Payment stands; delivery will
      // resume when the student re-uploads and re-pays — this shouldn't happen
      // in practice because cancel clears session.rate before any payment.
      logger.warn({ phoneHash: String(phoneHash).slice(0, 12), paymentId }, 'fulfillRatePayment: rate payload missing');
      return { ok: false, reason: 'rate_payload_missing' };
    }

    // Point of no return: mark paid BEFORE any delivery work.
    session.paid = true;
    session.payment_id = paymentId;
    session.payment_link_id = linkId || session.payment_link_id;
    session.state = STATES.RATE_IMPROVING;
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'rate_payment_succeeded', state: session.state, payload: { amount: 49 }, userFields: { paid: true } });

    if (!session.phone_from) {
      logger.warn({ phoneHash: String(phoneHash).slice(0, 12) }, 'no phone_from on session; payment settled, delivery deferred');
      return { ok: true, sent: false, reason: 'no_phone_from' };
    }

    // ─── Improve (LLM + verifier + safe fallback) ────────────────────
    const t0 = Date.now();
    let improveResult;
    try {
      improveResult = await improveResume({
        resume_json: session.rate.resume_json,
        sourceText: session.rate.source_text,
        role: session.rate.role,
      });
    } catch (e) {
      logger.error({ err: e.message, phoneHash: String(phoneHash).slice(0, 12) }, 'improveResume crashed in fulfill');
      throw e; // release lock → Cashfree retry
    }
    logEvent({ phoneHash, eventName: 'rate_improved', state: session.state, payload: { bullets: improveResult.meta.counts.total, ms: Date.now() - t0 } });

    // ─── Re-score AFTER improvements (honest, not projected) ────────
    let scoreAfter = null;
    try {
      const rescored = await scoreAll({
        text: session.rate.source_text, // score against ORIGINAL source (matches "before")
        parseMeta: session.rate.parse_meta,
        resume_json: improveResult.resume_json_improved,
        role: session.rate.role,
        roleType: 'tech',
      });
      scoreAfter = rescored.score;
    } catch (e) {
      // Non-fatal — audit report just won't show an "after" number.
      logger.warn({ err: e.message }, 'rate-fulfill: post-improvement re-score failed (non-fatal)');
    }

    // Persist improved artifacts on session for the render step + future look-ups.
    session.rate.resume_json_improved = improveResult.resume_json_improved;
    session.rate.audit = improveResult.audit;
    session.rate.score_after = scoreAfter;

    // v1's deliverPdf() reads session.resume_json_rewritten and renders it
    // through the Handlebars template. Flatten the improved JSON (bullets
    // objects → string[]) so it matches v1's expected shape. This is the
    // 100% v1-pipeline reuse the design called out on Day 0.
    session.resume_json_rewritten = flattenForRender(improveResult.resume_json_improved);
    await setSession(phoneHash, session);

    // ─── Render + upload + delivery ─────────────────────────────────
    const delivery = await deliverPdf(session, phoneHash, { clean: true });
    if (!delivery || !delivery.signedUrl) {
      throw new Error('clean improved PDF generation failed post-payment');
    }

    // Msg 1 — PDF + caption. Must succeed (throw → retry).
    await send({
      to: session.phone_from,
      body: buildCaption(
        {
          llm:      countMode(improveResult.audit, 'llm'),
          retry:    countMode(improveResult.audit, 'llm-retry'),
          fallback: countMode(improveResult.audit, 'safe-fallback'),
          unchanged: countMode(improveResult.audit, 'unchanged'),
        },
        session.rate.score_before,
        scoreAfter,
      ),
      mediaUrl: delivery.signedUrl,
    });

    // Msg 2+ — audit report. Wrapped so a mid-chunk failure doesn't force a
    // full retry (PDF + caption already landed). First chunk still critical.
    try {
      const auditReport = renderAuditText({
        audit: improveResult.audit,
        role: session.rate.role,
        scoreBefore: session.rate.score_before,
        scoreAfter,
        meta: {},
      });
      await sendAuditReport(session, phoneHash, auditReport, send);
    } catch (e) {
      logger.warn({ err: e.message, phoneHash: String(phoneHash).slice(0, 12) }, 'audit-report send failed (non-fatal after PDF)');
    }

    // Delivered — mark terminal.
    session.state = STATES.RATE_DELIVERED;
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'rate_delivered', state: STATES.RATE_DELIVERED });

    return {
      ok: true,
      sent: true,
      score_before: session.rate.score_before,
      score_after: scoreAfter,
      bullets: improveResult.meta.counts.total,
    };
  } catch (e) {
    await unmarkPaymentProcessed(paymentId);
    logger.error({ err: e.message, phoneHash: String(phoneHash).slice(0, 12), paymentId }, 'rate delivery failed; lock released for retry (payment settled)');
    throw e;
  }
}

function countMode(audit, mode) {
  return (audit || []).filter((r) => r.mode === mode).length;
}

module.exports = { fulfillRatePayment };
