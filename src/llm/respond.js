// Hybrid LLM-Reply layer. See docs/HYBRID-REPLY-SPEC.md.
//
// Job: produce ONE outbound message text given (state, resume_json, last student
// message, decision). The extractor (extract.js) handles "what did the student
// say"; this module handles "what do we say next" — state-aware, role-aware,
// and unable to re-ask a filled field by construction.
//
// Failure-safe by design: any LLM error, JSON-parse failure, sanity-gate
// rejection, or invalid output causes a SILENT fallback to the caller-supplied
// canned text. The student never sees a sanity failure.
//
// This module is dormant when config.HYBRID_REPLY is false — the router's
// composeReply() helper checks the flag and skips this module entirely.

const { complete } = require('./client');
const { config } = require('../config');
const logger = require('../logger');

const HARD_CHAR_CAP = 600;

// Pre-built per-field re-ask regexes. If the LLM tries to re-ask a field that
// is already filled in resume_json, we trip a sanity failure and fall back.
// Patterns are conservative on purpose — they target the field NAMED as a
// question, not every mention of the word.
const FIELD_REASK_RE = {
  name:     /\b(your\s+(full\s+)?name|full\s+name|naam\s+(kya|batay|share)|aapka\s+naam)\b/i,
  email:    /\b(your\s+email|email\s+(id|address)|email\s+kya|email\s+share|drop\s+your\s+email|share\s+your\s+email)\b/i,
  linkedin: /\b(your\s+linkedin|linkedin\s+(url|link|profile)|linkedin\s+kya|share\s+your\s+linkedin|linkedin\s+ka\s+link)\b/i,
  github:   /\b(your\s+github|github\s+(url|link|profile)|github\s+kya|share\s+your\s+github|github\s+ka\s+link)\b/i,
  cgpa:     /\b(your\s+cgpa|cgpa\s+(kya|share|batay)|percentage\s+(kya|share|batay)|academic\s+score)\b/i,
};

// Whitelist of multi-digit runs that may legitimately appear in a reply even
// when not in input: bot-product constants and time/length conventions.
// Kept SHORT so any new number sneaking in trips fallback.
const NUMBER_WHITELIST = new Set([
  '10', '30', '60',     // typical time hints: 10 minutes, 30s wait, 60s retry
  '49',                 // ₹49 unlock price
  '600',                // char cap reference, occasional
]);

// Latin-only check — project rule: Hinglish in Roman letters only.
const DEVANAGARI_RE = /[ऀ-ॿ]/;

// ---------------------------------------------------------------------------
// SYSTEM PROMPT — kept as a stable string for prompt-cache hits.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Saathi, the BHARAT RESUME WhatsApp bot. You are talking to an Indian college student who is filling out their resume one section at a time. Your job is to write ONE short, warm, role-aware outbound message in response to the student's last turn.

THE STATE MACHINE IS THE SPINE. You do NOT decide section transitions — the router has already decided. Your job is the conversational surface: ask, acknowledge, transition, loop.

================ ABSOLUTE RULES (violations = your reply will be discarded) ================
1. NEVER invent a fact. No number, date, name, organization, role, percentage, score, or specific outcome may appear in your reply unless it is present in the input under STUDENT_JUST_SAID or RESUME_JSON. If the student said "led a team" with no number, you may NOT say "team of 50" — you must ASK for the number.
2. NEVER write a draft bullet for the student to approve ("Here's your bullet: ... sound right?"). Ask for the facts; the rewriter will phrase them later.
3. NEVER claim verification ("I checked your repo", "verified", "confirmed").
4. NEVER ask for a field that is already filled in RESUME_JSON. If name is present, do not ask for name. If email is present, do not ask for email. Look at every field before writing.
5. NEVER use Devanagari script. Hinglish must be in Roman/Latin letters only (e.g., "kya kiya tha" not "क्या किया था").
6. NEVER exceed 600 characters total. Mobile WhatsApp message. 2-4 short lines ideal.
7. NEVER add any payment, pricing, or refund language. The router handles payment states.

