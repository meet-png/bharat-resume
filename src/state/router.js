// State machine. PRD §6, §18 Day 2-3.
const { STATES, NEXT_STATE, OPTIONAL_STATES, PHASE_2_STATES } = require('./states');
const { pickPrompt, pickMessage, expSlotQuestion } = require('./prompts');
const { extractSection, SECTION_CONFIG } = require('../llm/extract');
const { runGeneration, buildPreview } = require('./generator');
const { deliverPdf } = require('./delivery');
const { createPaymentLink } = require('../payment');
const { applyEdit } = require('../llm/edit');
const { respond } = require('../llm/respond');
const { scoreResume, suggestionsFor } = require('../resume/ats_score');
const { getSession, setSession, checkRateLimit, acquirePhoneLock, releasePhoneLock, RATELIMIT_MAX } = require('../store/redis');
const { logEvent } = require('../telemetry/events');
const { config } = require('../config');
const logger = require('../logger');

// A session is "unlocked" — clean PDF + paid edit budget, no ₹49 gate — when the
// student has paid OR the free pilot is on. Single source of truth so delivery,
// edits, and the preview CTA all agree. Pilot never sets session.paid, so
// telemetry/revenue (driven by payment_succeeded events) stays clean.
function unlocked(session) {
  return !!session.paid || !!session.pilot;
}

