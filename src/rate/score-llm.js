// LLM scorer — 4.0 of the total 10.0 rate-mode score.
//
// Three subscores:
//   Content Quality (LLM) 1.0 — bullet impact judgment (activity vs achievement)
//   Role Fit              2.0 — coverage of jd_intel keywords across skills + bullets
//   Polish (LLM)          1.0 — grammar / tense / agreement issues
//
// Determinism note: LLM temperature is set to 0 to minimize drift. Absolute
// determinism (byte-equal across runs) comes from Redis caching by cache_key
// on the caller side — this file just makes the drift minimal so an
// uncached cold run is still stable-ish.
//
// Reuses v1's `src/llm/keywords.js` for jd_intel — same one-pass profile the
// v1 rewriter consumes, so v2 rating stays aligned with v1 rewriting.

const crypto = require('crypto');
const { complete } = require('../llm/client');
const { extractKeywords } = require('../llm/keywords');
const { config } = require('../config');
const { getClient: getRedisClient } = require('../store/redis');
const logger = require('../logger');
const { ACTION_VERBS } = require('./lexicon');

// jd_intel Redis cache — same role produces the same intel profile, so
// caching by sha256(role) turns Role Fit into a deterministic sub-score
// across all sessions using the same target (Data Analyst, Backend SWE,
// etc.). TTL matches the rubric-version lifetime.
const JD_INTEL_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
async function getCachedJdIntel(role) {
  if (!role) return null;
  try {
    const key = `jd_intel:${crypto.createHash('sha256').update(String(role).toLowerCase().trim()).digest('hex').slice(0, 24)}`;
    const raw = await getRedisClient().get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    logger.warn({ err: e.message }, 'jd_intel cache read failed');
    return null;
  }
}
async function setCachedJdIntel(role, intel) {
  if (!role || !intel) return;
  try {
    const key = `jd_intel:${crypto.createHash('sha256').update(String(role).toLowerCase().trim()).digest('hex').slice(0, 24)}`;
    await getRedisClient().set(key, JSON.stringify(intel), 'EX', JD_INTEL_TTL_SEC);
  } catch (e) {
    logger.warn({ err: e.message }, 'jd_intel cache write failed');
  }
}

const SEV = { CRITICAL: 3, MEDIUM: 2, MINOR: 1 };

// Collect all bullets with source-line anchors, capped at MAX_BULLETS to keep
// the LLM prompt bounded. A resume with >20 impact-worthy bullets is either
// senior (out of scope for JECRC pilot) or padded (which the deterministic
// scorer already flags via density).
const MAX_BULLETS = 24;
function collectBullets(rj) {
  const out = [];
  const walk = (arr, section) => {
    for (const entry of (arr || [])) {
      for (const b of (entry.bullets || [])) {
        if (out.length >= MAX_BULLETS) return;
        const text = typeof b === 'string' ? b : b.text || '';
        const source_line = typeof b === 'object' ? b.source_line || null : null;
        if (text) out.push({ text, source_line, section });
      }
    }
  };
  walk(rj?.experience, 'experience');
  walk(rj?.projects, 'projects');
  walk(rj?.por, 'por');
  for (const a of (rj?.achievements || [])) {
    if (out.length >= MAX_BULLETS) break;
    const text = typeof a === 'string' ? a : a.text || '';
    const source_line = typeof a === 'object' ? a.source_line || null : null;
    if (text) out.push({ text, source_line, section: 'achievements' });
  }
  return out;
}

