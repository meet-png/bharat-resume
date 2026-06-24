// Targeted edit pass. PRD §7.3 / §5 Phase 4 (edit loop, Day 5.3).
// Takes the ALREADY-rewritten resume JSON + one free-text change request and
// returns the SAME schema with ONLY that change applied. Never invents facts,
// never touches unrelated sections. On ambiguity or a request that would require
// fabricating data, returns the resume unchanged + a short clarification.
const { complete } = require('./client');
const logger = require('../logger');

// Sections we structurally guard: if the LLM drops/shrinks any of these for an
// edit that didn't reference the section, we restore from the pre-edit value.
// Surfaced by live-test 2026-06-24: adding an Experience caused the entire
// Projects section to disappear from the rendered PDF (LLM moved projects into
// experience and emitted projects:[]). Guard makes that class of failure
// invisible to the student.
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

// Two structural failures we've observed: (1) LLM emits a section as empty
// when it shouldn't, (2) LLM duplicates an existing entry in projects (or
// experience) with a thinner version. Dedup is case-insensitive on name; the
// LONGER entry wins (more bullets / more tech_stack), under the assumption
// that the LLM's "thinner duplicate" is the corruption, not the original.
function dedupeByName(arr, label) {
  if (!Array.isArray(arr)) return arr;
  const seen = new Map(); // key: lowercased trimmed name → index in `out`
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

// Returns { data: <full resume schema> | null, clarification_needed: string | null, usage }.
async function applyEdit({ rewritten, instruction, jdRole, jdText, jdGeneric }) {
  if (!rewritten) throw new Error('applyEdit: rewritten resume required');
  if (!instruction || !String(instruction).trim()) {
    return { data: null, clarification_needed: 'Kya change karna hai? Ek line mein batao.', usage: null };
  }

  const system = `You edit an already-finalized resume JSON for an Indian student. You are given the CURRENT resume JSON and ONE change request. Apply ONLY that change and return the COMPLETE resume JSON in the exact same schema.

${jdLine({ jdRole, jdText, jdGeneric })}

ABSOLUTE RULES:
1. NEVER invent facts, metrics, companies, skills, or achievements. If the change asks to ADD something the student gives no real detail for (e.g. "add a Google internship" with no specifics), do NOT fabricate — set clarification_needed asking for the concrete detail and return the resume UNCHANGED.
2. Touch ONLY what the request asks for. Every other field must come back byte-for-byte identical. Do not re-write, re-order, or "improve" unrelated bullets/sections.
3. Preserve formatting: bullets are plain strings that keep their \`**bold**\` markdown markers around metrics. Keep that convention on any bullet you add or modify.
4. If the request is a genuine edit you can apply from given information (rephrase a bullet, fix a typo, change CGPA the student now states, remove a project, reorder skills, shorten the summary), apply it and set clarification_needed = null.
5. If the request is ambiguous or you cannot tell what to change, return the resume unchanged + a one-line clarification.
6. PROJECT LINKS: each project has two link fields — "github_url" (a github.com repo) and "demo_url" (a deployed/live URL: *.streamlit.app, *.vercel.app, *.netlify.app, a custom domain, or anything the student calls a "live"/"demo"/"deployed" link). When the student asks to add a link to a project, put it in the CORRECT field by its kind, and KEEP any existing link in the other field (adding a demo link must not erase the github link, and vice versa). Match the project by the name the student references.

CURRENT resume JSON:
${JSON.stringify(rewritten)}

Return ONLY valid JSON in this shape (no prose, no markdown fences):
{ "resume": <the FULL resume JSON in the same schema as above>, "clarification_needed": string | null }

VOICE for clarification_needed: Hinglish or English, Latin script only, one short warm sentence (goes straight to WhatsApp).`;

  const result = await complete({ system, user: String(instruction), maxTokens: 2400, temperature: 0.2 });
  const out = result.data || {};
  const clarification = out.clarification_needed || null;
  const resume = clarification ? null : (out.resume || null);

  // Defensive: preserve the contact phone from the prior version — an edit must
  // never drop or alter it unless explicitly asked (and the student can't change
  // their WhatsApp-derived number via chat anyway).
  if (resume && rewritten.phone && !resume.phone) resume.phone = rewritten.phone;

  // STRUCTURAL INTEGRITY GUARD (added 2026-06-24 after live-test "added one
  // Experience → Projects section disappeared"). For every guarded section: if
  // the original had content, the edit instruction did NOT reference that
  // section, and the LLM output dropped or SHRUNK it, restore from original.
  // Catches the class of failures where editing one section silently
  // corrupts unrelated structure.
  if (resume) {
    for (const f of GUARDED_SECTIONS) {
      const had = !isEmptyValue(rewritten[f]);
      const has = !isEmptyValue(resume[f]);
      const mentioned = instructionReferences(instruction, f);
      if (had && !has && !mentioned) {
        logger.warn({ field: f, instructionHead: String(instruction).slice(0, 80) }, 'edit dropped unrelated section — restoring from original');
        resume[f] = rewritten[f];
        continue;
      }
      // For array sections, also catch a SHRUNK array (LLM moved entries or
      // lost them mid-edit). Strict: shrink without instruction reference = restore.
      if (Array.isArray(rewritten[f]) && Array.isArray(resume[f])
          && resume[f].length < rewritten[f].length
          && !mentioned) {
        logger.warn({ field: f, oldLen: rewritten[f].length, newLen: resume[f].length, instructionHead: String(instruction).slice(0, 80) }, 'edit shrunk unrelated section — restoring from original');
        resume[f] = rewritten[f];
      }
    }
    // Dedup duplicate entries in projects + experience (LLM occasionally
    // emits a second thinner copy of an existing entry).
    if (Array.isArray(resume.projects))   resume.projects   = dedupeByName(resume.projects,   'projects');
    if (Array.isArray(resume.experience)) resume.experience = dedupeByName(resume.experience, 'experience');
  }

  return { data: resume, clarification_needed: clarification, usage: result.usage };
}

module.exports = { applyEdit };
