// GENERATING-state orchestrator. PRD §5 Phase 3.
// Sequence: scrape JD (if URL) → extract keywords → rewrite resume.
const { scrapeNaukri } = require('../jd/scrape');
const { extractKeywords } = require('../llm/keywords');
const { rewriteResume } = require('../llm/rewrite');
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

  if (session.jd_url && !session.jd_text) {
    const tScrape = Date.now();
    const scraped = await withTimeout(scrapeNaukri(session.jd_url), 10000, null, 'scrape');
    timings.scrape_ms = Date.now() - tScrape;
    if (scraped) session.jd_text = scraped;
  }

  // Parallelize keywords + rewrite. The rewriter uses keywords only as a
  // "match where the student has the skill" hint — not load-bearing. Running
  // both concurrently saves ~3-4s on the critical path (was ~10s before).
  //
  // TIMEOUTS: generously sized because the Meta webhook is ASYNC (ack-first —
  // see routes/whatsapp.js POST: it returns 200 immediately, then processes and
  // pushes the reply via a separate outbound API call). There is NO synchronous
  // 15s webhook budget anymore — that was a Twilio TwiML constraint. The old 13s
  // rewrite ceiling was clipping slow-but-valid rewrites on Railway's CPU
  // (~10.3s locally → over 13s in prod), producing a null resume and the
  // user-facing "PDF banane mein dikkat" failure. A resume taking ~20s is fine.
  const tPar = Date.now();
  const [kw, rewritten] = await Promise.all([
    withTimeout(
      extractKeywords({ jdText: session.jd_text, jdRole: session.jd_role, jdGeneric: session.jd_generic }),
      12000,
      { keywords: [], role_title: 'unknown', experience_level: 'fresher' },
      'keywords'
    ),
    withTimeout(
      rewriteResume({
        resumeJson: session.resume_json,
        jdRole: session.jd_role,
        jdText: session.jd_text,
        // Keywords not yet known — rewriter relies on role/JD context.
        // For the v1 prototype the quality loss is negligible; can re-pass with keywords later if needed.
        jdKeywords: [],
        jdGeneric: session.jd_generic,
        phoneFrom,
      }),
      30000,
      { data: null, usage: null },
      'rewrite'
    ),
  ]);
  timings.parallel_ms = Date.now() - tPar;
  session.jd_keywords = kw.keywords || [];
  session.jd_role_title = kw.role_title;
  session.jd_experience_level = kw.experience_level;
  session.resume_json_rewritten = rewritten.data;
  session.rewrite_usage = rewritten.usage;

  // Distinct, greppable signal: the rewrite produced no data (LLM timeout or
  // error). Everything downstream (PDF, preview) will fail from here, so make
  // this the obvious root-cause line in prod logs rather than a vague PDF error.
  if (!rewritten.data) {
    logger.error({ rewriteMs: timings.parallel_ms }, 'rewrite returned null data — resume cannot be generated this run');
  }

  // ATS score — deterministic, local, ~5-10ms. PRD §11.
  if (session.resume_json_rewritten) {
    const tAts = Date.now();
    const scored = scoreResume(session.resume_json_rewritten, session.jd_keywords);
    session.ats_score = scored.total;
    session.ats_breakdown = scored;
    session.ats_suggestions = suggestionsFor(scored);
    timings.ats_ms = Date.now() - tAts;
  }

  timings.total_ms = Date.now() - t0;
  logger.info({ timings, kwCount: session.jd_keywords.length, atsScore: session.ats_score }, 'generation complete');
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
  const sk = resume?.skills || {};
  for (const k of ['languages', 'frameworks', 'tools', 'databases', 'other']) {
    for (const item of (sk[k] || [])) add(item);
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

function summarizeSkills(skills) {
  if (!skills) return [];
  const out = [];
  const labels = { languages: 'Languages', frameworks: 'Frameworks', tools: 'Tools', databases: 'Databases', other: 'Other' };
  for (const k of ['languages', 'frameworks', 'tools', 'databases', 'other']) {
    const items = skills[k] || [];
    if (items.length === 0) continue;
    const shown = items.slice(0, 5).join(', ') + (items.length > 5 ? `, +${items.length - 5}` : '');
    out.push(`${labels[k]}: ${shown}`);
  }
  return out;
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

  // ATS score — primary "is it any good?" signal.
  if (typeof session.ats_score === 'number') {
    const target = session.jd_role || session.jd_role_title || 'this role';
    lines.push(`*ATS Score:* ${session.ats_score}/100 for ${target}`);
  }

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

  // Sub-60 hints — generic improvement nudges, no content reveal.
  if (typeof session.ats_score === 'number' && session.ats_score < 60 &&
      Array.isArray(session.ats_suggestions) && session.ats_suggestions.length > 0) {
    lines.push('');
    lines.push(`_To improve:_`);
    for (const s of session.ats_suggestions) lines.push(`  • ${s}`);
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

  let out = lines.join('\n');
  // Hard cap; should be well under this anyway now.
  if (out.length > 900) out = out.slice(0, 880) + '\n…';
  return out;
}

module.exports = { runGeneration, buildPreview, keywordsMatched, whatsappBold };
