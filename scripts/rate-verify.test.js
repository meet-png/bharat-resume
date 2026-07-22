// Fabrication-verifier regression suite. NO LLM — pure fixture cases.
//
// The contract this locks in: no rewrite containing a metric, tool,
// company, or product name absent from the source resume can ever pass.
//
// Two blocks of cases:
//   A. LEGITIMATE — verifier must return ok:true. These are rewrites that
//      strengthen wording, extract tech from elsewhere in the resume, or
//      merely add nothing new. If a legit case fails, the improver will be
//      forced to fall back to a safe rewrite on real student data → we
//      leave value on the table but never risk fabrication. Still worth
//      keeping tight to reduce false-reject rate.
//
//   B. FABRICATED — verifier must return ok:false. These are cheating
//      rewrites the improver LLM might produce if we trusted it. Every
//      one of these MUST be caught. A false-negative here is the
//      interview-killer bug we exist to prevent.
//
// Run: `node .runtime/test-rate-verify.js`
// Or via `npm run check` once wired in.

const { verify, extractNumericAtoms, extractTechAtoms, extractProperNouns } = require('../src/rate/verify');

const SOURCE = `MEET KABRA
meetkabra149@gmail.com | +91 63673 77638 | LinkedIn | GitHub
EDUCATION
JECRC University, Jaipur | B.Tech CS (Data Science) | 2023 - 2027
EXPERIENCE
Project Lead, JU MUN Society | Oct 2023 - Jun 2025 | Jaipur
Directed 450+ delegates, 45-member team, ₹10,00,000+ budget across two editions.
Secured 8+ sponsorships via stakeholder presentations.
PROJECTS
DM-to-Deal — Autonomous AI Sales Agent | Jun 2026 | Python, Claude API, Next.js
Shipped agent at $0.04/conv, 15% booking rate, 60% show rate, replacing $3-6K/mo SDR at <$30/mo (~95% margin).
Achieved >85% prompt-cache hit ratio via byte-stable prompts.
Jodhpur Export Intelligence | Apr 2026 | Python, PostgreSQL, SARIMAX, Streamlit
Architected ETL pipeline ingesting 5 sources into 8-table star schema — 12,828 rows, 20/20 validation checks.
Corrected ₹18,310 Cr price claim to ₹4,711 Cr via SARIMAX + XGBoost demand models on PostgreSQL.
Bharat Resume | Jun 2026 | Node.js, OpenAI, Meta WhatsApp, Supabase, Puppeteer, Cashfree
Pioneered India's first WhatsApp-native resume builder delivering ATS-scored PDFs in ~13s at <₹5 LLM cost vs ₹49 UPI.
Built deterministic ATS scorer + free-edit loop — dense resumes reach 92/100.
SKILLS
Languages: Python, JavaScript, SQL
Frameworks: Streamlit, Next.js, Node.js
Databases: PostgreSQL, Redis
Cloud: Railway, Supabase, GitHub Actions
`;

const legitimateCases = [
  // 1. Verb strengthening only, no new content
  {
    id: 'L1-verb-strengthen',
    original: 'Directed 450+ delegates, 45-member team, ₹10,00,000+ budget across two editions.',
    rewritten: 'Led 450+ delegates and a 45-member team on ₹10,00,000+ budget across two consecutive editions.',
  },
  // 2. Same metrics, restructured order
  {
    id: 'L2-restructure',
    original: 'Shipped agent at $0.04/conv, 15% booking rate, 60% show rate, replacing $3-6K/mo SDR at <$30/mo.',
    rewritten: 'Replaced $3-6K/mo SDR at <$30/mo with an AI sales agent delivering 15% booking and 60% show rates at $0.04/conv.',
  },
  // 3. Adds tech from elsewhere in the same project
  {
    id: 'L3-tech-from-project-line',
    original: 'Shipped agent at $0.04/conv, 15% booking rate.',
    rewritten: 'Shipped Python + Claude API agent at $0.04/conv, 15% booking rate.',
  },
  // 4. Adds tech from another project section (allowed — student HAS it)
  {
    id: 'L4-tech-from-source',
    original: 'Architected ETL pipeline ingesting 5 sources.',
    rewritten: 'Architected PostgreSQL-backed ETL pipeline ingesting 5 sources across 8-table star schema.',
  },
  // 5. Preserves complex Indian rupee metric
  {
    id: 'L5-rupee-preserve',
    original: 'Corrected ₹18,310 Cr price claim to ₹4,711 Cr via SARIMAX + XGBoost.',
    rewritten: 'Recomputed ₹18,310 Cr headline claim to grade-adjusted ₹4,711 Cr using SARIMAX + XGBoost demand models.',
  },
  // 6. Adds tech from skills section (Node.js is in Skills)
  {
    id: 'L6-tech-from-skills',
    original: 'Pioneered India\'s first WhatsApp-native resume builder delivering ATS-scored PDFs in ~13s.',
    rewritten: 'Pioneered India\'s first WhatsApp-native Node.js resume builder delivering ATS-scored PDFs in ~13s at <₹5 LLM cost vs ₹49 UPI.',
  },
  // 7. Number normalisation: "50000" in source, "50K" in rewrite — value-equivalent
  {
    id: 'L7-number-normalization',
    original: 'Handled 50000 daily transactions.',
    sourceOverride: 'Handled 50000 daily transactions across production nodes.',
    rewritten: 'Scaled backend to handle 50K daily transactions across production nodes.',
  },
  // 8. Proper noun mentioned in source (Bharat Resume)
  {
    id: 'L8-proper-noun-in-source',
    original: 'Pioneered India\'s first WhatsApp-native resume builder.',
    rewritten: 'Pioneered Bharat Resume — India\'s first WhatsApp-native resume builder.',
  },
  // 9. Alias expansion: source says "GitHub Actions", rewrite says "GH Actions" — same canonical
  {
    id: 'L9-tech-alias',
    original: 'Deployed weekly refresh via GitHub Actions CI/CD.',
    rewritten: 'Deployed weekly refresh via GH Actions CI/CD pipeline.',
  },
  // 10. Empty add — pure structural rearrangement
  {
    id: 'L10-structural-only',
    original: 'Built deterministic ATS scorer + free-edit loop.',
    rewritten: 'Engineered a deterministic ATS scorer coupled with a free-edit loop.',
  },
];

