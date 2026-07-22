// LLM extractor: parsed resume text → resume_json (v1-compatible shape).
//
// Two invariants that make v2 auditable:
//   1. GROUNDED — only extract what's literally in the source. If a field
//      isn't there, null. Never invent.
//   2. ANCHORED — every bullet keeps `source_line` (line number in the parsed
//      text). Raw source text is NOT duplicated into the extraction — we look
//      it up from parsed.lines[source_line-1] when we need it downstream.
//      Rationale: (a) halves output tokens, (b) the anchor can never drift
//      from the source because the "raw" side is literally the source.
//
// Output shape:
//   {
//     name, email, phone, linkedin, github, coding_profiles, leetcode, summary,
//     education:      [{ college, location, degree, branch, dates, cgpa, coursework, source_line }],
//     experience:     [{ role, company, location, dates, tech_stack, bullets:[{ text, source_line }] }],
//     projects:       [{ name, dates, github_url, demo_url, tech_stack, bullets:[{ text, source_line }] }],
//     por:            [{ role, organization, dates, bullets:[{ text, source_line }] }],
//     certifications: [{ name, url, issuer, date, source_line }],
//     achievements:   [{ text, source_line }],
//     skills:         [{ category, items }],
//   }
//
// v1 render (src/resume/render.js) expects `bullets: [string]`. Before rendering
// we flatten `bullets[].text → string[]`. The rich shape is preserved on the
// session so the audit report + verifier can cite source lines.
const { complete } = require('../llm/client');
const { config } = require('../config');
const logger = require('../logger');

const SYSTEM = `You are a resume-structuring extractor for Indian college students. You will receive the plain text of a resume (extracted from a PDF or DOCX) with each line prefixed by its 1-indexed line number. You output STRICT JSON matching the schema described in the user message.

HARD RULES (violations WILL be rejected downstream):
1. GROUNDED: Every field you populate must be literally present in the source text. If a field is missing, use null. NEVER invent numbers, tools, companies, or roles.
2. ANCHORED: For every bullet (experience.bullets[], projects.bullets[], por.bullets[], achievements[]), and for every education/certification entry, include a "source_line" field with the 1-indexed line number where the primary fact appears in the source. If a bullet spans multiple lines, use the FIRST line's number.
3. PRESERVE metrics as-is. If the student wrote "50K users" don't rewrite to "50,000 users". If they wrote "92% accuracy" keep the % sign. Rewriting comes later.
4. DEDUPLICATE headings and section markers — they are structural noise, not content. "PROJECTS", "EDUCATION", etc. are headers, not fields.
5. If the resume contains contact-block URLs (LinkedIn, GitHub, LeetCode), preserve them exactly as written including https:// or the bare domain form.
6. Skills — group into categories only if the source already groups them (e.g. "Languages: Java, Python"). If the source is a flat list, put everything under one category { category: "Skills", items: [...] }.

VOICE for extracted bullets: keep the student's original wording. Improvement/rewrite is a SEPARATE downstream step. Your only job is faithful capture.`;

const SCHEMA_HINT = `Output JSON with these keys (populate what's present, null for missing):
{
  "name": string | null,
  "email": string | null,
  "phone": string | null,
  "linkedin": string | null,
  "github": string | null,
  "coding_profiles": [{ "platform": string, "url": string }] | null,
  "leetcode": string | null,
  "summary": string | null,
  "education": [{
    "college": string, "location": string | null, "degree": string | null,
    "branch": string | null, "dates": string | null, "cgpa": string | null,
    "coursework": string | null, "source_line": number
  }],
  "experience": [{
    "role": string, "company": string, "location": string | null,
    "dates": string | null, "tech_stack": [string] | null,
    "bullets": [{ "text": string, "source_line": number }]
  }],
  "projects": [{
    "name": string, "dates": string | null,
    "github_url": string | null, "demo_url": string | null,
    "tech_stack": [string] | null,
    "bullets": [{ "text": string, "source_line": number }]
  }],
  "por": [{
    "role": string, "organization": string | null, "dates": string | null,
    "bullets": [{ "text": string, "source_line": number }]
  }],
  "certifications": [{
    "name": string, "url": string | null, "issuer": string | null,
    "date": string | null, "source_line": number
  }],
  "achievements": [{ "text": string, "source_line": number }],
  "skills": [{ "category": string, "items": [string] }]
}`;

