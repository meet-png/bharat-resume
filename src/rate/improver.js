// Bullet improver — LLM rewriter with mandatory verifier gate.
//
// Every improved bullet passes through src/rate/verify.js before being
// accepted. If verification fails, we retry ONCE with an even stricter
// prompt that cites what was flagged. If the retry still fails, we fall
// back to a deterministic verb-strengthening rewrite that never adds new
// content. Nothing else reaches the student.
//
// Contract:
//   improveSection({ bullets, section, role, resume_json, sourceText })
//     → { improved: [{ original, improved, mode, verified, changes, atoms }] }
//
//   mode ∈ {'llm', 'llm-retry', 'safe-fallback', 'unchanged'}
//   verified: true on 'llm' | 'llm-retry' | 'safe-fallback' | 'unchanged'
//             (safe-fallback is always verified because it doesn't add atoms)
//
// Batching: one LLM call per section (all bullets together), because the LLM
// sees other bullets in the same project/role as context and improves them
// coherently. Verifier runs per-bullet after the batch returns.

const { complete } = require('../llm/client');
const { config } = require('../config');
const { verify, checkContentPreservation } = require('./verify');
const { ACTION_VERBS, FILLERS } = require('./lexicon');
const logger = require('../logger');

const MAX_BULLETS_PER_CALL = 8; // above this, split into multiple calls

// Weak-opening → strong-verb map. Used by the deterministic safe fallback
// when the LLM rewrite fails verification. Keeps the original bullet's
// content unchanged; only strengthens the verb / removes filler.
const FILLER_REPLACEMENTS = [
  { pattern: /^worked on\b/i,           replacement: 'Built' },
  { pattern: /^worked with\b/i,         replacement: 'Collaborated with' },
  { pattern: /^responsible for\b/i,     replacement: 'Owned' },
  { pattern: /^in charge of\b/i,        replacement: 'Led' },
  { pattern: /^tasked with\b/i,         replacement: 'Executed' },
  { pattern: /^duties included\b/i,     replacement: 'Delivered' },
  { pattern: /^helped with\b/i,         replacement: 'Contributed to' },
  { pattern: /^helped in\b/i,           replacement: 'Contributed to' },
  { pattern: /^helped to\b/i,           replacement: 'Contributed to' },
  { pattern: /^assisted with\b/i,       replacement: 'Supported' },
  { pattern: /^assisted in\b/i,         replacement: 'Supported' },
  { pattern: /^involved in\b/i,         replacement: 'Executed' },
  { pattern: /^part of\b/i,             replacement: 'Contributed to' },
  { pattern: /^contributed to\b/i,      replacement: 'Contributed to' }, // no-op preserved
];

// Safe fallback: rewrite that changes ONLY the opening if it's a filler,
// leaving all content otherwise intact. Anything this produces has strictly
// fewer atoms than the original — so it can never be a fabrication.
function safeFallback(original) {
  let out = String(original || '').trim();
  if (!out) return out;
  for (const rule of FILLER_REPLACEMENTS) {
    if (rule.pattern.test(out)) {
      out = out.replace(rule.pattern, rule.replacement);
      break;
    }
  }
  // Capitalize first character if it lost caps in the replacement
  if (out.length && out[0] !== out[0].toUpperCase()) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  return out;
}

function looksImprovedByFallback(original, safe) {
  return safe.trim() !== String(original || '').trim();
}

// Trim source text passed to the LLM — keep it big enough to give context
// but bounded so cost/latency stay predictable on dense resumes.
function trimSourceForContext(sourceText, cap = 4000) {
  const s = String(sourceText || '');
  if (s.length <= cap) return s;
  return s.slice(0, cap);
}