================ ALLOWED BEHAVIORS ================
- Ask a role-aware follow-up question. If the student is targeting "Data Engineer" you may say "pipelines you built? throughput? data volume?" — these are CATEGORIES of facts (not specific numbers) appropriate to that role.
- Acknowledge what the student JUST said by echoing their own words ("Marketing Intern at Acme ✓").
- Confirm a transition: "Onto projects now — share one at a time."
- Offer multi-entry loop wording: "agla project bhejo, ya 'done' likho."
- Suggest a CATEGORY of fact the student might add ("Any budget you handled? Sponsorship secured? Flagship event?"). Categories — not specific numbers.
- Mention the count of items already saved when it's contextually useful ("2 projects saved ✓"). The count comes from RESUME_JSON.

================ ROLE-AWARENESS ================
You will receive SESSION_FLAGS.jd_role (e.g. "Data Engineer", "MUN Secretary", "Marketing Intern"). Tailor your follow-up questions to what THAT role typically involves:
- MUN / Debate Sec-Gen: team size, events organized, sponsorship, budget, delegates.
- Marketing / Growth: signups, conversion %, reach, CAC, A/B tests.
- Data Engineer / Analyst: data volume, query latency, throughput, dashboards used.
- Software / Backend: latency, users, deployment cadence, system reliability.
- Sales / BD: deal size, accounts, revenue, conversion.
You are using role knowledge to ask BETTER QUESTIONS — never to inject specific numbers.

================ DECISION-SPECIFIC GUIDANCE ================
You receive DECISION as a hint about what kind of reply fits:
- "advance"            → previous section was completed; acknowledge briefly + ask the next section's question.
- "still_missing"      → section incomplete; ask role-aware question for the MISSING fields only.
- "loop_more"          → multi-entry section sufficient; ask "another, or done?".
- "ack_save"           → section complete; acknowledge the save and confirm next move.
- "skip_ack"           → student skipped an optional section; light ack + next ask.
- "confirm_start"      → first greeting after "yes"/"haan" to begin.

================ OUTPUT FORMAT ================
Return STRICT JSON with exactly these two fields:
{
  "reply":     "<the message to send to the student>",
  "voice_tag": "<one of: ask_impact, ask_link, ask_basics, ack_save, loop_more_entry, confirm_transition, role_followup, skip_ack, confirm_start, reset_ack, fallback_safe>"
}

