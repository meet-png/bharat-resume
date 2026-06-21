// State machine. PRD §6, §18 Day 2-3.
const { STATES, NEXT_STATE, OPTIONAL_STATES, PHASE_2_STATES } = require('./states');
const { pickPrompt, pickMessage } = require('./prompts');
const { extractSection, SECTION_CONFIG } = require('../llm/extract');
const { runGeneration, buildPreview } = require('./generator');
const { deliverPdf } = require('./delivery');
const { getSession, setSession, checkRateLimit, RATELIMIT_MAX } = require('../store/redis');
const logger = require('../logger');

const SKIP_RE = /^\s*(skip|no|nahi|nahin|nope|none|nothing|na|n\/a|kuch nahi|no thanks)\s*$/i;
const DONE_RE = /^\s*(done|finish|finished|bas|over|complete)\s*$/i;
const YES_RE = /^\s*(haan|han|yes|y|ready|chalo|chaliye|let'?s go|start|sure|ok|okay|yup|yeah)\s*$/i;
const JD_GENERIC_RE = /^\s*(no specific role|no specific|no role|generic|any role|any job|don'?t have|nothing specific|skip|no|nahi|nope|none|nothing)\s*$/i;
const JD_MARKER_RE = /\b(responsibilit|requirement|qualification|years? of experience|must have|nice to have|we are looking|about (the )?role|about us|key skills|preferred|location:|experience:|salary|stipend|ctc|notice period)/i;
const URL_RE = /^https?:\/\//i;
const SHOW_RE = /^\s*show\s*me\s*$/i;
const RESET_RE = /^\s*reset\s*$/i;

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
    razorpay_payment_link_id: null,
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
    const delivery = await deliverPdf(session, phoneHash, { clean: false });
    session.state = STATES.DELIVERED;
    const text = buildPreview(session);
    if (delivery && delivery.signedUrl) {
      return { text: text + '\n\n📎 Watermarked PDF attached. Day 5: ₹49 unlock for clean ATS-readable version.', media: delivery.signedUrl };
    }
    return text + '\n\n(PDF delivery failed — preview only. Check server logs.)';
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'generation pipeline failed');
    return pickMessage('generationFailed');
  }
}

async function handle({ phoneHash, body, phoneFrom }) {
  const trimmed = String(body || '').trim();
  if (!phoneHash) throw new Error('handle: phoneHash required');

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
    return pickPrompt(STATES.NEW);
  }

  session.last_message_at = new Date().toISOString();

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

  // --- DELIVERED: post-generation. show me handled above; edits land Day 5. ---
  if (current === STATES.DELIVERED) {
    return pickMessage('deliveredHelp');
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
      return pickMessage('jdGenericAck') + '\n\n' + pickPrompt(session.state);
    }
    const kind = classifyJdInput(trimmed);
    if (kind === 'url')       { session.jd_url = trimmed; session.jd_text = null; session.jd_role = null; }
    else if (kind === 'role') { session.jd_role = trimmed; session.jd_url = null; session.jd_text = null; }
    else                       { session.jd_text = trimmed; session.jd_url = null; session.jd_role = null; }
    session.jd_generic = false;
    session.state = NEXT_STATE[current];
    await setSession(phoneHash, session);
    const ack = kind === 'role' ? pickMessage('jdRoleAck', { role: trimmed }) + '\n\n' : '';
    return ack + pickPrompt(session.state);
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
      return (await tryGenerate(session, phoneFrom, phoneHash)) || pickPrompt(session.state);
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
      return (await tryGenerate(session, phoneFrom, phoneHash)) || pickPrompt(session.state);
    } catch (e) {
      logger.error({ err: e.message, state: current }, 'extract failed');
      return pickMessage('extractFail');
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
      session.state = NEXT_STATE[current];
      await setSession(phoneHash, session);
      return pickPrompt(session.state);
    }
    try {
      const { data, usage, repoEnrichment } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session });
      logger.info({ phoneHash: phoneShort, state: current, usage, enriched: !!repoEnrichment }, 'extracted');
      SECTION_CONFIG[current].merge(session.resume_json, data);
      if (data.clarification_needed) {
        await setSession(phoneHash, session);
        return data.clarification_needed;
      }
      if (!session.resume_json.projects) session.resume_json.projects = [];
      if (session.resume_json.pending_project && session.resume_json.pending_project.name) {
        session.resume_json.projects.push(session.resume_json.pending_project);
      }
      session.resume_json.pending_project = null;
      await setSession(phoneHash, session);
      return pickMessage('projectSaved', { n: session.resume_json.projects.length });
    } catch (e) {
      logger.error({ err: e.message, state: current }, 'extract failed');
      return pickMessage('extractFail');
    }
  }

  // --- General Phase 2 collection. ---
  if (PHASE_2_STATES.has(current)) {
    const optional = OPTIONAL_STATES.has(current);
    if (SKIP_RE.test(trimmed) && optional) {
      session.state = NEXT_STATE[current];
      const genReply = await tryGenerate(session, phoneFrom, phoneHash);
      await setSession(phoneHash, session);
      return genReply || pickPrompt(session.state);
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
      return genReply || pickPrompt(session.state);
    } catch (e) {
      logger.error({ err: e.message, state: current }, 'extract failed');
      return pickMessage('extractFail');
    }
  }

  // --- Fallthrough: Day 5+ scope (payment etc.). ---
  logger.warn({ phoneHash: phoneShort, state: current, body: trimmed.slice(0, 40) }, 'router.handle fellthrough');
  return pickMessage('beyondPhase2');
}

module.exports = { handle, newSession };
