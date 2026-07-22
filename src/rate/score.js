// Deterministic resume scorer. NO LLM. Pure regex + counters.
//
// This is the trust foundation of rate mode. Same input → same output, always.
// The LLM parts of the total 10-point score (bullet impact judgment, grammar,
// role fit) live in a separate LLM scorer (Day 3) and merge with this on top.
//
// Rubric split (out of 10 total):
//   ATS Compliance      2.0   — deterministic only
//   Contact & Structure 1.0   — deterministic only
//   Content Quality     3.0   — 2.0 deterministic (this file) + 1.0 LLM
//   Role Fit            2.0   — LLM only (Day 3)
//   Polish              2.0   — 1.0 deterministic (this file) + 1.0 LLM
//
// So this file returns the deterministic 6.0 of 10.0 (ATS + Contact +
// deterministic parts of Content Quality + deterministic part of Polish).
// The LLM scorer contributes the remaining 4.0.
//
// Issues array is what the UI + audit report shows. Every issue has a source
// anchor (source_line) or fires against structure (source_line: null) —
// this is the "cite it or don't ship it" rule that makes the tool auditable.

const crypto = require('crypto');
const {
  ACTION_VERBS, FILLERS, CGPA_RE, CGPA_BARE_RE, BOARD_PCT_RE,
  METRIC_UNITS_RE, CURRENCY_RE, BARE_NUMBER_RE, RATIO_RE, CANONICAL_SECTIONS,
} = require('./lexicon');

// Bump when scoring math changes so previously cached scores get recomputed
// instead of being served stale. Cache key includes this; consumers do NOT
// need to invalidate manually.
const RUBRIC_VERSION = 'r1-2026-07-21';

const SEV = { CRITICAL: 3, MEDIUM: 2, MINOR: 1 };

function firstWord(s) {
  const m = String(s || '').trim().match(/^[A-Za-z]+/);
  return m ? m[0].toLowerCase() : '';
}

function countMetrics(bulletText) {
  const t = String(bulletText || '');
  const seen = new Set();
  const push = (re) => {
    const matches = t.match(re) || [];
    for (const m of matches) seen.add(m.toLowerCase());
  };
  push(METRIC_UNITS_RE);
  push(CURRENCY_RE);
  push(RATIO_RE);
  push(BARE_NUMBER_RE);
  return seen.size;
}

function bulletsWithSource(rj) {
  // Returns [{ text, source_line, section }] across experience, projects, por,
  // achievements — the four sections whose bullets carry impact-quality weight.
  const out = [];
  const walk = (arr, section) => {
    for (const entry of (arr || [])) {
      for (const b of (entry.bullets || [])) {
        if (typeof b === 'string') {
          out.push({ text: b, source_line: null, section });
        } else if (b && typeof b === 'object') {
          out.push({ text: b.text || '', source_line: b.source_line || null, section });
        }
      }
    }
  };
  walk(rj?.experience, 'experience');
  walk(rj?.projects, 'projects');
  walk(rj?.por, 'por');
  for (const a of (rj?.achievements || [])) {
    if (typeof a === 'string') out.push({ text: a, source_line: null, section: 'achievements' });
    else if (a && typeof a === 'object') out.push({ text: a.text || '', source_line: a.source_line || null, section: 'achievements' });
  }
  return out;
}

