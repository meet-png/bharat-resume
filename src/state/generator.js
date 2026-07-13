// GENERATING-state orchestrator. PRD §5 Phase 3 — upgraded 2026-07-13 to
// a MULTI-AGENT pipeline:
//
//   [Optional] Naukri JD scrape           → jd_text
//   Stage A     JD Intelligence agent      → { role_noun, domain, key_responsibilities, top_prioritized_skills, keywords, experience_level }
//   Stage B     Body rewrite (Pass 1)      → skills, experience, projects, PoR, achievements, certs (NO summary)
//                                             — consumes per-project readme_excerpt for deeper bullet mining.
//                                             — reorders skills by JD priority.
//   Stage C     Summary rewrite (Pass 2)   → opens with JD role_noun, leads with the strongest body fact
//                                             aligned to THAT role's angle.
//   Stage D     Deterministic ATS scoring  → ats_score + baseline suggestions.
//   Stage E     LLM ATS Reviewer agent     → contextual suggestions (missing keywords, generic verbs, thin bullets).
//                                             Merged with Stage D suggestions.
//
// Stage A runs in PARALLEL with the JD scrape completing (no dependency chain).
// Stage B waits for Stage A (needs the JD profile). Stage C waits for Stage B
// (needs the polished body). Stage E can run parallel with Stage D. Realistic
// end-to-end latency 15-22s on Railway — well under the 60s async webhook budget.
const { scrapeNaukri } = require('../jd/scrape');
const { extractKeywords } = require('../llm/keywords');
const { rewriteBody, rewriteSummary } = require('../llm/rewrite');
const { reviewResume } = require('../llm/review');
const { scoreResume, suggestionsFor } = require('../resume/ats_score');
const logger = require('../logger');

function withTimeout(promise, ms, fallback, label) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      logger.warn({ label, ms }, 'generation step timed out');
      resolve(fallback);
    }, ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }).catch((e) => {
      clearTimeout(t);
      logger.warn({ label, err: e.message }, 'generation step error');
      resolve(fallback);
    });
  });
}