const SKIP_RE = /^\s*(skip|no|nahi|nahin|nope|none|nothing|na|n\/a|kuch nahi|no thanks)\s*$/i;
const DONE_RE = /^\s*(done|finish|finished|bas|over|complete)\s*$/i;
// Broader "I have no more entries to add" — used in multi-entry "more or done?"
// loops (experience, projects, certs). Matches natural-language declines like
// "I don't have any", "no more", "nothing else", "that's all". Live-test
// 2026-06-26: friend typed "I don't have any" after one MUN experience and
// the bot pushed an empty {} onto experience[] then asked hard-slot questions
// forever because SKIP_RE/DONE_RE need an exact word match. NO_MORE_HINT is
// permissive on PURPOSE — applied only in the "more?" context, where any
// decline form should advance, never loop.
const NO_MORE_HINT = /\b(i don'?t have any|don'?t have any|i don'?t have|no more|nothing else|nothing more|that'?s all|that is all|nahi koi|koi nahi|nahi hai|nahi bhai|aur nahi|kuch nahi)\b/i;
// Broader Hinglish decline used ONLY for OPTIONAL states. Catches natural
// "can't share right now" / "will tell later" phrasings that SKIP_RE
// (exact-word) and NO_MORE_HINT ("I don't have any") both miss.
// Real-world trigger 2026-07-16: student typed "M abhi share ni krskti"
// (can't share right now) on LinkedIn — LLM interpreted as "will share
// later" and held state, question re-asked in a loop until she gave up.
// Deliberately optional-only: for REQUIRED fields (name/email/education),
// a fuzzy decline still needs LLM classification so we don't accidentally
// skip past a mandatory field.
const OPTIONAL_DECLINE_HINT = /\b(skip|abhi nahi|abhi nhi|abhi ni|abhi share|share nahi|share nhi|share ni|nahi kar sak\w*|nahi kr sak\w*|nahin kar sak\w*|ni kr sak\w*|ni kar sak\w*|nhi kar sak\w*|nahi krskt\w*|ni krskt\w*|nhi krskt\w*|nahi de sak\w*|ni de sak\w*|nhi de sak\w*|nahi bat\w+|ni bat\w+|nhi bat\w+|baad me|baad mein|later bat\w+|later tell|tell later|next time|not right now|not now|for now|can'?t share|cannot share|can'?t give|cannot give|dont wanna share|don'?t wanna share|don'?t want to share|dont want to share)\b/i;
// Student explicitly declining to share a cert verification link.
const NOLINK_RE = /\b(no link|skip link|nolink|no url|without link|no verification|link nahi|nahi link|link nahin|private)\b/i;
// A URL or bare domain (with path) anywhere in the message — used to pull a
// verification link out of a free-text cert reply.
const URL_IN_TEXT_RE = /(https?:\/\/\S+|[a-z0-9.-]+\.[a-z]{2,}\/\S*)/i;
const YES_RE = /^\s*(haan|han|yes|y|ready|chalo|chaliye|let'?s go|start|sure|ok|okay|yup|yeah)\s*$/i;
const JD_GENERIC_RE = /^\s*(no specific role|no specific|no role|generic|any role|any job|don'?t have|nothing specific|skip|no|nahi|nope|none|nothing)\s*$/i;
const JD_MARKER_RE = /\b(responsibilit|requirement|qualification|years? of experience|must have|nice to have|we are looking|about (the )?role|about us|key skills|preferred|location:|experience:|salary|stipend|ctc|notice period)/i;
const URL_RE = /^https?:\/\//i;
const SHOW_RE = /^\s*show\s*me\s*$/i;
const RESET_RE = /^\s*reset\s*$/i;
const PAY_RE = /^\s*(pay|pay now|unlock|buy|purchase|₹?\s*49|haan pay)\s*$/i;
const EDIT_RE = /^\s*(edit|edits|change|changes)\s*$/i;
// Post-PDF rating micro-survey (added 2026-07-14). Matches "5", "4/5",
// "5 stars", "rating 3" etc. Only fires in DELIVERED / PAID_COMPLETE state
// AFTER a PDF has been delivered, so a bare digit earlier in the flow
// (e.g. someone typing "5" as their CGPA) never trips this.
const RATE_RE = /^\s*(?:rating\s*|rate\s*)?([1-5])\s*(?:\/\s*5|stars?)?\s*$/i;
// Edit budget: 3 free (watermarked) edits before the pay nudge, then 3 more
// post-payment (clean PDF). Communicated to the student at every boundary.
const MAX_FREE_EDITS = 3;
const MAX_PAID_EDITS = 3;

// Experience: the three hard slots every entry needs. Asked deterministically
// (one question, only the empty ones) so a filled slot is never re-asked.
const EXP_HARD_SLOTS = ['role', 'company', 'dates'];
// Once these are filled, a clarification that still mentions them is the LLM
// wrongly re-asking — we detect it and substitute a deterministic impact ask.
const EXP_SLOT_REASK_RE = /\b(role|designation|company|organi[sz]ation|kaha|kahaan|where.*work|kab se|kab tak|duration|dates|kitne se kitne|naam kya|name of)\b/i;
// Bullet safety cap: if we already have this many bullets, advance regardless of
// the LLM's sufficiency clarification so the step can never loop forever.
const EXP_BULLET_CAP = 3;

function experienceHardMissing(exp) {
  if (!exp) return [...EXP_HARD_SLOTS];
  return EXP_HARD_SLOTS.filter((k) => !exp[k]);
}

function classifyJdInput(text) {
  const t = String(text || '').trim();
  if (URL_RE.test(t)) return 'url';
  if (t.length > 200) return 'jd';
  if (t.includes('\n')) return 'jd';
  if (JD_MARKER_RE.test(t)) return 'jd';
  if ((t.match(/,/g) || []).length > 4) return 'jd';
  return 'role';
}

function newSession() {
  return {
    state: STATES.NEW,
    resume_json: { pending_project: null },
    resume_json_rewritten: null,
    jd_text: null,
    jd_url: null,
    jd_role: null,
    jd_generic: false,
    jd_keywords: [],
    ats_score: null,
    iteration_count: 0,
    pdf_versions: [],
    paid: false,
    pilot: !!config.PILOT_MODE,
    razorpay_payment_link_id: null,
    edits_free_used: 0,
    edits_paid_used: 0,
    created_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  };
}

// Creates a ₹49 payment link and stores the URL on the session. Does NOT
// change state — caller decides whether to advance to AWAITING_PAYMENT.
// Idempotent: if `session.payment_link_url` is already set, no-ops. Returns
// true on success (link ready), false on failure. Failure is soft: caller
// falls back to a "type pay" CTA so the flow doesn't dead-end.
async function ensurePaymentLink(session, phoneHash) {
  if (session.payment_link_url) return true;
  try {
    const link = await createPaymentLink({
      phoneHash,
      phone: session.phone_from,
      name: session.resume_json && session.resume_json.name,
      email: session.resume_json && session.resume_json.email,
    });
    session.payment_link_id = link.id;
    // Legacy field name kept while old sessions age out (24h TTL). Safe to
    // remove after the Cashfree cutover has been live > 24h.
    session.razorpay_payment_link_id = link.id;
    session.payment_link_url = link.short_url;
    logEvent({ phoneHash, eventName: 'payment_link_created', state: session.state, payload: { amount: 49 } });
    return true;
  } catch (e) {
    logger.error(
      {
        err: e.message,
        statusCode: e.statusCode,
        rzpCode: e.error && e.error.code,
        rzpDesc: e.error && e.error.description,
        cfCode: e.cfCode,
        cfDesc: e.cfDesc,
      },
      'createPaymentLink failed',
    );
    return false;
  }
}

// Returns reply for the GENERATING transition. Runs rewrite + PDF delivery
// inline. Caller is responsible for persisting the session afterwards.
// Reply is { text, media } when PDF was delivered, else string.
async function tryGenerate(session, phoneFrom, phoneHash) {
  if (session.state !== STATES.GENERATING) return null;
  try {
    await runGeneration(session, phoneFrom);
    // Path 2 measure-then-compress (2026-07-16): if the initial rewrite
    // renders to >1 page, this callback re-runs rewriteBody+rewriteSummary
    // with the 1-page compression rule active. Delivery re-renders with the
    // compressed content. Zero overhead when the resume already fits.
    const onOverflow = async () => {
      try {
        const { rewriteBody, rewriteSummary } = require('../llm/rewrite');
        const jdIntel = {
          role_noun: session.jd_role_noun, role_title: session.jd_role_title,
          domain: session.jd_domain, experience_level: session.jd_experience_level,
          key_responsibilities: session.jd_key_responsibilities, top_prioritized_skills: session.jd_top_prioritized_skills,
          keywords: session.jd_keywords,
        };
        const bodyRes = await rewriteBody({
          resumeJson: session.resume_json,
          jdIntel,
          jdRole: session.jd_role, jdText: session.jd_text, jdKeywords: session.jd_keywords, jdGeneric: session.jd_generic,
          phoneFrom,
          oneP: true,
        });
        if (!bodyRes.data) return null;
        const sumRes = await rewriteSummary({
          body: bodyRes.data, jdIntel,
          jdText: session.jd_text, jdRole: session.jd_role, jdGeneric: session.jd_generic,
          rawResume: session.resume_json,
        });
        bodyRes.data.summary = (sumRes.data && sumRes.data.summary) || '';
        logger.info({ phoneHash: String(phoneHash).slice(0, 12) }, 'overflow re-rewrite complete (oneP=true)');
        return bodyRes.data;
      } catch (e) {
        logger.warn({ err: e.message }, 'overflow re-rewrite failed — shipping original');
        return null;
      }
    };
    const delivery = await deliverPdf(session, phoneHash, { clean: unlocked(session), onOverflow });
    // Delivery is checked BEFORE composing the response. If the PDF didn't
    // render/upload, we must NOT advance to DELIVERED or emit the success
    // preview (ATS score, "tayar", checkmarks) — that would claim a resume the
    // student can't open. Hold in GENERATING so the next message retries, and
    // return a clean, user-safe failure message (never "check server logs").
    if (!delivery || !delivery.signedUrl) {
      logger.error({ phoneHash: String(phoneHash).slice(0, 12) }, 'pdf delivery failed; holding in GENERATING for retry');
      return pickMessage('pdfDeliveryFailed');
    }
    // Eagerly create the payment link for non-unlocked students so the preview
    // includes a pay-now CTA instead of forcing a "type pay" round-trip.
    // Design call 2026-07-15. Soft failure — buildPreview degrades gracefully
    // if the link couldn't be created.
    if (!unlocked(session)) {
      await ensurePaymentLink(session, phoneHash);
    }
    session.state = STATES.DELIVERED;
    logEvent({ phoneHash, eventName: 'resume_delivered', state: STATES.DELIVERED, payload: { ats_score: session.ats_score } });
    return { text: buildPreview(session), media: delivery.signedUrl };
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'generation pipeline failed');
    return pickMessage('generationFailed');
  }
}

// Creates (or re-sends) the ₹49 payment link and moves to AWAITING_PAYMENT.
// Called on explicit 'pay' — the eager creation in tryGenerate usually means
// the link is already on the session; this just switches state so nudges work.
async function startPayment(session, phoneHash) {
  const ok = await ensurePaymentLink(session, phoneHash);
  if (!ok) return pickMessage('paymentLinkFailed');
  session.state = STATES.AWAITING_PAYMENT;
  return pickMessage('paymentLink', { url: session.payment_link_url });
}

// Re-runs the deterministic ATS scorer after the rewritten resume changes, so
// the score/suggestions stay honest across edits.
function rescore(session) {
  if (!session.resume_json_rewritten) return;
  const scored = scoreResume(session.resume_json_rewritten, session.jd_keywords || []);
  session.ats_score = scored.total;
  session.ats_breakdown = scored;
  session.ats_suggestions = suggestionsFor(scored);
}

// Post-PDF rating micro-survey (added 2026-07-14). Stores the rating on the
// session, logs a telemetry event for the admin dashboard, and returns a
// warmth-appropriate thank-you. Overwrite-safe — a student can revise their
// rating (e.g. rate 3, apply an edit, rate 5). Never advances state.
function handleRating(session, phoneHash, rating) {
  const clamped = Math.max(1, Math.min(5, Number(rating) || 0));
  const previous = Number(session.rating || 0);
  session.rating = clamped;
  session.rating_at = new Date().toISOString();
  logEvent({
    phoneHash,
    eventName: 'rating_submitted',
    state: session.state,
    payload: { rating: clamped, previous: previous || null },
  });
  if (clamped <= 2) return pickMessage('ratingThanksLow', { r: clamped });
  if (clamped === 3) return pickMessage('ratingThanksMid', { r: clamped });
  return pickMessage('ratingThanksHigh', { r: clamped });
}

// Enters edit mode from DELIVERED (free budget) or PAID_COMPLETE (paid budget).
// Caller persists. Returns the prompt string, or null if the budget is spent
// (caller then sends the appropriate cap message).
function enterEdit(session) {
  const paid = unlocked(session);
  const used = paid ? (session.edits_paid_used || 0) : (session.edits_free_used || 0);
  const max = paid ? MAX_PAID_EDITS : MAX_FREE_EDITS;
  if (used >= max) return null;
  session.state = STATES.AWAITING_EDIT_OR_DONE;
  return pickMessage('editPrompt', { remaining: max - used });
}

// Applies one free-text edit: LLM patch → re-score → regenerate the PDF (clean
// if paid, watermarked otherwise). A real change consumes one edit and returns
// the resting state (DELIVERED / PAID_COMPLETE); a clarification keeps the
// student in edit mode and consumes nothing. Caller persists.
// Returns { text, media } or a string.
async function runEdit(session, phoneHash, instruction) {
  const paid = unlocked(session);
  const used = paid ? (session.edits_paid_used || 0) : (session.edits_free_used || 0);
  const max = paid ? MAX_PAID_EDITS : MAX_FREE_EDITS;
  if (used >= max) {
    session.state = paid ? STATES.PAID_COMPLETE : STATES.DELIVERED;
    return pickMessage(paid ? 'editCapPaid' : 'editCapFree');
  }

  let result;
  try {
    result = await applyEdit({
      rewritten: session.resume_json_rewritten,
      instruction,
      jdRole: session.jd_role,
      jdText: session.jd_text,
      jdGeneric: session.jd_generic,
    });
  } catch (e) {
    logger.error({ err: e.message }, 'applyEdit failed');
    return pickMessage('editFailed');
  }

  if (result.clarification_needed || !result.data) {
    // Stay in edit mode; nothing consumed.
    return result.clarification_needed || pickMessage('editFailed');
  }

  session.resume_json_rewritten = result.data;
  rescore(session);
  // Edits also respect the 1-page rule — if an edit adds content that pushes
  // the resume to page 2, the compression callback fires the same way as in
  // tryGenerate.
  const editOnOverflow = async () => {
    try {
      const { rewriteBody, rewriteSummary } = require('../llm/rewrite');
      const jdIntel = {
        role_noun: session.jd_role_noun, role_title: session.jd_role_title,
        domain: session.jd_domain, experience_level: session.jd_experience_level,
        key_responsibilities: session.jd_key_responsibilities, top_prioritized_skills: session.jd_top_prioritized_skills,
        keywords: session.jd_keywords,
      };
      const bodyRes = await rewriteBody({
        resumeJson: session.resume_json_rewritten, jdIntel,
        jdRole: session.jd_role, jdText: session.jd_text, jdKeywords: session.jd_keywords, jdGeneric: session.jd_generic,
        oneP: true,
      });
      if (!bodyRes.data) return null;
      const sumRes = await rewriteSummary({
        body: bodyRes.data, jdIntel,
        jdText: session.jd_text, jdRole: session.jd_role, jdGeneric: session.jd_generic,
        rawResume: session.resume_json_rewritten,
      });
      bodyRes.data.summary = (sumRes.data && sumRes.data.summary) || '';
      return bodyRes.data;
    } catch (e) {
      logger.warn({ err: e.message }, 'edit overflow re-rewrite failed');
      return null;
    }
  };
  const delivery = await deliverPdf(session, phoneHash, { clean: paid, onOverflow: editOnOverflow });

  // Check delivery BEFORE claiming success. If the re-render failed, do NOT
  // consume an edit and do NOT send the "Updated ✓" template. The change is
  // saved on the session, so retrying 'edit' will re-deliver it. Return to the
  // resting state with a clear, user-safe failure message.
  if (!delivery || !delivery.signedUrl) {
    logger.error({ phoneHash: String(phoneHash).slice(0, 12) }, 'edit pdf delivery failed; edit not consumed');
    session.state = paid ? STATES.PAID_COMPLETE : STATES.DELIVERED;
    return pickMessage('editPdfFailed');
  }

  // A real change was applied AND delivered — consume one edit.
  if (paid) session.edits_paid_used = used + 1;
  else session.edits_free_used = used + 1;
  const remaining = max - (used + 1);
  logEvent({ phoneHash, eventName: 'edit_requested', state: session.state, payload: { phase: paid ? 'paid' : 'free', remaining } });

  // Back to the resting state — the next 'edit'/'pay' is a command again.
  session.state = paid ? STATES.PAID_COMPLETE : STATES.DELIVERED;

  return { text: pickMessage(paid ? 'editAppliedPaid' : 'editApplied', { remaining }), media: delivery.signedUrl };
}

// Hybrid LLM-Reply composer. See docs/HYBRID-REPLY-SPEC.md.
//
// Hybrid activates if EITHER:
//   - config.HYBRID_REPLY is true (global on — all sessions), OR
//   - config.HYBRID_REPLY_FOR_PILOT is true AND session.pilot is true
//     (pilot-only opt-in — paid sessions stay canned).
// Otherwise returns `fallback` verbatim — behavior identical to the
// canned-prompts path that has shipped to date.
//
// On activation, calls src/llm/respond.js, runs sanity gates inside that
// module, and uses the LLM reply if it passes. Any failure (LLM error, JSON
// parse, sanity-gate reject, empty result) silently returns `fallback`.
//
// `fallback` MUST already be the same string the legacy path would have
// returned at this point. Non-string fallbacks (e.g. {text, media} for
// delivery responses) pass through unchanged — this composer is only for
// collection-state text replies.
async function composeReply({ session, prev_state, decision, student_last, missing, fallback }) {
  const sessionPilot = !!(session && session.pilot);
  const useHybrid = config.HYBRID_REPLY || (config.HYBRID_REPLY_FOR_PILOT && sessionPilot);
  if (!useHybrid) return fallback;
  if (typeof fallback !== 'string') return fallback;
  if (!session || !student_last) return fallback;
  try {
    const result = await respond({
      state: session.state,
      prev_state: prev_state || null,
      resume_json: session.resume_json,
      student_last,
      decision: decision || 'still_missing',
      missing: missing || [],
      session_flags: {
        jd_role: session.jd_role,
        jd_text: session.jd_text ? `(${(session.jd_text || '').length} chars)` : null,
        jd_generic: !!session.jd_generic,
        exp_more_pending: !!session.exp_more_pending,
        certs_more_pending: !!session.certs_more_pending,
        proj_focus: session.proj_focus || null,
      },
      history: [],
    });
    if (result && result.used_llm && typeof result.reply === 'string' && result.reply.length > 0) {
      return result.reply;
    }
    return fallback;
  } catch (e) {
    logger.warn({ err: e.message, state: session && session.state }, 'composeReply threw — using fallback');
    return fallback;
  }
}

// Public entry. Serializes a single student's messages with a per-phone lock so
// two concurrent inbound messages can't race on the (read-modify-write) session.
// A message that can't grab the lock within the wait window is told to retry —
// its text isn't dropped, the student just resends.
async function handle({ phoneHash, body, phoneFrom }) {
  if (!phoneHash) throw new Error('handle: phoneHash required');
  const token = await acquirePhoneLock(phoneHash);
  if (!token) {
    logger.warn({ phoneHash: String(phoneHash).slice(0, 12) }, 'phone lock not acquired; asking student to retry');
    return pickMessage('busy');
  }
  try {
    return await handleInner({ phoneHash, body, phoneFrom });
  } finally {
    await releasePhoneLock(phoneHash, token);
  }
}

async function handleInner({ phoneHash, body, phoneFrom }) {
  const trimmed = String(body || '').trim();
  const phoneShort = phoneHash.slice(0, 12);
  logger.info({ phoneHash: phoneShort, bodyLen: trimmed.length, bodyHead: trimmed.slice(0, 30) }, 'router.handle inbound');

  // Rate limit (PRD §13.3).
  const rl = await checkRateLimit(phoneHash);
  if (!rl.allowed) {
    return pickMessage('rateLimit', { sec: rl.resetInSec });
  }

  if (RESET_RE.test(trimmed)) {
    const fresh = newSession();
    fresh.state = STATES.AWAITING_CONFIRM_START;
    await setSession(phoneHash, fresh);
    return pickMessage('reset') + '\n\n' + pickPrompt(STATES.NEW);
  }

  let session = await getSession(phoneHash);
  if (!session) {
    session = newSession();
    session.state = STATES.AWAITING_CONFIRM_START;
    await setSession(phoneHash, session);
    logEvent({ phoneHash, eventName: 'session_started', state: STATES.AWAITING_CONFIRM_START });
    return pickPrompt(STATES.NEW);
  }

  session.last_message_at = new Date().toISOString();
  // Persist the WhatsApp address (server-side only, private Redis) so the
  // post-payment webhook can push the clean PDF outbound. Never logged/exposed.
  if (phoneFrom) session.phone_from = phoneFrom;

  // show me: dump rewritten resume if available (post-generation), else collected raw.
  if (SHOW_RE.test(trimmed)) {
    const isRewritten = !!session.resume_json_rewritten;
    const payload = isRewritten
      ? { state: session.state, label: 'rewritten', resume: session.resume_json_rewritten, jd_keywords: session.jd_keywords }
      : { state: session.state, label: 'collected', resume: session.resume_json, jd_url: session.jd_url, jd_role: session.jd_role, jd_generic: session.jd_generic, jd_text: session.jd_text ? `(${session.jd_text.length} chars)` : null };
    const dump = JSON.stringify(payload, null, 2);
    return dump.length > 1400 ? dump.slice(0, 1400) + '\n...(truncated, full version in PDF Day 4)' : dump;
  }

  const current = session.state;

  // --- DELIVERED: watermarked PDF sent. "pay" → create link; "edit" → edit loop.
  // Rating check runs FIRST so a bare "5" is captured as feedback, not
  // fallthrough to deliveredHelp. Overwriteable — a student can revise their
  // rating after applying edits and re-viewing the PDF.
  if (current === STATES.DELIVERED) {
    const rateMatch = trimmed.match(RATE_RE);
    if (rateMatch) {
      const reply = handleRating(session, phoneHash, Number(rateMatch[1]));
      await setSession(phoneHash, session);
      return reply;
    }
    if (PAY_RE.test(trimmed) && !unlocked(session)) {
      const reply = await startPayment(session, phoneHash);
      await setSession(phoneHash, session);
      return reply;
    }
    if (PAY_RE.test(trimmed) && unlocked(session)) {
      return pickMessage('pilotNoPay');
    }
    if (EDIT_RE.test(trimmed)) {
      const reply = enterEdit(session);
      await setSession(phoneHash, session);
      return reply || pickMessage(unlocked(session) ? 'editCapPaid' : 'editCapFree');
    }
    return pickMessage(unlocked(session) ? 'paidComplete' : 'deliveredHelp');
  }

  // --- AWAITING_EDIT_OR_DONE: next message is the change instruction (free or
  // paid phase, decided by session.paid). 'done' exits; 'pay' (free phase) jumps
  // to checkout. Anything else is the edit request. ---
  if (current === STATES.AWAITING_EDIT_OR_DONE) {
    if (DONE_RE.test(trimmed)) {
      session.state = unlocked(session) ? STATES.PAID_COMPLETE : STATES.DELIVERED;
      await setSession(phoneHash, session);
      return pickMessage(unlocked(session) ? 'editDonePaid' : 'editDone');
    }
    if (PAY_RE.test(trimmed) && !unlocked(session)) {
      const reply = await startPayment(session, phoneHash);
      await setSession(phoneHash, session);
      return reply;
    }
    const reply = await runEdit(session, phoneHash, trimmed);
    await setSession(phoneHash, session);
    return reply;
  }

  // --- AWAITING_PAYMENT: link sent, waiting on the Razorpay webhook. ---
  if (current === STATES.AWAITING_PAYMENT) {
    if (PAY_RE.test(trimmed) && session.payment_link_url) {
      return pickMessage('paymentLink', { url: session.payment_link_url });
    }
    return pickMessage('awaitingPayment', { url: session.payment_link_url || '' });
  }

  // --- PAID_COMPLETE: clean PDF delivered. "edit" → 3 post-payment edits on the
  // clean version; otherwise terminal ack. Rating micro-survey also lives
  // here — students who paid can still rate the final clean copy. ---
  if (current === STATES.PAID_COMPLETE) {
    const rateMatch = trimmed.match(RATE_RE);
    if (rateMatch) {
      const reply = handleRating(session, phoneHash, Number(rateMatch[1]));
      await setSession(phoneHash, session);
      return reply;
    }
    if (EDIT_RE.test(trimmed)) {
      const reply = enterEdit(session);
      await setSession(phoneHash, session);
      return reply || pickMessage('editCapPaid');
    }
    return pickMessage('paidComplete');
  }

  // --- GENERATING: usually transient — pipeline runs inline on entry. If we
  // land here in a follow-up message, run again (e.g., student pinged before
  // initial generation finished, very rare). ---
  if (current === STATES.GENERATING) {
    const reply = await tryGenerate(session, phoneFrom, phoneHash);
    await setSession(phoneHash, session);
    return reply || pickMessage('deliveredHelp');
  }

  // --- Phase 1: confirm start. ---
  if (current === STATES.NEW || current === STATES.AWAITING_CONFIRM_START) {
    if (YES_RE.test(trimmed)) {
      session.state = STATES.AWAITING_NAME;
      await setSession(phoneHash, session);
      return pickPrompt(STATES.AWAITING_NAME);
    }
    return pickPrompt(STATES.AWAITING_CONFIRM_START);
  }

  // --- AWAITING_JD: 4 paths — generic, URL, role-name, or full JD text. ---
  if (current === STATES.AWAITING_JD) {
    if (JD_GENERIC_RE.test(trimmed)) {
      session.jd_text = null; session.jd_url = null; session.jd_role = null;
      session.jd_generic = true;
      session.state = NEXT_STATE[current];
      await setSession(phoneHash, session);
      return pickMessage('jdGenericAck') + '\n\n' + pickPrompt(session.state, session);
    }
    const kind = classifyJdInput(trimmed);
    if (kind === 'url')       { session.jd_url = trimmed; session.jd_text = null; session.jd_role = null; }
    else if (kind === 'role') { session.jd_role = trimmed; session.jd_url = null; session.jd_text = null; }
    else                       { session.jd_text = trimmed; session.jd_url = null; session.jd_role = null; }
    session.jd_generic = false;
    session.state = NEXT_STATE[current];
    await setSession(phoneHash, session);
    const ack = kind === 'role' ? pickMessage('jdRoleAck', { role: trimmed }) + '\n\n' : '';
    return ack + pickPrompt(session.state, session);
  }

  // --- AWAITING_POR: multi-entry with pending_por accumulator + "more or done?" loop. ---
  // Mirrors experience/certs/projects (2026-07-15 — PoR was the last multi-entry-
  // shaped section still single-entry). Per-entry: gather → sufficiency check →
  // commit pending_por into por[] → set por_more_pending → "N saved ✓ — agla?" →
  // done/skip/decline advances; anything else starts a fresh pending_por entry.
  if (current === STATES.AWAITING_POR) {
    // (a) "Add another or 'done'?" pending — DONE/SKIP/decline advances; any
    //     other text starts a new pending_por entry (falls through to extract).
    if (session.por_more_pending) {
      if (DONE_RE.test(trimmed) || SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed)) {
        session.por_more_pending = false;
        session.state = NEXT_STATE[current];
        const genReply = await tryGenerate(session, phoneFrom, phoneHash);
        await setSession(phoneHash, session);
        return genReply || pickPrompt(session.state, session);
      }
      session.por_more_pending = false;
      // Fall through to extraction below with a fresh pending_por.
    }

    // (b) Empty-slot skip (never got any content) — advance without commit.
    if (SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed)) {
      const pending = session.resume_json.pending_por;
      if (pending && (pending.role || pending.organization) && (pending.bullets || []).length > 0) {
        session.resume_json.por = (session.resume_json.por || []).concat([pending]);
      } else if (!session.resume_json.por) {
        session.resume_json.por = [];
      }
      session.resume_json.pending_por = null;
      session.state = NEXT_STATE[current];
      await setSession(phoneHash, session);
      return (await tryGenerate(session, phoneFrom, phoneHash)) || pickPrompt(session.state, session);
    }

    try {
      const { data, usage } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session });
      logger.info({ phoneHash: phoneShort, state: current, usage }, 'extracted');
      SECTION_CONFIG[current].merge(session.resume_json, data);
      if (data.clarification_needed) {
        await setSession(phoneHash, session);
        return await composeReply({
          session,
          prev_state: current,
          decision: 'still_missing',
          student_last: trimmed,
          missing: ['clarification'],
          fallback: data.clarification_needed,
        });
      }
      // Sufficient — commit pending_por to por[] and enter the "add another?" loop.
      const pending = session.resume_json.pending_por;
      if (pending && (pending.role || pending.organization)) {
        session.resume_json.por = (session.resume_json.por || []).concat([pending]);
      }
      session.resume_json.pending_por = null;
      session.por_more_pending = true;
      await setSession(phoneHash, session);
      const n = (session.resume_json.por || []).length;
      const loopFallback = `Leadership role #${n} saved ✓ — agla leadership role bhejo (ek message mein), ya 'done' likho.`;
      return await composeReply({
        session,
        prev_state: current,
        decision: 'loop_more',
        student_last: trimmed,
        missing: [],
        fallback: loopFallback,
      });
    } catch (e) {
      // A throw here is a BACKEND failure (LLM call errored or returned
      // unparseable JSON), never a "bad user input" — that path returns the
      // LLM's own clarification_needed above. So tell the student the server
      // hiccuped, not that their (often perfectly valid) message was unclear.
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
  }

  // --- AWAITING_PROJECTS: multi-entry with pending_project accumulator. ---
  // commitProject: replace any prior project with the same case-insensitive
  // name instead of appending a duplicate (live-test 2026-06-24: a student who
  // re-entered the projects state across sessions ended up with the same
  // project saved twice — once full, once thin). Newer wins because the most
  // recent attempt is the one the student just authored.
  function commitProject(rj, pending) {
    if (!Array.isArray(rj.projects)) rj.projects = [];
    const newName = String(pending.name || '').trim().toLowerCase();
    if (!newName) { rj.projects.push(pending); return; }
    const idx = rj.projects.findIndex((p) => String(p && p.name || '').trim().toLowerCase() === newName);
    if (idx >= 0) {
      logger.info({ phoneHash: phoneShort, projectName: pending.name }, 'project name collision — replacing prior entry');
      rj.projects[idx] = pending;
    } else {
      rj.projects.push(pending);
    }
  }

  if (current === STATES.AWAITING_PROJECTS) {
    if (DONE_RE.test(trimmed) || SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed)) {
      const pending = session.resume_json.pending_project;
      if (pending && Object.keys(pending).length > 0) {
        commitProject(session.resume_json, pending);
      } else if (!session.resume_json.projects) {
        session.resume_json.projects = [];
      }
      session.resume_json.pending_project = null;
      session.proj_focus = null;
      session.state = NEXT_STATE[current];
      await setSession(phoneHash, session);
      return pickPrompt(session.state, session);
    }
    try {
      // Pass a follow-up hint when we're mid-project (pending_project exists). The
      // projects extractor is otherwise stateless, so a terse metric/link reply
      // ("around 300 signups") would get dropped and re-asked as a new project.
      const { data, usage, repoEnrichment } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session, focus: session.proj_focus || null });
      const preMergeBullets = ((session.resume_json.pending_project || {}).bullets || []).length;
      SECTION_CONFIG[current].merge(session.resume_json, data);
      const postMergeBullets = ((session.resume_json.pending_project || {}).bullets || []).length;

      // Persist the raw README on the pending project so the rewriter can mine
      // it directly for architecture / feature / decision bullets. The extractor
      // sees the README but the rewriter (a separate LLM call) previously did
      // not, producing shallow paraphrases of the extractor's output. Live-test
      // 2026-07-13: Meet's JEIS project rendered as "Developed a decision tool
      // for guar-gum exporter" instead of "Architected weekly-refreshing ETL
      // pipeline… 12,828 rows, 20/20 validation" because the README with those
      // exact facts never reached the rewrite pass.
      if (repoEnrichment && repoEnrichment.readme && session.resume_json.pending_project) {
        session.resume_json.pending_project.readme_excerpt = repoEnrichment.readme.slice(0, 2500);
        if (repoEnrichment.description && !session.resume_json.pending_project.repo_description) {
          session.resume_json.pending_project.repo_description = repoEnrichment.description;
        }
        if (repoEnrichment.languages && Array.isArray(repoEnrichment.languages)) {
          session.resume_json.pending_project.repo_languages = repoEnrichment.languages;
        }
      }
      logger.info({
        phoneHash: phoneShort, state: current, usage,
        enriched: !!repoEnrichment,
        bulletsBefore: preMergeBullets,
        bulletsAfter: postMergeBullets,
        bulletsFromTurn: postMergeBullets - preMergeBullets,
      }, 'extracted');
      if (data.clarification_needed) {
        // We asked a follow-up about the current project — remember it so the next
        // (terse) reply is mapped onto pending_project instead of restarting.
        session.proj_focus = session.resume_json.pending_project && session.resume_json.pending_project.name ? 'followup' : null;
        await setSession(phoneHash, session);
        return await composeReply({
          session,
          prev_state: current,
          decision: 'still_missing',
          student_last: trimmed,
          missing: ['clarification'],
          fallback: data.clarification_needed,
        });
      }
      if (session.resume_json.pending_project && session.resume_json.pending_project.name) {
        commitProject(session.resume_json, session.resume_json.pending_project);
      }
      session.resume_json.pending_project = null;
      session.proj_focus = null;
      await setSession(phoneHash, session);
      return await composeReply({
        session,
        prev_state: current,
        decision: 'loop_more',
        student_last: trimmed,
        missing: [],
        fallback: pickMessage('projectSaved', { n: (session.resume_json.projects || []).length }),
      });
    } catch (e) {
      // A throw here is a BACKEND failure (LLM call errored or returned
      // unparseable JSON), never a "bad user input" — that path returns the
      // LLM's own clarification_needed above. So tell the student the server
      // hiccuped, not that their (often perfectly valid) message was unclear.
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
  }

  // --- AWAITING_EXPERIENCE: dedicated handler. Multi-entry loop (2026-06-25). ---
  // Friend-test 2026-06-25 surfaced two pains: (1) the LLM kept re-asking for
  // an impact metric even after several metrics had been given (terse follow-ups
  // were getting dropped — fixed in extract.js PRE-CHECK + TERSE-METRIC rules),
  // (2) the flow never asked "add another internship/job?" so students with
  // multiple jobs only got one rendered. Mirror the projects + certs pattern.
  // Tracks whether the current turn just pushed an empty {} onto experience[]
  // via the exp_more_pending fall-through. If extraction then produces nothing,
  // we treat the message as a decline (pop the empty entry, advance) rather
  // than loop on hard-slot asks.
  let justPushedEmptyExp = false;
  if (current === STATES.AWAITING_EXPERIENCE) {
    // (a) "Add another experience or done?" pending — DONE / SKIP / natural-
    //     language decline ("I don't have any", "no more") advances; otherwise
    //     treat this message as the start of a NEW experience entry.
    if (session.exp_more_pending) {
      if (DONE_RE.test(trimmed) || SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed)) {
        session.exp_more_pending = false;
        session.exp_focus = null;
        session.state = NEXT_STATE[current];
        const genReply = await tryGenerate(session, phoneFrom, phoneHash);
        await setSession(phoneHash, session);
        return genReply || pickPrompt(session.state, session);
      }
      session.exp_more_pending = false;
      session.exp_focus = null;
      if (!Array.isArray(session.resume_json.experience)) session.resume_json.experience = [];
      session.resume_json.experience.push({});
      justPushedEmptyExp = true;
      // fall through to extraction; the merger targets the last (new) entry.
    }

    // (b) First-entry skip — no experience yet → advance straight to projects.
    if (SKIP_RE.test(trimmed) && !(Array.isArray(session.resume_json.experience) && session.resume_json.experience.length > 0)) {
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state, session);
    }

    let data, usage;
    try {
      ({ data, usage } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session, focus: session.exp_focus || null }));
    } catch (e) {
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
    SECTION_CONFIG[current].merge(session.resume_json, data);
    const expList = Array.isArray(session.resume_json.experience) ? session.resume_json.experience : [];
    const exp = expList.length ? expList[expList.length - 1] : null;
    const bulletCount = (exp && exp.bullets || []).length;
    logger.info({ phoneHash: phoneShort, state: current, usage, expEntries: expList.length, bullets: bulletCount }, 'extracted');

    // Safety: if we just pushed an empty {} via exp_more_pending fall-through
    // AND extraction produced no fields on that new entry, the student likely
    // meant 'done' but used a natural-language form NO_MORE_HINT didn't catch
    // (e.g. "umm I'm out", "kuch khaas nahi"). Pop the empty entry and advance
    // instead of locking into a hard-slot loop on a phantom entry.
    if (justPushedEmptyExp && exp && Object.keys(exp).length === 0) {
      logger.info({ phoneHash: phoneShort, state: current }, 'empty experience entry after decline — popping and advancing');
      expList.pop();
      session.state = NEXT_STATE[current];
      const genReplyAdv = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReplyAdv || pickPrompt(session.state, session);
    }

    const missing = experienceHardMissing(exp);

    // 1. Hard slots empty → ask ONLY for those, deterministically. Never re-asks a filled slot.
    if (missing.length > 0) {
      session.exp_focus = missing[0];
      await setSession(phoneHash, session);
      return expSlotQuestion(missing);
    }
    session.exp_focus = null;

    // 2. All hard slots present → use the LLM's clarification for bullet/impact depth.
    //    If it re-asks a filled slot, substitute a deterministic impact ask.
    //    Hybrid: composeReply may swap the canned text for a role-aware,
    //    no-fabrication LLM ask. Fallback is the canned text — behavior is
    //    identical when HYBRID_REPLY=false.
    if (data.clarification_needed && bulletCount < EXP_BULLET_CAP) {
      if (EXP_SLOT_REASK_RE.test(data.clarification_needed)) {
        logger.warn({ phoneHash: phoneShort, state: current, clar: data.clarification_needed.slice(0, 60) }, 'LLM re-asked a filled experience slot; substituting impact ask');
        await setSession(phoneHash, session);
        return await composeReply({
          session,
          prev_state: current,
          decision: 'still_missing',
          student_last: trimmed,
          missing: ['impact'],
          fallback: pickMessage('expAskImpact'),
        });
      }
      await setSession(phoneHash, session);
      return await composeReply({
        session,
        prev_state: current,
        decision: 'still_missing',
        student_last: trimmed,
        missing: ['clarification'],
        fallback: data.clarification_needed,
      });
    }

    // 3. Sufficient → enter the "add another or done?" loop instead of advancing.
    session.exp_more_pending = true;
    session.exp_focus = null;
    await setSession(phoneHash, session);
    const n = expList.length;
    const loopFallback = `Internship/job #${n} saved ✓ — agla internship ya job bhejo (ek message mein), ya 'done' likho.`;
    return await composeReply({
      session,
      prev_state: current,
      decision: 'loop_more',
      student_last: trimmed,
      missing: [],
      fallback: loopFallback,
    });
  }

  // --- AWAITING_CERTS: multi-item with per-cert link follow-up + "more or done?" loop. ---
  // A cert without a verification URL is a dangling, unverifiable claim. The LLM
  // sometimes captures only the first cert from a multi-line message and
  // sometimes accepts a bare name silently, so we backstop both: (1) ask for the
  // link of EVERY missing-URL cert one-by-one (not just the first), (2) after
  // all links resolve, mirror the projects "add another, or 'done'?" loop so
  // students can stack certs naturally instead of being forced into the next
  // state on the first one.
  if (current === STATES.AWAITING_CERTS) {
    // (1) Resolve a link asked for last turn, for a SPECIFIC named cert.
    if (session.cert_link_pending) {
      const targetName = session.cert_link_pending;
      session.cert_link_pending = null;
      const target = (session.resume_json.certifications || []).find((c) => c && c.name === targetName);
      if (target) {
        if (SKIP_RE.test(trimmed) || NOLINK_RE.test(trimmed)) {
          target._link_skipped = true;
        } else {
          const m = trimmed.match(URL_IN_TEXT_RE);
          if (m) target.url = m[0];
          else target._link_skipped = true; // reply wasn't a URL — treat as no-link rather than loop forever
        }
      }
      // More missing-link certs from the same batch? Ask the next one's link.
      const next = (session.resume_json.certifications || []).find((c) => c && c.name && !c.url && !c._link_skipped);
      if (next) {
        session.cert_link_pending = next.name;
        await setSession(phoneHash, session);
        return await composeReply({
          session,
          prev_state: current,
          decision: 'ask_link',
          student_last: trimmed,
          missing: ['cert_link'],
          fallback: `Got it. Verification link for '${next.name}'? 'skip' agar nahi hai.`,
        });
      }
      // All links resolved → enter the "add another or done?" loop.
      session.certs_more_pending = true;
      await setSession(phoneHash, session);
      const n = (session.resume_json.certifications || []).length;
      return await composeReply({
        session,
        prev_state: current,
        decision: 'loop_more',
        student_last: trimmed,
        missing: [],
        fallback: `${n} cert${n > 1 ? 's' : ''} saved ✓ — agla cert bhejo, ya 'done' likho.`,
      });
    }

    // (2) "Add another or 'done'?" pending. DONE / SKIP / natural-language
    //     decline advances; otherwise treat this message as additional cert(s)
    //     and fall through to extraction.
    if (session.certs_more_pending) {
      if (DONE_RE.test(trimmed) || SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed)) {
        session.certs_more_pending = false;
        session.state = NEXT_STATE[current];
        const genReply = await tryGenerate(session, phoneFrom, phoneHash);
        await setSession(phoneHash, session);
        return genReply || pickPrompt(session.state, session);
      }
      session.certs_more_pending = false;
      // fall through to extraction below
    }

    // (3) First-entry skip / decline: no certs at all.
    if (SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed)) {
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state, session);
    }

    // (4) Extract certs from this message. The extractor returns an ARRAY so a
    //     multi-line / numbered / comma-separated message yields multiple certs.
    let data, usage;
    try {
      ({ data, usage } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session }));
    } catch (e) {
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
    logger.info({ phoneHash: phoneShort, state: current, usage, newCerts: Array.isArray(data && data.certifications) ? data.certifications.length : 0 }, 'extracted');
    SECTION_CONFIG[current].merge(session.resume_json, data);

    // If the student declared "no link" in the SAME message (e.g. "NPTEL DBMS,
    // no link"), mark every newly-added missing-URL cert as skipped so we don't
    // ask. Applies to all currently missing-link certs (the merge just added them).
    if (NOLINK_RE.test(trimmed)) {
      for (const c of (session.resume_json.certifications || [])) {
        if (c && c.name && !c.url) c._link_skipped = true;
      }
    }

    // (5) Loop: ask for the FIRST cert still missing a link.
    const missingLink = (session.resume_json.certifications || []).find((c) => c && c.name && !c.url && !c._link_skipped);
    if (missingLink) {
      session.cert_link_pending = missingLink.name;
      await setSession(phoneHash, session);
      return await composeReply({
        session,
        prev_state: current,
        decision: 'ask_link',
        student_last: trimmed,
        missing: ['cert_link'],
        fallback: `Got it — '${missingLink.name}'. Verification link bhej dijiye (Coursera / NPTEL / official URL)? 'skip' agar nahi hai.`,
      });
    }

    if (data.clarification_needed) {
      await setSession(phoneHash, session);
      return await composeReply({
        session,
        prev_state: current,
        decision: 'still_missing',
        student_last: trimmed,
        missing: ['clarification'],
        fallback: data.clarification_needed,
      });
    }

    // (6) Every cert in this batch had a URL (or was declined) → "more or done?".
    session.certs_more_pending = true;
    await setSession(phoneHash, session);
    const n = (session.resume_json.certifications || []).length;
    return await composeReply({
      session,
      prev_state: current,
      decision: 'loop_more',
      student_last: trimmed,
      missing: [],
      fallback: `${n} cert${n > 1 ? 's' : ''} saved ✓ — agla cert bhejo, ya 'done' likho.`,
    });
  }

  // --- AWAITING_ACHIEVEMENTS: multi-entry with "more or done?" loop. ---
  // Mirror experience/certs/projects: per-message save → achievements_more_pending
  // → "saved ✓ — agla bhejo, ya 'done' likho." → next done/skip/decline advances.
  // Pattern added 2026-06-26 after live-test showed single-shot achievements
  // forced students to cram everything into one message.
  if (current === STATES.AWAITING_ACHIEVEMENTS) {
    // (1) "Add another or 'done'?" pending — done/skip/decline advances.
    if (session.achievements_more_pending) {
      if (DONE_RE.test(trimmed) || SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed)) {
        session.achievements_more_pending = false;
        session.state = NEXT_STATE[current];
        const genReply = await tryGenerate(session, phoneFrom, phoneHash);
        await setSession(phoneHash, session);
        return genReply || pickPrompt(session.state, session);
      }
      session.achievements_more_pending = false;
      // fall through to extraction below
    }

    // (2) First-entry skip / decline: no achievements at all.
    if (SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed)) {
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state, session);
    }

    // (3) Extract achievement(s) from this message. The extractor's merge does
    //     a concat() on rj.achievements, so multi-turn accumulation is native.
    let dataA, usageA;
    try {
      ({ data: dataA, usage: usageA } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session }));
    } catch (e) {
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
    logger.info({
      phoneHash: phoneShort, state: current, usage: usageA,
      newAchievements: Array.isArray(dataA && dataA.achievements) ? dataA.achievements.length : 0,
    }, 'extracted');
    SECTION_CONFIG[current].merge(session.resume_json, dataA);

    if (dataA.clarification_needed) {
      await setSession(phoneHash, session);
      return await composeReply({
        session,
        prev_state: current,
        decision: 'still_missing',
        student_last: trimmed,
        missing: ['clarification'],
        fallback: dataA.clarification_needed,
      });
    }

    // (4) Saved → "more or done?" loop.
    session.achievements_more_pending = true;
    await setSession(phoneHash, session);
    const nA = (session.resume_json.achievements || []).length;
    return await composeReply({
      session,
      prev_state: current,
      decision: 'loop_more',
      student_last: trimmed,
      missing: [],
      fallback: `${nA} achievement${nA > 1 ? 's' : ''} saved ✓ — agla bhejo, ya 'done' likho.`,
    });
  }

  // --- General Phase 2 collection. ---
  if (PHASE_2_STATES.has(current)) {
    const optional = OPTIONAL_STATES.has(current);
    // SKIP / natural-language decline advances optional sections. This is what
    // catches AWAITING_COURSEWORK "nothing else", etc. — without it, the
    // extractor returns empty and the section loops on its clarification.
    if (optional && (SKIP_RE.test(trimmed) || NO_MORE_HINT.test(trimmed) || OPTIONAL_DECLINE_HINT.test(trimmed))) {
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state, session);
    }
    try {
      const { data, usage } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session });
      logger.info({ phoneHash: phoneShort, state: current, usage }, 'extracted');
      SECTION_CONFIG[current].merge(session.resume_json, data);
      if (data.clarification_needed) {
        await setSession(phoneHash, session);
        return await composeReply({
          session,
          prev_state: current,
          decision: 'still_missing',
          student_last: trimmed,
          missing: ['clarification'],
          fallback: data.clarification_needed,
        });
      }
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state, session);
    } catch (e) {
      // A throw here is a BACKEND failure (LLM call errored or returned
      // unparseable JSON), never a "bad user input" — that path returns the
      // LLM's own clarification_needed above. So tell the student the server
      // hiccuped, not that their (often perfectly valid) message was unclear.
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
  }

  // --- Fallthrough: Day 5+ scope (payment etc.). ---
  logger.warn({ phoneHash: phoneShort, state: current, body: trimmed.slice(0, 40) }, 'router.handle fellthrough');
  return pickMessage('beyondPhase2');
}

module.exports = { handle, newSession, unlocked };
