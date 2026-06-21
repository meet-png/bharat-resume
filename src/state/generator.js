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
    const scraped = await withTimeout(scrapeNaukri(session.jd_url), 7000, null, 'scrape');
    timings.scrape_ms = Date.now() - tScrape;
    if (scraped) session.jd_text = scraped;
  }

  // Parallelize keywords + rewrite. The rewriter uses keywords only as a
  // "match where the student has the skill" hint — not load-bearing. Running
  // both concurrently saves ~3-4s on the critical path (was ~10s before).
  const tPar = Date.now();
  const [kw, rewritten] = await Promise.all([
    withTimeout(
      extractKeywords({ jdText: session.jd_text, jdRole: session.jd_role, jdGeneric: session.jd_generic }),
      5500,
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
      // 13s ceiling (bumped from 11s after observable cold-call flake).
      // We're parallel with keywords (which usually finishes in 2-4s), so the
      // critical path is rewrite alone. Render+watermark+upload add ~3-4s,
      // keeping us inside Twilio's 15s webhook budget on the happy path.
      13000,
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

// Compact preview for WhatsApp. ≤1400 chars total.
// Shows: name, summary, skills, ALL experience entries (top bullet each),
// ALL project entries (top bullet each, capped at 3), real keywords matched.
function buildPreview(session) {
  const r = session.resume_json_rewritten;
  if (!r) return 'Generation failed. Type "reset" to try again.';

  const lines = [];
  lines.push(`✓ Resume ready! Preview:`);
  lines.push('');

  if (r.name) lines.push(`*${r.name}*`);
  if (r.summary) lines.push(`${whatsappBold(r.summary)}`);
  lines.push('');

  const skillLines = summarizeSkills(r.skills);
  if (skillLines.length > 0) {
    lines.push(`*Skills:*`);
    for (const s of skillLines) lines.push(`• ${s}`);
    lines.push('');
  }

  if (r.experience && r.experience.length > 0) {
    lines.push(`*Experience:*`);
    for (const e of r.experience.slice(0, 2)) {
      const header = [e.role, e.company].filter(Boolean).join(' @ ') + (e.dates ? ` (${e.dates})` : '');
      lines.push(header);
      if (Array.isArray(e.tech_stack) && e.tech_stack.length > 0) {
        lines.push(`_${e.tech_stack.join(' · ')}_`);
      }
      for (const b of (e.bullets || []).slice(0, 3)) lines.push(`• ${whatsappBold(b)}`);
    }
    lines.push('');
  }

  if (r.projects && r.projects.length > 0) {
    lines.push(`*Projects (${r.projects.length}):*`);
    for (const [i, p] of r.projects.slice(0, 3).entries()) {
      const title = p.name || `Project ${i + 1}`;
      lines.push(`${i + 1}. ${title}`);
      if (Array.isArray(p.tech_stack) && p.tech_stack.length > 0) {
        lines.push(`   _${p.tech_stack.join(' · ')}_`);
      }
      for (const b of (p.bullets || []).slice(0, 2)) lines.push(`   • ${whatsappBold(b)}`);
    }
    if (r.projects.length > 3) lines.push(`+${r.projects.length - 3} more in full resume`);
    lines.push('');
  }

  const matched = keywordsMatched(r, session.jd_keywords);
  if (matched.length > 0) {
    lines.push(`*Your skills matching the JD:* ${matched.slice(0, 10).join(', ')}`);
  } else if (session.jd_keywords && session.jd_keywords.length > 0) {
    lines.push(`*JD keywords (for reference):* ${session.jd_keywords.slice(0, 6).join(', ')}\n_(No direct overlap with your skills — rewriter still tailored framing to the role.)_`);
  }

  // ATS score block — PRD §11.2.
  if (typeof session.ats_score === 'number') {
    lines.push('');
    lines.push(`*ATS Score:* ${session.ats_score}/100`);
    if (session.ats_score < 60 && Array.isArray(session.ats_suggestions) && session.ats_suggestions.length > 0) {
      lines.push(`_To improve:_`);
      for (const s of session.ats_suggestions) lines.push(`  • ${s}`);
    }
  }

  lines.push('');
  lines.push(`Type "show me" for full JSON.`);

  let out = lines.join('\n');
  if (out.length > 1500) out = out.slice(0, 1480) + '\n…(truncated)';
  return out;
}

module.exports = { runGeneration, buildPreview, keywordsMatched, whatsappBold };