async function runGeneration(session, phoneFrom) {
  const t0 = Date.now();
  const timings = {};

  // ─────── Stage 0: JD scrape (if URL, and not already scraped) ───────
  if (session.jd_url && !session.jd_text) {
    const tScrape = Date.now();
    // 15s scrape budget: live-test 2026-07-13 showed the Naukri scraper
    // finishing at ~13.5s on a first cold-run selector cascade (`[class*="jd-container"]`).
    // The old 10s cap fired just before a successful scrape, forcing the rewriter
    // to run on jd_role alone and losing the full JD text. 15s is comfortable
    // under the async webhook budget and dramatically upgrades JD-intel quality.
    const scraped = await withTimeout(scrapeNaukri(session.jd_url), 15000, null, 'scrape');
    timings.scrape_ms = Date.now() - tScrape;
    if (scraped) session.jd_text = scraped;
    else logger.warn({ url: session.jd_url }, 'JD scrape returned empty — rewriter will run on jd_role/generic path only');
  }

  // ─────── Stage A: JD Intelligence agent ───────
  // Produces role_noun, domain, key_responsibilities, top_prioritized_skills,
  // full keyword list, and experience_level. Every downstream stage consumes
  // this profile — one intelligence pass, many specialized consumers.
  const tIntel = Date.now();
  const jdIntel = await withTimeout(
    extractKeywords({ jdText: session.jd_text, jdRole: session.jd_role, jdGeneric: session.jd_generic }),
    12000,
    { keywords: [], role_noun: session.jd_role || 'candidate', role_title: 'unknown', domain: 'generic', experience_level: 'fresher', key_responsibilities: [], top_prioritized_skills: [] },
    'jd_intel'
  );
  timings.jd_intel_ms = Date.now() - tIntel;
  session.jd_keywords = jdIntel.keywords || [];
  session.jd_role_noun = jdIntel.role_noun;
  session.jd_role_title = jdIntel.role_title;
  session.jd_domain = jdIntel.domain;
  session.jd_experience_level = jdIntel.experience_level;
  session.jd_key_responsibilities = jdIntel.key_responsibilities || [];
  session.jd_top_prioritized_skills = jdIntel.top_prioritized_skills || [];

  // ─────── Stage B: Body rewrite (Pass 1) ───────
  // Rewrites every section EXCEPT the summary. Consumes per-project
  // readme_excerpt (persisted by router.js on the pending_project during the
  // AWAITING_PROJECTS turn) for deeper bullet mining. Reorders skills by
  // jdIntel.top_prioritized_skills. Timeout budget is generous — Meta webhook
  // is async since 2026-06-22, so a 30s rewrite is fine end-to-end.
  const tBody = Date.now();
  const bodyRes = await withTimeout(
    rewriteBody({
      resumeJson: session.resume_json,
      jdIntel,
      jdRole: session.jd_role,
      jdText: session.jd_text,
      jdKeywords: jdIntel.keywords || [],
      jdGeneric: session.jd_generic,
      phoneFrom,
    }),
    60000,
    { data: null, usage: null },
    'rewrite_body'
  );
  timings.rewrite_body_ms = Date.now() - tBody;
  if (!bodyRes.data) {
    logger.error({ bodyMs: timings.rewrite_body_ms }, 'body rewrite returned null data — resume cannot be generated this run');
    session.resume_json_rewritten = null;
    timings.total_ms = Date.now() - t0;
    logger.info({ timings }, 'generation complete (body failure)');
    return session;
  }

  // ─────── Stage C: Summary rewrite (Pass 2) ───────
  // Takes the polished body + JD intel. Opens with the JD's role_noun.
  // Failure here is graceful: keep the empty summary and log — the resume
  // still delivers, just without a summary section.
  const tSum = Date.now();
  const sumRes = await withTimeout(
    rewriteSummary({
      body: bodyRes.data,
      jdIntel,
      jdText: session.jd_text,
      jdRole: session.jd_role,
      jdGeneric: session.jd_generic,
      rawResume: session.resume_json,
    }),
    30000,
    { data: { summary: '' }, usage: null },
    'rewrite_summary'
  );
  timings.rewrite_summary_ms = Date.now() - tSum;
  bodyRes.data.summary = (sumRes.data && sumRes.data.summary) || '';
  session.resume_json_rewritten = bodyRes.data;
  session.rewrite_usage = bodyRes.usage;
  session.summary_usage = sumRes.usage;

  // ─────── Stage D: Deterministic ATS scoring ───────
  const tAts = Date.now();
  const scored = scoreResume(session.resume_json_rewritten, session.jd_keywords);
  session.ats_score = scored.total;
  session.ats_breakdown = scored;
  const deterministicSuggestions = suggestionsFor(scored);
  timings.ats_ms = Date.now() - tAts;

  // ─────── Stage E: LLM Reviewer agent ───────
  // Contextual suggestions that the deterministic scorer can't produce
  // (JD-specific missing keywords the student COULD honestly include, generic
  // verbs, bullets thin on metrics). Runs in parallel to nothing — Stage D is
  // synchronous and fast; Stage E is the last LLM call. Failure is graceful
  // (fall back to deterministic suggestions).
  const tRev = Date.now();
  const review = await withTimeout(
    reviewResume({
      rewritten: session.resume_json_rewritten,
      jdIntel,
      rawResume: session.resume_json,
    }),
    20000,
    { suggestions: [], interview_topics: [] },
    'review'
  );
  timings.review_ms = Date.now() - tRev;
  const llmSuggestions = Array.isArray(review.suggestions) ? review.suggestions : [];
  session.interview_topics = Array.isArray(review.interview_topics) ? review.interview_topics : [];
  // Merge: LLM suggestions first (more actionable), then deterministic ones the
  // LLM didn't already cover. Cap at 5 total so preview stays scannable.
  const seen = new Set(llmSuggestions.map((s) => String(s).toLowerCase().slice(0, 40)));
  const merged = [...llmSuggestions];
  for (const s of deterministicSuggestions) {
    const k = String(s).toLowerCase().slice(0, 40);
    if (!seen.has(k) && merged.length < 5) { merged.push(s); seen.add(k); }
  }
  session.ats_suggestions = merged;

  timings.total_ms = Date.now() - t0;
  logger.info({
    timings,
    kwCount: session.jd_keywords.length,
    roleNoun: session.jd_role_noun,
    atsScore: session.ats_score,
    llmSuggestionCount: llmSuggestions.length,
    projectsWithReadme: (session.resume_json.projects || []).filter((p) => p && p.readme_excerpt).length,
  }, 'multi-agent generation complete');
  return session;
}

