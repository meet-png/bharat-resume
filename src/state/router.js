// State machine. PRD §6, §18 Day 2-3.
const { STATES, NEXT_STATE, OPTIONAL_STATES, PHASE_2_STATES } = require('./states');
const { pickPrompt, pickMessage, expSlotQuestion } = require('./prompts');
const { extractSection, SECTION_CONFIG } = require('../llm/extract');
const { runGeneration, buildPreview } = require('./generator');
const { deliverPdf } = require('./delivery');
const { createPaymentLink } = require('../payment/razorpay');
const { applyEdit } = require('../llm/edit');
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

// Returns reply for the GENERATING transition. Runs rewrite + PDF delivery
// inline. Caller is responsible for persisting the session afterwards.
// Reply is { text, media } when PDF was delivered, else string.
async function tryGenerate(session, phoneFrom, phoneHash) {
  if (session.state !== STATES.GENERATING) return null;
  try {
    await runGeneration(session, phoneFrom);
    const delivery = await deliverPdf(session, phoneHash, { clean: unlocked(session) });
    // Delivery is checked BEFORE composing the response. If the PDF didn't
    // render/upload, we must NOT advance to DELIVERED or emit the success
    // preview (ATS score, "tayar", checkmarks) — that would claim a resume the
    // student can't open. Hold in GENERATING so the next message retries, and
    // return a clean, user-safe failure message (never "check server logs").
    if (!delivery || !delivery.signedUrl) {
      logger.error({ phoneHash: String(phoneHash).slice(0, 12) }, 'pdf delivery failed; holding in GENERATING for retry');
      return pickMessage('pdfDeliveryFailed');
    }
    session.state = STATES.DELIVERED;
    logEvent({ phoneHash, eventName: 'resume_delivered', state: STATES.DELIVERED, payload: { ats_score: session.ats_score } });
    return { text: buildPreview(session), media: delivery.signedUrl };
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'generation pipeline failed');
    return pickMessage('generationFailed');
  }
}

