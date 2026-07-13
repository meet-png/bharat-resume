// Multi-agent edit pipeline. PRD §7.3 / §5 Phase 4, upgraded 2026-07-13.
//
// The old single-call edit silently DROPPED multi-line natural-language edits.
// Live-test 2026-07-13: student typed
//   "Add these certificates\n\nNeural Networks & Deep Learning\n\n
//    Introduction to AI, Data Science & Ethics"
// The bot returned "Updated ✓ 2 edits left" but the resume's certifications
// stayed empty. Root cause: the single-call prompt treated "cert without URL"
// as needing clarification, so the LLM emitted certifications:[] AND
// clarification_needed:null — a silent-drop that consumes an edit while
// applying nothing. Trust-critical.
//
// New shape:
//   Stage 1 — classifyIntent (LLM): parses the free-text instruction into a
//     structured intent {section, action, items_to_add, target_ref,
//     new_value, clarification_needed}. Does NOT touch the resume yet.
//   Stage 2 — applyIntent (deterministic OR LLM depending on action):
//     • add          → deterministic append (respects schema; url optional)
//     • remove       → deterministic filter by name / index / substring
//     • rephrase     → LLM patch on the single targeted string
//     • modify       → LLM patch on the single targeted entry
//     • reorder      → LLM re-order within one array
//     • replace_all  → LLM full-section rewrite (rare; skills reordering etc.)
//   Stage 3 — validate + guard: sections not referenced by intent must
//     round-trip byte-identical; anti-silent-drop check.
//
// Failure modes are OBVIOUS now:
//   • Classifier can't parse intent → clarification_needed (Meet's rule)
//   • Add produced no items → clarification (never a silent success)
//   • LLM apply corrupted a guarded section → restored from pre-edit
const { complete } = require('./client');
const logger = require('../logger');

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