// ─── ATS Compliance (2.0) ────────────────────────────────────────────────
// Text-extractability is a precondition (if we're scoring, it passed layer 1
// or 2 already). We penalize multi-column layouts (parsers can jumble reading
// order) and low canonical-section count (weakly-structured resumes get lower
// ATS parse quality).
function scoreAtsCompliance({ text, parseMeta }) {
  const issues = [];
  let earned = 2.0;

  if (parseMeta && parseMeta.multiColumn) {
    earned -= 1.0;
    issues.push({
      severity: 'CRITICAL',
      category: 'ats_multi_column',
      source_line: null,
      why: 'PDF uses a multi-column layout. ATS parsers read left-to-right by y-coordinate and often jumble multi-column resumes into unreadable text.',
      cost: 'Some ATS systems will store your resume as scrambled text or reject it outright.',
    });
  }

  const textLower = text.toLowerCase();
  const foundSections = CANONICAL_SECTIONS.filter((s) => new RegExp(`(^|\\n)\\s*${s}\\b`, 'i').test(textLower));
  const uniqueSections = new Set(foundSections.map((s) => {
    // Collapse aliases so "experience" and "work experience" count once
    if (/experience|internship|employment/.test(s)) return 'experience';
    if (/education|academic/.test(s)) return 'education';
    if (/skills|competencies/.test(s)) return 'skills';
    if (/project/.test(s)) return 'projects';
    if (/certification|certificate/.test(s)) return 'certifications';
    if (/achievement|award|honor/.test(s)) return 'achievements';
    if (/responsibility|leadership|por/.test(s)) return 'por';
    if (/summary|objective|profile/.test(s)) return 'summary';
    return s;
  }));
  if (uniqueSections.size < 3) {
    earned -= 0.5;
    issues.push({
      severity: 'MEDIUM',
      category: 'ats_weak_structure',
      source_line: null,
      why: `Only ${uniqueSections.size} standard section headers detected (${[...uniqueSections].join(', ') || 'none'}). ATS parsers rely on standard headers ("Experience", "Education", "Skills", "Projects") to segment content.`,
      cost: 'Fields may be extracted into wrong buckets or dropped entirely.',
    });
  }

  earned = Math.max(0, earned);
  return { earned, max: 2.0, issues };
}

// ─── Contact & Structure (1.0) ───────────────────────────────────────────
function scoreContact({ resume_json, roleType }) {
  const rj = resume_json || {};
  const issues = [];
  let earned = 1.0;

  const emailOk = rj.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rj.email);
  const phoneOk = rj.phone && /\d{5,}/.test(rj.phone);
  const linkedinOk = rj.linkedin && /^https?:\/\/(www\.)?linkedin\.com\/in\/[\w-]+/i.test(rj.linkedin);
  const linkedinLegacy = rj.linkedin && /\/pub\/|\/profile\//i.test(rj.linkedin);
  const githubOk = rj.github && /^https?:\/\/(www\.)?github\.com\/[\w-]+/i.test(rj.github);

  if (!emailOk) {
    earned -= 0.4;
    issues.push({
      severity: 'CRITICAL',
      category: 'contact_email_missing',
      source_line: null,
      why: 'No valid email address found on the resume.',
      cost: 'Recruiter cannot reply. This is a resume-rejected-in-3-seconds level defect.',
    });
  }
  if (!phoneOk) {
    earned -= 0.2;
    issues.push({
      severity: 'CRITICAL',
      category: 'contact_phone_missing',
      source_line: null,
      why: 'No phone number found in a recognizable format.',
      cost: 'Recruiter cannot call.',
    });
  }
  if (!linkedinOk) {
    earned -= 0.2;
    issues.push({
      severity: linkedinLegacy ? 'MEDIUM' : 'MEDIUM',
      category: linkedinLegacy ? 'contact_linkedin_legacy_format' : 'contact_linkedin_missing',
      source_line: null,
      why: linkedinLegacy
        ? `LinkedIn URL uses legacy format (${rj.linkedin}). Modern format is linkedin.com/in/<handle>. Some ATS parsers strip legacy /pub/ or /profile/ URLs.`
        : 'No LinkedIn URL found (or the source PDF has "LinkedIn" as clickable text without an exposed URL — some PDF templates hide the href).',
      cost: 'Recruiter cannot verify claims or reach you outside email/phone.',
    });
  }
  if (roleType === 'tech' && !githubOk) {
    earned -= 0.2;
    issues.push({
      severity: 'MEDIUM',
      category: 'contact_github_missing',
      source_line: null,
      why: 'No GitHub URL for a technical role. Recruiters expect a code sample source they can browse.',
      cost: 'Strong technical resumes without a GitHub link get ranked below equally-strong resumes that have one.',
    });
  }

  earned = Math.max(0, earned);
  return { earned, max: 1.0, issues };
}

