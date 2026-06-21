// State machine. PRD §6, §18 Day 2.
// Loads Redis session, applies rate limit, routes by state, calls LLM extract,
// transitions, persists, returns the next prompt.
const { STATES, NEXT_STATE, OPTIONAL_STATES, PHASE_2_STATES } = require('./states');
const { pickPrompt, pickMessage } = require('./prompts');
const { extractSection, SECTION_CONFIG } = require('../llm/extract');
const { getSession, setSession, checkRateLimit, RATELIMIT_MAX } = require('../store/redis');
const logger = require('../logger');

// SKIP_RE covers all common negatives so the bot never gets stuck on a "no" answer.
// Previously achievements + others looped because only the literal word "skip" advanced.
const SKIP_RE = /^\s*(skip|no|nahi|nahin|nope|none|nothing|na|n\/a|kuch nahi|no thanks)\s*$/i;
const DONE_RE = /^\s*(done|finish|finished|bas|over|complete)\s*$/i;
const YES_RE = /^\s*(haan|han|yes|y|ready|chalo|chaliye|let'?s go|start|sure|ok|okay|yup|yeah)\s*$/i;
// AWAITING_JD: explicit generic-mode triggers + SKIP_RE equivalents — student
// who has no target role still gets a resume (Decisions log 2026-06-21).
const JD_GENERIC_RE = /^\s*(no specific role|no specific|no role|generic|any role|any job|don'?t have|nothing specific|skip|no|nahi|nope|none|nothing)\s*$/i;
// Heuristic markers that a chunk of text is a real JD (not just a role name).
const JD_MARKER_RE = /\b(responsibilit|requirement|qualification|years? of experience|must have|nice to have|we are looking|about (the )?role|about us|key skills|preferred|location:|experience:|salary|stipend|ctc|notice period)/i;
const URL_RE = /^https?:\/\//i;

// Classify AWAITING_JD input: 'url' (Naukri/etc.), 'jd' (full JD text), or
// 'role' (just the role name). Heuristic only — no LLM call, no latency, no $.
function classifyJdInput(text) {
  const t = String(text || '').trim();
  if (URL_RE.test(t)) return 'url';
  if (t.length > 200) return 'jd';
  if (t.includes('\n')) return 'jd';
  if (JD_MARKER_RE.test(t)) return 'jd';
  if ((t.match(/,/g) || []).length > 4) return 'jd';
  // Short, single-line, no JD markers, few commas → likely a role name.
  return 'role';
}
const SHOW_RE = /^\s*show\s*me\s*$/i;
const RESET_RE = /^\s*reset\s*$/i;

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

async function handle({ phoneHash, body }) {
  const trimmed = String(body || '').trim();
  if (!phoneHash) throw new Error('handle: phoneHash required');

  const phoneShort = phoneHash.slice(0, 12);
  logger.info({ phoneHash: phoneShort, bodyLen: trimmed.length, bodyHead: trimmed.slice(0, 30) }, 'router.handle inbound');

  // Rate limit (PRD §13.3).
  const rl = await checkRateLimit(phoneHash);
  if (!rl.allowed) {
    logger.info({ phoneHash: phoneShort, branch: 'rateLimit', resetInSec: rl.resetInSec }, 'router.handle branch');
    return pickMessage('rateLimit', { sec: rl.resetInSec });
  }

  // RESET: wipe + seed AWAITING_CONFIRM_START, reply combines confirmation + welcome.
  if (RESET_RE.test(trimmed)) {
    const fresh = newSession();
    fresh.state = STATES.AWAITING_CONFIRM_START;
    await setSession(phoneHash, fresh);
    logger.info({ phoneHash: phoneShort, branch: 'reset' }, 'router.handle branch');
    return pickMessage('reset') + '\n\n' + pickPrompt(STATES.NEW);
  }

  let session = await getSession(phoneHash);
  if (!session) {
    session = newSession();
    session.state = STATES.AWAITING_CONFIRM_START;
    await setSession(phoneHash, session);
    logger.info({ phoneHash: phoneShort, branch: 'newSession' }, 'router.handle branch');
    return pickPrompt(STATES.NEW);
  }

  session.last_message_at = new Date().toISOString();

  if (SHOW_RE.test(trimmed)) {
    logger.info({ phoneHash: phoneShort, branch: 'showMe' }, 'router.handle branch');
    const dump = JSON.stringify({
      state: session.state,
      resume_json: session.resume_json,
      jd_url: session.jd_url,
      jd_text: session.jd_text ? `(${session.jd_text.length} chars)` : null,
      jd_generic: session.jd_generic,
    }, null, 2);
    return dump.length > 1400 ? dump.slice(0, 1400) + '\n...(truncated)' : dump;
  }

  const current = session.state;
  logger.info({ phoneHash: phoneShort, state: current }, 'router.handle state');

  // --- Phase 1: confirm start. NEW + AWAITING_CONFIRM_START handled together. ---
  if (current === STATES.NEW || current === STATES.AWAITING_CONFIRM_START) {
    if (YES_RE.test(trimmed)) {
      session.state = STATES.AWAITING_NAME;
      await setSession(phoneHash, session);
      logger.info({ phoneHash: phoneShort, branch: 'confirmStart→AWAITING_NAME' }, 'router.handle branch');
      return pickPrompt(STATES.AWAITING_NAME);
    }
    logger.info({ phoneHash: phoneShort, branch: 'confirmStart-stay' }, 'router.handle branch');
    return pickPrompt(STATES.AWAITING_CONFIRM_START);
  }

  // --- AWAITING_JD: four paths — generic, URL, role-name only, or full JD text. ---
  if (current === STATES.AWAITING_JD) {
    if (JD_GENERIC_RE.test(trimmed)) {
      session.jd_text = null;
      session.jd_url = null;
      session.jd_role = null;
      session.jd_generic = true;
      session.state = NEXT_STATE[current];
      await setSession(phoneHash, session);
      logger.info({ phoneHash: phoneShort, branch: 'AWAITING_JD→generic' }, 'router.handle branch');
      return pickMessage('jdGenericAck') + '\n\n' + pickPrompt(session.state);
    }

    const kind = classifyJdInput(trimmed);
    if (kind === 'url') {
      session.jd_url = trimmed; session.jd_text = null; session.jd_role = null;
    } else if (kind === 'role') {
      session.jd_role = trimmed; session.jd_url = null; session.jd_text = null;
    } else {
      session.jd_text = trimmed; session.jd_url = null; session.jd_role = null;
    }
    session.jd_generic = false;
    session.state = NEXT_STATE[current];
    await setSession(phoneHash, session);
    logger.info({ phoneHash: phoneShort, branch: `AWAITING_JD→${kind}` }, 'router.handle branch');

    const ack = kind === 'role'
      ? pickMessage('jdRoleAck', { role: trimmed }) + '\n\n'
      : '';
    return ack + pickPrompt(session.state);
  }

  // --- AWAITING_PROJECTS: pending_project accumulates across turns; commit when
  // the LLM signals sufficient, or finalize on done/skip. ---
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
      logger.info({ phoneHash: phoneShort, branch: 'AWAITING_PROJECTS→done', count: session.resume_json.projects.length }, 'router.handle branch');
      return pickPrompt(session.state);
    }
    try {
      const { data, usage, repoEnrichment } = await extractSection({ state: current, body: trimmed, resumeJson: session.resume_json, session });
      logger.info({ phoneHash: phoneShort, state: current, usage, enriched: !!repoEnrichment }, 'extracted');

      // Always merge (preserves data across clarification turns).
      SECTION_CONFIG[current].merge(session.resume_json, data);

      if (data.clarification_needed) {
        await setSession(phoneHash, session);
        return data.clarification_needed;
      }

      // Project is sufficient — commit pending to projects[], clear.
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

  // --- General Phase 2 collection. Always merge what extract returned so
  // partial data survives clarification turns; only advance on null clarification. ---
  if (PHASE_2_STATES.has(current)) {
    const optional = OPTIONAL_STATES.has(current);
    if (SKIP_RE.test(trimmed) && optional) {
      session.state = NEXT_STATE[current];
      await setSession(phoneHash, session);
      logger.info({ phoneHash: phoneShort, branch: `${current}→skip` }, 'router.handle branch');
      return reachedGeneratingReply(session) || pickPrompt(session.state);
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
      await setSession(phoneHash, session);
      return reachedGeneratingReply(session) || pickPrompt(session.state);
    } catch (e) {
      logger.error({ err: e.message, state: current }, 'extract failed');
      return pickMessage('extractFail');
    }
  }

  // --- Beyond Phase 2: Day 3+ scope. ---
  logger.warn({ phoneHash: phoneShort, state: current, body: trimmed.slice(0, 40) }, 'router.handle fellthrough to beyondPhase2');
  return pickMessage('beyondPhase2');
}

function reachedGeneratingReply(session) {
  if (session.state !== STATES.GENERATING) return null;
  return pickMessage('generatingDone');
}

module.exports = { handle, newSession };
