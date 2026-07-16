// HTML renderer for resume_json_rewritten. PRD §9.
// Pre-processes the JSON (markdown bold → <strong>, contact row, skills bucket
// re-labeling), then runs through Handlebars template.
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'resume.hbs');
let _template = null;
function getTemplate() {
  if (_template) return _template;
  const src = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  _template = Handlebars.compile(src, { noEscape: false });
  return _template;
}

// Decode the five named entities plus numeric entities that LLMs occasionally
// emit when they "helpfully" think they're writing HTML. Without this, an
// input like "Tom &amp; Jerry" goes through escapeHtml() → "Tom &amp;amp; Jerry"
// and renders as the literal "Tom &amp; Jerry" in the PDF text layer (Bug B
// 2026-06-24 prevention — the ATS checklist treats raw entities as a blocking
// defect). Apply DECODE → ESCAPE so any pre-existing entities collapse to
// their character, then re-escape just-once for safe HTML insertion.
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
    });
}

function escapeHtml(s) {
  return decodeEntities(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Mark a string we've already escaped as HTML-safe so Handlebars' default
// `{{x}}` stash does NOT escape it a second time (double-escape was producing
// literal "&amp;amp;" → visible "&amp;" in the PDF text layer). Triple-stash
// `{{{x}}}` would also work, but wrapping centralises the invariant: every
// value placed into the template context here is HTML-ready.
function safe(s) {
  return new Handlebars.SafeString(s == null ? '' : String(s));
}

// Convert markdown-bold to HTML. Inputs may be raw text from the rewriter.
function mdBold(s) {
  return escapeHtml(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function safeArray(a) { return Array.isArray(a) ? a : []; }

// Drop empty/whitespace strings. Used everywhere we materialize bullets,
// tech_stack items, achievements, or any other free-text list — without this,
// an empty string in the array becomes a stray "·" separator or an empty <li>
// (rendered as a lone bullet point with no text). See edit-flow bug fix
// 2026-06-24: applyEdit occasionally returned arrays containing one empty
// string trailing a real bullet; that produced visible stray "·" artifacts.
function nonEmptyStrings(a) {
  return safeArray(a).filter((s) => s != null && String(s).trim() !== '');
}

// Cap tech_stack at MAX items, deduplicating case-insensitively. Per the ATS
// checklist 2026-06-24: tech-stack lines should be 5-7 items, ordered by
// relevance, no duplicates. Earlier items win on dedup (the rewriter orders
// by JD relevance, so we preserve its lead).
const TECH_STACK_MAX = 7;
function capTechStack(items) {
  const seen = new Set();
  const out = [];
  for (const raw of nonEmptyStrings(items)) {
    const key = String(raw).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= TECH_STACK_MAX) break;
  }
  return out;
}

// Format Indian phone numbers as "+91 NNNNN NNNNN" (e.g. "+919876543210" →
// "+91 98765 43210"). Some ATS parsers misread bare 12-digit strings as one
// malformed number. Anything that's not a recognisable Indian number passes
// through unchanged so e.g. a US format isn't mangled.
function formatPhone(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return '+91 ' + digits.slice(2, 7) + ' ' + digits.slice(7);
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    // "09876543210" → strip leading 0 and treat as +91
    return '+91 ' + digits.slice(1, 6) + ' ' + digits.slice(6);
  }
  if (digits.length === 10) {
    return '+91 ' + digits.slice(0, 5) + ' ' + digits.slice(5);
  }
  return s;
}

// Only allow http(s)/mailto in hrefs. Blocks javascript:/data:/file: schemes
// that could ride along in a user-supplied link. Returns the RAW validated URL
// (callers escape for their context) or '' if the scheme isn't allowed.
function safeUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) return s;
  // Bare domain like "linkedin.com/in/x" → assume https.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return 'https://' + s;
  return '';
}