No prose outside the JSON. No markdown fences. Reply must be ≤ 600 chars.`;

// ---------------------------------------------------------------------------
// Sanity gates — runs on EVERY respond() reply before send. Pure functions,
// testable in isolation (exported for .runtime/test-respond.js).
// ---------------------------------------------------------------------------

// Collect every multi-digit run from a string (length ≥ 2).
function multiDigitRuns(s) {
  if (!s) return [];
  return (String(s).match(/\d{2,}/g) || []);
}

// Build the corpus of strings the LLM is "allowed" to derive numbers from.
function allowedNumberCorpus(studentLast, resumeJson) {
  const parts = [String(studentLast || '')];
  try { parts.push(JSON.stringify(resumeJson || {})); } catch { /* ignore */ }
  return parts.join(' ');
}

// Check: every digit-run ≥ 2 in `reply` must appear as substring of corpus
// OR be on the small whitelist. Returns null on OK, string reason on fail.
function checkNoFabricatedDigits(reply, studentLast, resumeJson) {
  const corpus = allowedNumberCorpus(studentLast, resumeJson);
  const runs = multiDigitRuns(reply);
  for (const run of runs) {
    if (NUMBER_WHITELIST.has(run)) continue;
    if (corpus.includes(run)) continue;
    return `fabricated_digit:${run}`;
  }
  return null;
}

// Check: reply must not re-ask any field that is already filled.
function checkNoReaskOfFilled(reply, resumeJson) {
  const rj = resumeJson || {};
  for (const [field, re] of Object.entries(FIELD_REASK_RE)) {
    if (!rj[field]) continue;
    if (re.test(reply)) return `reask_filled:${field}`;
  }
  return null;
}

function checkLatinOnly(reply) {
  if (DEVANAGARI_RE.test(reply)) return 'devanagari';
  return null;
}

function checkLength(reply) {
  if (!reply || typeof reply !== 'string') return 'empty_reply';
  if (reply.length > HARD_CHAR_CAP) return `too_long:${reply.length}`;
  return null;
}

// Run all gates; return null on OK, string reason on first fail.
function runSanityGates(reply, { studentLast, resumeJson }) {
  return (
    checkLength(reply) ||
    checkLatinOnly(reply) ||
    checkNoFabricatedDigits(reply, studentLast, resumeJson) ||
    checkNoReaskOfFilled(reply, resumeJson) ||
    null
  );
}

// ---------------------------------------------------------------------------
// Public: respond()
//
// Returns { reply, voice_tag, used_llm } on success, or { used_llm: false }
// on any failure (caller falls back to canned text). Never throws — all
// failures are absorbed into the fallback path.
// ---------------------------------------------------------------------------
async function respond(args) {
  const {
    state, prev_state, resume_json, student_last, decision,
    missing, session_flags, history,
  } = args || {};

  if (!state || !student_last) return { used_llm: false, reason: 'bad_args' };

  // Trim resume_json to the fields a reply layer actually needs to know about.
  // We intentionally include EVERY top-level filled field so the no-reask gate
  // can detect "this field is already known".
  const rjForLlm = trimResumeForLlm(resume_json || {});

  const userPrompt = JSON.stringify({
    state,
    prev_state: prev_state || null,
    decision: decision || 'still_missing',
    missing: Array.isArray(missing) ? missing.slice(0, 8) : [],
    session_flags: session_flags || {},
    resume_json: rjForLlm,
    student_just_said: String(student_last).slice(0, 800),
    history: Array.isArray(history) ? history.slice(-4) : [],
  });

  let data;
  try {
    const res = await complete({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      temperature: 0.4,
      maxTokens: 250,
    });
    data = res.data;
  } catch (e) {
    logger.warn({ err: e.message, state, decision }, 'respond.llm_failed — falling back');
    return { used_llm: false, reason: 'llm_failed' };
  }

  const reply = data && typeof data.reply === 'string' ? data.reply.trim() : '';
  const voiceTag = data && typeof data.voice_tag === 'string' ? data.voice_tag : 'unknown';

  const sanityFail = runSanityGates(reply, { studentLast: student_last, resumeJson: resume_json || {} });
  if (sanityFail) {
    logger.warn({ state, decision, voiceTag, reason: sanityFail, replyHead: reply.slice(0, 80) }, 'respond.sanity_fail — falling back');
    return { used_llm: false, reason: `sanity:${sanityFail}` };
  }

  return { used_llm: true, reply, voice_tag: voiceTag };
}

// Strip session-internal flags and large fields the LLM doesn't need; keep
// every top-level value that names a filled field so the no-reask check works.
function trimResumeForLlm(rj) {
  const out = {};
  const PASS_THROUGH = [
    'name', 'email', 'phone', 'linkedin', 'github',
    'coding_profiles', 'education', 'cgpa', 'skills',
    'coursework', 'achievements',
  ];
  for (const k of PASS_THROUGH) {
    if (rj[k] != null && rj[k] !== '') out[k] = rj[k];
  }
  // Arrays — pass shape (count + recent entries) without ballooning the prompt.
  for (const k of ['experience', 'projects', 'por', 'certifications']) {
    if (Array.isArray(rj[k]) && rj[k].length) {
      out[k] = rj[k].slice(-3); // last 3 entries are most contextually relevant
      out[`${k}_count`] = rj[k].length;
    }
  }
  // pending_* slots — these are what the student is mid-filling.
  if (rj.pending_project) out.pending_project = rj.pending_project;
  if (rj.pending_por) out.pending_por = rj.pending_por;
  return out;
}

module.exports = {
  respond,
  runSanityGates,
  // exposed for unit tests:
  checkLength,
  checkLatinOnly,
  checkNoFabricatedDigits,
  checkNoReaskOfFilled,
  HARD_CHAR_CAP,
  SYSTEM_PROMPT,
};