const IMPROVER_SYSTEM = `You are a resume improver for Indian college students. You improve bullets by:
  - strengthening verbs (Built, Shipped, Designed, Optimized, Scaled)
  - restructuring for impact (verb → what → outcome)
  - pulling in specific tools, tech, and details from ELSEWHERE in the same student's resume when they legitimately belong to that bullet
  - keeping to 20-35 words

HARD RULES — violations will be REJECTED downstream by an automated verifier:
1. Every number, metric, percentage, currency amount, tool name, framework, company name, and product name in your OUTPUT must appear somewhere in the ORIGINAL bullet or in the FULL RESUME context.
2. NEVER invent metrics. If a bullet has no measurable outcome in the source, DO NOT add one. Strengthen verb and structure only.
3. NEVER invent tech that isn't in the student's skills or projects list.
4. NEVER invent proper nouns (companies, products, orgs).
5. PRESERVE ALL specifics from the original bullet — do not shorten by deleting content, tools, features, or descriptive detail. A rewrite that drops important content is REJECTED just like a fabrication. If the original bullet is already rich, keep every detail; only restructure and strengthen verbs.
6. Aim for a rewrite that is AT LEAST 70% the length of the original. Removing filler like "helped with" is fine; removing real specifics is not.
7. Match the student's writing voice; don't over-polish.

Output STRICT JSON: { "improvements": [{ "i": <bullet index>, "improved": <string>, "changes": <one-line reason ≤80 chars> }] }`;

function buildUserPrompt({ bullets, section, role, resumeContext }) {
  const enumerated = bullets.map((b, i) => `${i}| ${b}`).join('\n');
  return `Target role: ${role}
Section being improved: ${section}

Bullets to improve:
${enumerated}

FULL RESUME CONTEXT (for grounding — any atom in your improved bullets must appear here or in the original bullet):
${resumeContext}

Return JSON with an "improvements" array. Preserve all metrics as written. If a bullet needs no change, echo it as-is.`;
}

// Call the LLM for a batch of bullets. Returns raw improvements array
// [{ i, improved, changes }].
async function callImprover({ bullets, section, role, sourceText, extraGuidance = '' }) {
  const resumeContext = trimSourceForContext(sourceText);
  const system = extraGuidance
    ? `${IMPROVER_SYSTEM}\n\nADDITIONAL CONSTRAINT (from prior verifier rejection):\n${extraGuidance}`
    : IMPROVER_SYSTEM;
  const user = buildUserPrompt({ bullets, section, role, resumeContext });

  const { data, usage } = await complete({
    system, user,
    model: config.LLM_EDIT,   // gpt-4o — stronger reasoning matters for the verifier-friendly rewrite
    temperature: 0.2,
    maxTokens: 2000,
  });
  const improvements = Array.isArray(data?.improvements) ? data.improvements : [];
  return { improvements, usage };
}