// Convert markdown-bold (**foo**) to WhatsApp-bold (*foo*) for the preview.
// The actual stored bullets keep ** so the Day 4 HTML template can render <strong>.
function whatsappBold(s) {
  return String(s || '').replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
}

// Collect every concrete skill the student actually has — across categorized
// skills buckets AND project tech_stacks. Used to compute REAL JD matches.
function collectActualSkills(resume) {
  const set = new Set();
  const add = (s) => { if (s && typeof s === 'string') set.add(s.toLowerCase().trim()); };
  for (const cat of (Array.isArray(resume?.skills) ? resume.skills : [])) {
    for (const item of (cat?.items || [])) add(item);
  }
  for (const p of (resume?.projects || [])) {
    for (const t of (p.tech_stack || [])) add(t);
  }
  for (const e of (resume?.experience || [])) {
    for (const t of (e.tech_stack || [])) add(t);
  }
  return set;
}

// Intersection of student's actual skills and the JD keyword list.
// For short keywords (≤2 chars like "R", "Go", "C") require EXACT match —
// substring match would let "R" match "Power BI" because of the letter R.
// For 3+ char keywords, substring works in either direction ("Node" ↔ "Node.js").
function keywordsMatched(resume, jdKeywords) {
  if (!Array.isArray(jdKeywords) || jdKeywords.length === 0) return [];
  const skills = collectActualSkills(resume);
  if (skills.size === 0) return [];
  const matched = [];
  for (const kw of jdKeywords) {
    const k = String(kw).toLowerCase().trim();
    if (!k) continue;
    for (const s of skills) {
      if (s === k) { matched.push(kw); break; }
      if (k.length >= 3 && s.length >= 3 && (s.includes(k) || k.includes(s))) {
        matched.push(kw); break;
      }
    }
  }
  return matched;
}

