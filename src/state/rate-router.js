// Rate-mode state machine. Parallel to build-mode router (src/state/router.js);
// dispatched from handleInner when session.mode === 'rate'. Kept in its own
// file so build-mode logic can't accidentally leak in.
//
// Flow:
//   AWAITING_MODE_SELECT  → user picks build / rate
//   RATE_AWAITING_PDF     → user uploads PDF/DOCX attachment
//   RATE_AWAITING_ROLE    → user types target role
//   RATE_SCORING          → scoring runs inline; user sees glimpse
//   RATE_SHOWING_SCORE    → user replies pay / cancel
//   RATE_AWAITING_PAYMENT → payment link sent; waiting for webhook
//   RATE_IMPROVING        → improver runs; PDF + audit report delivered (Day 8+)
//   RATE_DELIVERED        → terminal
//
// Every attachment / body pair reaches this handler with a session that has
// mode='rate'. Return value is a reply string (or object) matching the same
// shape build-mode returns.

const { STATES } = require('./states');
const { parse } = require('../rate/parse');
const { extract, flattenForRender } = require('../rate/extract');
const { scoreAll } = require('../rate/score-combined');
const p = require('./rate-prompts');
const { setSession } = require('../store/redis');
const { logEvent } = require('../telemetry/events');
const { createPaymentLink } = require('../payment');
const logger = require('../logger');

const CANCEL_RE = /^\s*(cancel|back|exit|quit|stop|reset|switch|change mode)\s*$/i;
const BUILD_SWITCH_RE = /^\s*(build|1|naya|new|banao|create)\s*$/i;
const PAY_RE = /^\s*(pay|pay now|unlock|buy|purchase|₹?\s*49|haan pay|yes pay|ok pay)\s*$/i;

const UNLOCK_AMOUNT = 49;

// Trim / normalize source data we store on the session so Redis payload
// doesn't balloon. We keep just what downstream needs:
//   source_text — full parsed text (for scoring's text-side checks + audit anchors)
//   source_lines — { n, page, text } (source_line anchor resolution)
//   resume_json — extracted structure with source_line anchors
function persistRateSource(session, { text, lines, resume_json, parseMeta }) {
  session.rate = session.rate || {};
  session.rate.source_text = text;
  session.rate.source_lines = lines;
  session.rate.resume_json = resume_json;
  session.rate.parse_meta = parseMeta;
}

async function handleAwaitingPdf({ session, phoneHash, body, phoneFrom, attachment, sendWhatsApp }) {
  // Attachment case: try to parse. If parse refuses, tell the student why.
  if (attachment && attachment.buffer) {
    // Ack immediately — parse+extract takes 15-25s and silence during that
    // window worries the student. Best-effort; failure is non-fatal.
    if (phoneFrom && sendWhatsApp) {
      try { await sendWhatsApp({ to: phoneFrom, body: p.parsing() }); }
      catch (e) { logger.warn({ err: e.message }, 'rate: parsing-ack send failed'); }
    }

    let parsed;
    try {
      parsed = await parse(attachment.buffer, { filename: attachment.filename || '' });
    } catch (e) {
      logger.error({ err: e.message, phoneHash: phoneHash.slice(0, 12) }, 'rate: parse crashed');
      return p.refusePdf('parse-error');
    }
    logger.info({
      phoneHash: phoneHash.slice(0, 12),
      layer: parsed.meta.layerName,
      words: parsed.meta.wordCount,
      pages: parsed.meta.pageCount,
      multi: parsed.meta.multiColumn,
    }, 'rate: parse complete');

    if (parsed.meta.refuse) {
      logEvent({ phoneHash, eventName: 'rate_parse_refused', state: session.state, payload: { reason: parsed.meta.refuseReason } });
      return p.refusePdf(parsed.meta.refuseReason);
    }

    let ex;
    try {
      ex = await extract({ lines: parsed.lines });
    } catch (e) {
      logger.error({ err: e.message }, 'rate: extract crashed');
      return p.refusePdf('extract-error');
    }
    if (!ex.resume_json) {
      logEvent({ phoneHash, eventName: 'rate_extract_skipped', state: session.state, payload: { reason: ex.meta && ex.meta.reason } });
      return p.refusePdf('extract-skipped');
    }

    persistRateSource(session, {
      text: parsed.text,
      lines: parsed.lines,
      resume_json: ex.resume_json,
      parseMeta: parsed.meta,
    });
    session.state = STATES.RATE_AWAITING_ROLE;
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'rate_pdf_ingested', state: session.state, payload: { words: parsed.meta.wordCount, layer: parsed.meta.layerName } });
    return p.askForRole();
  }

  // No attachment, just text. Handle cancel / build switch or nudge for file.
  const t = String(body || '').trim();
  if (CANCEL_RE.test(t)) return cancelToModeSelect(session, phoneHash);
  if (BUILD_SWITCH_RE.test(t)) return switchToBuild(session, phoneHash);
  return p.askForPdfNoText();
}

