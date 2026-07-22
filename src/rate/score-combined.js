// Combines deterministic (6.0) + LLM (4.0) into the total 10.0 rate-mode score.
// This is what the WhatsApp bot and the audit-report generator will call.
//
// Contract:
//   scoreAll(input) → {
//     score,             // total 0.0 - 10.0
//     max: 10.0,
//     score_deterministic, score_llm,          // sub-totals for transparency
//     subscores: {
//       ats_compliance, contact_structure,     // deterministic subscores
//       content_quality_det, polish_det,
//       content_quality_llm, role_fit, polish_llm,
//     },
//     issues,            // merged + severity-sorted, source_line where applicable
//     meta,              // cache_key, rubric_version, timings, role, jd_intel
//   }
//
// Same-input-same-output guarantee comes from Redis caching by cache_key
// on the caller side. LLM subscores use temperature=0 to keep uncached
// runs stable-ish, but Redis cache is what guarantees byte-equality.
const { score: scoreDet, cacheKey, RUBRIC_VERSION } = require('./score');
const { scoreLlm } = require('./score-llm');

const SEV = { CRITICAL: 3, MEDIUM: 2, MINOR: 1 };

async function scoreAll(input) {
  const { text, parseMeta, resume_json, role, roleType = 'tech' } = input;
  if (!text || !resume_json || !role) {
    throw new Error('scoreAll: text, resume_json, role are required');
  }

  const t0 = Date.now();
  // Deterministic can be computed sync; LLM is a Promise. Overlap them.
  const det = scoreDet({ text, parseMeta, resume_json, role, roleType });
  const llmPromise = scoreLlm({ resume_json, role });
  const llm = await llmPromise;

  const total = Math.round((det.score_deterministic + llm.score_llm) * 10) / 10;

  const mergedIssues = [
    ...det.issues,
    ...llm.issues,
  ].sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0) || a.category.localeCompare(b.category));

  return {
    score: total,
    max: det.max_deterministic + llm.max_llm, // 10.0
    score_deterministic: det.score_deterministic,
    score_llm: llm.score_llm,
    subscores: {
      ...det.subscores,
      ...llm.subscores,
    },
    issues: mergedIssues,
    meta: {
      rubric_version: RUBRIC_VERSION,
      role,
      roleType,
      cache_key: cacheKey({ text, role }),
      elapsed_ms: Date.now() - t0,
      det_bullets_total: det.meta.bullets_total,
      role_fit: llm.meta.role_fit_meta,
    },
  };
}

module.exports = { scoreAll };
