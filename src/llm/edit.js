// Multi-intent edit pipeline. PRD §7.3 / §5 Phase 4.
// Rebuilt 2026-07-16 after Meet's cert-URL failure: "add these links to their
// respective certificates" was silently misclassified as action='add' (new
// certs) then dropped when items_to_add didn't parse. The classifier now
// returns an ARRAY of intents so multi-part edits ("add link A to cert 1 and
// link B to cert 2", "shorten summary and fix my email") are handled natively.
//
// Intent shape (per intent):
//   { section, action, items_to_add?, target_reference?, new_value?,
//     new_url?, modify_instruction? }
//
// Action vocabulary (expanded):
//   add            → new items appended to a section
//   modify         → change ONE FIELD of an existing item (URL to cert, dates
//                    to experience, cgpa on education, github_url on project)
//   remove         → delete a matching item
//   rephrase       → reword one string in place (LLM)
//   reorder        → reorder within an array (deterministic for skills, LLM for others)
//   replace_section→ full rewrite of one section (LLM; rare)
//   clarify        → intent is genuinely ambiguous
//
// applyEdit iterates through intents in order. Each intent is tried
// deterministically first; falls through to LLM apply for rephrase / modify
// (complex) / reorder / replace_section. Anti-silent-drop guard runs per-intent.
const { complete } = require('./client');
const { config } = require('../config');
const logger = require('../logger');

// Edit feature uses a stronger model than extraction/rewrite. Meet's 2026-07-16
// call: hybrid deterministic + gpt-4o so simple cases stay instant + free while
// complex cases get ChatGPT-tier reasoning.
const EDIT_MODEL = config.LLM_EDIT;

const GUARDED_SECTIONS = [
  'summary', 'education', 'skills', 'experience', 'projects',
  'por', 'certifications', 'achievements', 'coding_profiles',
  'name', 'email', 'phone', 'linkedin', 'github',
];

const SECTION_ALIASES = {
  summary:        ['summary', 'intro', 'profile', 'about', 'objective'],
  education:      ['educat', 'edu', 'degree', 'college', 'university', 'school', 'branch', 'cgpa', 'percentage', 'coursework'],
  skills:         ['skill'],
  experience:     ['experience', 'internship', 'intern ', 'work', ' job', 'role at', 'company', 'employer'],
  projects:       ['project'],
  por:            ['leadership', 'position of responsibility', 'club', 'society', 'committee'],
  certifications: ['cert', 'certif', 'certificate', 'course '],
  achievements:   ['achievement', 'award', 'prize', 'rank', 'percentile', 'won', 'winner', 'hackathon'],
  coding_profiles:['leetcode', 'codeforces', 'codechef', 'coding profile', 'hackerrank', 'gfg', 'geeksforgeeks'],
  name:           [' name'],
  email:          ['email', 'mail '],
  phone:          ['phone', 'mobile', 'number'],
  linkedin:       ['linkedin'],
  github:         ['github'],
};

function isEmptyValue(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function instructionReferences(instruction, section) {
  const i = ' ' + String(instruction).toLowerCase() + ' ';
  const aliases = SECTION_ALIASES[section] || [section];
  return aliases.some((a) => i.includes(a));
}

function dedupeByName(arr, label) {
  if (!Array.isArray(arr)) return arr;
  const seen = new Map();
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') { out.push(item); continue; }
    const name = String(item.name || '').trim().toLowerCase();
    if (!name) { out.push(item); continue; }
    if (seen.has(name)) {
      const idx = seen.get(name);
      const prev = out[idx];
      const prevScore = (Array.isArray(prev.bullets) ? prev.bullets.length : 0) + (Array.isArray(prev.tech_stack) ? prev.tech_stack.length : 0);
      const newScore = (Array.isArray(item.bullets) ? item.bullets.length : 0) + (Array.isArray(item.tech_stack) ? item.tech_stack.length : 0);
      if (newScore > prevScore) {
        out[idx] = item;
        logger.warn({ section: label, name: item.name, prevScore, newScore }, 'duplicate entry name — replaced with denser version');
      } else {
        logger.warn({ section: label, name: item.name, prevScore, newScore }, 'duplicate entry name — kept original');
      }
    } else {
      seen.set(name, out.length);
      out.push(item);
    }
  }
  return out;
}