async function handleAwaitingRole({ session, phoneHash, body, phoneFrom, sendWhatsApp }) {
  const t = String(body || '').trim();
  if (CANCEL_RE.test(t)) return cancelToModeSelect(session, phoneHash);
  if (!t) return p.askForRole();

  session.rate = session.rate || {};
  session.rate.role = t.slice(0, 120);
  session.state = STATES.RATE_SCORING;
  await setSession(phoneHash, session);
  logEvent({ phoneHash, eventName: 'rate_role_captured', state: session.state, payload: { role: session.rate.role } });

  // Ack the score-is-running wait. Score is 3 parallel LLM calls + deterministic — ~10-25s.
  if (phoneFrom && sendWhatsApp) {
    try { await sendWhatsApp({ to: phoneFrom, body: p.scoring() }); }
    catch (e) { logger.warn({ err: e.message }, 'rate: scoring-ack send failed'); }
  }

  let scored;
  try {
    scored = await scoreAll({
      text: session.rate.source_text,
      parseMeta: session.rate.parse_meta,
      resume_json: session.rate.resume_json,
      role: session.rate.role,
      roleType: 'tech', // simple default for pilot — role registry is a later refinement
    });
  } catch (e) {
    logger.error({ err: e.message, phoneHash: phoneHash.slice(0, 12) }, 'rate: scoreAll crashed');
    session.state = STATES.RATE_AWAITING_ROLE;
    await setSession(phoneHash, session);
    return '⛔ Scoring me kuch issue aa gaya. 30 seconds baad dobara role bhejo, ya "cancel" karke restart.';
  }

  session.rate.score_before = scored.score;
  session.rate.score_subscores = scored.subscores;
  session.rate.score_issues = scored.issues;
  session.rate.score_cache_key = scored.meta.cache_key;
  session.state = STATES.RATE_SHOWING_SCORE;
  await setSession(phoneHash, session);
  logEvent({ phoneHash, eventName: 'rate_score_computed', state: session.state, payload: { score: scored.score, issue_count: scored.issues.length } });

  return p.renderScoreGlimpse({
    score: scored.score,
    subscores: scored.subscores,
    issues: scored.issues,
    role: session.rate.role,
    unlockAmount: UNLOCK_AMOUNT,
  });
}