// Builds the contact row HTML: email | phone | LinkedIn | GitHub | LeetCode.
// Underlined links use the template's `.contact a` styling.
function buildContactHtml(r) {
  const parts = [];
  if (r.email) parts.push(escapeHtml(r.email));
  if (r.phone) parts.push(escapeHtml(formatPhone(r.phone)));
  const link = (raw, label) => { const u = safeUrl(raw); return u ? `<a href="${escapeHtml(u)}">${label}</a>` : escapeHtml(label); };
  if (r.linkedin) parts.push(link(r.linkedin, 'LinkedIn'));
  if (r.github)   parts.push(link(r.github, 'GitHub'));
  // Competitive-coding profiles — one link per platform, labelled by platform.
  for (const cp of safeArray(r.coding_profiles)) {
    if (cp && cp.url) parts.push(link(cp.url, escapeHtml(cp.platform || 'Coding')));
  }
  // Back-compat: a bare single `leetcode` field still renders if present.
  if (r.leetcode) parts.push(link(r.leetcode, 'LeetCode'));
  return parts.join('<span class="sep">|</span>');
}

// skills is an ordered array of role-tailored categories: [{ category, items }].
// Labels are passed raw (Handlebars HTML-escapes them, so "Data & BI" renders
// correctly); items are pre-escaped here and rendered via the same template slot.
function buildSkillCategories(skills) {
  if (!Array.isArray(skills)) return [];
  const out = [];
  for (const cat of skills) {
    const items = nonEmptyStrings(cat && cat.items);
    const label = String((cat && cat.category) || '').trim();
    if (items.length === 0 || !label) continue;
    out.push({
      label: safe(escapeHtml(label)),
      items: safe(' ' + items.map(escapeHtml).join(', ')),
    });
  }
  return out;
}

function prepResume(r0) {
  const r = JSON.parse(JSON.stringify(r0 || {}));

  // Summary: convert markdown bold. Wrap in safe() so the template's `{{ }}`
  // doesn't escape our already-escaped HTML a second time (double-escape was
  // producing literal "&amp;amp;" → visible "&amp;" in the PDF text layer).
  const summary = r.summary ? safe(mdBold(r.summary)) : '';

  const education = safeArray(r.education).map((e) => ({
    college:    safe(escapeHtml(e.college || '')),
    location:   e.location ? safe(escapeHtml(e.location)) : '',
    degree:     safe(escapeHtml(e.degree || '')),
    branch:     e.branch ? safe(escapeHtml(e.branch)) : '',
    dates:      safe(escapeHtml(e.dates || e.expected_year || '')),
    cgpa:       e.cgpa ? safe(escapeHtml(e.cgpa)) : '',
    coursework: e.coursework ? safe(escapeHtml(e.coursework)) : '',
  }));

  const experience = safeArray(r.experience).map((e) => ({
    role:           safe(escapeHtml(e.role || '')),
    company:        safe(escapeHtml(e.company || '')),
    location:       e.location ? safe(escapeHtml(e.location)) : '',
    dates:          safe(escapeHtml(e.dates || '')),
    tech_stack_str: safe(capTechStack(e.tech_stack).map(escapeHtml).join(' · ')),
    bullets:        nonEmptyStrings(e.bullets).map((b) => safe(mdBold(b))),
  }));

  const projects = safeArray(r.projects).map((p) => ({
    name:           safe(escapeHtml(p.name || '')),
    dates:          safe(escapeHtml(p.dates || '')),
    github_url:     safeUrl(p.github_url),   // href attribute — let Handlebars escape once for attribute context.
    demo_url:       safeUrl(p.demo_url),
    tech_stack_str: safe(capTechStack(p.tech_stack).map(escapeHtml).join(' · ')),
    bullets:        nonEmptyStrings(p.bullets).map((b) => safe(mdBold(b))),
  }));

  const por = safeArray(r.por).map((p) => ({
    role:         safe(escapeHtml(p.role || '')),
    organization: safe(escapeHtml(p.organization || '')),
    dates:        safe(escapeHtml(p.dates || '')),
    bullets:      nonEmptyStrings(p.bullets).map((b) => safe(mdBold(b))),
  }));

  const certifications = safeArray(r.certifications).map((c) => ({
    name:   safe(escapeHtml(c.name || '')),
    url:    safeUrl(c.url),                  // href attribute
    issuer: c.issuer ? safe(escapeHtml(c.issuer)) : '',
    date:   c.date ? safe(escapeHtml(c.date)) : '',
  }));

  const achievements = nonEmptyStrings(r.achievements).map((a) => safe(mdBold(a)));

  const skill_categories = buildSkillCategories(r.skills);

  return {
    name:    safe(escapeHtml(r.name || '')),
    summary,
    contact_html: buildContactHtml(r),
    education,
    skill_categories,
    experience,
    projects,
    por,
    certifications,
    achievements,
    has_education:    education.length > 0,
    has_skills:       skill_categories.length > 0,
    has_experience:   experience.length > 0,
    has_projects:     projects.length > 0,
    has_por:          por.length > 0,
    has_certs:        certifications.length > 0,
    has_achievements: achievements.length > 0,
  };
}

