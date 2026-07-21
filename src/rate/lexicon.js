// Lexicons for the deterministic scorer. Kept in a separate file so growth is
// cheap and grep-able: adding a new verb or filler doesn't touch scoring logic.
//
// Everything here is LOWERCASE; callers must lowercase inputs before match.

// Strong action verbs typically found at the start of an impact bullet.
// Selected from analysis of high-scoring Indian tech resumes + FAANG-style
// bullet patterns. Includes both common ("Built") and specific ("Refactored")
// verbs, plus PoR/leadership-adjacent ("Led", "Chaired") for non-code roles.
const ACTION_VERBS = new Set([
  'accelerated', 'achieved', 'acquired', 'analyzed', 'applied', 'architected',
  'assembled', 'automated', 'boosted', 'built', 'chaired', 'coached',
  'coded', 'collaborated', 'communicated', 'compiled', 'completed', 'composed',
  'conceived', 'conducted', 'configured', 'constructed', 'consulted', 'coordinated',
  'created', 'cut', 'debugged', 'decreased', 'defined', 'delivered', 'demonstrated',
  'deployed', 'designed', 'developed', 'devised', 'diagnosed', 'directed',
  'documented', 'drove', 'earned', 'edited', 'eliminated', 'enabled',
  'engineered', 'enhanced', 'ensured', 'established', 'evaluated', 'executed',
  'expanded', 'facilitated', 'finalized', 'forecasted', 'formulated', 'founded',
  'generated', 'grew', 'guided', 'handled', 'headed', 'identified',
  'implemented', 'improved', 'increased', 'initiated', 'installed', 'instrumented',
  'integrated', 'introduced', 'investigated', 'launched', 'led', 'leveraged',
  'maintained', 'managed', 'mentored', 'migrated', 'minimized', 'modeled',
  'modernized', 'monitored', 'negotiated', 'onboarded', 'operated', 'optimized',
  'orchestrated', 'organized', 'overhauled', 'oversaw', 'owned', 'partnered',
  'performed', 'piloted', 'pioneered', 'planned', 'presented', 'prevented',
  'prioritized', 'produced', 'programmed', 'proposed', 'prototyped', 'published',
  'raised', 'ranked', 'rebuilt', 'received', 'recommended', 'reduced',
  'refactored', 'released', 'remediated', 'reorganized', 'replaced', 'researched',
  'resolved', 'restored', 'restructured', 'reviewed', 'revamped', 'saved',
  'scaled', 'scheduled', 'scoped', 'scripted', 'secured', 'selected',
  'shipped', 'simplified', 'simulated', 'solved', 'sourced', 'spearheaded',
  'standardized', 'streamlined', 'strengthened', 'structured', 'supervised', 'supported',
  'synthesized', 'targeted', 'taught', 'tested', 'tracked', 'trained',
  'transformed', 'translated', 'troubleshot', 'tuned', 'unified', 'unlocked',
  'upgraded', 'utilized', 'validated', 'verified', 'won', 'wrote',
]);

// Weak / filler openings and phrases. Case-insensitive; matched anywhere in
// the bullet. Presence hurts the content-quality subscore even when other
// signals (metrics, verbs later in the bullet) are strong.
const FILLERS = [
  'responsible for',
  'in charge of',
  'tasked with',
  'duties included',
  'worked on',      // very common; contextually weak on its own — flags but not fatal
  'worked with',
  'helped with',
  'helped in',
  'helped to',
  'assisted with',
  'assisted in',
  'involved in',
  'part of',
  'contributed to',
  'various tasks',
  'day-to-day',
  'day to day',
  'as needed',
  'good understanding of',
  'basic knowledge of',
  'familiar with',
  'exposure to',
  'hands on experience',
  'hands-on experience',
  'passionate about',
  'seeking opportunity',
  'seeking an opportunity',
  'objective:',
  'career objective',
];

// India-specific tokens the scorer looks for. Used by cgpaPresent + boardsPresent
// checks (India-specific ATS-compliance signals — the deterministic scorer flags
// their absence for freshers because Indian recruiters at tier-2/3 colleges
// almost always look for CGPA + 10th/12th percentages).
//
// CGPA_RE matches "8.4", "8.4/10", "8.4 / 10", "CGPA 8.4", "GPA: 3.8/4"; the
// "/10" denominator absence is a separate soft flag.
// BOARD_PCT_RE captures "10th - 92%", "XII: 89.4", "12th CBSE 90%".
const CGPA_RE      = /\b(?:cgpa|gpa|sgpa)\s*[:\-]?\s*(\d(?:\.\d{1,2})?)(?:\s*\/\s*(10|4|4\.0))?/i;
const CGPA_BARE_RE = /\b(\d\.\d{1,2})\s*\/\s*(10|4|4\.0)\b/;
const BOARD_PCT_RE = /\b(?:x|xii|10th|12th|10\+2|higher secondary|hsc|ssc|cbse|icse)\b[^.\n]{0,40}?(\d{1,3}(?:\.\d{1,2})?)\s*%/i;

// A "metric" is: a number with a unit (%, K, M, L, Cr, ms, s, min, hr, GB, MB,
// pt, x); OR a currency amount (₹, $, Rs); OR a bare integer/decimal that's
// large enough to be substantive (≥2 characters, avoids day-of-month noise);
// OR a ratio like "20/20". Preserves student wording — the scorer counts, doesn't
// normalize.
const METRIC_UNITS_RE = /\b\d+(?:[.,]\d+)?\s*(?:%|k|m|b|l|cr|ms|s|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks|month|months|year|years|yr|yrs|gb|mb|kb|pt|pts|point|points|x|users|customers|clients|delegates|members|records|rows|files|events|requests|txn|txns|transactions|leads|calls|bookings|conversions|orders|sales|releases|deployments|pull requests|prs|prs\/day|days\/week)\b/ig;
const CURRENCY_RE     = /(?:₹|rs\.?|inr|\$|usd|€)\s*\d/ig;
const BARE_NUMBER_RE  = /\b\d{2,}(?:[.,]\d+)?\b/g;
const RATIO_RE        = /\b\d+\s*\/\s*\d+\b/g;

// Standard resume section headings. If a resume has 3+ of these it looks
// structured; fewer than 3 is a Structure penalty.
const CANONICAL_SECTIONS = [
  'summary', 'objective', 'profile',
  'education', 'academic',
  'experience', 'internship', 'employment', 'work experience', 'professional experience',
  'projects', 'personal projects', 'academic projects',
  'skills', 'technical skills', 'core competencies',
  'certifications', 'certificates',
  'achievements', 'awards', 'honors',
  'positions of responsibility', 'por', 'leadership',
  'publications',
  'volunteer', 'extracurricular',
];

module.exports = {
  ACTION_VERBS,
  FILLERS,
  CGPA_RE,
  CGPA_BARE_RE,
  BOARD_PCT_RE,
  METRIC_UNITS_RE,
  CURRENCY_RE,
  BARE_NUMBER_RE,
  RATIO_RE,
  CANONICAL_SECTIONS,
};
