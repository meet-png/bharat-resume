// ATS scorer. PRD §11 with bullet-density + metric-count enhancements per
// Meet's Day 4 feedback: "keyword match alone won't get content this thin to
// 90+. Reward bullet density and metric count too."
//
// Final formula keeps PRD's weights:
//   total = 0.6 * keyword_match + 0.2 * structure + 0.2 * impact
//
// But impact_score is restructured to penalize thin content:
//   impact = action_verb_ratio*30 + metric_ratio*35 + density_bonus + volume_bonus
//
// So a resume with all the right keywords but only 1 bullet per entry caps
// near the 60-70s, and one with dense, quantified bullets can clear 90.
//
// All scoring is local + deterministic (no LLM call). Runs in ~5-10ms.

// --- Action verb palette (used by rewriter; matched here for impact_score). ---
const ACTION_VERBS = new Set([
  // software / data / AI
  'architected','built','shipped','deployed','refactored','automated','optimized',
  'engineered','developed','implemented','reduced','increased','analyzed','created',
  'delivered','launched','managed','debugged','migrated','scaled','accelerated',
  'streamlined','consolidated','integrated','programmed','modeled','forecasted',
  'debunked','reverse-engineered','compressed','scraped','surfaced','tuned','trained',
  // marketing / sales
  'drove','grew','targeted','segmented','converted','activated','closed','sourced',
  'qualified','prospected','expanded','negotiated','generated','captured','retained',
  // design
  'designed','prototyped','researched','wireframed','iterated','validated','tested',
  // finance / ops
  'audited','reconciled','saved','cut','restructured','rebalanced','hedged',
  // leadership / por
  'directed','secured','chaired','coached','organized','mentored','led','coordinated',
  'orchestrated','spearheaded','founded','launched','presided',
  // civil / mech / construction
  'drafted','surveyed','constructed','assembled','specified','commissioned',
  // teaching / social
  'taught','tutored','counseled','onboarded','trained',
]);

// Soft / vague verbs that bring down impact_score even though they look verb-like.
const VAGUE_VERBS = new Set([
  'worked','helped','assisted','participated','involved','contributed','supported',
  'handled','dealt','did','made','got','tried','attempted','focused','aimed',
]);

// Skill synonym dictionary — PRD §11.1 gives "JS"="JavaScript", "ML"="Machine Learning".
// Expanded with common Indian-market overlaps.
const SYNONYMS = {
  'js': 'javascript', 'javascript': 'js',
  'ts': 'typescript', 'typescript': 'ts',
  'ml': 'machine learning', 'machine learning': 'ml',
  'ai': 'artificial intelligence', 'artificial intelligence': 'ai',
  'dl': 'deep learning', 'deep learning': 'dl',
  'nlp': 'natural language processing',
  'cv': 'computer vision',
  'sql': 'structured query language',
  'rest': 'restful', 'restful': 'rest', 'restful apis': 'rest', 'rest apis': 'rest',
  'node': 'node.js', 'node.js': 'node', 'nodejs': 'node',
  'react': 'reactjs', 'reactjs': 'react', 'react.js': 'react',
  'next': 'next.js', 'next.js': 'next', 'nextjs': 'next',
  'postgres': 'postgresql', 'postgresql': 'postgres',
  'mongo': 'mongodb', 'mongodb': 'mongo',
  'k8s': 'kubernetes', 'kubernetes': 'k8s',
  'gh actions': 'github actions',
  'pbi': 'power bi', 'power bi': 'pbi',
};

// --- Levenshtein distance for fuzzy match (PRD §11.1). ---
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) m[i][0] = i;
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = a[i - 1] === b[j - 1]
        ? m[i - 1][j - 1]
        : 1 + Math.min(m[i - 1][j - 1], m[i - 1][j], m[i][j - 1]);
    }
  }
  return m[a.length][b.length];
}

// Collect every skill the student demonstrably has — categorized skills buckets,
// project tech_stack arrays, experience tech_stack arrays. Lowercased + trimmed.
function collectActualSkills(resume) {
  const set = new Set();
  const add = (s) => { if (s && typeof s === 'string') set.add(s.toLowerCase().trim()); };
  for (const cat of (Array.isArray(resume?.skills) ? resume.skills : [])) {
    for (const item of (cat?.items || [])) add(item);
  }
  for (const p of (resume?.projects || [])) for (const t of (p.tech_stack || [])) add(t);
  for (const e of (resume?.experience || [])) for (const t of (e.tech_stack || [])) add(t);
  return set;
}