function numberedText(lines) {
  return lines.map((l) => `${String(l.n).padStart(3, ' ')}| ${l.text}`).join('\n');
}

// Minimal shape enforcement — reject the LLM's output if it's structurally
// broken so the caller can fail cleanly instead of shipping bad JSON downstream.
// This is NOT the fabrication verifier (that runs on rewrites, not extractions);
// this only guards against structural corruption / missing arrays.
function validateShape(obj) {
  if (!obj || typeof obj !== 'object') return 'not-an-object';
  const arrays = ['education', 'experience', 'projects', 'por', 'certifications', 'achievements', 'skills'];
  for (const k of arrays) {
    if (obj[k] != null && !Array.isArray(obj[k])) return `${k}-not-array`;
  }
  return null;
}

// Null out URL fields that don't parse as http(s) URLs. Meet's resume test
// showed the LLM sometimes puts hyperlink-DISPLAY text like "[GitHub]" or
// "LinkedIn" into url slots because that's what pdfjs extracts (the underlying
// hrefs aren't in the text-content stream). Better to store null than a broken
// string that will render as visible garbage in the resume.
function isHttpUrl(s) {
  if (!s || typeof s !== 'string') return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}
function coerceUrl(s) { return isHttpUrl(s) ? s.trim() : null; }
function sanitizeUrls(rj) {
  if (!rj) return rj;
  rj.linkedin = coerceUrl(rj.linkedin);
  rj.github = coerceUrl(rj.github);
  rj.leetcode = coerceUrl(rj.leetcode);
  if (Array.isArray(rj.coding_profiles)) {
    rj.coding_profiles = rj.coding_profiles
      .map((cp) => (cp && cp.url ? { ...cp, url: coerceUrl(cp.url) } : cp))
      .filter((cp) => cp && cp.url);
  }
  if (Array.isArray(rj.projects)) {
    for (const p of rj.projects) {
      p.github_url = coerceUrl(p.github_url);
      p.demo_url = coerceUrl(p.demo_url);
    }
  }
  if (Array.isArray(rj.certifications)) {
    for (const c of rj.certifications) c.url = coerceUrl(c.url);
  }
  return rj;
}

// Public. Takes the { text, lines } from parse() and returns { resume_json, usage, meta }.
// role is optional at extraction time — it's used by scoring later, but the
// extractor doesn't need it (extraction is source-only, role-independent).
async function extract({ lines }) {
  if (!lines || lines.length === 0) {
    return { resume_json: null, usage: null, meta: { skipped: true, reason: 'empty-input' } };
  }

  const user = `${SCHEMA_HINT}

Source resume (line-numbered):
${numberedText(lines)}

Extract now. Output only the JSON object.`;

  const { data, usage, model, attempts } = await complete({
    system: SYSTEM,
    user,
    model: config.LLM_PRIMARY,
    temperature: 0.1,  // near-zero to keep extraction deterministic across re-runs
    // 3500 truncated dense resumes mid-JSON on the first live test (Meet's own
    // 610-word resume produced ~3800 output tokens with raw_text per bullet).
    // 8000 leaves headroom for two-page technical resumes without paying more
    // than a few tenths of a cent extra at gpt-4o-mini rates.
    maxTokens: 8000,
  });

  const shapeErr = validateShape(data);
  if (shapeErr) {
    logger.warn({ shapeErr }, 'extract shape invalid');
    return { resume_json: null, usage, meta: { skipped: true, reason: `shape-invalid:${shapeErr}` } };
  }

  sanitizeUrls(data);

  logger.info({
    hasName: !!data.name,
    hasEmail: !!data.email,
    hasPhone: !!data.phone,
    education: data.education?.length || 0,
    experience: data.experience?.length || 0,
    projects: data.projects?.length || 0,
    certifications: data.certifications?.length || 0,
    achievements: data.achievements?.length || 0,
    skillCategories: data.skills?.length || 0,
    usage,
    model,
    attempts,
  }, 'rate.extract complete');

  return { resume_json: data, usage, meta: { model, attempts } };
}

