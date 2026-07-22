// Content-atom fabrication verifier. NO LLM.
//
// The moat. This is what structurally prevents the improver from
// hallucinating metrics, tools, companies, or credentials the student never
// had. Every rewritten bullet passes through here before it can be shown
// (much less rendered into a paid PDF).
//
// Contract:
//   verify({ rewritten, original, sourceText, options? }) →
//     { ok: bool, unverified_atoms: [...], details: [...] }
//
// An "atom" is a piece of content that could constitute fabrication if the
// LLM invented it:
//   - Numbers with units (50K users, 92%, ₹5 lakh, 20/20, p95 400ms)
//   - Currency amounts (₹, $, Rs)
//   - Tech tokens (from tech-dictionary.json — with alias collapse)
//   - Proper nouns (companies, products, tools not in the dictionary)
//
// Verification: each atom in the OUTPUT must appear either in the ORIGINAL
// bullet or anywhere in the sourceText (the student's full parsed resume).
// If ANY atom fails verification, ok=false and the improved bullet MUST be
// rejected by the caller (typically fall back to a safe verb-strengthening
// rewrite that adds nothing).
//
// Fuzzy matching:
//   - Case-insensitive throughout.
//   - Numbers normalized (50K == 50000, 1.5M == 1500000, "10 users" matches "10").
//   - Tech aliases collapse (K8s == Kubernetes, JS == JavaScript, PG == PostgreSQL).
//   - Proper nouns match on substring after lowercase (so "GitHub Actions" in
//     output matches "GitHub" in source — subset relationship is fine because
//     the improver can name a specific product from a general mention).
//
// Deliberately conservative: we prefer to reject a legitimate rewrite (the
// caller will fall back to a safe rewrite) over letting a fabricated atom
// slip through. Rejecting the rewrite hurts nobody; letting a fake metric
// through kills the student's interview.

const path = require('path');
const fs = require('fs');
const logger = require('../logger');
const { ACTION_VERBS } = require('./lexicon');

// Load tech dictionary once per process. Read errors are fatal — running
// without the dictionary would silently degrade verification quality.
let _dict = null;
function loadDict() {
  if (_dict) return _dict;
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'tech-dictionary.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const canonical = new Set((parsed.canonical || []).map((s) => String(s).toLowerCase()));
  const aliases = new Map();
  for (const [k, v] of Object.entries(parsed.aliases || {})) {
    aliases.set(String(k).toLowerCase(), String(v).toLowerCase());
  }
  // Every canonical token also aliases to itself for uniform lookup
  for (const c of canonical) aliases.set(c, c);
  _dict = { canonical, aliases };
  return _dict;
}

// English stopwords + common resume adjectives we should not treat as
// proper nouns. Lowercase only. Kept small — over-filtering here defeats
// the point of proper-noun detection.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'while', 'as', 'of', 'at', 'by', 'for', 'with',
  'to', 'from', 'in', 'on', 'up', 'off', 'over', 'under', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'can', 'shall',
  'i', 'my', 'me', 'we', 'our', 'us', 'you', 'your', 'they', 'their', 'them', 'he', 'she', 'it', 'his', 'her', 'its',
  'this', 'that', 'these', 'those', 'each', 'every', 'all', 'any', 'some', 'no', 'not', 'nor',
  'built', 'designed', 'developed', 'shipped', 'led', 'created', 'implemented', 'engineered',
  'analyzed', 'reduced', 'increased', 'improved', 'automated', 'launched', 'delivered',
  // Section-header nouns
  'summary', 'objective', 'education', 'experience', 'projects', 'skills', 'certifications',
  'achievements', 'awards', 'internship', 'internships',
]);

// ─── Number extraction + normalization ──────────────────────────────────
// Extract every number occurrence + its trailing unit. Return normalized
// numeric value + a "token" string for source-scan matching.
//
// Examples:
//   "50K users"    → { raw: "50K", value: 50000, token: "50k" }
//   "92%"          → { raw: "92%", value: 92, token: "92%" }
//   "1.5M"         → { raw: "1.5M", value: 1500000, token: "1.5m" }
//   "₹18,310 Cr"   → { raw: "₹18,310 Cr", value: 1831000000000, token: "18310cr" }
//   "20/20"        → { raw: "20/20", value: null, token: "20/20", ratio: true }
//   "p99 400ms"    → two atoms: "p99" (bare 99), "400ms"
//
// Kept aggressive on capture so we don't miss fabrications; matching is
// where we're more lenient.
const NUM_UNIT_RE = /(₹|rs\.?\s*|\$|usd|inr|€)?\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:\.\d+)?)\s*(k|m|b|l|lakh|lakhs|crore|crores|cr|%|x|users?|customers?|clients?|delegates?|members?|records?|rows?|files?|events?|requests?|txns?|transactions?|leads?|calls?|bookings?|conversions?|orders?|sales?|releases?|deployments?|prs?|ms|s|sec|secs|min|mins|hrs?|hours?|days?|weeks?|months?|years?|yrs?|gb|mb|kb|pt|pts?|points?)?\b/ig;