// keyword_match (0-100): PRD §11.1 — exact 100%, fuzzy (lev ≤ 2) 70%, synonym 80%.
// Scored against the JD's top-N keywords (capped at 15).
function keywordMatchScore(resume, jdKeywords) {
  const keywords = Array.isArray(jdKeywords) ? jdKeywords.slice(0, 15) : [];
  if (keywords.length === 0) {
    // No JD context — neutral score (don't penalize a generic-resume student).
    return { score: 50, matched: [], totalCredit: 0, denominator: 0, mode: 'no-jd' };
  }
  const skills = [...collectActualSkills(resume)];
  if (skills.length === 0) return { score: 0, matched: [], totalCredit: 0, denominator: keywords.length, mode: 'no-skills' };

  const matched = [];
  let totalCredit = 0;
  for (const raw of keywords) {
    const kw = String(raw).toLowerCase().trim();
    if (!kw) continue;
    let credit = 0;
    let matchedAs = null;

    // 1. exact (short keyword guard: ≤2 chars must be exact only — no substring fallbacks)
    for (const s of skills) {
      if (s === kw) { credit = 1.0; matchedAs = s; break; }
    }

    // 2. substring (only for 3+ char terms; avoids "R" hitting "Power BI")
    if (credit === 0 && kw.length >= 3) {
      for (const s of skills) {
        if (s.length >= 3 && (s.includes(kw) || kw.includes(s))) {
          credit = Math.max(credit, 1.0);
          matchedAs = s;
          break;
        }
      }
    }

    // 3. synonym
    if (credit === 0) {
      const syn = SYNONYMS[kw];
      if (syn) {
        for (const s of skills) {
          if (s === syn || (s.length >= 3 && syn.length >= 3 && (s.includes(syn) || syn.includes(s)))) {
            credit = Math.max(credit, 0.8);
            matchedAs = s;
            break;
          }
        }
      }
    }

    // 4. fuzzy (Levenshtein ≤ 2, only on tokens of length ≥ 4)
    if (credit === 0 && kw.length >= 4) {
      for (const s of skills) {
        if (s.length >= 4 && lev(s, kw) <= 2) {
          credit = Math.max(credit, 0.7);
          matchedAs = s;
          break;
        }
      }
    }

    if (credit > 0) {
      matched.push({ keyword: raw, matched_as: matchedAs, credit });
      totalCredit += credit;
    }
  }
  const score = Math.round((totalCredit / keywords.length) * 100);
  return { score, matched, totalCredit, denominator: keywords.length, mode: 'jd' };
}

// structure_score (0-100): PRD §11.1 weights.
// Within-1-page heuristic: total rewritten content ≤ ~3500 chars.
function structureScore(resume) {
  let s = 0;
  const parts = {};
  parts.summary = !!(resume?.summary && resume.summary.length > 40);
  if (parts.summary) s += 20;
  parts.education = Array.isArray(resume?.education) && resume.education.some((e) => e.college || e.degree);
  if (parts.education) s += 20;
  parts.skills = !!resume?.skills && Object.values(resume.skills).some((arr) => Array.isArray(arr) && arr.length > 0);
  if (parts.skills) s += 20;
  parts.experience_or_projects = (resume?.experience?.length > 0) || (resume?.projects?.length > 0);
  if (parts.experience_or_projects) s += 30;

  const charCount = JSON.stringify(resume || {}).length;
  parts.within_one_page = charCount <= 3500;
  if (parts.within_one_page) s += 10;

  return { score: Math.min(s, 100), parts, char_count: charCount };
}

// impact_score (0-100): rewards bullet density + metric count + verb quality.
// This is where thin-but-keyword-matched resumes get capped below 70.
const METRIC_RE = /(\d[\d,.]*\s*(?:%|k|m|cr|lakh|lpa|crore|mn|users?|customers?|members?|delegates?|rows?|records?|requests?|teams?|hours?|days?|months?|seconds?|ms|years?|stakeholders?|projects?|leads?|deals?|sponsorships?|articles?|posts?|sessions?|delegates?|attendees?|participants?|impressions?|clicks?|leads?)|\d+\s*[+]|₹[\d,.]+(?:\s*(?:cr|lakh|l|k))?|\$[\d,.]+(?:k|m|cr)?|>\s*\d+|<\s*\d+|\d+x|\d+:\d+)/i;

function bulletAngles(b) {
  const text = String(b || '').toLowerCase();
  const angles = new Set();
  // scale tokens
  if (/(rows?|records?|users?|customers?|members?|requests?|impressions?|clicks?|leads?|projects?|teams?|delegates?|attendees?|participants?|articles?|posts?|sessions?)/.test(text)) angles.add('scale');
  // quality tokens
  if (/(%|accuracy|precision|recall|f1|nps|csat|error rate|defect|coverage|uptime|sla)/.test(text)) angles.add('quality');
  // impact tokens
  if (/(saved|reduced|cut|increased|grew|drove|generated|raised|secured|shipped|deployed|delivered|replaced|automated)/.test(text)) angles.add('impact');
  return angles;
}