// Improve one section's bullets. Runs one LLM call, then verifies each bullet
// individually. On any verifier failure, retries ONCE with a targeted extra
// guidance string. If retry still fails, safe-fallback for that bullet.
async function improveSection({ bullets, section, role, sourceText }) {
  const orig = (bullets || []).filter(Boolean).map(String);
  if (orig.length === 0) return { improved: [] };

  // Batch: split if oversized so we stay in the LLM's sweet-spot output budget.
  const chunks = [];
  for (let i = 0; i < orig.length; i += MAX_BULLETS_PER_CALL) {
    chunks.push(orig.slice(i, i + MAX_BULLETS_PER_CALL));
  }

  const results = new Array(orig.length);
  let cursor = 0;

  for (const chunk of chunks) {
    let attempt = 1;
    let retryGuidance = '';
    let picked = null;
    while (attempt <= 2) {
      let batch;
      try {
        batch = await callImprover({
          bullets: chunk,
          section,
          role,
          sourceText,
          extraGuidance: attempt === 2 && retryGuidance ? retryGuidance : '',
        });
      } catch (e) {
        logger.warn({ err: e.message, attempt, section }, 'improver LLM call failed');
        break;
      }
      // Verify every bullet in this batch. Two checks:
      //   1. verify() — no fabricated atoms in output (fabrication guard)
      //   2. checkContentPreservation() — no atoms/length dropped too far (regression guard)
      // Either failure treats the whole bullet as needing retry / fallback.
      const perBullet = chunk.map((original, idxInChunk) => {
        const hit = batch.improvements.find((r) => r && r.i === idxInChunk);
        const improved = hit ? String(hit.improved || '').trim() : '';
        if (!improved) return { original, improved: '', changes: '', verified: false, unverified: [], fail_reason: 'empty', mode: 'skipped' };
        const v = verify({ rewritten: improved, original, sourceText });
        const p = checkContentPreservation({ original, rewritten: improved });
        const verifiedOk = v.ok && p.ok;
        const unverified = v.unverified_atoms.map((a) => a.raw);
        const dropped = p.dropped_atoms.map((a) => a.raw);
        return {
          original,
          improved,
          changes: hit.changes ? String(hit.changes).slice(0, 200) : '',
          verified: verifiedOk,
          unverified,
          dropped,
          word_ratio: p.word_ratio,
          fail_reason: !v.ok ? 'fabrication' : (!p.ok ? 'over-compression' : ''),
          mode: attempt === 1 ? 'llm' : 'llm-retry',
        };
      });

      const anyFailed = perBullet.some((r) => !r.verified && r.mode !== 'skipped');
      if (!anyFailed) { picked = perBullet; break; }

      if (attempt === 1) {
        // Collect targeted guidance across the batch. Separate lists so the
        // retry prompt can address fabrication and over-compression distinctly.
        const fabricatedAtoms = [];
        const droppedAtoms = [];
        const overCompressed = [];
        for (const r of perBullet) {
          if (r.fail_reason === 'fabrication') fabricatedAtoms.push(...r.unverified.slice(0, 3));
          if (r.fail_reason === 'over-compression') {
            droppedAtoms.push(...r.dropped.slice(0, 3));
            overCompressed.push(`bullet #${chunk.indexOf(r.original)} (${r.word_ratio.toFixed(2)}× length)`);
          }
        }
        const fabricatedUnique = [...new Set(fabricatedAtoms)].slice(0, 8);
        const droppedUnique = [...new Set(droppedAtoms)].slice(0, 8);
        const parts = [];
        if (fabricatedUnique.length) parts.push(`Prior draft added atoms not in source: ${fabricatedUnique.join(', ')}. Do NOT add them.`);
        if (droppedUnique.length) parts.push(`Prior draft dropped specifics from source: ${droppedUnique.join(', ')}. Keep them.`);
        if (overCompressed.length) parts.push(`These bullets were over-compressed: ${overCompressed.join('; ')}. Preserve original length and specifics.`);
        retryGuidance = parts.join(' ');
        attempt++;
        continue;
      }

      picked = perBullet;
      attempt++;
    }

    // For any bullet still unverified, fall back
    if (!picked) picked = chunk.map((original) => ({ original, improved: '', changes: '', verified: false, unverified: [], fail_reason: 'skipped', mode: 'skipped' }));
    for (const r of picked) {
      if (!r.verified) {
        const safe = safeFallback(r.original);
        const changed = looksImprovedByFallback(r.original, safe);
        const why = r.fail_reason === 'fabrication' ? 'LLM tried to invent atoms; falling back to safe verb-strengthening.'
                  : r.fail_reason === 'over-compression' ? 'LLM over-compressed the bullet; keeping original with verb-strengthening only.'
                  : 'safe fallback';
        r.improved = changed ? safe : r.original;
        r.changes = changed ? `${why} Replaced filler opening.` : why;
        r.mode = changed ? 'safe-fallback' : 'unchanged';
        r.verified = true; // safe-fallback + unchanged both trivially verified
        r.unverified = [];
        r.dropped = [];
      }
    }
    for (const r of picked) results[cursor++] = r;
  }
  return { improved: results };
}

module.exports = {
  improveSection,
  safeFallback,
  // Exposed for tests + future improvements
  IMPROVER_SYSTEM,
};
