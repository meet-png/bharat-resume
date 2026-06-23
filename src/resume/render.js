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

// Bucket labels — adapt to what the role context shaped. For the v1 prototype
// we keep the 5 generic labels but use clean title-case names that read well
// in the template-reference.md style.
const BUCKET_LABELS = {
  languages:  'Languages',
  frameworks: 'Frameworks',
  tools:      'Tools',
  databases:  'Databases',
  other:      'Other',
};

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

function buildSkillCategories(skills) {
  if (!skills || typeof skills !== 'object') return [];
  const out = [];
  for (const key of ['languages', 'frameworks', 'tools', 'databases', 'other']) {
    const items = safeArray(skills[key]);
    if (items.length === 0) continue;
    out.push({ label: BUCKET_LABELS[key], items: ' ' + items.map(escapeHtml).join(', ') });
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
  const experience = safeArray(r.experience).map((e) => ({
    role:           escapeHtml(e.role || ''),
    company:        escapeHtml(e.company || ''),
    location:       e.location ? escapeHtml(e.location) : '',
    dates:          escapeHtml(e.dates || ''),
    tech_stack_str: safeArray(e.tech_stack).map(escapeHtml).join(' · '),
    bullets:        safeArray(e.bullets).map(mdBold),
  }));

  // Projects: tech stack joined with " · ", bullets converted.
  const projects = safeArray(r.projects).map((p) => ({
    name:           escapeHtml(p.name || ''),
    dates:          escapeHtml(p.dates || ''),
    github_url:     safeUrl(p.github_url),
    tech_stack_str: safeArray(p.tech_stack).map(escapeHtml).join(' · '),
    bullets:        safeArray(p.bullets).map(mdBold),
  }));

  const por = safeArray(r.por).map((p) => ({
    role:         escapeHtml(p.role || ''),
    organization: escapeHtml(p.organization || ''),
    dates:        escapeHtml(p.dates || ''),
    bullets:      safeArray(p.bullets).map(mdBold),
  }));

  const certifications = safeArray(r.certifications).map((c) => ({
    name:   escapeHtml(c.name || ''),
    url:    safeUrl(c.url),
    issuer: c.issuer ? escapeHtml(c.issuer) : '',
    date:   c.date ? escapeHtml(c.date) : '',
  }));

  const achievements = safeArray(r.achievements).map(mdBold);

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
