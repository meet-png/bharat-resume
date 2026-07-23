// Audit report generator — turns improveResume() audit[] + score data into
// the student-facing before/after report.
//
// This is what makes the moat visible to the student — and to any HR who
// interrogates the resume. Every changed bullet is quoted BEFORE and AFTER,
// cites its source_line anchor, names the change reason, and lists the
// specifics that came from elsewhere in the student's own file (so nothing
// looks invented).
//
// Two renderers:
//   renderAuditText({...})  — plain WhatsApp-friendly text, chunks to fit
//                              WhatsApp's ~4000-char message limit.
//   renderAuditJson({...})  — machine-readable shape for a future audit PDF
//                              generator; mirrors the WhatsApp output but
//                              structured for template rendering.

const MAX_WHATSAPP_CHARS = 3900; // WhatsApp text limit is 4096; keep headroom

const SECTION_LABELS = {
  experience: 'Experience',
  projects:   'Projects',
  por:        'Positions of Responsibility',
  achievements: 'Achievements',
};

// Group audit rows by section, preserving order within each section.
function groupBySection(audit) {
  const grouped = { experience: [], projects: [], por: [], achievements: [] };
  for (const row of (audit || [])) {
    if (grouped[row.section]) grouped[row.section].push(row);
  }
  return grouped;
}

// Count outcomes for the header summary.
function tallyModes(audit) {
  const t = { total: 0, llm: 0, retry: 0, fallback: 0, unchanged: 0 };
  for (const row of (audit || [])) {
    t.total++;
    if (row.mode === 'llm') t.llm++;
    else if (row.mode === 'llm-retry') t.retry++;
    else if (row.mode === 'safe-fallback') t.fallback++;
    else if (row.mode === 'unchanged') t.unchanged++;
  }
  return t;
}

// Truncate long strings for compact display in WhatsApp
function trunc(s, cap) {
  const t = String(s || '');
  return t.length <= cap ? t : t.slice(0, cap - 1).trimEnd() + '…';
}

// A row is "showable" in the diff if we actually rewrote it. Unchanged and
// skipped rows would show BEFORE == AFTER which looks embarrassing (Meet's
// 2026-07-23 feedback) — those get summarised in the header count instead.
function isShowableRow(row) {
  return row.mode === 'llm' || row.mode === 'llm-retry' || row.mode === 'safe-fallback';
}

// Render one bullet's diff. Format kept minimal to survive WhatsApp render.
function renderRowText(row, index) {
  const sectionLabel = SECTION_LABELS[row.section] || row.section;
  const anchor = row.source_line ? `line ${row.source_line}` : 'no line anchor';
  const entryTag = row.entry_label && row.entry_label !== '(unnamed)' && row.entry_label !== '(achievement)'
    ? ` · ${trunc(row.entry_label, 40)}`
    : '';

  let icon = '·';
  if (row.mode === 'llm') icon = '✍';
  else if (row.mode === 'llm-retry') icon = '↻';
  else if (row.mode === 'safe-fallback') icon = '⚠';

  const lines = [];
  lines.push(`${icon} #${index + 1} [${sectionLabel} · ${anchor}${entryTag}]`);
  lines.push(`BEFORE  ${trunc(row.original, 300)}`);
  lines.push(`AFTER   ${trunc(row.improved, 300)}`);
  if (row.changes) lines.push(`why     ${trunc(row.changes, 180)}`);
  return lines.join('\n');
}

