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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  if (r.phone) parts.push(escapeHtml(r.phone));
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
    out.push({ label, items: ' ' + items.map(escapeHtml).join(', ') });
  }
  return out;
}

function prepResume(r0) {
  const r = JSON.parse(JSON.stringify(r0 || {}));

  // Summary: convert markdown bold.
  const summary = r.summary ? mdBold(r.summary) : '';

  // Education: leave fields as-is; template handles markup.
  const education = safeArray(r.education).map((e) => ({
    college:    escapeHtml(e.college || ''),
    location:   e.location ? escapeHtml(e.location) : '',
    degree:     escapeHtml(e.degree || ''),
    branch:     e.branch ? escapeHtml(e.branch) : '',
    dates:      escapeHtml(e.dates || e.expected_year || ''),
    cgpa:       e.cgpa ? escapeHtml(e.cgpa) : '',
    coursework: e.coursework ? escapeHtml(e.coursework) : '',
  }));

  // Experience: bullets get markdown-bold conversion; tech_stack rendered inline italic.
  // Filter empty strings out of bullets + tech_stack so an empty entry from the
  // LLM never becomes a stray "·" artifact or a bare-bullet <li>.
  const experience = safeArray(r.experience).map((e) => ({
    role:           escapeHtml(e.role || ''),
    company:        escapeHtml(e.company || ''),
    location:       e.location ? escapeHtml(e.location) : '',
    dates:          escapeHtml(e.dates || ''),
    tech_stack_str: nonEmptyStrings(e.tech_stack).map(escapeHtml).join(' · '),
    bullets:        nonEmptyStrings(e.bullets).map(mdBold),
  }));

  // Projects: tech stack joined with " · ", bullets converted. Same filter.
  const projects = safeArray(r.projects).map((p) => ({
    name:           escapeHtml(p.name || ''),
    dates:          escapeHtml(p.dates || ''),
    github_url:     safeUrl(p.github_url),
    demo_url:       safeUrl(p.demo_url),
    tech_stack_str: nonEmptyStrings(p.tech_stack).map(escapeHtml).join(' · '),
    bullets:        nonEmptyStrings(p.bullets).map(mdBold),
  }));

  const por = safeArray(r.por).map((p) => ({
    role:         escapeHtml(p.role || ''),
    organization: escapeHtml(p.organization || ''),
    dates:        escapeHtml(p.dates || ''),
    bullets:      nonEmptyStrings(p.bullets).map(mdBold),
  }));

  const certifications = safeArray(r.certifications).map((c) => ({
    name:   escapeHtml(c.name || ''),
    url:    safeUrl(c.url),
    issuer: c.issuer ? escapeHtml(c.issuer) : '',
    date:   c.date ? escapeHtml(c.date) : '',
  }));

  const achievements = nonEmptyStrings(r.achievements).map(mdBold);

  const skill_categories = buildSkillCategories(r.skills);

  return {
    name:    escapeHtml(r.name || ''),
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

function renderHtml(resumeJson) {
  if (!resumeJson) throw new Error('renderHtml: resumeJson required');
  const ctx = prepResume(resumeJson);
  const html = getTemplate()(ctx);
  return html;
}

module.exports = { renderHtml, prepResume };