// Flatten rich bullets → string[] for v1's render.js. Preserves order.
// This is what gets passed to the renderer; the rich shape stays on the session
// for audit + verifier.
function flattenForRender(rj) {
  if (!rj) return rj;
  const clone = JSON.parse(JSON.stringify(rj));
  const flattenBullets = (arr) => (arr || []).map((entry) => ({
    ...entry,
    bullets: (entry.bullets || []).map((b) => (typeof b === 'string' ? b : b.text || '')),
  }));
  clone.experience = flattenBullets(clone.experience);
  clone.projects = flattenBullets(clone.projects);
  clone.por = flattenBullets(clone.por);
  if (Array.isArray(clone.achievements)) {
    clone.achievements = clone.achievements.map((a) => (typeof a === 'string' ? a : a.text || ''));
  }
  return clone;
}

// Look up the raw source line for a given source_line anchor from the parsed
// text. This is what replaces the redundant `raw_text` field — every audit /
// verifier / display call that needs "what did the student actually write for
// this bullet" reads it here.
function rawForAnchor(parsedLines, sourceLine) {
  if (!Array.isArray(parsedLines) || !sourceLine) return null;
  const hit = parsedLines.find((l) => l.n === sourceLine);
  return hit ? hit.text : null;
}

// Post-extract sanity check. Catches the case where parse succeeded (didn't
// hit any refuse trigger) but extraction came back suspiciously sparse — for
// example, chaotic multi-column layouts that produce scrambled reading order
// where the LLM can't recover coherent experience/projects/skills.
//
// Signals of a "silent-bad" extraction:
//   - source has ≥ 200 words
//   - AND extraction returned zero experience AND zero projects AND zero POR
//   - AND no achievements
// A student's resume with ≥200 words simply cannot legitimately have zero
// entries across all four bullet-carrying sections — that's an extractor
// failure, likely from column scrambling, table chaos, or exotic formatting.
//
// Returns null on success, or a diagnostic { reason, suggestion } if the
// extraction looks suspect. The caller (rate-router) can convert this into
// a graceful refuse.
function checkExtractionQuality({ resume_json, parsedText, parsedLineCount }) {
  if (!resume_json) return { reason: 'extraction-null', suggestion: 'text-format' };
  const wc = (String(parsedText || '').match(/\S+/g) || []).length;
  if (wc < 200) return null; // too little text — probably legitimate, defer to score

  const experience = Array.isArray(resume_json.experience) ? resume_json.experience.length : 0;
  const projects = Array.isArray(resume_json.projects) ? resume_json.projects.length : 0;
  const por = Array.isArray(resume_json.por) ? resume_json.por.length : 0;
  const achievements = Array.isArray(resume_json.achievements) ? resume_json.achievements.length : 0;
  const totalEntries = experience + projects + por + achievements;
  if (totalEntries === 0) {
    return {
      reason: 'silent-bad-extraction',
      suggestion: 'chaotic-layout',
      details: `${wc} words parsed, but LLM extracted zero experience/projects/PoR/achievements. Likely a scrambled multi-column layout.`,
    };
  }

  // Secondary check: extraction dropped an unreasonable share of source content.
  const bullets = [];
  for (const arr of [experience, projects, por].map((_, i) => resume_json[['experience', 'projects', 'por'][i]] || [])) {
    for (const entry of arr) {
      for (const b of (entry.bullets || [])) {
        const t = typeof b === 'string' ? b : b.text || '';
        if (t.trim()) bullets.push(t);
      }
    }
  }
  const bulletChars = bullets.reduce((n, s) => n + s.length, 0);
  const textChars = String(parsedText || '').length;
  // If bullets account for < 5% of source text with ≥400 words, extraction
  // is probably missing large chunks of the resume (typical multi-column
  // symptom: LLM captures name/email/summary but drops experience column).
  if (wc >= 400 && textChars > 0 && bulletChars / textChars < 0.05) {
    return {
      reason: 'sparse-bullet-extraction',
      suggestion: 'chaotic-layout',
      details: `${wc} source words but only ${bulletChars} chars in bullets — likely a scrambled layout dropped major sections.`,
    };
  }
  return null;
}

module.exports = { extract, flattenForRender, rawForAnchor, checkExtractionQuality };