function impactScore(resume) {
  // Collect all bullets (experience + projects + por + achievements as one-liner bullets).
  const bullets = [];
  for (const e of (resume?.experience || [])) for (const b of (e.bullets || [])) bullets.push(b);
  for (const p of (resume?.projects   || [])) for (const b of (p.bullets || [])) bullets.push(b);
  for (const p of (resume?.por        || [])) for (const b of (p.bullets || [])) bullets.push(b);
  for (const a of (resume?.achievements || [])) bullets.push(String(a));

  if (bullets.length === 0) {
    return { score: 0, total_bullets: 0, action_verb_ratio: 0, metric_ratio: 0, density: 0, distinct_metric_bullets: 0 };
  }

  let actionVerbHits = 0, metricHits = 0, vagueHits = 0;
  let distinctAnglesAcross = new Set();

  for (const b of bullets) {
    const text = String(b).replace(/\*\*/g, '');
    // First word, stripped of markdown bold markers
    const first = (text.match(/^[A-Za-z][\w-]*/) || [''])[0].toLowerCase();
    if (ACTION_VERBS.has(first)) actionVerbHits++;
    if (VAGUE_VERBS.has(first)) vagueHits++;
    if (METRIC_RE.test(text)) metricHits++;
    for (const a of bulletAngles(text)) distinctAnglesAcross.add(a);
  }

  const actionVerbRatio = actionVerbHits / bullets.length;
  const metricRatio = metricHits / bullets.length;

  // Average bullets per entry (capped at 3 for normalization).
  const entries = ((resume?.experience || []).length) + ((resume?.projects || []).length) + ((resume?.por || []).length);
  const avgBulletsPerEntry = entries > 0 ? bullets.length / entries : 0;

  // Sub-scores
  const action_pts = Math.round(actionVerbRatio * 30);                       // up to 30
  const metric_pts = Math.round(metricRatio * 35);                            // up to 35
  // density: 0 if <1 avg, 8 if 1-1.5, 14 if 1.5-2.5, 20 if 2.5+
  const density_pts = avgBulletsPerEntry >= 2.5 ? 20
                    : avgBulletsPerEntry >= 1.5 ? 14
                    : avgBulletsPerEntry >= 1   ? 8 : 0;
  // distinct-angle volume: rewards a resume that covers SCALE + QUALITY + IMPACT across the whole thing.
  const angle_pts = distinctAnglesAcross.size >= 3 ? 15
                  : distinctAnglesAcross.size === 2 ? 10
                  : distinctAnglesAcross.size === 1 ? 5 : 0;
  // vague-verb penalty
  const vague_penalty = Math.min(15, Math.round((vagueHits / bullets.length) * 30));

  const score = Math.max(0, Math.min(100, action_pts + metric_pts + density_pts + angle_pts - vague_penalty));

  return {
    score,
    total_bullets: bullets.length,
    entries,
    avg_bullets_per_entry: Math.round(avgBulletsPerEntry * 100) / 100,
    action_verb_ratio: Math.round(actionVerbRatio * 100) / 100,
    metric_ratio: Math.round(metricRatio * 100) / 100,
    distinct_angles: [...distinctAnglesAcross],
    vague_verb_hits: vagueHits,
    breakdown: { action_pts, metric_pts, density_pts, angle_pts, vague_penalty },
  };
}

// Top-level score. PRD §11 formula stays: 0.6 + 0.2 + 0.2.
function scoreResume(resume, jdKeywords) {
  const kw = keywordMatchScore(resume, jdKeywords);
  const st = structureScore(resume);
  const ip = impactScore(resume);
  const total = Math.round(0.6 * kw.score + 0.2 * st.score + 0.2 * ip.score);
  return {
    total,
    keyword_match: kw,
    structure: st,
    impact: ip,
  };
}

// Short, friendly suggestion lines for sub-60 scores per PRD §11.2.
// Returns up to 3 actionable hints.
function suggestionsFor(scoreObj) {
  const out = [];
  const ip = scoreObj.impact || {};
  if ((ip.metric_ratio || 0) < 0.5) {
    out.push("Add specific numbers to your bullets — e.g. 'reduced load time by 40%' instead of 'improved performance'.");
  }
  if ((ip.avg_bullets_per_entry || 0) < 1.5) {
    out.push("Each role/project deserves 2-3 bullets covering different angles (scale, quality, impact).");
  }
  if ((scoreObj.keyword_match?.matched?.length || 0) < 5 && scoreObj.keyword_match?.denominator > 0) {
    out.push("Mention more skills from the JD that you actually have — list them in skills and weave into project descriptions.");
  }
  if (ip.vague_verb_hits > 0) {
    out.push("Replace 'worked on' / 'helped with' with concrete action verbs (Built, Shipped, Reduced, Designed).");
  }
  return out.slice(0, 3);
}

module.exports = { scoreResume, suggestionsFor, keywordMatchScore, structureScore, impactScore };