// ─── Content Quality — deterministic parts (2.0 of 3.0) ──────────────────
// Metric density (1.0) + action-verb-start rate (0.6) + filler penalty (0.4).
// The remaining 1.0 is LLM bullet-impact judgment (Day 3).
function scoreContentDeterministic({ resume_json }) {
  const issues = [];
  const bullets = bulletsWithSource(resume_json);

  if (bullets.length === 0) {
    return {
      earned: 0,
      max: 2.0,
      issues: [{
        severity: 'CRITICAL',
        category: 'content_no_bullets',
        source_line: null,
        why: 'No bullet points found under experience, projects, PoR, or achievements.',
        cost: 'Recruiter has nothing to skim. Resume is functionally a header + skills list.',
      }],
    };
  }

  // Metric density — fraction of bullets containing ≥1 metric
  const withMetric = bullets.filter((b) => countMetrics(b.text) > 0);
  const metricFrac = withMetric.length / bullets.length;
  const metricEarned = Math.min(1.0, metricFrac * 1.4); // full credit at ~70% coverage
  if (metricFrac < 0.5) {
    // Point out up to 3 metric-less bullets, sorted by section priority (experience > projects > por > achievements)
    const priority = { experience: 0, projects: 1, por: 2, achievements: 3 };
    const missingMetric = bullets
      .filter((b) => countMetrics(b.text) === 0)
      .sort((a, b) => (priority[a.section] || 9) - (priority[b.section] || 9))
      .slice(0, 3);
    for (const b of missingMetric) {
      issues.push({
        severity: metricFrac < 0.2 ? 'CRITICAL' : 'MEDIUM',
        category: 'content_missing_metric',
        source_line: b.source_line,
        why: `Bullet has no measurable outcome: "${b.text.slice(0, 100)}"`,
        cost: 'Recruiter skim compares candidates by numbers. Bullets without them lose to peers who have them.',
      });
    }
    if (bullets.length - withMetric.length > 3) {
      issues.push({
        severity: 'MEDIUM',
        category: 'content_metric_density_low',
        source_line: null,
        why: `Only ${withMetric.length} of ${bullets.length} bullets carry a metric (${Math.round(metricFrac * 100)}%). Target is 70%+.`,
        cost: 'Overall resume reads as tasks-done rather than impact-created.',
      });
    }
  }

  // Action-verb-start
  const verbStarted = bullets.filter((b) => ACTION_VERBS.has(firstWord(b.text)));
  const verbFrac = verbStarted.length / bullets.length;
  const verbEarned = Math.min(0.6, verbFrac * 0.75); // full credit at ~80% coverage
  if (verbFrac < 0.7) {
    const weakOpens = bullets
      .filter((b) => !ACTION_VERBS.has(firstWord(b.text)))
      .slice(0, 3);
    for (const b of weakOpens) {
      issues.push({
        severity: 'MEDIUM',
        category: 'content_weak_verb',
        source_line: b.source_line,
        why: `Bullet does not start with a strong action verb: "${b.text.slice(0, 100)}"`,
        cost: 'Weak openings dilute impact in the 6-second recruiter skim.',
      });
    }
  }

  // Filler penalty — count instances across all bullets
  const allBulletText = bullets.map((b) => b.text.toLowerCase()).join('\n');
  const fillerHits = [];
  for (const f of FILLERS) {
    let idx = 0;
    while ((idx = allBulletText.indexOf(f, idx)) !== -1) {
      fillerHits.push(f);
      idx += f.length;
    }
  }
  const fillerPenalty = Math.min(0.4, fillerHits.length * 0.08);
  const fillerEarned = 0.4 - fillerPenalty;
  if (fillerHits.length > 0) {
    // Cite up to 2 concrete offenders with their source lines
    let cited = 0;
    for (const b of bullets) {
      if (cited >= 2) break;
      const lc = b.text.toLowerCase();
      const hitFiller = FILLERS.find((f) => lc.includes(f));
      if (hitFiller) {
        issues.push({
          severity: 'MINOR',
          category: 'content_filler_phrase',
          source_line: b.source_line,
          why: `Bullet contains filler phrase "${hitFiller}": "${b.text.slice(0, 100)}"`,
          cost: 'Filler phrases signal task-list writing instead of outcome writing.',
        });
        cited++;
      }
    }
  }

  const earned = Math.max(0, metricEarned + verbEarned + fillerEarned);
  return { earned, max: 2.0, issues };
}