async function handleShowingScore({ session, phoneHash, body }) {
  const t = String(body || '').trim();
  if (CANCEL_RE.test(t)) return cancelToModeSelect(session, phoneHash);

  if (PAY_RE.test(t)) {
    // Create payment link if not already
    if (!session.payment_link_url) {
      try {
        const link = await createPaymentLink({
          phoneHash,
          phone: session.phone_from,
          name: (session.rate.resume_json && session.rate.resume_json.name) || null,
          email: (session.rate.resume_json && session.rate.resume_json.email) || null,
          // Tag with rate-mode context so the webhook fulfiller (Day 8+) can
          // distinguish rate-paid from build-paid and dispatch the right flow.
          notes: { flow: 'rate' },
        });
        session.payment_link_id = link.id;
        session.payment_link_url = link.short_url;
        logEvent({ phoneHash, eventName: 'rate_payment_link_created', state: session.state });
      } catch (e) {
        logger.error({ err: e.message }, 'rate: createPaymentLink failed');
        return '⛔ Payment link banane me issue aa gaya. Thodi der me dobara "pay" likho, ya "cancel" karke restart.';
      }
    }
    session.state = STATES.RATE_AWAITING_PAYMENT;
    await setSession(phoneHash, session);
    return p.payIntro({ payUrl: session.payment_link_url, unlockAmount: UNLOCK_AMOUNT });
  }

  // Nudge — student typed something else after the score
  return 'Reply *"pay"* to unlock the full report + clean PDF (₹49), or *"cancel"* to start over.';
}

async function handleAwaitingPayment({ session, phoneHash, body }) {
  const t = String(body || '').trim();
  if (CANCEL_RE.test(t)) return cancelToModeSelect(session, phoneHash);
  // Student pinged before webhook — re-send the payment link.
  if (session.payment_link_url) {
    return p.payIntro({ payUrl: session.payment_link_url, unlockAmount: UNLOCK_AMOUNT });
  }
  return 'Payment pending — link bheji thi. Reply "cancel" if you want to start over.';
}

async function handleDelivered({ session, phoneHash, body }) {
  const t = String(body || '').trim();
  if (CANCEL_RE.test(t)) return cancelToModeSelect(session, phoneHash);
  // MVP: acknowledge; deeper edit-of-improved is Day 8+.
  return '✅ Aapka improved resume + audit report deliver ho gaya. Naya start karna ho to "rate" ya "build" type karo.';
}

async function cancelToModeSelect(session, phoneHash) {
  session.mode = null;
  session.state = STATES.AWAITING_MODE_SELECT;
  session.rate = null;
  session.payment_link_id = null;
  session.payment_link_url = null;
  await setSession(phoneHash, session);
  logEvent({ phoneHash, eventName: 'rate_cancelled', state: session.state });
  return p.cancelled();
}

async function switchToBuild(session, phoneHash) {
  session.mode = 'build';
  session.state = STATES.AWAITING_CONFIRM_START;
  session.rate = null;
  await setSession(phoneHash, session);
  logEvent({ phoneHash, eventName: 'rate_switched_to_build', state: session.state });
  const { pickPrompt } = require('./prompts');
  return pickPrompt(STATES.NEW);
}

// Public entry — dispatched from src/state/router.js#handleInner when
// session.mode === 'rate'. Returns a reply (string OR {text, media}).
async function handleRateInner({ session, phoneHash, body, phoneFrom, attachment, sendWhatsApp }) {
  switch (session.state) {
    case STATES.RATE_AWAITING_PDF:
      return handleAwaitingPdf({ session, phoneHash, body, phoneFrom, attachment, sendWhatsApp });
    case STATES.RATE_AWAITING_ROLE:
      return handleAwaitingRole({ session, phoneHash, body, phoneFrom, sendWhatsApp });
    case STATES.RATE_SHOWING_SCORE:
      return handleShowingScore({ session, phoneHash, body });
    case STATES.RATE_AWAITING_PAYMENT:
      return handleAwaitingPayment({ session, phoneHash, body });
    case STATES.RATE_DELIVERED:
      return handleDelivered({ session, phoneHash, body });
    default:
      // Fallback: unknown rate state → reset to mode select. Should never happen
      // in a healthy session, but a defensive default is better than throwing.
      logger.warn({ phoneHash: phoneHash.slice(0, 12), state: session.state }, 'rate: unknown state; resetting to mode select');
      return cancelToModeSelect(session, phoneHash);
  }
}

module.exports = {
  handleRateInner,
  UNLOCK_AMOUNT,
  CANCEL_RE,
  BUILD_SWITCH_RE,
  PAY_RE,
  // Exposed for tests
  handleAwaitingPdf,
  handleAwaitingRole,
  handleShowingScore,
};
