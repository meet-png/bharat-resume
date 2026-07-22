// Whole-resume improvement pipeline. Runs improveSection() for each
// bullet-carrying section (experience, projects, por, achievements) and
// returns the improved resume_json AND a per-bullet audit trail for the
// downstream audit-report generator.
//
// Sections are improved in PARALLEL so total latency is bounded by the
// slowest section, not the sum. Verifier runs per-bullet inside each
// section; a fabrication in one section can never propagate to another.

const { improveSection } = require('./improver');
const logger = require('../logger');

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

  const [expResult, projResult, porResult, achResult] = await Promise.all([
    improveEntries({ entries: resume_json.experience, sectionLabel: 'experience', role, sourceText }),
    improveEntries({ entries: resume_json.projects, sectionLabel: 'projects', role, sourceText }),
    improveEntries({ entries: resume_json.por, sectionLabel: 'por', role, sourceText }),
    improveAchievements({ achievements: resume_json.achievements, role, sourceText }),
  ]);

  const resume_json_improved = {
    ...resume_json,
    experience: expResult.entries,
    projects: projResult.entries,
    por: porResult.entries,
    achievements: achResult.achievements,
  };

  const audit = [
    ...expResult.audit,
    ...projResult.audit,
    ...porResult.audit,
    ...achResult.audit,
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