const RATIO_RE = /\b(\d+)\s*\/\s*(\d+)\b/g;
const P_METRIC_RE = /\bp\s*(\d{2,3})\b/ig; // p95, p99, p50

function normalizeNumber(numStr, unit) {
  let n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!isFinite(n)) return null;
  const u = String(unit || '').toLowerCase().replace(/\s+/g, '');
  switch (u) {
    case 'k': n *= 1_000; break;
    case 'm': n *= 1_000_000; break;
    case 'b': n *= 1_000_000_000; break;
    case 'l': case 'lakh': case 'lakhs': n *= 100_000; break;
    case 'cr': case 'crore': case 'crores': n *= 10_000_000; break;
    // % and count units keep the bare number as-is
  }
  return n;
}

function extractNumericAtoms(text) {
  const out = [];
  const s = String(text || '');
  // Number + unit
  NUM_UNIT_RE.lastIndex = 0;
  let m;
  while ((m = NUM_UNIT_RE.exec(s)) !== null) {
    const [full, currency, numStr, unit] = m;
    if (!numStr) continue;
    // Reject tiny bare numbers we don't care about (single digit with no unit or currency)
    if (!currency && !unit && parseFloat(numStr) < 10 && !numStr.includes('.')) continue;
    const value = normalizeNumber(numStr, unit);
    const token = (currency ? '' + (currency.trim().toLowerCase()) : '') + numStr.toLowerCase().replace(/,/g, '') + (unit ? unit.toLowerCase().replace(/\s+/g, '') : '');
    out.push({
      kind: 'number',
      raw: full.trim(),
      value,
      token,
    });
  }
  // Ratios
  RATIO_RE.lastIndex = 0;
  while ((m = RATIO_RE.exec(s)) !== null) {
    out.push({
      kind: 'ratio',
      raw: m[0],
      value: null,
      token: `${m[1]}/${m[2]}`,
    });
  }
  // Percentile metrics
  P_METRIC_RE.lastIndex = 0;
  while ((m = P_METRIC_RE.exec(s)) !== null) {
    out.push({
      kind: 'percentile',
      raw: m[0],
      value: parseInt(m[1], 10),
      token: `p${m[1]}`,
    });
  }
  return dedupeAtoms(out);
}