// Header — one compact block. Score delta, one-line change summary, and a
// short trust statement. No verbose explanations; the per-bullet diffs below
// already show what happened.
function renderHeader({ role, scoreBefore, scoreAfter, tally, meta }) {
  const lines = [];
  lines.push('*BHARAT RESUME — Audit*');
  if (role) lines.push(`Role: ${role}`);
  if (scoreBefore != null && scoreAfter != null) {
    const delta = scoreAfter - scoreBefore;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    lines.push(`Score: ${scoreBefore.toFixed(1)} → ${scoreAfter.toFixed(1)} / 10 (${arrow} ${Math.abs(delta).toFixed(1)})`);
  } else if (scoreBefore != null) {
    lines.push(`Score: ${scoreBefore.toFixed(1)} / 10`);
  }
  // Single-line change summary
  const parts = [];
  const rewritten = (tally.llm || 0) + (tally.retry || 0);
  if (rewritten) parts.push(`${rewritten} rewritten`);
  if (tally.fallback) parts.push(`${tally.fallback} verb-only`);
  if (tally.unchanged) parts.push(`${tally.unchanged} already strong`);
  if (parts.length) lines.push(`Bullets: ${parts.join(' · ')}`);
  lines.push('');
  lines.push('_Every atom in AFTER traces back to your original. Report a bug if not._');
  return lines.join('\n');
}

// Render a whole section's rows. Skips sections with no rows.
function renderSection(section, rows, startIndex) {
  if (!rows || rows.length === 0) return null;
  const heading = `━━━ ${SECTION_LABELS[section] || section} ━━━`;
  const body = rows.map((r, i) => renderRowText(r, startIndex + i)).join('\n\n');
  return `${heading}\n\n${body}`;
}

// Split output into WhatsApp-sized chunks so it can be sent as multiple
// messages without triggering the 4096-char cap. Break only on section
// boundaries when possible so headers don't split.
function chunkForWhatsApp(fullText) {
  if (fullText.length <= MAX_WHATSAPP_CHARS) return [fullText];
  const chunks = [];
  const parts = fullText.split(/\n(?=━━━)/); // split on section headers
  let cur = '';
  for (const part of parts) {
    if ((cur + '\n' + part).length > MAX_WHATSAPP_CHARS && cur) {
      chunks.push(cur.trim());
      cur = part;
    } else {
      cur = cur ? `${cur}\n${part}` : part;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

// Public — build the text report.
// input:
//   audit         — from improveResume()
//   role          — target role string
//   scoreBefore?  — total score before improvements (0-10)
//   scoreAfter?   — total score after (real re-score, not projected)
//   meta          — passed through for optional rubric_version / cache_key line
function renderAuditText({ audit, role, scoreBefore, scoreAfter, meta }) {
  const tally = tallyModes(audit);
  const header = renderHeader({ role, scoreBefore, scoreAfter, tally, meta });
  // Only render bullets that actually got a rewrite. Unchanged / skipped
  // rows are already summarised in the header count line — showing them as
  // BEFORE=AFTER made the report look wasteful and eroded trust.
  const showable = (audit || []).filter(isShowableRow);
  const grouped = groupBySection(showable);

  const sections = [];
  let idx = 0;
  for (const key of ['experience', 'projects', 'por', 'achievements']) {
    const rows = grouped[key];
    if (!rows.length) continue;
    const rendered = renderSection(key, rows, idx);
    if (rendered) sections.push(rendered);
    idx += rows.length;
  }

  const full = [header, ...sections].join('\n\n');
  return {
    text: full,
    chunks: chunkForWhatsApp(full),
    char_count: full.length,
    tally,
  };
}

// Machine-readable shape for a future PDF renderer. Same information as
// renderAuditText but structured for template consumption.
function renderAuditJson({ audit, role, scoreBefore, scoreAfter, meta }) {
  const tally = tallyModes(audit);
  const grouped = groupBySection(audit);
  return {
    role,
    score_before: scoreBefore != null ? Number(scoreBefore.toFixed(1)) : null,
    score_after: scoreAfter != null ? Number(scoreAfter.toFixed(1)) : null,
    tally,
    sections: ['experience', 'projects', 'por', 'achievements']
      .map((key) => ({
        key,
        label: SECTION_LABELS[key],
        rows: (grouped[key] || []).map((r) => ({
          source_line: r.source_line,
          entry_label: r.entry_label,
          before: r.original,
          after: r.improved,
          why: r.changes,
          mode: r.mode,
          verified: r.verified,
        })),
      }))
      .filter((s) => s.rows.length > 0),
    meta,
  };
}

module.exports = {
  renderAuditText,
  renderAuditJson,
  chunkForWhatsApp,
  MAX_WHATSAPP_CHARS,
};
