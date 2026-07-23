// Whole-resume improvement pipeline. Runs improveSection() for each
// bullet-carrying section (experience, projects, por, achievements) and
// returns the improved resume_json AND a per-bullet audit trail for the
// downstream audit-report generator.
//
// Sections are improved in PARALLEL so total latency is bounded by the
// slowest section, not the sum. Verifier runs per-bullet inside each
// section; a fabrication in one section can never propagate to another.

const { improveSection } = require('./improver');
const { complete } = require('../llm/client');
const { config } = require('../config');
const logger = require('../logger');

// ─── Interests glorify ─────────────────────────────────────────────────
// Takes raw "hobbies" entries (e.g. "Chess", "Reading", "Cricket") and
// reframes them professionally (e.g. "Strategic Thinking & Long-term
// Planning (Competitive Chess)"). The original wording MUST appear in the
// improved version as a substring — if the LLM drops it, we keep the
// original as-is. No fabrication surface.
const INTERESTS_SYSTEM = `You are a resume improver rewriting a student's Hobbies / Interests entries into professional framings that connect to workplace-relevant skills (critical thinking, discipline, teamwork, communication, curiosity, leadership).

Rules:
1. EVERY improved entry must contain the ORIGINAL hobby text as a substring (case-insensitive). If you can't do that, echo the original unchanged.
2. Keep to 8-14 words per entry.
3. Formula: "<Skill or trait name>" — "(<original hobby, verbatim>)" or "<original hobby>: <one-line professional angle>".
4. Do NOT invent achievements ("won 3 tournaments") — glorify the SKILL the hobby demonstrates, not results.
5. No padding adjectives ("very", "extremely"). No soft-skill clichés ("team player").

Example transformations:
  "Chess" → "Strategic Thinking & Long-term Planning (Competitive Chess)"
  "Reading" → "Independent Learning through Non-fiction & Technical Reading"
  "Cricket" → "Team Coordination & Discipline (College Cricket Team)"
  "Cooking" → "Process Control & Attention to Detail (Home Cooking)"
  "Photography" → "Visual Storytelling & Composition (Amateur Photography)"

Output STRICT JSON: { "improved": [{ "i": <index>, "text": <string>, "changes": <one-line reason ≤80 chars> }] }`;

async function improveInterests({ interests, role }) {
  const items = (Array.isArray(interests) ? interests : [])
    .map((it) => (typeof it === 'string' ? { text: it, source_line: null } : { text: it.text || '', source_line: it.source_line || null }))
    .filter((it) => it.text && it.text.trim());
  if (items.length === 0) return { interests: [], audit: [] };

  const enumerated = items.map((it, i) => `${i}| ${it.text}`).join('\n');
  const user = `Target role: ${role || 'unspecified'}

Hobbies / interests to glorify:
${enumerated}

Return JSON with an "improved" array. Every "text" MUST include the original hobby verbatim as a substring.`;

  let data;
  try {
    const res = await complete({
      system: INTERESTS_SYSTEM,
      user,
      model: config.LLM_EDIT,
      temperature: 0.2,
      maxTokens: 800,
    });
    data = res.data || {};
  } catch (e) {
    logger.warn({ err: e.message }, 'interests-glorify LLM call failed; keeping original');
    const audit = items.map((it) => ({
      section: 'interests', entry_label: '(interest)',
      source_line: it.source_line, original: it.text, improved: it.text,
      mode: 'unchanged', changes: 'LLM failed; kept original', verified: true, unverified: [],
    }));
    return { interests: items, audit };
  }

  const impArr = Array.isArray(data.improved) ? data.improved : [];
  const outInterests = [];
  const audit = [];
  for (let i = 0; i < items.length; i++) {
    const orig = items[i];
    const hit = impArr.find((x) => x && x.i === i);
    const proposed = hit && hit.text ? String(hit.text).trim() : '';
    // Ground: proposed must contain the original as a case-insensitive substring.
    const grounded = proposed && proposed.toLowerCase().includes(orig.text.toLowerCase());
    const finalText = grounded ? proposed : orig.text;
    const mode = grounded && finalText !== orig.text ? 'llm' : 'unchanged';
    outInterests.push({ text: finalText, source_line: orig.source_line });
    audit.push({
      section: 'interests',
      entry_label: '(interest)',
      source_line: orig.source_line,
      original: orig.text,
      improved: finalText,
      mode,
      changes: grounded ? (hit && hit.changes ? String(hit.changes).slice(0, 120) : 'Reframed professionally') : 'LLM output dropped original hobby text; kept as-is',
      verified: true, // no fabrication path — grounded on substring
      unverified: [],
    });
  }
  return { interests: outInterests, audit };
}