// ─── Bullet impact (1.0) ─────────────────────────────────────────────────
// LLM scores each bullet 0/1/2. Score = avg / 2, so a resume where every
// bullet is a strong achievement earns 1.0.
async function scoreBulletImpact({ resume_json, role }) {
  const bullets = collectBullets(resume_json);
  if (bullets.length === 0) return { earned: 0, max: 1.0, issues: [], meta: { skipped: true } };

  const system = `You are a resume reviewer. For each bullet, score 0/1/2:
  0 — pure activity ("Worked on X", no outcome, no scope)
  1 — activity with some scope OR partial outcome (numbers of users, a %, a specific tool named)
  2 — achievement with measurable outcome AND context (verb + what + result)

Never invent context that isn't in the bullet. Score what's there.

Output STRICT JSON: { "scores": [{ "i": <bullet index>, "s": 0|1|2, "why": <short reason ≤80 chars> }] }`;

  const enumerated = bullets.map((b, i) => `${i}| ${b.text}`).join('\n');
  const user = `Role target: ${role}
Bullets to score:
${enumerated}

Return JSON with a score per bullet index. No other text.`;

  let scores = [];
  try {
    const { data } = await complete({
      system, user,
      model: config.LLM_PRIMARY,
      temperature: 0,
      maxTokens: 2000,
    });
    scores = Array.isArray(data?.scores) ? data.scores : [];
  } catch (e) {
    logger.warn({ err: e.message }, 'bullet impact LLM call failed');
    return { earned: 0, max: 1.0, issues: [], meta: { skipped: true, err: e.message } };
  }

  // Map returned scores back to bullets by index; unscored bullets default to 1
  // (mid) so a partial LLM response doesn't tank the score.
  const perBullet = bullets.map((b, i) => {
    const hit = scores.find((s) => s.i === i);
    return {
      ...b,
      impact: hit ? Number(hit.s) : 1,
      why: hit ? String(hit.why || '') : '',
    };
  });

  const totalPossible = bullets.length * 2;
  const totalEarned = perBullet.reduce((n, b) => n + (b.impact || 0), 0);
  const earned = Math.min(1.0, totalEarned / totalPossible);

  // Emit issues for the weakest bullets (impact === 0) — up to 3, prioritised
  // by section (experience > projects > por > achievements).
  const priority = { experience: 0, projects: 1, por: 2, achievements: 3 };
  const weak = perBullet
    .filter((b) => b.impact === 0)
    .sort((a, b) => (priority[a.section] || 9) - (priority[b.section] || 9))
    .slice(0, 3);
  const issues = weak.map((b) => ({
    severity: 'MEDIUM',
    category: 'content_low_impact',
    source_line: b.source_line,
    why: `Bullet reads as pure activity, no outcome: "${b.text.slice(0, 100)}"${b.why ? ` — ${b.why}` : ''}`,
    cost: 'Recruiter cannot compare you on this line. Add a number, a scope, or a specific result.',
  }));

  return { earned, max: 1.0, issues, meta: { scored: bullets.length, avg_impact: totalEarned / bullets.length } };
}