const fabricationCases = [
  // F1. Invented percentage (source has NO "40%")
  {
    id: 'F1-invented-percent',
    original: 'Built chat feature.',
    rewritten: 'Built chat feature reducing latency 40% for daily active users.',
  },
  // F2. Invented user count (source has NO "10K")
  {
    id: 'F2-invented-user-count',
    original: 'Interned at OSHRM handling speaker outreach.',
    rewritten: 'Interned at OSHRM handling outreach to 10K+ speakers across 3 continents.',
  },
  // F3. Invented company (source has NO "Google")
  {
    id: 'F3-invented-company',
    original: 'Applied OOP principles to maintain codebase.',
    rewritten: 'Applied Google-recommended OOP principles to maintain enterprise-grade codebase.',
  },
  // F4. Invented tech (source has NO Docker)
  {
    id: 'F4-invented-tech',
    original: 'Deployed application to production.',
    rewritten: 'Deployed application to production via Docker and Kubernetes on AWS.',
  },
  // F5. Invented certification-style credential
  {
    id: 'F5-invented-credential',
    original: 'Completed Neural Networks course.',
    rewritten: 'Completed Stanford CS230 Neural Networks course with distinction.',
  },
  // F6. Invented specific metric that resembles source style
  {
    id: 'F6-mimicked-metric',
    original: 'Directed a large-team event.',
    rewritten: 'Directed 500+ delegates event across 3 editions with ₹15,00,000 budget.',
  },
  // F7. Invented product name
  {
    id: 'F7-invented-product',
    original: 'Built a resume tool.',
    rewritten: 'Built ResumeRocket — an AI-powered resume tool.',
  },
  // F8. Invented dollar amount
  {
    id: 'F8-invented-dollar',
    original: 'Reduced infrastructure spend.',
    rewritten: 'Reduced infrastructure spend by $5,000/month via right-sizing.',
  },
  // F9. Invented percentile metric
  {
    id: 'F9-invented-percentile',
    original: 'Optimized API latency.',
    rewritten: 'Optimized API latency to p99 <120ms across 4 regions.',
  },
  // F10. Invented ratio
  {
    id: 'F10-invented-ratio',
    original: 'Passed all validation tests.',
    rewritten: 'Passed 47/47 validation tests across 4 environments.',
  },
];

let passed = 0;
let failed = 0;
const failedCases = [];

console.log('═══════════════════════════════════════════════════════');
console.log(' rate-verify — fabrication regression suite');
console.log('═══════════════════════════════════════════════════════\n');

console.log('─── BLOCK A: legitimate rewrites (must PASS verifier) ───');
for (const c of legitimateCases) {
  const source = c.sourceOverride || SOURCE;
  const v = verify({ rewritten: c.rewritten, original: c.original, sourceText: source, options: { debug: true } });
  if (v.ok) {
    console.log(`  ✓ ${c.id}   ${v.meta.atoms_checked} atoms verified`);
    passed++;
  } else {
    console.log(`  ✗ ${c.id}   FALSE-REJECT: ${v.unverified_atoms.map((a) => a.raw).join(', ')}`);
    console.log(`      rewritten: ${c.rewritten}`);
    failed++;
    failedCases.push(c.id);
  }
}

console.log('\n─── BLOCK B: fabrication attempts (must FAIL verifier) ───');
for (const c of fabricationCases) {
  const v = verify({ rewritten: c.rewritten, original: c.original, sourceText: SOURCE });
  if (!v.ok) {
    const flagged = v.unverified_atoms.map((a) => a.raw).slice(0, 3).join(', ');
    console.log(`  ✓ ${c.id}   caught: ${flagged}`);
    passed++;
  } else {
    console.log(`  ✗ ${c.id}   FABRICATION SLIPPED THROUGH`);
    console.log(`      rewritten: ${c.rewritten}`);
    failed++;
    failedCases.push(c.id);
  }
}

console.log('\n═══════════════════════════════════════════════════════');
console.log(` Summary: ${passed}/${passed + failed} cases passed`);
if (failed > 0) {
  console.log(`\n  FAILED CASES: ${failedCases.join(', ')}`);
  console.log('\n  Any FABRICATION SLIPPED THROUGH is a launch-blocker — the verifier is the moat.');
  console.log('  FALSE-REJECT on legitimate rewrites is tuning — improver will safe-fallback.');
  process.exit(1);
}
console.log('  ✅ Fabrication guard intact.\n');
process.exit(0);