// ─── Polish — deterministic part (1.0 of 2.0) ────────────────────────────
// Page count + date-format consistency. LLM adds grammar (1.0) in Day 3.
function scorePolishDeterministic({ parseMeta, resume_json }) {
  const issues = [];
  let earned = 1.0;

  const pages = parseMeta?.pageCount || 1;
  if (pages > 2) {
    earned -= 0.5;
    issues.push({
      severity: 'MEDIUM',
      category: 'polish_page_count_high',
      source_line: null,
      why: `Resume is ${pages} pages. Freshers and early-career candidates should stick to 1 page; 2 is the ceiling.`,
      cost: 'Longer resumes get partial skims; recruiters rarely turn beyond page 2.',
    });
  }

  // Date-format consistency — collect dates from education, experience, projects
  const dateStrings = [
    ...(resume_json?.education || []).map((e) => e.dates).filter(Boolean),
    ...(resume_json?.experience || []).map((e) => e.dates).filter(Boolean),
    ...(resume_json?.projects || []).map((e) => e.dates).filter(Boolean),
  ];
  if (dateStrings.length >= 2) {
    // Classify each: "MMM YYYY" (Jan 2024), "MM/YYYY" (01/2024), "YYYY" bare, other
    const patterns = dateStrings.map((d) => {
      if (/[A-Za-z]{3,}\s+\d{4}/.test(d)) return 'mmm-yyyy';
      if (/\d{1,2}\/\d{4}/.test(d)) return 'num-yyyy';
      if (/^\d{4}\b/.test(d)) return 'yyyy';
      return 'other';
    });
    const unique = new Set(patterns.filter((p) => p !== 'other'));
    if (unique.size > 1) {
      earned -= 0.3;
      issues.push({
        severity: 'MINOR',
        category: 'polish_date_format_inconsistent',
        source_line: null,
        why: `Dates use ${unique.size} different formats (${[...unique].join(', ')}). Pick one and use it across all sections.`,
        cost: 'Small polish signal; recruiters notice inconsistency, though it rarely blocks.',
      });
    }
  }

  earned = Math.max(0, earned);
  return { earned, max: 1.0, issues };
}