function dedupeAtoms(atoms) {
  const seen = new Set();
  const out = [];
  for (const a of atoms) {
    const key = `${a.kind}|${a.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// ─── Tech token extraction ───────────────────────────────────────────────
// Split text into tokens, look each up in the alias table. Also try
// multi-word phrases up to 3 tokens ("power bi", "spring boot", "next.js"
// after normalizing punctuation).
function extractTechAtoms(text) {
  const { aliases } = loadDict();
  const s = String(text || '').toLowerCase();
  // Preserve dots + hyphens inside tokens (next.js, node.js, c++, c#).
  // Split on whitespace + punctuation that isn't inside a compound.
  const words = s.split(/[\s,;:()\[\]<>{}!?"'|\\\/·—–\-]+/).filter(Boolean);
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push({ kind: 'tech', raw: t, token: t, canonical: aliases.get(t) });
  };
  // Single-word
  for (const w of words) {
    if (aliases.has(w)) add(w);
  }
  // 2-word and 3-word
  for (let i = 0; i < words.length - 1; i++) {
    const two = `${words[i]} ${words[i + 1]}`;
    if (aliases.has(two)) add(two);
    if (i < words.length - 2) {
      const three = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (aliases.has(three)) add(three);
    }
  }
  return out;
}

// Verb-morphology guard: return true if `word` (lowercase) is a form of an
// action verb from lexicon. Handles bare form + -ed / -ing / -s / -ied.
// Used to filter sentence-start capitalized verbs like "Replaced" or
// "Scaled" out of the proper-noun set — those are grammar, not entities.
function isVerbForm(word) {
  if (!word) return false;
  if (checkOne(word)) return true;
  // Try stripping a "re-" prefix (recomputed, rearchitected, remigrated).
  // Improvers commonly reach for these on rewrites; matching each individually
  // would bloat the ACTION_VERBS list.
  if (word.startsWith('re') && word.length > 4) {
    if (checkOne(word.slice(2))) return true;
  }
  return false;
}

function checkOne(word) {
  if (ACTION_VERBS.has(word)) return true;
  // -ed / -d
  if (word.endsWith('ed')) {
    const stem = word.slice(0, -2);
    if (ACTION_VERBS.has(stem)) return true;
    if (ACTION_VERBS.has(stem + 'e')) return true; // "increased" → "increase"
  }
  if (word.endsWith('d') && !word.endsWith('ed')) {
    const stem = word.slice(0, -1);
    if (ACTION_VERBS.has(stem)) return true;
  }
  // -ing
  if (word.endsWith('ing')) {
    const stem = word.slice(0, -3);
    if (ACTION_VERBS.has(stem)) return true;
    if (ACTION_VERBS.has(stem + 'e')) return true;
  }
  // -ied → -y
  if (word.endsWith('ied')) {
    const stem = word.slice(0, -3) + 'y';
    if (ACTION_VERBS.has(stem)) return true;
  }
  return false;
}

// ─── Proper noun extraction ──────────────────────────────────────────────
// A "proper noun" here = a capitalized word (or hyphenated compound) that
// isn't a stopword, a verb form, or already captured as a tech token.
// Catches companies, product names, org names that aren't in the tech
// dictionary — for example "Razorpay", "IIT Bombay", "Smart India Hackathon".
//
// Multi-word phrases get their leading verb / stopword stripped, so
// "Built ResumeRocket" reduces to the atom "ResumeRocket" (the actual entity)
// instead of accidentally passing verification because "built" is in source.
function extractProperNouns(text, techAtoms) {
  const s = String(text || '');
  const techSet = new Set(techAtoms.map((a) => a.token));
  const out = [];
  const seen = new Set();

  const re = /(?:^|[^.!?]\s+)([A-Z][A-Za-z0-9]+(?:[ -](?:[A-Z][A-Za-z0-9]+|of|the|and))*)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const phraseRaw = m[1].trim();
    if (phraseRaw.length <= 1) continue;

    // Strip a leading verb / stopword — a sentence-start "Built Bharat Resume"
    // reduces to the entity "Bharat Resume". Otherwise the leading verb
    // would satisfy verification for a fake entity because the verb itself
    // is naturally common in source.
    const words = phraseRaw.split(/[ -]+/);
    let start = 0;
    while (start < words.length) {
      const lcw = words[start].toLowerCase();
      if (STOPWORDS.has(lcw) || isVerbForm(lcw)) start++;
      else break;
    }
    if (start >= words.length) continue; // whole phrase was stopwords/verbs
    const phrase = words.slice(start).join(' ');
    const lc = phrase.toLowerCase();

    if (STOPWORDS.has(lc)) continue;
    if (isVerbForm(lc)) continue;
    if (techSet.has(lc)) continue;
    if (loadDict().aliases.has(lc)) continue;
    if (phrase.length <= 1) continue;
    // Drop very short / all-caps 2-letter tokens (I, AI, ML, etc.) — too
    // noisy to be reliably verified. Real proper nouns are ≥3 chars.
    if (phrase.length < 3) continue;
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push({ kind: 'proper_noun', raw: phrase, token: lc });
  }
  return out;
}

// ─── Comparison / verification ───────────────────────────────────────────
// For each atom found in `rewritten`, is it present in `original` or anywhere
// in `sourceText`? An atom is "present" when its token OR (for tech) its
// canonical alias OR (for numbers) its normalized value appears somewhere.
function atomInText(atom, sourceLower, sourceAtoms) {
  if (atom.kind === 'tech') {
    // Match on either the original alias or its canonical form
    const candidates = [atom.token, atom.canonical].filter(Boolean);
    for (const c of candidates) {
      if (sourceLower.includes(c)) return true;
      // Also match against source's extracted tech atoms (alias-collapsed)
      for (const s of sourceAtoms.tech) {
        if (s.token === c || s.canonical === c) return true;
      }
    }
    return false;
  }
  if (atom.kind === 'number') {
    // Exact token match wins
    if (sourceLower.includes(atom.token)) return true;
    // Numeric-value match: source has an atom with same normalized value
    if (atom.value != null) {
      for (const s of sourceAtoms.numbers) {
        if (s.value != null && Math.abs(s.value - atom.value) < 0.01) return true;
        // Also: bare number in source without unit ("500 customers" matches "500")
        if (s.value === atom.value) return true;
      }
      // Substring on the bare integer form (handles "500" appearing anywhere)
      const bareForm = String(atom.value).replace(/\.0$/, '');
      const re = new RegExp(`\\b${bareForm}\\b`);
      if (re.test(sourceLower)) return true;
    }
    return false;
  }
  if (atom.kind === 'ratio' || atom.kind === 'percentile') {
    return sourceLower.includes(atom.token);
  }
  if (atom.kind === 'proper_noun') {
    // Full-phrase substring match wins outright ("GitHub Actions" in output,
    // "GitHub Actions" in source → verified).
    if (sourceLower.includes(atom.token)) return true;
    // Multi-word phrases: EVERY content word (length ≥ 3, non-stopword,
    // non-verb) must appear in source. This is what stops
    // "Built ResumeRocket" from sneaking through on the strength of "built"
    // alone — the entity word "resumerocket" is the one the check bites on.
    const contentWords = atom.token.split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !isVerbForm(w));
    if (contentWords.length === 0) return true; // stopwords + verbs only → already vacuous
    return contentWords.every((w) => sourceLower.includes(w));
  }
  return false;
}

// ─── Public ──────────────────────────────────────────────────────────────
function verify({ rewritten, original, sourceText, options = {} }) {
  if (typeof rewritten !== 'string' || rewritten.trim() === '') {
    return { ok: false, unverified_atoms: [], details: ['empty-rewritten'] };
  }
  const orig = String(original || '');
  const src = String(sourceText || '');

  // Fast-path: rewritten is identical (verb-only tweaks would still change
  // the string) — nothing to verify.
  if (rewritten.trim() === orig.trim()) {
    return { ok: true, unverified_atoms: [], details: ['identical-passthrough'] };
  }

  // Combined "known" text = original bullet + full source. Both sides get
  // lowercased once for scan efficiency.
  const known = (orig + '\n' + src).toLowerCase();
  const sourceAtoms = {
    numbers: [...extractNumericAtoms(orig), ...extractNumericAtoms(src)],
    tech: [...extractTechAtoms(orig), ...extractTechAtoms(src)],
  };

  const outAtoms = [
    ...extractNumericAtoms(rewritten),
    ...extractTechAtoms(rewritten),
  ];
  const outProper = extractProperNouns(rewritten, outAtoms);
  const allOutAtoms = [...outAtoms, ...outProper];

  const unverified = [];
  const details = [];
  for (const a of allOutAtoms) {
    if (!atomInText(a, known, sourceAtoms)) {
      unverified.push(a);
      details.push(`FABRICATED[${a.kind}] ${a.raw}`);
    }
  }

  if (options.debug && unverified.length === 0) {
    details.push(`verified ${allOutAtoms.length} atoms`);
  }

  return {
    ok: unverified.length === 0,
    unverified_atoms: unverified,
    details,
    meta: {
      atoms_checked: allOutAtoms.length,
      numeric_atoms: outAtoms.filter((a) => a.kind === 'number' || a.kind === 'ratio' || a.kind === 'percentile').length,
      tech_atoms: outAtoms.filter((a) => a.kind === 'tech').length,
      proper_noun_atoms: outProper.length,
    },
  };
}

// Convenience for the improver: "did this rewrite introduce a fabricated
// atom" boolean, with a log line for the reject path.
function safeAssertVerified(v, ctx = {}) {
  if (v.ok) return true;
  logger.warn({
    ...ctx,
    unverified: v.unverified_atoms.map((a) => a.raw).slice(0, 10),
    atoms_checked: v.meta?.atoms_checked,
  }, 'rate.verify rejected rewrite');
  return false;
}

module.exports = {
  verify,
  safeAssertVerified,
  // Exposed for tests + future improvements
  extractNumericAtoms,
  extractTechAtoms,
  extractProperNouns,
};