// ─── Role Fit (2.0) ──────────────────────────────────────────────────────
// Runs v1's jd_intel extraction, then computes coverage of jd_intel.keywords
// across:
//   (a) skills mentioned in resume_json.skills[]  → skills_coverage (1.0)
//   (b) bullets containing at least one keyword   → bullets_coverage (1.0)
//
// Purely deterministic once jd_intel is fetched — no per-bullet LLM. This
// keeps cost low AND makes the sub-score stable across runs (cache jd_intel
// alone; skills/bullets side is regex).
async function scoreRoleFit({ resume_json, role }) {
  let intel;
  let cacheHit = false;
  try {
    intel = await getCachedJdIntel(role);
    if (intel) {
      cacheHit = true;
    } else {
      intel = await extractKeywords({ jdRole: role });
      // Fire-and-forget cache write; failure to cache is non-fatal.
      setCachedJdIntel(role, intel).catch(() => {});
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'role-fit: jd_intel extraction failed');
    return { earned: 0, max: 2.0, issues: [], meta: { skipped: true, err: e.message } };
  }

  const keywords = (intel?.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  const topSkills = (intel?.top_prioritized_skills || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  const allTargets = [...new Set([...keywords, ...topSkills])];
  if (allTargets.length === 0) {
    return { earned: 1.0, max: 2.0, issues: [], meta: { neutral: true, reason: 'no-role-keywords' } };
  }

  // Skills coverage
  const studentSkills = [];
  for (const cat of (resume_json?.skills || [])) {
    for (const item of (cat.items || [])) studentSkills.push(String(item).toLowerCase().trim());
  }
  const skillHits = allTargets.filter((t) => studentSkills.some((s) => s.includes(t) || t.includes(s)));
  const skillsCoverage = allTargets.length ? skillHits.length / allTargets.length : 0;
  const skillsEarned = Math.min(1.0, skillsCoverage * 1.5); // full credit at ~67% coverage

  // Bullets coverage
  const bullets = collectBullets(resume_json);
  const bulletsWithKw = bullets.filter((b) => {
    const t = b.text.toLowerCase();
    return allTargets.some((kw) => t.includes(kw));
  });
  const bulletsCoverage = bullets.length ? bulletsWithKw.length / bullets.length : 0;
  const bulletsEarned = Math.min(1.0, bulletsCoverage * 2.0); // full credit at ~50% coverage

  const earned = skillsEarned + bulletsEarned;
  const issues = [];

  const missingKeywords = allTargets
    .filter((t) => !studentSkills.some((s) => s.includes(t) || t.includes(s)))
    .filter((t) => !bullets.some((b) => b.text.toLowerCase().includes(t)))
    .slice(0, 6);
  if (missingKeywords.length > 0 && earned < 1.5) {
    issues.push({
      severity: earned < 0.8 ? 'CRITICAL' : 'MEDIUM',
      category: 'role_fit_missing_keywords',
      source_line: null,
      why: `Role "${intel.role_noun}" typically requires: ${missingKeywords.join(', ')}. None found on your resume.`,
      cost: 'ATS keyword filter drops resumes below coverage threshold before a human ever sees them.',
    });
  }

  return {
    earned,
    max: 2.0,
    issues,
    meta: {
      role_noun: intel.role_noun,
      role_title: intel.role_title,
      domain: intel.domain,
      keyword_count: allTargets.length,
      skills_coverage: Math.round(skillsCoverage * 100),
      bullets_coverage: Math.round(bulletsCoverage * 100),
      missing_keywords: missingKeywords,
      cache_hit: cacheHit,
    },
  };
}

// ─── Grammar / Polish LLM (1.0) ──────────────────────────────────────────
// Single-shot: LLM reads summary + all bullets, returns count of grammar
// issues and a short list of the top 3 to cite. Score decreases with count.
async function scoreGrammar({ resume_json }) {
  const parts = [];
  if (resume_json?.summary) parts.push(`SUMMARY: ${resume_json.summary}`);
  const bullets = collectBullets(resume_json);
  for (const b of bullets) parts.push(`L${b.source_line || '?'}: ${b.text}`);
  const body = parts.join('\n');
  if (!body.trim()) return { earned: 0, max: 1.0, issues: [], meta: { skipped: true } };

  const system = `You are a grammar reviewer for a resume. Read the summary and bullets. Flag ONLY unambiguous, blocking grammar errors:
- tense inconsistency (mixing past/present when both apply to the same period)
- subject-verb disagreement ("the team have" vs "the team has")
- pluralization errors ("one criterias")
- obvious typos ("recieved", "developped", "responsibilty")
- misused homonyms ("effect" vs "affect" when clearly wrong)

DO NOT flag:
- Missing articles in bullets — resume bullets ARE fragments, "Built payment service" is CORRECT, do not suggest "Built a payment service"
- Missing final periods (style, not grammar)
- Passive voice (style, not grammar)
- Word-choice preferences
- Any change that is stylistic rather than mechanically wrong

If nothing is unambiguously wrong, issue_count MUST be 0. When in doubt, don't flag.

Output STRICT JSON: { "issue_count": <integer>, "top_issues": [{ "line": <source line or null>, "issue": <≤80 chars> }] }`;

  const user = `Resume body to check:
${body}

Return grammar issue count + up to 3 concrete citations. JSON only.`;

  let data;
  try {
    const res = await complete({
      system, user,
      model: config.LLM_PRIMARY,
      temperature: 0,
      maxTokens: 500,
    });
    data = res.data || {};
  } catch (e) {
    logger.warn({ err: e.message }, 'grammar LLM call failed');
    return { earned: 0.7, max: 1.0, issues: [], meta: { skipped: true, err: e.message } };
  }

  const issueCount = Number.isInteger(data.issue_count) ? data.issue_count : 0;
  // Curve: 0 issues = 1.0, 10+ issues = 0. Softer than 0.2/issue after Meet's
  // first live test showed the earlier curve over-penalised clean resumes when
  // the LLM had a bad day and mis-flagged fragment bullets as needing articles.
  const earned = Math.max(0, 1.0 - issueCount * 0.1);

  const issues = (Array.isArray(data.top_issues) ? data.top_issues.slice(0, 3) : []).map((it) => ({
    severity: 'MINOR',
    category: 'polish_grammar',
    source_line: Number.isInteger(it.line) ? it.line : null,
    why: `Grammar: ${String(it.issue || '').slice(0, 100)}`,
    cost: 'Small polish issue; combined they signal a resume that was not proofread.',
  }));

  return { earned, max: 1.0, issues, meta: { issue_count: issueCount } };
}

// ─── Public ──────────────────────────────────────────────────────────────
// Runs the three LLM subscores in parallel (they're independent) and returns
// combined output that mirrors score.js shape.
//
// Total from this file: 4.0 (impact 1.0 + role fit 2.0 + grammar 1.0).
async function scoreLlm({ resume_json, role }) {
  if (!resume_json) throw new Error('scoreLlm: resume_json is required');
  if (!role) throw new Error('scoreLlm: role is required');

  const t0 = Date.now();
  const [impact, roleFit, grammar] = await Promise.all([
    scoreBulletImpact({ resume_json, role }),
    scoreRoleFit({ resume_json, role }),
    scoreGrammar({ resume_json }),
  ]);
  const elapsed = Date.now() - t0;

  const subscores = {
    content_quality_llm: { ...impact, label: 'Content Quality (LLM bullet impact)' },
    role_fit:            { ...roleFit, label: 'Role Fit' },
    polish_llm:          { ...grammar, label: 'Polish (LLM grammar)' },
  };

  const issues = [
    ...impact.issues,
    ...roleFit.issues,
    ...grammar.issues,
  ].sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0) || a.category.localeCompare(b.category));

  const score_llm = Math.round((impact.earned + roleFit.earned + grammar.earned) * 10) / 10;

  return {
    score_llm,
    max_llm: impact.max + roleFit.max + grammar.max, // 4.0
    subscores,
    issues,
    meta: {
      role,
      elapsed_ms: elapsed,
      role_fit_meta: roleFit.meta,
    },
  };
}

module.exports = { scoreLlm };