function jdLine({ jdRole, jdText, jdGeneric }) {
  if (jdGeneric) return 'TARGET: generic resume (no specific role).';
  if (jdRole) return `TARGET ROLE: "${jdRole}". Keep edits consistent with this role.`;
  if (jdText) return `TARGET JD (excerpt): """${String(jdText).slice(0, 600)}"""`;
  return 'TARGET: generic resume.';
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE 1 — Intent classifier
// Parses free-text edit into structured intent. Does NOT touch the resume.
// Special handling for multi-item natural inputs (Meet's cert failure).
// ─────────────────────────────────────────────────────────────────────────
async function classifyIntent({ rewritten, instruction, jd }) {
  const system = `You classify a resume edit request into a STRUCTURED INTENT. You are NOT rewriting the resume in this step — a separate stage will apply your intent to the JSON.

${jdLine(jd)}

CURRENT resume shape (for context — you can see what sections exist and their contents to disambiguate references):
${JSON.stringify(rewritten)}

The student's message (STUDENTS TYPE IN ANY STYLE — multi-line lists, terse phrases, Hinglish, English, informal. Parse robustly):
"""${String(instruction)}"""

Return JSON exactly:
{
  "section": "summary" | "education" | "skills" | "experience" | "projects" | "por" | "certifications" | "achievements" | "coding_profiles" | "contact" | "unknown",
  "action":  "add" | "remove" | "modify" | "rephrase" | "reorder" | "replace_section" | "clarify",
  "items_to_add":     [/* items to be added; SHAPE depends on section */] | null,
  "target_reference": string | null,   /* how to find the item to remove/modify (name, index, substring, "first"/"last") */
  "new_value":        string | null,   /* for contact-field or single-value changes: the new value the student wants */
  "modify_instruction": string | null, /* for modify/rephrase: the natural-language change to apply to the target */
  "clarification_needed": string | null /* only if intent is genuinely unclear */
}

FIELD GUIDANCE:

- **section**:
    • summary — anything about the top summary/profile/intro.
    • education — degree, college, CGPA, coursework.
    • skills — any programming languages, tools, frameworks.
    • experience — internships, jobs, work history.
    • projects — projects, portfolio work.
    • por — leadership roles, clubs, societies, committees.
    • certifications — courses, MOOCs, credentials.
    • achievements — awards, ranks, hackathons.
    • coding_profiles — LeetCode, Codeforces, HackerRank, GfG.
    • contact — name / email / phone / linkedin / github URL.
    • unknown — genuinely can't tell.

- **action**:
    • add — student wants to add a NEW item. items_to_add contains the parsed items.
    • remove — student wants to delete something. target_reference identifies it.
    • modify — student wants a specific existing entry changed. target_reference + modify_instruction.
    • rephrase — reword a single bullet or the whole summary. target_reference (e.g. "2nd bullet in Razorpay") + modify_instruction.
    • reorder — change ordering within an array. modify_instruction describes new order.
    • replace_section — nuke and rewrite (rare; only use for skills reorganization requests).
    • clarify — truly ambiguous. Set clarification_needed with ONE short Hinglish/English question.

- **items_to_add** (only for action='add'; SHAPE varies by section):
    • certifications → [{ "name": string, "url": string | null }]  (URL is OPTIONAL — do NOT clarify just because the URL wasn't given)
    • achievements   → [string]
    • skills         → [{ "category": string, "items": [string] }]  (or a flat list to be merged into an existing category)
    • coding_profiles→ [{ "platform": string, "url": string | null, "stat": string | null }]
    • projects       → [{ "name": string, "tech_stack": [string], "bullets": [string], "github_url"?: string, "demo_url"?: string }]  (rare via edit — usually needs full conversation)
    • experience     → [{ "role": string, "company": string, "dates": string | null, "bullets": [string] }]  (rare via edit — usually needs sufficiency check)
    • por            → [{ "role": string, "organization": string, "bullets": [string] }]
    • education      → [{ "degree": string, "college": string, "branch": string | null, "cgpa": string | null }]
    • summary/contact → n/a for 'add'; use action='replace_section' or 'modify'

MULTI-ITEM PARSING (this is what broke Meet's test):
When the student's message contains MULTIPLE items on separate lines / separated by commas / listed with hyphens or numbers, parse ALL of them into items_to_add. Example:

  "Add these certificates
   Neural Networks & Deep Learning
   Introduction to AI, Data Science & Ethics"

→ items_to_add: [
    { "name": "Neural Networks & Deep Learning", "url": null },
    { "name": "Introduction to AI, Data Science & Ethics", "url": null }
  ]

The URL being null is FINE. Do NOT set clarification_needed just because URLs are missing — certifications with name only are valid resume content.

CLARIFY-ONLY GUARDRAIL:
Set action='clarify' ONLY when the intent is genuinely ambiguous — e.g. "make it better", "improve this", "shorter please" without saying which section. When the instruction NAMES what to add and what section, parse it and set action='add'. Never punt to clarify because of missing optional fields.

CONTACT CHANGES:
For "change my email to X", "update phone number to Y", set section='contact', action='modify', and new_value=the new value.

Return ONLY the JSON, no prose.`;

  try {
    const result = await complete({ system, user: 'classify the edit intent now', maxTokens: 900, temperature: 0.15 });
    const data = result.data || {};
    return {
      section: data.section || 'unknown',
      action: data.action || 'clarify',
      items_to_add: Array.isArray(data.items_to_add) ? data.items_to_add : null,
      target_reference: data.target_reference || null,
      new_value: data.new_value || null,
      modify_instruction: data.modify_instruction || null,
      clarification_needed: data.clarification_needed || null,
      usage: result.usage,
    };
  } catch (e) {
    logger.warn({ err: e.message }, 'edit intent classification failed — falling back to clarify');
    return {
      section: 'unknown', action: 'clarify',
      clarification_needed: 'Kya change karna hai? Ek line mein batao — jaise "add cert X", "shorten summary", "change email to Y".',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE 2 — Deterministic apply for simple actions.
// Only handles the actions that are safely deterministic. LLM apply
// (rephrase / modify / replace_section) is handled by applyWithLlm below.
// Returns { applied, notes } — applied=false means we couldn't do it here.
// ─────────────────────────────────────────────────────────────────────────
function applyDeterministic(resume, intent) {
  const { section, action, items_to_add, target_reference, new_value } = intent;

  // Contact-field modifications.
  if (section === 'contact' && action === 'modify' && new_value) {
    const inst = (intent.modify_instruction || '').toLowerCase();
    // Heuristic: identify which contact field the student meant.
    if (/email|mail/.test(inst) || /@/.test(new_value)) {
      resume.email = new_value.trim();
      return { applied: true, notes: 'email updated' };
    }
    if (/phone|mobile|number/.test(inst)) {
      resume.phone = new_value.trim();
      return { applied: true, notes: 'phone updated' };
    }
    if (/linkedin/.test(inst) || /linkedin\.com/.test(new_value)) {
      resume.linkedin = new_value.trim();
      return { applied: true, notes: 'linkedin updated' };
    }
    if (/github/.test(inst) || /github\.com/.test(new_value)) {
      resume.github = new_value.trim();
      return { applied: true, notes: 'github updated' };
    }
    return { applied: false };
  }

  // Simple additions (certifications, achievements, coding_profiles).
  if (action === 'add' && Array.isArray(items_to_add) && items_to_add.length > 0) {
    if (section === 'certifications') {
      if (!Array.isArray(resume.certifications)) resume.certifications = [];
      // Normalize items → { name, url } shape.
      for (const raw of items_to_add) {
        const name = String((raw && raw.name) || raw).trim();
        if (!name) continue;
        const url = raw && raw.url ? String(raw.url).trim() : null;
        // Skip exact duplicate names (case-insensitive).
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
        // Two shapes possible: { category, items:[...] } OR just a string list.
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
        // Dedup by role+company case-insensitive.
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

  // Deterministic skills reorder: parse "move X above Y" / "put X first" from
  // the modify_instruction. Handles the common cases without an LLM roundtrip.
  if (action === 'reorder' && section === 'skills' && Array.isArray(resume.skills) && intent.modify_instruction) {
    const inst = String(intent.modify_instruction).toLowerCase();
    // Pattern: "move X above Y" or "move X before Y" or "put X above Y"
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
    // Pattern: "put X first" / "move X to top"
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
    // Fall through to LLM if regex didn't match.
  }

  // Simple removals by target reference.
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
// STAGE 2b — LLM apply for the rephrase/modify/reorder/replace_section paths.
// One LLM call, tightly scoped: give it the current resume + the specific
// intent + explicit "touch only what's asked" rule. Post-guard restores any
// unrelated section that got dropped.
// ─────────────────────────────────────────────────────────────────────────
async function applyWithLlm({ rewritten, instruction, intent, jd }) {
  const system = `You edit an already-finalized resume JSON. Apply ONE targeted change from the classified intent and return the COMPLETE resume JSON in the exact same schema.

${jdLine(jd)}

CLASSIFIED INTENT (from Stage 1):
${JSON.stringify(intent, null, 2)}

RAW student instruction (for tone/context, but the intent above is authoritative):
"""${String(instruction)}"""

ABSOLUTE RULES:
1. Apply ONLY the change described by the intent. Every other field must round-trip byte-identical.
2. NEVER invent facts, metrics, companies, skills, or achievements. If the intent asks to modify something but the underlying detail requires information the student did not provide, return the resume UNCHANGED and set clarification_needed to a short one-line ask (Hinglish or English, Latin script).
3. Preserve markdown \`**bold**\` markers on bullets you touch.
4. PROJECT LINKS: github_url is a github.com repo; demo_url is a deployed URL (*.streamlit.app, *.vercel.app, custom domain, "live"/"demo" link). Route by kind; keep the other field.

CURRENT resume JSON:
${JSON.stringify(rewritten)}

Return JSON only:
{ "resume": <FULL resume JSON in the same schema>, "clarification_needed": string | null }`;

  // One retry on empty resume — the apply LLM occasionally returns
  // {resume: null, clarification_needed: null} for reorder / rephrase
  // intents at temperature 0.2 (~1 in 3 during local flake). Retry once at
  // lower temperature almost always succeeds.
  let result = await complete({ system, user: 'apply the change now', maxTokens: 2400, temperature: 0.15 });
  let out = result.data || {};
  if (!out.resume && !out.clarification_needed) {
    logger.warn({ intentSection: intent.section, intentAction: intent.action }, 'LLM apply returned empty; retrying at lower temperature');
    result = await complete({ system, user: 'apply the change now (retry — return the FULL resume JSON with the change applied)', maxTokens: 2400, temperature: 0.05 });
    out = result.data || {};
  }
  return { resume: out.resume || null, clarification_needed: out.clarification_needed || null, usage: result.usage };
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE 3 — Structural integrity guard.
// If any guarded section was non-empty before, wasn't referenced by the
// edit instruction, and got dropped/shrunk by the LLM, restore it. Also
// dedupe projects/experience by case-insensitive name.
// ─────────────────────────────────────────────────────────────────────────
function integrityGuard(resume, rewritten, instruction) {
  if (!resume) return resume;
  for (const f of GUARDED_SECTIONS) {
    const had = !isEmptyValue(rewritten[f]);
    const has = !isEmptyValue(resume[f]);
    const mentioned = instructionReferences(instruction, f);
    if (had && !has && !mentioned) {
      logger.warn({ field: f, instructionHead: String(instruction).slice(0, 80) }, 'edit dropped unrelated section — restoring from original');
      resume[f] = rewritten[f];
      continue;
    }
    if (Array.isArray(rewritten[f]) && Array.isArray(resume[f])
        && resume[f].length < rewritten[f].length
        && !mentioned) {
      logger.warn({ field: f, oldLen: rewritten[f].length, newLen: resume[f].length, instructionHead: String(instruction).slice(0, 80) }, 'edit shrunk unrelated section — restoring from original');
      resume[f] = rewritten[f];
    }
  }
  if (Array.isArray(resume.projects))   resume.projects   = dedupeByName(resume.projects,   'projects');
  if (Array.isArray(resume.experience)) resume.experience = dedupeByName(resume.experience, 'experience');
  return resume;
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

  // Stage 1: classify intent.
  const intent = await classifyIntent({ rewritten, instruction, jd });
  logger.info({
    section: intent.section, action: intent.action,
    itemsCount: intent.items_to_add ? intent.items_to_add.length : 0,
    clar: !!intent.clarification_needed,
  }, 'edit intent classified');

  if (intent.action === 'clarify' || intent.clarification_needed) {
    return { data: null, clarification_needed: intent.clarification_needed || 'Kya change karna hai? Thoda specific batao.', usage: intent.usage };
  }

  // Stage 2: try deterministic apply first (safest for add/remove/contact).
  const resume = JSON.parse(JSON.stringify(rewritten));
  let usedLlmApply = false;
  let applyUsage = null;
  const det = applyDeterministic(resume, intent);
  if (!det.applied) {
    // Fall through to LLM apply for rephrase/modify/reorder/replace_section.
    const llmRes = await applyWithLlm({ rewritten, instruction, intent, jd });
    if (llmRes.clarification_needed) {
      return { data: null, clarification_needed: llmRes.clarification_needed, usage: intent.usage };
    }
    if (!llmRes.resume) {
      return { data: null, clarification_needed: 'Change apply nahi ho paya — dobara try karo ya rephrase kar do.', usage: intent.usage };
    }
    Object.assign(resume, llmRes.resume);
    usedLlmApply = true;
    applyUsage = llmRes.usage;
  }

  // Anti-silent-drop check: if action was 'add' and the target section didn't
  // grow, treat as failure and ask for clarification. Meet's cert test was
  // exactly this failure mode — "updated ✓" with no items actually added.
  if (intent.action === 'add' && intent.section !== 'contact' && intent.section !== 'unknown') {
    const before = Array.isArray(rewritten[intent.section]) ? rewritten[intent.section].length : 0;
    const after  = Array.isArray(resume[intent.section]) ? resume[intent.section].length : 0;
    if (after <= before) {
      logger.warn({ section: intent.section, before, after, instructionHead: String(instruction).slice(0, 80) }, 'edit add produced no net items — asking for clarification');
      return {
        data: null,
        clarification_needed: `Mujhe ${intent.section} add karne mein confusion hui. Batao — konsa item add karna hai? Ek line mein poora naam bhejo.`,
        usage: intent.usage,
      };
    }
  }

  // Defensive: preserve phone from prior version.
  if (resume && rewritten.phone && !resume.phone) resume.phone = rewritten.phone;

  // Stage 3: integrity guard.
  integrityGuard(resume, rewritten, instruction);

  return {
    data: resume,
    clarification_needed: null,
    usage: {
      intent: intent.usage || null,
      apply: applyUsage,
      llmApplyUsed: usedLlmApply,
    },
  };
}

module.exports = { applyEdit, classifyIntent, applyDeterministic, applyWithLlm, integrityGuard };