// Optional CSS overrides applied INLINE at the very end of the rendered HTML
// (after all template styles). Used by Path 2 Tier 3 compression: when the
// resume still overflows after prompt-level oneP compression, we tighten the
// layout AND slightly reduce font size deterministically. Overrides are
// scoped and non-destructive to the primary template.
function compactCssOverride(opts = {}) {
  const {
    fontScale = 1,       // 0.95 shrinks all body/section/name/meta text by 5%
    sectionGap = 9,      // pt — default is 9pt; tighter = fewer page breaks
    entryGap = 6,        // pt — default is 6pt
    bulletGap = 3,       // pt — bullet spacing
    pageMargin = '10mm 16mm', // A4 top/bottom left/right — default template has 14mm top/bot
  } = opts;
  const bodyPt   = (10   * fontScale).toFixed(2);
  const namePt   = (17   * fontScale).toFixed(2);
  const secPt    = (12   * fontScale).toFixed(2);
  const metaPt   = (9    * fontScale).toFixed(2);
  return `<style>
    /* Path 2 compact override — Meet's 2026-07-16 call:
       "free space is present above the name and bottom of page 1 — use it first".
       Reclaim vertical space from the @page margins BEFORE touching content. */
    @page { size: A4; margin: ${pageMargin}; }
    :root {
      --sz-body: ${bodyPt}pt;
      --sz-name: ${namePt}pt;
      --sz-section: ${secPt}pt;
      --sz-meta: ${metaPt}pt;
    }
    section { margin-top: ${sectionGap}pt; }
    .entry { margin-bottom: ${entryGap}pt; }
    .bullet, li { margin-bottom: ${bulletGap}pt; }
    /* Relax the h2 "avoid break-after" rule so a small tail section
       (e.g. certifications with 2 lines) can sit at the bottom of page 1
       instead of being pushed entirely to page 2. Orphan/widow control
       keeps it graceful. */
    h2 { break-after: auto; }
    section { orphans: 2; widows: 2; }
  </style>`;
}

function renderHtml(resumeJson, opts = {}) {
  if (!resumeJson) throw new Error('renderHtml: resumeJson required');
  const ctx = prepResume(resumeJson);
  let html = getTemplate()(ctx);
  if (opts.compact) {
    const cfg = opts.compact === true ? { fontScale: 0.95, sectionGap: 6, entryGap: 4, pageMargin: '9mm 16mm' } : opts.compact;
    // Chromium's PDF export doesn't cascade multiple @page rules cleanly —
    // it locks onto the FIRST @page seen. So we REPLACE the template's
    // original @page rule instead of appending a second one.
    html = html.replace(/@page\s*\{[^}]*\}/i, `@page { size: A4; margin: ${cfg.pageMargin || '9mm 16mm'}; }`);
    // Everything else (font scale, section gap, entry gap, h2 break rule)
    // still appended just before </head> — those cascade normally.
    const override = compactCssOverride(cfg);
    // Strip the @page from the override since we replaced it inline above.
    const overrideNoPage = override.replace(/@page[^{]*\{[^}]*\}/i, '');
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${overrideNoPage}</head>`);
    } else {
      html = overrideNoPage + html;
    }
  }
  return html;
}

module.exports = { renderHtml, prepResume, compactCssOverride };