// Lean preview for WhatsApp — deliberately omits all copyable content
// (summary, bullets, project descriptions, rewritten skills) per Meet's
// product call 2026-06-21 (see PROGRESS Decisions log). The PDF is the
// only surface where the work is visible; this caption is the CTA.
//
// What we DO surface (none of it copy-pasteable as a usable resume):
//   • Student's own name (they typed it; not a leak)
//   • ATS score for the targeted role (numeric only — no copyable text)
//   • Count of matched JD keywords (count + 3 short tokens) — answers
//     "did the rewriter actually tailor to my JD?" without revealing the
//     rewritten bullets
//   • "ATS can't read this watermarked version" — the conversion driver
//   • Sub-60 improvement hints (generic; reveal nothing about content)
function buildPreview(session) {
  const r = session.resume_json_rewritten;
  if (!r) return 'Generation failed. Type "reset" to try again.';

  const lines = [];
  lines.push(`✓ Resume tayar — open the PDF above to review.`);
  if (r.name) lines.push(`_For: ${r.name}_`);
  lines.push('');

  // ATS score itself is NOT shown to the student (Meet's call 2026-06-26 —
  // students fixate on the number instead of using their edits to improve the
  // content). The score still lives on session.ats_score for bot awareness
  // (admin dashboard, telemetry, rewriter calibration) — just not surfaced
  // here. The improvement suggestions ARE shown so students know what to do
  // with their edit budget.

  // Matched-skill COUNT (not full list). 3-token tease is enough signal
  // without giving a usable skill section. ONLY shown when a REAL JD exists —
  // pasted JD text or a scraped JD URL (both land in session.jd_text). A bare
  // role title makes keywords.js *infer* keywords, which is not a real JD match,
  // so we must never present that inferred count as a "JD match".
  const hasRealJd = !!session.jd_text;
  const matched = keywordsMatched(r, session.jd_keywords);
  const jdN = Array.isArray(session.jd_keywords) ? session.jd_keywords.length : 0;
  if (hasRealJd && matched.length > 0 && jdN > 0) {
    const tease = matched.slice(0, 3).join(', ') + (matched.length > 3 ? ', …' : '');
    lines.push(`*JD match:* ${matched.length}/${jdN} keywords (${tease})`);
  }

  // Improvement suggestions — always shown when the scorer surfaces any.
  // Drives use of the 3 free edits. No <60 gate any more (the score itself
  // is hidden, so gating on it would silently turn the help off and on for
  // identical-looking students).
  if (Array.isArray(session.ats_suggestions) && session.ats_suggestions.length > 0) {
    lines.push('');
    lines.push(`_To improve with your edits:_`);
    for (const s of session.ats_suggestions) lines.push(`  • ${s}`);
  }

  // Interview hot topics (2026-07-13) — Reviewer agent generates 4-5 topics
  // tailored to THIS resume and the JD. Different resumes → different topics.
  // Purpose: help students prep for the actual questions they're likely to
  // face given what's on their resume + role. Not shown when the reviewer
  // returned zero (network failure, etc.).
  if (Array.isArray(session.interview_topics) && session.interview_topics.length > 0) {
    lines.push('');
    lines.push(`_Prep for interview — hot topics based on your resume + JD:_`);
    for (const t of session.interview_topics) lines.push(`  • ${t}`);
  }

  lines.push('');
  // Pilot/paid students already have the clean, ATS-parseable PDF — no
  // watermark, no ₹49 gate. Everyone else sees the conversion CTA.
  const isUnlocked = !!session.paid || !!session.pilot;
  if (isUnlocked) {
    lines.push(`✅ Clean, ATS-parseable PDF — ready to send to recruiters.`);
    lines.push('');
    lines.push(`✏️ "edit" to refine — 3 edits included.`);
  } else {
    lines.push(`⚠️  Watermarked + ATS-unreadable (ATS can't parse images).`);
    lines.push(`₹49 unlock = clean text-parseable PDF that Naukri reads.`);
    lines.push('');
    lines.push(`✏️ "edit" to refine — 3 free edits included.`);
    lines.push(`💳 "pay" — ₹49 unlocks the clean PDF + 3 more edits.`);
  }

  // Final safety caution (2026-07-13). Prompts the student to open the PDF
  // and eyeball every fact before shipping to a recruiter. Prevents them
  // from firing off an AI-generated resume with a typo or misattribution.
  lines.push('');
  lines.push(`⚠️ _Zaroor: PDF khol ke poora resume review kar lo bhejne se pehle — koi fact / metric / date galat lage to "edit" bolke fix karo._`);

  // Post-PDF rating micro-survey (2026-07-14). Only shown when the student
  // hasn't rated yet — after they rate, we don't re-prompt so the preview
  // doesn't feel naggy on subsequent messages. Rating is captured by the
  // DELIVERED / PAID_COMPLETE handler's RATE_RE match (a bare digit 1-5).
  if (!session.rating) {
    lines.push('');
    lines.push(`⭐ _Reply 1-5 to rate this resume — 30 seconds, helps us improve fast._`);
  }

  let out = lines.join('\n');
  // Hard cap generous enough to fit ATS suggestions + interview topics +
  // payment CTAs + double-check caution comfortably. WhatsApp text limit is
  // 4096 chars — 1800 stays well within while respecting attention span.
  // Was 900 (single-agent), bumped to 1800 (multi-agent with reviewer +
  // interview topics + caution).
  if (out.length > 1800) out = out.slice(0, 1780) + '\n…';
  return out;
}

module.exports = { runGeneration, buildPreview, keywordsMatched, whatsappBold };