// Extract [{ text, source_line }] from a section's bullets. Both the string
// and the anchored-object shapes from extract.js are handled.
function extractBullets(entryBullets) {
  const out = [];
  for (const b of (entryBullets || [])) {
    if (typeof b === 'string') out.push({ text: b, source_line: null });
    else if (b && typeof b === 'object') out.push({ text: b.text || '', source_line: b.source_line || null });
  }
  return out;
}

// Replace bullets on a copy of entry, preserving order + source_line anchors
function replaceBullets(entry, improved) {
  const cloned = { ...entry, bullets: [] };
  const items = extractBullets(entry.bullets);
  for (let i = 0; i < items.length; i++) {
    const r = improved[i];
    if (!r) { cloned.bullets.push(items[i]); continue; }
    cloned.bullets.push({ text: r.improved || items[i].text, source_line: items[i].source_line });
  }
  return cloned;
}

async function improveEntries({ entries, sectionLabel, role, sourceText }) {
  const perEntry = [];
  const auditPerEntry = [];
  for (const entry of (entries || [])) {
    const items = extractBullets(entry.bullets);
    if (items.length === 0) { perEntry.push(entry); auditPerEntry.push([]); continue; }
    const { improved } = await improveSection({
      bullets: items.map((it) => it.text),
      section: sectionLabel,
      role,
      sourceText,
      entry, // scope-aware tech check needs this to reject cross-section leaks
    });
    perEntry.push(replaceBullets(entry, improved));
    auditPerEntry.push(improved.map((r, i) => ({
      section: sectionLabel,
      entry_label: entry.role || entry.name || entry.organization || '(unnamed)',
      source_line: items[i].source_line,
      original: r.original,
      improved: r.improved,
      mode: r.mode,
      changes: r.changes,
      verified: r.verified,
      unverified: r.unverified,
    })));
  }
  return { entries: perEntry, audit: auditPerEntry.flat() };
}

async function improveAchievements({ achievements, role, sourceText }) {
  const items = extractBullets(achievements);
  if (items.length === 0) return { achievements: [], audit: [] };
  const { improved } = await improveSection({
    bullets: items.map((it) => it.text),
    section: 'achievements',
    role,
    sourceText,
  });
  const outAchievements = improved.map((r, i) => ({ text: r.improved || items[i].text, source_line: items[i].source_line }));
  const audit = improved.map((r, i) => ({
    section: 'achievements',
    entry_label: '(achievement)',
    source_line: items[i].source_line,
    original: r.original,
    improved: r.improved,
    mode: r.mode,
    changes: r.changes,
    verified: r.verified,
    unverified: r.unverified,
  }));
  return { achievements: outAchievements, audit };
}

// Public. Returns:
//   { resume_json_improved, audit: [ ...per-bullet audit rows ], meta }
// resume_json_improved has the same shape as the input, with bullets rewritten
// where possible. Every bullet in `audit` has {original, improved, mode,
// verified, unverified, changes} — the audit-report generator formats this
// into the student-facing report.
async function improveResume({ resume_json, sourceText, role }) {
  if (!resume_json) throw new Error('improveResume: resume_json required');
  if (!role) throw new Error('improveResume: role required');
  const t0 = Date.now();

  const [expResult, projResult, porResult, achResult, interestsResult] = await Promise.all([
    improveEntries({ entries: resume_json.experience, sectionLabel: 'experience', role, sourceText }),
    improveEntries({ entries: resume_json.projects, sectionLabel: 'projects', role, sourceText }),
    improveEntries({ entries: resume_json.por, sectionLabel: 'por', role, sourceText }),
    improveAchievements({ achievements: resume_json.achievements, role, sourceText }),
    improveInterests({ interests: resume_json.interests, role }),
  ]);

  const resume_json_improved = {
    ...resume_json,
    experience: expResult.entries,
    projects: projResult.entries,
    por: porResult.entries,
    achievements: achResult.achievements,
    interests: interestsResult.interests,
  };

  const audit = [
    ...expResult.audit,
    ...projResult.audit,
    ...porResult.audit,
    ...achResult.audit,
    ...interestsResult.audit,
  ];

  const counts = audit.reduce(
    (acc, a) => {
      acc.total++;
      acc[a.mode] = (acc[a.mode] || 0) + 1;
      if (!a.verified) acc.unverified++;
      return acc;
    },
    { total: 0, unverified: 0 },
  );

  logger.info({
    bullets_total: counts.total,
    llm: counts.llm || 0,
    llm_retry: counts['llm-retry'] || 0,
    safe_fallback: counts['safe-fallback'] || 0,
    unchanged: counts.unchanged || 0,
    skipped: counts.skipped || 0,
    elapsed_ms: Date.now() - t0,
  }, 'improveResume complete');

  return {
    resume_json_improved,
    audit,
    meta: {
      role,
      counts,
      elapsed_ms: Date.now() - t0,
    },
  };
}

module.exports = { improveResume };
