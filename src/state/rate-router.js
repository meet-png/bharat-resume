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
const { extract, flattenForRender, checkExtractionQuality } = require('../rate/extract');
const { scoreAll } = require('../rate/score-combined');
const p = require('./rate-prompts');
const { setSession, checkRateLlmCap } = require('../store/redis');
const { logEvent } = require('../telemetry/events');
const { createPaymentLink } = require('../payment');
const logger = require('../logger');

const CANCEL_RE = /^\s*(cancel|back|exit|quit|stop|reset|switch|change mode)\s*$/i;
const BUILD_SWITCH_RE = /^\s*(build|1|naya|new|banao|create)\s*$/i;
const PAY_RE = /^\s*(pay|pay now|unlock|buy|purchase|₹?\s*49|haan pay|yes pay|ok pay)\s*$/i;
// "change role" at RATE_SHOWING_SCORE keeps the parsed PDF and re-scores
// against a different role — saves the student from re-uploading if they
// picked the wrong target the first time.
const CHANGE_ROLE_RE = /^\s*(change role|new role|different role|role change|role badalna|role badlo|dusra role|another role)\s*$/i;
// Post-delivery 1-5 stars micro-survey. Same shape as v1's RATE_RE but scoped
// to rate mode's RATE_DELIVERED state so a bare digit at any earlier state
// (e.g. someone typing "5" as the number of years experience they want in
// their bullet) can never trip this.
const STAR_RE = /^\s*(?:rating\s*|rate\s*)?([1-5])\s*(?:\/\s*5|stars?)?\s*$/i;
const RESTART_RE = /^\s*(rate|review|score|check|existing)\s*$/i;
const BUILD_RE = /^\s*(build|banao|create|new|naya|make)\s*$/i;
const RESET_RE_LOCAL = /^\s*reset\s*$/i;

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

    // Cost cap check — before we spend any $ on parse/extract. Cap is
    // per-phone per 24h. Rejecting past the cap is a friendly message,
    // not a hard-block, so a legit student who tests many resumes at
    // once can come back tomorrow.
    const capCheck = await checkRateLlmCap(phoneHash);
    if (!capCheck.allowed) {
      logger.warn({
        phoneHash: phoneHash.slice(0, 12), count: capCheck.count, cap: capCheck.capPerDay,
      }, 'rate: LLM cap hit — refusing extraction');
      const hoursLeft = Math.ceil(capCheck.resetInSec / 3600);
      return (
        `⏳ Aaj ka rate-mode quota use ho gaya (${capCheck.capPerDay} PDFs/day).\n\n` +
        `${hoursLeft} ghante baad dobara try karo, ya *"build"* likhkar chat me naya resume banwao.`
      );
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

    // Post-extract sanity check — catches chaotic multi-column layouts that
    // slipped past parse-layer refuse triggers. Without this, a Canva 2-col
    // resume with placeholder text replaced would extract to near-empty JSON
    // and the student would get scored on nothing.
    const qc = checkExtractionQuality({
      resume_json: ex.resume_json,
      parsedText: parsed.text,
      parsedLineCount: parsed.lines.length,
    });
    if (qc) {
      logger.warn({ phoneHash: phoneHash.slice(0, 12), reason: qc.reason, details: qc.details }, 'rate: post-extract quality check failed');
      logEvent({ phoneHash, eventName: 'rate_extract_quality_refused', state: session.state, payload: { reason: qc.reason } });
      return p.refusePdf(qc.suggestion === 'chaotic-layout' ? 'multi-column-layout' : 'text-too-thin-probably-image-pdf');
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

  if (CHANGE_ROLE_RE.test(t)) {
    // Reset back to role prompt but KEEP the parsed PDF + resume_json. This
    // avoids the re-upload penalty when a student picked the wrong target
    // role the first time. Only clear score-derived fields; source stays.
    session.rate.role = null;
    session.rate.score_before = null;
    session.rate.score_subscores = null;
    session.rate.score_issues = null;
    session.rate.score_cache_key = null;
    // Also clear the payment link — new role = new score = new pay flow.
    session.payment_link_id = null;
    session.payment_link_url = null;
    session.state = STATES.RATE_AWAITING_ROLE;
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'rate_role_changed', state: session.state });
    return '🔄 Role change kar rahe hain — parse hui hui PDF wahi hai.\n\n' + p.askForRole();
  }

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

  // 1-5 stars micro-survey. Only recorded once per session — subsequent
  // digits are ignored so a student who mis-types can't overwrite their
  // rating with a rage-tap.
  const starMatch = t.match(STAR_RE);
  if (starMatch && !session.rating) {
    const rating = Math.max(1, Math.min(5, Number(starMatch[1]) || 0));
    session.rating = rating;
    session.rating_at = new Date().toISOString();
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'rating_submitted', state: session.state, payload: { rating, flow: 'rate' } });
    if (rating <= 2) {
      return `Feedback ke liye shukriya 🙏 (${rating}/5). Kya galat laga? Reply karo — hum improve karenge.`;
    }
    if (rating === 3) {
      return `Thanks for the feedback 🙏 (${rating}/5). Kuch specific improve karna chahoge? Reply karo.`;
    }
    return `Thanks! 🎉 (${rating}/5). Naya start karna ho to "rate" ya "build" type karo.`;
  }

  // Post-delivery restart shortcuts — save the student from having to type
  // "cancel" then a second command. Any of these takes them straight to
  // the target mode without a mode-select bounce.
  if (RESTART_RE.test(t)) {
    await cancelToModeSelect(session, phoneHash); // clears session.rate + payment
    session.mode = 'rate';
    session.state = STATES.RATE_AWAITING_PDF;
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'mode_selected', state: session.state, payload: { mode: 'rate', from: 'rate_delivered' } });
    return p.askForPdf();
  }
  if (BUILD_RE.test(t)) {
    return switchToBuild(session, phoneHash);
  }
  if (RESET_RE_LOCAL.test(t)) {
    return cancelToModeSelect(session, phoneHash);
  }

  // Nudge — ask for rating or restart command
  return (
    '✅ Aapka improved resume + audit report deliver ho gaya.\n\n' +
    (session.rating
      ? '_"rate"_ karo naya resume review karvane, _"build"_ karo naya banane, ya _"cancel"_ / _"reset"_ karo.'
      : '⭐ Reply *1-5* to rate this experience (30 seconds — helps us improve).\n\n_"rate"_ / _"build"_ / _"cancel"_ likhkar naya start karo.'
    )
  );
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