// Creates (or re-sends) the ₹49 Razorpay link and moves to AWAITING_PAYMENT.
// Caller persists the session. Returns a string reply.
async function startPayment(session, phoneHash) {
  // Re-use an existing link if one was already created for this session.
  if (session.payment_link_url) {
    session.state = STATES.AWAITING_PAYMENT;
    return pickMessage('paymentLink', { url: session.payment_link_url });
  }
  try {
    const link = await createPaymentLink({ phoneHash });
    session.razorpay_payment_link_id = link.id;
    session.payment_link_url = link.short_url;
    session.state = STATES.AWAITING_PAYMENT;
    logEvent({ phoneHash, eventName: 'payment_link_created', state: STATES.AWAITING_PAYMENT, payload: { amount: 49 } });
    return pickMessage('paymentLink', { url: link.short_url });
  } catch (e) {
    // Razorpay SDK errors carry no `.message`; the reason lives in
    // e.statusCode / e.error.{code,description}. Capture both so prod failures
    // are diagnosable (e.g. 429 test-mode quota, auth, or link-config issues).
    logger.error(
      { err: e.message, statusCode: e.statusCode, rzpCode: e.error && e.error.code, rzpDesc: e.error && e.error.description },
      'createPaymentLink failed',
    );
    return pickMessage('paymentLinkFailed');
  }
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
  const delivery = await deliverPdf(session, phoneHash, { clean: paid });

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

  // --- DELIVERED: watermarked PDF sent. "pay" → create link; "edit" → edit loop. ---
  if (current === STATES.DELIVERED) {
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
  // clean version; otherwise terminal ack. ---
  if (current === STATES.PAID_COMPLETE) {
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

  // --- AWAITING_POR: pending_por accumulator (similar to projects). ---
  // Multi-bullet, multi-angle sufficiency check; commits pending to por[] when sufficient.
  if (current === STATES.AWAITING_POR) {
    if (SKIP_RE.test(trimmed)) {
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
        return data.clarification_needed;
      }
      // Sufficient — commit pending_por to por[] and advance.
      const pending = session.resume_json.pending_por;
      if (pending && (pending.role || pending.organization)) {
        session.resume_json.por = (session.resume_json.por || []).concat([pending]);
      }
      session.resume_json.pending_por = null;
      session.state = NEXT_STATE[current];
      await setSession(phoneHash, session);
      return (await tryGenerate(session, phoneFrom, phoneHash)) || pickPrompt(session.state, session);
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
  if (current === STATES.AWAITING_PROJECTS) {
    if (DONE_RE.test(trimmed) || SKIP_RE.test(trimmed)) {
      const pending = session.resume_json.pending_project;
      if (pending && Object.keys(pending).length > 0) {
        if (!session.resume_json.projects) session.resume_json.projects = [];
        session.resume_json.projects.push(pending);
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
      logger.info({ phoneHash: phoneShort, state: current, usage, enriched: !!repoEnrichment }, 'extracted');
      SECTION_CONFIG[current].merge(session.resume_json, data);
      if (data.clarification_needed) {
        // We asked a follow-up about the current project — remember it so the next
        // (terse) reply is mapped onto pending_project instead of restarting.
        session.proj_focus = session.resume_json.pending_project && session.resume_json.pending_project.name ? 'followup' : null;
        await setSession(phoneHash, session);
        return data.clarification_needed;
      }
      if (!session.resume_json.projects) session.resume_json.projects = [];
      if (session.resume_json.pending_project && session.resume_json.pending_project.name) {
        session.resume_json.projects.push(session.resume_json.pending_project);
      }
      session.resume_json.pending_project = null;
      session.proj_focus = null;
      await setSession(phoneHash, session);
      return pickMessage('projectSaved', { n: session.resume_json.projects.length });
    } catch (e) {
      // A throw here is a BACKEND failure (LLM call errored or returned
      // unparseable JSON), never a "bad user input" — that path returns the
      // LLM's own clarification_needed above. So tell the student the server
      // hiccuped, not that their (often perfectly valid) message was unclear.
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
  }

  // --- AWAITING_EXPERIENCE: dedicated handler to prevent re-asking filled slots. ---
  // The extractor already parses each message against ALL fields (role, company,
  // dates, bullets, tech_stack), and merge() accumulates across turns. The bug
  // was the LLM's free-form clarification re-asking a slot that's already filled.
  // Fix: drive hard-slot questions DETERMINISTICALLY (ask only what's empty), and
  // only defer to the LLM for bullet/impact depth — guarding against any
  // clarification that re-mentions a filled hard slot.
  if (current === STATES.AWAITING_EXPERIENCE) {
    if (SKIP_RE.test(trimmed)) {
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state, session);
    }
    let data, usage;
    try {
      // Pass the slot we asked for last turn so a terse reply ("Jan 2023 to Dec
      // 2024") gets mapped to it instead of being dropped as context-less.
      ({ data, usage } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session, focus: session.exp_focus || null }));
    } catch (e) {
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
    logger.info({ phoneHash: phoneShort, state: current, usage }, 'extracted');
    SECTION_CONFIG[current].merge(session.resume_json, data);

    const exp = (session.resume_json.experience && session.resume_json.experience[0]) || null;
    const missing = experienceHardMissing(exp);

    // 1. Hard slots still empty → ask ONLY for those, deterministically. Never
    //    re-asks a slot already filled, never relies on the LLM here. Remember
    //    which slot we're asking for so next turn's extraction can map a terse
    //    reply straight to it.
    if (missing.length > 0) {
      session.exp_focus = missing[0];
      await setSession(phoneHash, session);
      return expSlotQuestion(missing);
    }
    session.exp_focus = null;

    // 2. All hard slots present → use the LLM's clarification for bullet/impact
    //    depth, but guard it. If it re-asks a filled slot, log and substitute a
    //    deterministic impact ask instead of repeating the question.
    const bulletCount = (exp.bullets || []).length;
    if (data.clarification_needed && bulletCount < EXP_BULLET_CAP) {
      if (EXP_SLOT_REASK_RE.test(data.clarification_needed)) {
        logger.warn(
          { phoneHash: phoneShort, state: current, clar: data.clarification_needed.slice(0, 60) },
          'LLM re-asked a filled experience slot; substituting impact ask',
        );
        await setSession(phoneHash, session);
        return pickMessage('expAskImpact');
      }
      await setSession(phoneHash, session);
      return data.clarification_needed;
    }

    // 3. Sufficient (or bullet safety cap hit) → advance + generate.
    session.state = NEXT_STATE[current];
    const genReply = await tryGenerate(session, phoneFrom, phoneHash);
    await setSession(phoneHash, session);
    return genReply || pickPrompt(session.state, session);
  }

  // --- AWAITING_CERTS: dedicated handler with a deterministic link follow-up. ---
  // A cert without a verification URL is a dangling, unverifiable claim. The LLM
  // instruction asks for the link but isn't reliable (it sometimes accepts a
  // bare name silently), so we backstop it: if a cert arrives without a URL and
  // the student didn't decline, ask ONCE for the link with a clear skip fallback.
  if (current === STATES.AWAITING_CERTS) {
    // Resolve a link we asked for on the previous turn.
    if (session.cert_link_pending) {
      session.cert_link_pending = false;
      if (!SKIP_RE.test(trimmed) && !NOLINK_RE.test(trimmed)) {
        const m = trimmed.match(URL_IN_TEXT_RE);
        const target = (session.resume_json.certifications || []).find((c) => c && !c.url);
        if (m && target) target.url = m[0];
      }
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state, session);
    }

    if (SKIP_RE.test(trimmed)) {
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state, session);
    }

    let data, usage;
    try {
      ({ data, usage } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session }));
    } catch (e) {
      logger.error({ err: e.message, status: e.status, code: e.code, state: current, bodyLen: trimmed.length }, 'extract failed');
      return pickMessage('serverError');
    }
    logger.info({ phoneHash: phoneShort, state: current, usage }, 'extracted');
    SECTION_CONFIG[current].merge(session.resume_json, data);

    // Deterministic guard: first cert with a name but no URL, and the student
    // didn't decline → ask once for the link. Skip-friendly for the many real
    // professional certs (Bar Council, CA, etc.) without a public verify URL.
    const missingLink = (session.resume_json.certifications || []).find((c) => c && c.name && !c.url);
    if (missingLink && !NOLINK_RE.test(trimmed)) {
      session.cert_link_pending = true;
      await setSession(phoneHash, session);
      return `Got it — '${missingLink.name}'. Verification link bhej dijiye (Coursera / NPTEL / official URL)? 'skip' agar nahi hai.`;
    }

    if (data.clarification_needed) {
      await setSession(phoneHash, session);
      return data.clarification_needed;
    }

    session.state = NEXT_STATE[current];
    const genReply = await tryGenerate(session, phoneFrom, phoneHash);
    await setSession(phoneHash, session);
    return genReply || pickPrompt(session.state, session);
  }

  // --- General Phase 2 collection. ---
  if (PHASE_2_STATES.has(current)) {
    const optional = OPTIONAL_STATES.has(current);
    if (SKIP_RE.test(trimmed) && optional) {
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
        return data.clarification_needed;
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