// Fuzzy match a target string against a list of candidate strings.
// Returns the matched index (best match) or -1 if no reasonable match.
// Handles partial-name matches, case-insensitive, punctuation-tolerant.
function fuzzyMatchIndex(target, candidates) {
  if (!target || !Array.isArray(candidates) || candidates.length === 0) return -1;
  const t = String(target).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return -1;
  const scored = candidates.map((c, i) => {
    const s = String(c || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return { i, score: 0 };
    // Exact match beats everything.
    if (s === t) return { i, score: 1000 };
    // Full-substring match (either direction) is strong.
    if (s.includes(t) || t.includes(s)) return { i, score: 500 + Math.min(t.length, s.length) };
    // Word-overlap heuristic: count shared distinctive words (>= 3 chars).
    const tw = new Set(t.split(' ').filter((w) => w.length >= 3));
    const sw = s.split(' ').filter((w) => w.length >= 3);
    let overlap = 0;
    for (const w of sw) if (tw.has(w)) overlap++;
    if (overlap === 0) return { i, score: 0 };
    return { i, score: overlap * 10 + Math.min(t.length, s.length) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score >= 10 ? scored[0].i : -1;
}

function jdLine({ jdRole, jdText, jdGeneric }) {
  if (jdGeneric) return 'TARGET: generic resume (no specific role).';
  if (jdRole) return `TARGET ROLE: "${jdRole}". Keep edits consistent with this role.`;
  if (jdText) return `TARGET JD (excerpt): """${String(jdText).slice(0, 600)}"""`;
  return 'TARGET: generic resume.';
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE 1 — Multi-intent classifier.
// Parses free-text edit into an ARRAY of structured intents. A single message
// can carry multiple intents ("add link A to cert 1 and link B to cert 2";
// "shorten summary and fix my email"). Each is applied in order downstream.
// ─────────────────────────────────────────────────────────────────────────
async function classifyIntent({ rewritten, instruction, jd }) {
  const system = `You classify a resume edit request into an ARRAY OF STRUCTURED INTENTS. You are NOT rewriting the resume in this step — a separate stage applies each intent to the JSON.

${jdLine(jd)}

CURRENT resume shape (use to disambiguate references + find existing item names):
${JSON.stringify(rewritten)}

Student's message (STUDENTS TYPE IN ANY STYLE — multi-line lists, terse phrases, Hinglish, English, informal, sometimes messy. Parse robustly):
"""${String(instruction)}"""

Return JSON exactly:
{
  "intents": [
    {
      "section": "summary" | "education" | "skills" | "experience" | "projects" | "por" | "certifications" | "achievements" | "coding_profiles" | "contact" | "unknown",
      "action":  "add" | "modify" | "remove" | "rephrase" | "reorder" | "replace_section",
      "items_to_add":       [...] | null,
      "target_reference":   string | null,
      "new_value":          string | null,
      "new_url":            string | null,
      "modify_instruction": string | null
    },
    ... (one intent per distinct change the student is asking for)
  ],
  "clarification_needed": string | null
}

CORE PRINCIPLE — MULTI-INTENT PARSING:
One student message can contain MULTIPLE independent changes. Return one intent per change. Examples:

  "add link https://x.com to Neural Networks cert and https://y.com to Ethics cert"
  → 2 intents:
    { section: "certifications", action: "modify", target_reference: "Neural Networks", new_url: "https://x.com", modify_instruction: "add verification url" }
    { section: "certifications", action: "modify", target_reference: "Ethics", new_url: "https://y.com", modify_instruction: "add verification url" }

  "shorten summary and change email to meet@x.com"
  → 2 intents:
    { section: "summary", action: "rephrase", modify_instruction: "shorten to 2 lines" }
    { section: "contact", action: "modify", target_reference: "email", new_value: "meet@x.com" }

  "add these links to their respective certificates: https://x.com https://y.com"
  → INFERENCE: 2 URLs + N certs without URLs → map by ORDER (1st URL to 1st url-less cert, 2nd URL to 2nd url-less cert). Return 2 modify intents with the fuzzy-matched cert names.

FIELD GUIDANCE:

- **section** — the top-level resume section being touched:
    • summary — the top summary/profile/intro paragraph
    • education — degree, college, CGPA, coursework
    • skills — languages, tools, frameworks
    • experience — internships, jobs, work history
    • projects — projects, portfolio work
    • por — leadership roles, clubs, societies, committees
    • certifications — courses, MOOCs, credentials
    • achievements — awards, ranks, hackathons
    • coding_profiles — LeetCode, Codeforces, HackerRank, GfG
    • contact — name / email / phone / linkedin / github

- **action** — what to do to that section:
    • add — student wants a NEW item appended. Set items_to_add.
    • modify — change ONE FIELD of an EXISTING item. Set target_reference (which item — its name, role, or index) + new_value OR new_url OR modify_instruction.
    • remove — delete an item. Set target_reference.
    • rephrase — reword one string (a bullet or the summary). Set target_reference + modify_instruction.
    • reorder — change ordering within an array. Set modify_instruction.
    • replace_section — full rewrite of the section (rare; skills-only re-org).

CRITICAL DISTINCTION — "add" vs "modify":

  ADD → student wants a NEW item.
    "add a cert called AWS Solutions Architect" → action=add
    "add another project — StockPredictor" → action=add
    "also mention my Google Summer of Code experience" → action=add

  MODIFY → student wants to change a FIELD of an EXISTING item.
    "add link X to my Neural Networks cert" → action=modify (existing cert; adding URL field)
    "add github link https://github.com/x/y to my chat app project" → action=modify (existing project; adding github_url field)
    "update dates on my Razorpay experience to Jun-Aug" → action=modify (existing entry; changing dates)
    "add cgpa 8.5 to education" → action=modify (existing education; adding cgpa field)

  Rule of thumb: if the referenced item ALREADY EXISTS in the resume above, and the student is providing a value for a MISSING or WRONG FIELD, that's modify (NOT add).

- **items_to_add** (only for action=add; shape varies by section):
    • certifications → [{ "name": string, "url": string | null }]  (URL is OPTIONAL — do NOT clarify just because URL wasn't given)
    • achievements   → [string]
    • coding_profiles→ [{ "platform": string, "url": string | null, "stat": string | null }]
    • skills         → [{ "category": string, "items": [string] }]
    • projects       → [{ "name": string, "tech_stack": [string], "bullets": [string], "github_url"?: string, "demo_url"?: string }]
    • experience     → [{ "role": string, "company": string, "dates": string | null, "bullets": [string] }]
    • por            → [{ "role": string, "organization": string, "bullets": [string] }]
    • education      → [{ "degree": string, "college": string, "branch": string | null, "cgpa": string | null }]

- **target_reference** (for modify / remove / rephrase):
    A string that identifies which existing item to touch. Use the item's name/role/organization/platform as the student referred to it. Partial matches are fine — the applier does fuzzy matching. Examples:
    • For a cert: "Neural Networks" (matches "Neural Networks & Deep Learning")
    • For an experience: "Razorpay" (matches the Razorpay entry)
    • For a bullet: "2nd bullet in Razorpay" or "the coding profile bullet in achievements"
    • For contact: "email" | "phone" | "linkedin" | "github" | "name"
    • For positional selection: "first" | "last" | "1" | "2"

- **new_value** — for contact-field changes or single-value modifications (e.g. "change email to X"). Contains ONLY the new value string.
- **new_url**   — SPECIFICALLY for adding/updating a URL on an existing item (verification URL for a cert, github_url or demo_url for a project). Use this instead of new_value when the change is a URL. If a URL is a github.com/... link, treat as github_url (project) or github (contact); if it looks like a deployed app (*.streamlit.app, *.vercel.app, custom domain), treat as demo_url (project).
- **modify_instruction** — human-language description of the change, used when neither new_value nor new_url captures the intent (e.g. "shorten to 2 lines", "make more senior-sounding", "swap 2nd and 3rd bullets").

WORKED EXAMPLES (input → intents):

Ex 1: "add link https://verify.netcredential.com/roy8hcHGoM to Neural Networks & Deep Learning cert"
→ intents: [{ section: "certifications", action: "modify", target_reference: "Neural Networks & Deep Learning", new_url: "https://verify.netcredential.com/roy8hcHGoM", modify_instruction: "add verification url" }]

Ex 2: "https://x.com/a add this to Cert 1\\nhttps://x.com/b add this to Cert 2"
→ 2 intents (one per cert-URL pair).

Ex 3: "add these links to their respective certificates: https://x.com/a  https://x.com/b"
→ INFERENCE: 2 URLs and 2 url-less certs in the resume. Map by order:
  [{ section: "certifications", action: "modify", target_reference: "<name of 1st url-less cert>", new_url: "https://x.com/a", modify_instruction: "add verification url" },
   { section: "certifications", action: "modify", target_reference: "<name of 2nd url-less cert>", new_url: "https://x.com/b", modify_instruction: "add verification url" }]

Ex 4: "change my email to meet@x.com"
→ [{ section: "contact", action: "modify", target_reference: "email", new_value: "meet@x.com" }]

Ex 5: "shorten my summary and remove the 2nd bullet from Razorpay"
→ 2 intents:
  [{ section: "summary", action: "rephrase", modify_instruction: "shorten by ~30%" },
   { section: "experience", action: "remove", target_reference: "2nd bullet in Razorpay" }]

Ex 6: "Add these certificates\\n\\nNeural Networks & Deep Learning\\n\\nIntroduction to AI, Data Science & Ethics"
→ 1 intent, add action:
  [{ section: "certifications", action: "add", items_to_add: [
      { name: "Neural Networks & Deep Learning", url: null },
      { name: "Introduction to AI, Data Science & Ethics", url: null }
   ] }]

Ex 7: "move data & bi above languages in skills"
→ [{ section: "skills", action: "reorder", modify_instruction: "move Data & BI above Languages" }]

Ex 8: "add github link https://github.com/x/y to DevHab project"
→ [{ section: "projects", action: "modify", target_reference: "DevHab", new_url: "https://github.com/x/y", modify_instruction: "add github url" }]

Ex 9: "add cgpa 8.7 to my education"
→ [{ section: "education", action: "modify", target_reference: "first", new_value: "8.7", modify_instruction: "set cgpa" }]

CLARIFY-ONLY GUARDRAIL:
Set clarification_needed (top-level) with ONE short Hinglish/English question ONLY when the intent is genuinely ambiguous — e.g. "make it better", "improve this", "shorter please" without saying which section. When the instruction NAMES what to change and provides values, parse it — never punt to clarify because of missing OPTIONAL fields.

If clarification_needed is set, "intents" MUST be an empty array [].

Return ONLY the JSON. No prose, no code fence.`;

  try {
    const result = await complete({
      system,
      user: 'Think step by step about what the student is asking. Then output the intents array. If truly ambiguous, set clarification_needed instead of guessing.',
      model: EDIT_MODEL,
      maxTokens: 1600,
      temperature: 0.1,
    });
    const data = result.data || {};
    const rawIntents = Array.isArray(data.intents) ? data.intents : [];
    const intents = rawIntents.map((raw) => ({
      section: raw.section || 'unknown',
      action: raw.action || 'clarify',
      items_to_add: Array.isArray(raw.items_to_add) ? raw.items_to_add : null,
      target_reference: raw.target_reference || null,
      new_value: raw.new_value || null,
      new_url: raw.new_url || null,
      modify_instruction: raw.modify_instruction || null,
    }));
    return {
      intents,
      clarification_needed: data.clarification_needed || null,
      usage: result.usage,
    };
  } catch (e) {
    logger.warn({ err: e.message }, 'edit intent classification failed — falling back to clarify');
    return {
      intents: [],
      clarification_needed: 'Kya change karna hai? Ek line mein batao — jaise "add cert X", "shorten summary", "change email to Y".',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE 2 — Deterministic apply for one intent.
// Returns { applied, notes } — applied=false means we couldn't handle it here
// and the caller should try LLM apply next.
// ─────────────────────────────────────────────────────────────────────────
function applyDeterministic(resume, intent) {
  const { section, action, items_to_add, target_reference, new_value, new_url } = intent;

  // ── CONTACT modifications ────────────────────────────────────────────
  if (section === 'contact' && action === 'modify') {
    const inst = (intent.modify_instruction || '').toLowerCase();
    const ref = (target_reference || '').toLowerCase();
    const value = new_value || new_url || null;
    if (!value) return { applied: false };
    if (ref.includes('email') || inst.includes('email') || inst.includes('mail') || /@/.test(value)) {
      resume.email = value.trim();
      return { applied: true, notes: 'email updated' };
    }
    if (ref.includes('phone') || inst.includes('phone') || inst.includes('mobile') || inst.includes('number')) {
      resume.phone = value.trim();
      return { applied: true, notes: 'phone updated' };
    }
    if (ref.includes('linkedin') || inst.includes('linkedin') || /linkedin\.com/.test(value)) {
      resume.linkedin = value.trim();
      return { applied: true, notes: 'linkedin updated' };
    }
    if (ref.includes('github') || inst.includes('github') || /github\.com/.test(value)) {
      resume.github = value.trim();
      return { applied: true, notes: 'github updated' };
    }
    if (ref.includes('name') || inst.includes('name')) {
      resume.name = value.trim();
      return { applied: true, notes: 'name updated' };
    }
    return { applied: false };
  }

  // ── MODIFY a FIELD on an existing item ───────────────────────────────
  // This is the new path that fixes Meet's "add link X to cert Y" case.
  if (action === 'modify' && target_reference) {
    // Certifications — modify URL on an existing cert.
    if (section === 'certifications' && Array.isArray(resume.certifications) && resume.certifications.length > 0) {
      const url = new_url || (new_value && /^https?:\/\//.test(new_value) ? new_value : null);
      if (url) {
        const names = resume.certifications.map((c) => c && c.name);
        const idx = /^(first|1|1st)$/i.test(target_reference) ? 0
                  : /^(last)$/i.test(target_reference) ? resume.certifications.length - 1
                  : fuzzyMatchIndex(target_reference, names);
        if (idx >= 0) {
          resume.certifications[idx] = { ...resume.certifications[idx], url: url.trim() };
          return { applied: true, notes: `set url on cert #${idx + 1} (${names[idx]})` };
        }
      }
    }
    // Projects — modify github_url or demo_url on an existing project.
    if (section === 'projects' && Array.isArray(resume.projects) && resume.projects.length > 0) {
      const url = new_url || (new_value && /^https?:\/\//.test(new_value) ? new_value : null);
      if (url) {
        const names = resume.projects.map((p) => p && p.name);
        const idx = /^(first|1|1st)$/i.test(target_reference) ? 0
                  : /^(last)$/i.test(target_reference) ? resume.projects.length - 1
                  : fuzzyMatchIndex(target_reference, names);
        if (idx >= 0) {
          const inst = (intent.modify_instruction || '').toLowerCase();
          const isDeployed = /streamlit\.app|vercel\.app|netlify\.app|render\.com|onrender|herokuapp|railway\.app|fly\.dev|deno\.dev|pages\.dev|github\.io|live|demo/i.test(url) || inst.includes('demo') || inst.includes('live');
          const isGithub = /github\.com/i.test(url) || inst.includes('github');
          if (isGithub && !isDeployed) {
            resume.projects[idx] = { ...resume.projects[idx], github_url: url.trim() };
            return { applied: true, notes: `set github_url on project #${idx + 1} (${names[idx]})` };
          }
          if (isDeployed) {
            resume.projects[idx] = { ...resume.projects[idx], demo_url: url.trim() };
            return { applied: true, notes: `set demo_url on project #${idx + 1} (${names[idx]})` };
          }
          // Default: treat as github if unclear.
          resume.projects[idx] = { ...resume.projects[idx], github_url: url.trim() };
          return { applied: true, notes: `set github_url on project #${idx + 1} (${names[idx]})` };
        }
      }
    }
    // Education — modify cgpa / coursework / dates on an existing education entry.
    if (section === 'education' && Array.isArray(resume.education) && resume.education.length > 0) {
      const inst = (intent.modify_instruction || '').toLowerCase();
      const ref = String(target_reference).toLowerCase();
      const idx = /^(first|1|1st)$/i.test(ref) ? 0
                : /^(last)$/i.test(ref) ? resume.education.length - 1
                : 0; // education usually has just one entry
      if (new_value) {
        if (inst.includes('cgpa') || inst.includes('percentage') || /cgpa|percentage/.test(ref) || /^\d+(\.\d+)?%?$/.test(String(new_value).trim())) {
          resume.education[idx] = { ...resume.education[idx], cgpa: String(new_value).trim() };
          return { applied: true, notes: `set cgpa on education #${idx + 1}` };
        }
        if (inst.includes('coursework') || ref.includes('coursework')) {
          resume.education[idx] = { ...resume.education[idx], coursework: String(new_value).trim() };
          return { applied: true, notes: `set coursework on education #${idx + 1}` };
        }
      }
    }
    // Experience — modify dates on an existing experience entry.
    if (section === 'experience' && Array.isArray(resume.experience) && resume.experience.length > 0) {
      const inst = (intent.modify_instruction || '').toLowerCase();
      if (new_value && (inst.includes('date') || inst.includes('duration'))) {
        const names = resume.experience.map((e) => (e && (e.company || e.role)) || '');
        const idx = fuzzyMatchIndex(target_reference, names);
        if (idx >= 0) {
          resume.experience[idx] = { ...resume.experience[idx], dates: String(new_value).trim() };
          return { applied: true, notes: `set dates on experience #${idx + 1} (${names[idx]})` };
        }
      }
    }
    // Achievements — no fields to modify beyond text; fall through to LLM.
    // Fall through if nothing above matched — LLM apply handles the tail.
  }

  // ── ADD new items (existing behavior, preserved) ─────────────────────
  if (action === 'add' && Array.isArray(items_to_add) && items_to_add.length > 0) {
    if (section === 'certifications') {
      if (!Array.isArray(resume.certifications)) resume.certifications = [];
      for (const raw of items_to_add) {
        const name = String((raw && raw.name) || raw).trim();
        if (!name) continue;
        const url = raw && raw.url ? String(raw.url).trim() : null;
        if (resume.certifications.some((c) => String(c.name || '').trim().toLowerCase() === name.toLowerCase())) continue;
        resume.certifications.push({ name, url });
      }
      return { applied: true, notes: `added ${items_to_add.length} certification(s)` };
    }
    if (section === 'achievements') {
      if (!Array.isArray(resume.achievements)) resume.achievements = [];
      for (const raw of items_to_add) {
        const s = String((raw && raw.text) || raw).trim();
        if (!s) continue;
        if (resume.achievements.some((a) => String(a).trim().toLowerCase() === s.toLowerCase())) continue;
        resume.achievements.push(s);
      }
      return { applied: true, notes: `added ${items_to_add.length} achievement(s)` };
    }
    if (section === 'coding_profiles') {
      if (!Array.isArray(resume.coding_profiles)) resume.coding_profiles = [];
      for (const raw of items_to_add) {
        const platform = String((raw && raw.platform) || '').trim();
        if (!platform) continue;
        const url = raw && raw.url ? String(raw.url).trim() : null;
        const stat = raw && raw.stat ? String(raw.stat).trim() : null;
        if (resume.coding_profiles.some((c) => String(c.platform || '').trim().toLowerCase() === platform.toLowerCase())) continue;
        resume.coding_profiles.push({ platform, url, stat });
      }
      return { applied: true, notes: `added ${items_to_add.length} coding profile(s)` };
    }
    if (section === 'skills') {
      if (!Array.isArray(resume.skills)) resume.skills = [];
      for (const raw of items_to_add) {
        if (raw && raw.category && Array.isArray(raw.items)) {
          const cat = resume.skills.find((c) => String(c.category || '').toLowerCase() === String(raw.category).toLowerCase());
          if (cat) {
            const existing = new Set(cat.items.map((s) => String(s).toLowerCase()));
            for (const item of raw.items) if (!existing.has(String(item).toLowerCase())) cat.items.push(item);
          } else {
            resume.skills.push({ category: String(raw.category), items: raw.items.map(String) });
          }
        }
      }
      return { applied: true, notes: 'skills merged' };
    }
    if (section === 'experience') {
      if (!Array.isArray(resume.experience)) resume.experience = [];
      for (const raw of items_to_add) {
        if (!raw || !raw.role || !raw.company) continue;
        const key = (String(raw.role) + '@' + String(raw.company)).toLowerCase();
        if (resume.experience.some((e) => (String(e.role || '') + '@' + String(e.company || '')).toLowerCase() === key)) continue;
        resume.experience.push({
          role: String(raw.role),
          company: String(raw.company),
          location: raw.location || null,
          dates: raw.dates || null,
          tech_stack: Array.isArray(raw.tech_stack) ? raw.tech_stack : [],
          bullets: Array.isArray(raw.bullets) ? raw.bullets.map(String) : [],
        });
      }
      return { applied: true, notes: `added ${items_to_add.length} experience entry(ies)` };
    }
    if (section === 'por') {
      if (!Array.isArray(resume.por)) resume.por = [];
      for (const raw of items_to_add) {
        if (!raw || !raw.role || !raw.organization) continue;
        const key = (String(raw.role) + '@' + String(raw.organization)).toLowerCase();
        if (resume.por.some((p) => (String(p.role || '') + '@' + String(p.organization || '')).toLowerCase() === key)) continue;
        resume.por.push({
          role: String(raw.role),
          organization: String(raw.organization),
          dates: raw.dates || null,
          bullets: Array.isArray(raw.bullets) ? raw.bullets.map(String) : [],
        });
      }
      return { applied: true, notes: `added ${items_to_add.length} PoR entry(ies)` };
    }
  }

  // ── REORDER skills (deterministic patterns) ──────────────────────────
  if (action === 'reorder' && section === 'skills' && Array.isArray(resume.skills) && intent.modify_instruction) {
    const inst = String(intent.modify_instruction).toLowerCase();
    const mMove = inst.match(/(?:move|put)\s+["']?([^"']+?)["']?\s+(?:above|before|over|on\s+top\s+of)\s+["']?([^"']+?)["']?(?:$|\s)/i);
    if (mMove) {
      const target = mMove[1].trim().toLowerCase();
      const anchor = mMove[2].trim().toLowerCase();
      const targetIdx = resume.skills.findIndex((c) => String(c.category || '').toLowerCase().includes(target));
      const anchorIdx = resume.skills.findIndex((c) => String(c.category || '').toLowerCase().includes(anchor));
      if (targetIdx >= 0 && anchorIdx >= 0 && targetIdx !== anchorIdx) {
        const [item] = resume.skills.splice(targetIdx, 1);
        const insertAt = targetIdx < anchorIdx ? anchorIdx - 1 : anchorIdx;
        resume.skills.splice(insertAt, 0, item);
        return { applied: true, notes: `reordered skills: ${mMove[1]} moved above ${mMove[2]}` };
      }
    }
    const mFirst = inst.match(/(?:put|move|make)\s+["']?([^"']+?)["']?\s+(?:first|to\s+(?:the\s+)?top|at\s+(?:the\s+)?top)/i);
    if (mFirst) {
      const target = mFirst[1].trim().toLowerCase();
      const targetIdx = resume.skills.findIndex((c) => String(c.category || '').toLowerCase().includes(target));
      if (targetIdx > 0) {
        const [item] = resume.skills.splice(targetIdx, 1);
        resume.skills.unshift(item);
        return { applied: true, notes: `reordered skills: ${mFirst[1]} moved to top` };
      }
    }
  }

  // ── REMOVE items (by target reference) ───────────────────────────────
  if (action === 'remove' && target_reference && ['certifications', 'achievements', 'coding_profiles', 'projects', 'experience', 'por', 'education'].includes(section)) {
    const ref = String(target_reference).toLowerCase();
    const arr = resume[section];
    if (!Array.isArray(arr)) return { applied: false };
    const before = arr.length;
    resume[section] = arr.filter((item) => {
      if (typeof item === 'string') return !item.toLowerCase().includes(ref);
      if (item && typeof item === 'object') {
        const name = String(item.name || item.role || item.platform || item.college || '').toLowerCase();
        return !name.includes(ref);
      }
      return true;
    });
    const removed = before - resume[section].length;
    if (removed === 0) return { applied: false, notes: 'no matching item found' };
    return { applied: true, notes: `removed ${removed} item(s) from ${section}` };
  }

  return { applied: false };
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE 2b — LLM apply for the rephrase/modify(complex)/reorder/replace_section paths.
// One LLM call, tightly scoped to a single intent.
// ─────────────────────────────────────────────────────────────────────────
async function applyWithLlm({ rewritten, instruction, intent, jd }) {
  const system = `You are a senior resume editor with 15 years of experience. You are editing a finalized resume JSON to apply ONE specific change from the classified intent. Reason carefully — this student is trusting you to be precise.

${jdLine(jd)}

CLASSIFIED INTENT (from Stage 1 — authoritative):
${JSON.stringify(intent, null, 2)}

RAW student instruction (for tone/nuance):
"""${String(instruction)}"""

YOUR PROCESS (do this step-by-step in your head before emitting output):

1. UNDERSTAND — What is the student asking to change? Which specific item(s), which field?
2. LOCATE — In the current resume JSON, find the exact section + item(s) that match the intent's target_reference. Use fuzzy matching (case-insensitive substring, word overlap) when the reference isn't exact.
3. APPLY — Make the targeted change. Preserve markdown \`**bold**\` markers on any bullets you touch. Preserve verbatim any field NOT part of the change.
4. VERIFY — Before returning, mentally check:
   (a) Did any OTHER section change accidentally? If yes, revert those.
   (b) Did you invent any fact / metric / tool / outcome the student did not provide? If yes, remove.
   (c) Are all input metrics still present with their bold markers?
   (d) Does the resume schema match the original shape?

ABSOLUTE RULES:
1. Apply ONLY the change described by the intent. Every other field must round-trip byte-identical.
2. NEVER invent facts, metrics, companies, skills, achievements, tools, or outcomes. If the intent asks for a change but the value/detail requires information the student did not provide, return the resume UNCHANGED and set clarification_needed to a short one-line question (Hinglish or English, Latin script).
3. Preserve markdown \`**bold**\` markers on bullets you touch. Preserve every input metric verbatim.
4. PROJECT LINKS: github_url is a github.com repo; demo_url is a deployed URL (*.streamlit.app, *.vercel.app, *.netlify.app, *.pages.dev, custom domain, "live"/"demo" phrasing). Route by kind; keep the other field.
5. When rephrasing, keep the SAME facts but change the wording. Do not add new metrics or new claims.
6. For 'remove' actions: if you cannot find the target with reasonable confidence, DO NOT delete anything — return clarification_needed asking the student to specify which item.

CURRENT resume JSON:
${JSON.stringify(rewritten)}

Return JSON only:
{ "resume": <FULL resume JSON in the same schema>, "clarification_needed": string | null }`;

  let result = await complete({
    system,
    user: 'Reason through the process (understand → locate → apply → verify), then return the JSON with the change applied.',
    model: EDIT_MODEL,
    maxTokens: 3000,
    temperature: 0.12,
  });
  let out = result.data || {};
  if (!out.resume && !out.clarification_needed) {
    logger.warn({ intentSection: intent.section, intentAction: intent.action }, 'LLM apply returned empty; retrying at lower temperature');
    result = await complete({
      system,
      user: 'Retry. Reason through the process step-by-step. Return the FULL resume JSON with the change applied, in the same schema.',
      model: EDIT_MODEL,
      maxTokens: 3000,
      temperature: 0.05,
    });
    out = result.data || {};
  }
  return { resume: out.resume || null, clarification_needed: out.clarification_needed || null, usage: result.usage };
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE 3 — Structural integrity guard.
// ─────────────────────────────────────────────────────────────────────────
function integrityGuard(resume, rewritten, instruction, intents = []) {
  if (!resume) return resume;
  // Any section the CLASSIFIER explicitly targeted is legitimately being
  // modified — do not restore it. Static-alias matching on the raw
  // instruction misses cases like "REMOVE DATA ANALYST" where the alias
  // list doesn't contain "data analyst" but the intent clearly targets
  // section=experience. Trust the classifier's decision.
  const intentSections = new Set(
    (Array.isArray(intents) ? intents : [])
      .map((i) => (i && i.section) || null)
      .filter(Boolean)
  );
  for (const f of GUARDED_SECTIONS) {
    const had = !isEmptyValue(rewritten[f]);
    const has = !isEmptyValue(resume[f]);
    const mentioned = intentSections.has(f) || instructionReferences(instruction, f);
    // Contact fields (name/email/phone/linkedin/github) are grouped under
    // 'contact' at intent level — treat as intent-targeted if any contact
    // intent exists.
    const contactField = ['name', 'email', 'phone', 'linkedin', 'github'].includes(f);
    const contactTouched = contactField && intentSections.has('contact');
    if (had && !has && !mentioned && !contactTouched) {
      logger.warn({ field: f, instructionHead: String(instruction).slice(0, 80) }, 'edit dropped unrelated section — restoring from original');
      resume[f] = rewritten[f];
      continue;
    }
    if (Array.isArray(rewritten[f]) && Array.isArray(resume[f])
        && resume[f].length < rewritten[f].length
        && !mentioned && !contactTouched) {
      logger.warn({ field: f, oldLen: rewritten[f].length, newLen: resume[f].length, instructionHead: String(instruction).slice(0, 80) }, 'edit shrunk unrelated section — restoring from original');
      resume[f] = rewritten[f];
    }
  }
  if (Array.isArray(resume.projects))   resume.projects   = dedupeByName(resume.projects,   'projects');
  if (Array.isArray(resume.experience)) resume.experience = dedupeByName(resume.experience, 'experience');
  return resume;
}

// Track whether an intent actually mutated the resume — used for
// anti-silent-drop enforcement. Compares JSON stringifications of the relevant
// section before vs after applying the intent.
function didIntentMutate(before, after, section) {
  if (!section || section === 'unknown') return false;
  if (section === 'contact') {
    return before.name !== after.name || before.email !== after.email || before.phone !== after.phone
        || before.linkedin !== after.linkedin || before.github !== after.github;
  }
  return JSON.stringify(before[section]) !== JSON.stringify(after[section]);
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC — the edit-loop callsite calls this.
// ─────────────────────────────────────────────────────────────────────────
async function applyEdit({ rewritten, instruction, jdRole, jdText, jdGeneric }) {
  if (!rewritten) throw new Error('applyEdit: rewritten resume required');
  if (!instruction || !String(instruction).trim()) {
    return { data: null, clarification_needed: 'Kya change karna hai? Ek line mein batao.', usage: null };
  }
  const jd = { jdRole, jdText, jdGeneric };

  // Stage 1: classify — returns array of intents.
  const cls = await classifyIntent({ rewritten, instruction, jd });
  logger.info({
    intentCount: cls.intents.length,
    intents: cls.intents.map((i) => ({ section: i.section, action: i.action })),
    clar: !!cls.clarification_needed,
  }, 'edit intents classified');

  if (cls.clarification_needed) {
    return { data: null, clarification_needed: cls.clarification_needed, usage: cls.usage };
  }
  if (!cls.intents.length) {
    return { data: null, clarification_needed: 'Kya change karna hai? Thoda specific batao.', usage: cls.usage };
  }

  // Stage 2: apply each intent INDEPENDENTLY. One intent's failure doesn't
  // abort the whole batch — that would make "shorten summary AND change email"
  // fail-all-or-nothing which is exactly the ChatGPT-anti-pattern. Instead,
  // collect per-intent outcomes; if any succeed, return the merged result and
  // report which intents failed in the clarification.
  let resume = JSON.parse(JSON.stringify(rewritten));
  const notes = [];
  const perIntentClarify = [];
  let anyMutation = false;
  let llmApplyUsed = false;
  let applyUsage = null;

  for (let ii = 0; ii < cls.intents.length; ii++) {
    const intent = cls.intents[ii];
    const before = JSON.parse(JSON.stringify(resume));

    const det = applyDeterministic(resume, intent);
    if (det.applied) {
      const mutated = didIntentMutate(before, resume, intent.section);
      if (mutated) {
        anyMutation = true;
        notes.push(det.notes || `${intent.action} on ${intent.section}`);
      } else {
        // Deterministic reported success but nothing actually changed. Log a
        // per-intent failure but keep going — other intents in the batch may
        // still succeed.
        perIntentClarify.push(`${intent.section} ${intent.action}: no matching item`);
      }
      continue;
    }

    // Fall through to LLM apply for this intent.
    let llmRes;
    try {
      llmRes = await applyWithLlm({ rewritten: resume, instruction, intent, jd });
    } catch (e) {
      logger.warn({ intentSection: intent.section, intentAction: intent.action, err: e.message }, 'LLM apply threw — logging and continuing to next intent');
      perIntentClarify.push(`${intent.section} ${intent.action}: apply error`);
      continue;
    }
    llmApplyUsed = true;
    applyUsage = llmRes.usage;
    if (llmRes.clarification_needed) {
      perIntentClarify.push(`${intent.section} ${intent.action}: ${String(llmRes.clarification_needed).slice(0, 80)}`);
      continue;
    }
    if (!llmRes.resume) {
      perIntentClarify.push(`${intent.section} ${intent.action}: apply returned empty`);
      continue;
    }
    resume = llmRes.resume;
    if (didIntentMutate(before, resume, intent.section)) {
      anyMutation = true;
      notes.push(`llm-applied ${intent.action} on ${intent.section}`);
    } else {
      perIntentClarify.push(`${intent.section} ${intent.action}: no observable change`);
    }
  }

  // Anti-silent-drop enforcement — if NOT A SINGLE intent produced a mutation,
  // return clarification. If SOME succeeded, ship the partial result.
  if (!anyMutation) {
    logger.warn({ instructionHead: String(instruction).slice(0, 80), intentCount: cls.intents.length, perIntentClarify }, 'edit intents produced no mutation — asking clarify');
    return {
      data: null,
      clarification_needed: 'Change apply nahi hua — thoda aur specific batao, jaise item ka poora naam ya field.',
      usage: cls.usage,
    };
  }

  // Defensive: preserve phone from prior version if the LLM dropped it.
  if (resume && rewritten.phone && !resume.phone) resume.phone = rewritten.phone;

  // Stage 3: integrity guard — pass the classified intents so sections
  // legitimately targeted are trusted (fixes the "REMOVE DATA ANALYST" case).
  integrityGuard(resume, rewritten, instruction, cls.intents);

  return {
    data: resume,
    clarification_needed: null,
    usage: {
      intent: cls.usage || null,
      apply: applyUsage,
      llmApplyUsed,
      intentCount: cls.intents.length,
      notes,
    },
  };
}

module.exports = { applyEdit, classifyIntent, applyDeterministic, applyWithLlm, integrityGuard, fuzzyMatchIndex };