// ─── India-specific embedded checks ──────────────────────────────────────
// These emit issues but don't have their own sub-score line — CGPA absence
// hits Contact & Structure (0.1 penalty). Board % absence is a MINOR flag.
function scoreIndiaChecks({ text, resume_json }) {
  const issues = [];
  let contactPenalty = 0;

  const rjCgpa = (resume_json?.education || []).some((e) => e.cgpa && String(e.cgpa).trim());
  const textHasCgpa = CGPA_RE.test(text) || CGPA_BARE_RE.test(text);
  if (!rjCgpa && !textHasCgpa) {
    contactPenalty += 0.1;
    issues.push({
      severity: 'MEDIUM',
      category: 'india_cgpa_missing',
      source_line: null,
      why: 'CGPA / GPA not found. Indian recruiters at tier-2/3 colleges routinely filter by CGPA before reading further.',
      cost: 'Many campus-adjacent recruiters set a floor (7.0/10 or 8.0/10) and skip resumes without a visible CGPA.',
    });
  } else if (rjCgpa) {
    // Check /10 denominator presence
    const cgpaStr = (resume_json.education || []).map((e) => e.cgpa).filter(Boolean).join(' ');
    if (!/\/\s*10|\/\s*4/.test(cgpaStr)) {
      issues.push({
        severity: 'MINOR',
        category: 'india_cgpa_missing_denominator',
        source_line: null,
        why: `CGPA present but no scale denominator (e.g. "${cgpaStr}" — write it as "${cgpaStr}/10").`,
        cost: 'Some ATS parsers only pick up CGPA when the /10 form is present.',
      });
    }
  }

  if (!BOARD_PCT_RE.test(text)) {
    issues.push({
      severity: 'MINOR',
      category: 'india_boards_missing',
      source_line: null,
      why: '10th / 12th board percentage not detected. Recruiters at Indian tier-2/3 campuses check this.',
      cost: 'Missing at freshers-heavy roles can cost you the phone screen.',
    });
  }

  return { contactPenalty, issues };
}

// ─── Public ──────────────────────────────────────────────────────────────
// score(input) → { score_deterministic, subscores, issues, meta }
//
// input:
//   text        — full parsed text (for section-header + india-token regex)
//   lines       — parsed lines with source anchors (used indirectly via resume_json)
//   parseMeta   — { pageCount, multiColumn, wordCount, layer } from parse.js
//   resume_json — extracted structure with source_line anchors on bullets
//   role        — target role string (mandatory per v2 spec)
//   roleType    — 'tech' | 'business' | 'other'; affects github-required check
function score(input) {
  const { text, parseMeta, resume_json, role, roleType = 'tech' } = input;
  if (!text || !resume_json) {
    throw new Error('score: text and resume_json are required');
  }

  const ats = scoreAtsCompliance({ text, parseMeta });
  const contact = scoreContact({ resume_json, roleType });
  const contentDet = scoreContentDeterministic({ resume_json });
  const polishDet = scorePolishDeterministic({ parseMeta, resume_json });
  const india = scoreIndiaChecks({ text, resume_json });

  // India penalty applies to contact — cap-safe subtraction, never go below 0
  const contactAdjusted = { ...contact, earned: Math.max(0, contact.earned - india.contactPenalty) };

  const subscores = {
    ats_compliance:      { ...ats, label: 'ATS Compliance' },
    contact_structure:   { ...contactAdjusted, label: 'Contact & Structure' },
    content_quality_det: { ...contentDet, label: 'Content Quality (deterministic parts)' },
    polish_det:          { ...polishDet, label: 'Polish (deterministic parts)' },
  };

  const allIssues = [
    ...ats.issues,
    ...contact.issues,
    ...contentDet.issues,
    ...polishDet.issues,
    ...india.issues,
  ];

  // Sort by severity then category so glimpse output is stable
  allIssues.sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0) || a.category.localeCompare(b.category));

  const score_deterministic = Math.round(
    (ats.earned + contactAdjusted.earned + contentDet.earned + polishDet.earned) * 10,
  ) / 10;
  const max_deterministic = ats.max + contact.max + contentDet.max + polishDet.max; // 6.0

  return {
    score_deterministic,
    max_deterministic,
    subscores,
    issues: allIssues,
    meta: {
      rubric_version: RUBRIC_VERSION,
      role,
      roleType,
      cache_key: cacheKey({ text, role }),
      bullets_total: bulletsWithSource(resume_json).length,
    },
  };
}

// Cache key = sha256(text + role + rubric_version). Same inputs → same key →
// same score. Wire this into Redis on the caller side with a 30d TTL.
function cacheKey({ text, role }) {
  return crypto
    .createHash('sha256')
    .update(String(text || '') + '\n\nROLE=' + String(role || '') + '\n\nRUBRIC=' + RUBRIC_VERSION)
    .digest('hex');
}

module.exports = { score, cacheKey, RUBRIC_VERSION };
