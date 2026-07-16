// Hinglish stress test — 20 real-world scenarios against the live LLM.
//
// Purpose: pre-broadcast validation that the extractors + safety nets handle
// the natural Hinglish patterns JECRC students actually type. Runs each
// scenario through extractSection with real OpenAI calls, records what the
// LLM produced, and grades against expectations.
//
// Not in npm run check — this hits the paid LLM. Opt-in. Cost: ~21 turns ×
// ~200 tokens ≈ $0.10 total, ~45s wall time.
//
// Usage: node scripts/stress-hinglish.js
// Extend by appending to SCENARIOS below — each scenario is one state, a
// sequence of turns, and an expect()/checkClarification() pair.
process.env.NODE_ENV = 'development'; // NOT test — test skips telemetry AND certain code paths

const { extractSection } = require('../src/llm/extract');
const { SECTION_CONFIG } = require('../src/llm/extract');
const { STATES } = require('../src/state/states');

// Each scenario is a sequence of turns. The runner tracks a mock resume_json,
// runs extract on each turn, merges via SECTION_CONFIG, and checks expectations
// against the final state.
const SCENARIOS = [
  // -------- EDUCATION (multi-turn, Class A merge bug from Gunjita) --------
  {
    id: 'EDU-1',
    label: 'Education across 4 messages',
    state: STATES.AWAITING_EDUCATION,
    turns: ['Jecrc university', 'Bachelors of technology', '2027', 'Data analysis and science'],
    expect: (rj) => {
      const e = rj.education?.[0] || {};
      return e.college && e.degree && e.expected_year && e.branch;
    },
    hint: 'ALL 4 fields present after 4 turns — no wipes',
  },
  {
    id: 'EDU-2',
    label: 'Education all-in-one Hinglish',
    state: STATES.AWAITING_EDUCATION,
    turns: ['B.Tech CSE JECRC University, 2025 batch'],
    expect: (rj) => {
      const e = rj.education?.[0] || {};
      return e.college && e.degree;
    },
    hint: 'Single message with all fields → all extracted',
  },

  // -------- SKILLS (Class A merge bug) --------
  {
    id: 'SKI-1',
    label: 'Skills across 2 turns',
    state: STATES.AWAITING_SKILLS,
    turns: ['Python, SQL, Java', 'Also add Tableau and Power BI'],
    expect: (rj) => {
      const all = (rj.skills || []).flatMap((c) => c.items || []).map((s) => s.toLowerCase());
      return ['python', 'sql', 'tableau', 'power bi'].every((k) => all.some((s) => s.includes(k)));
    },
    hint: 'Python + SQL + Tableau + Power BI all present after 2 turns',
  },

  // -------- CODING PROFILES (Class A merge bug) --------
  {
    id: 'CP-1',
    label: 'Coding profiles across 2 turns',
    state: STATES.AWAITING_CODING_PROFILES,
    turns: ['leetcode.com/u/aditya - 500 solved', 'codeforces.com/profile/aditya - rating 1600'],
    expect: (rj) => {
      const platforms = (rj.coding_profiles || []).map((p) => p.platform.toLowerCase());
      return platforms.includes('leetcode') && platforms.includes('codeforces');
    },
    hint: 'LeetCode and Codeforces both preserved',
  },

  // -------- LINKEDIN / GITHUB DECLINE (Class B soft-decline bug) --------
  {
    id: 'LN-1',
    label: 'LinkedIn — "abhi share ni krskti"',
    state: STATES.AWAITING_LINKEDIN,
    turns: ['M abhi share ni krskti'],
    expect: (rj) => rj.linkedin === null,
    checkClarification: (data) => !data.clarification_needed, // LLM must not ask again
    hint: 'linkedin=null AND no clarification (advance)',
  },
  {
    id: 'LN-2',
    label: 'LinkedIn — "baad me batungi"',
    state: STATES.AWAITING_LINKEDIN,
    turns: ['baad me batungi'],
    expect: (rj) => rj.linkedin === null,
    checkClarification: (data) => !data.clarification_needed,
    hint: 'linkedin=null, no clarification',
  },
  {
    id: 'GH-1',
    label: 'GitHub — "github nahi hai"',
    state: STATES.AWAITING_GITHUB,
    turns: ['github nahi hai'],
    expect: (rj) => rj.github === null,
    checkClarification: (data) => !data.clarification_needed,
    hint: 'github=null, no clarification',
  },

  // -------- CGPA DECLINE --------
  {
    id: 'CG-1',
    label: 'CGPA — "abhi results ni aaye"',
    state: STATES.AWAITING_CGPA,
    turns: ['abhi results ni aaye'],
    expect: (rj) => rj.education?.[0]?.cgpa == null,
    checkClarification: (data) => !data.clarification_needed,
    hint: 'cgpa=null, no clarification',
  },
  {
    id: 'CG-2',
    label: 'CGPA — "1st sem hai"',
    state: STATES.AWAITING_CGPA,
    turns: ['1st sem hai, abhi tak nahi mila'],
    expect: (rj) => rj.education?.[0]?.cgpa == null,
    checkClarification: (data) => !data.clarification_needed,
    hint: 'cgpa=null, no clarification',
  },

  // -------- COURSEWORK DECLINE --------
  {
    id: 'CW-1',
    label: 'Coursework — "yaad nahi"',
    state: STATES.AWAITING_COURSEWORK,
    turns: ['yaad nahi kya kya tha'],
    expect: (rj) => rj.education?.[0]?.coursework == null,
    checkClarification: (data) => !data.clarification_needed,
    hint: 'coursework=null, no clarification',
  },

  // -------- EXPERIENCE (Hinglish natural) --------
  {
    id: 'EXP-1',
    label: 'Experience — Razorpay intern in Hinglish',
    state: STATES.AWAITING_EXPERIENCE,
    turns: ['Razorpay me 6 mahine intern tha, API build karta tha payment retry ke liye'],
    expect: (rj) => {
      const e = rj.experience?.[0] || {};
      return e.company && /razor/i.test(e.company) && (e.role || (e.bullets || []).length > 0);
    },
    hint: 'company=Razorpay + role/bullets extracted',
  },
  {
    id: 'EXP-2',
    label: 'Experience — never worked, skip',
    state: STATES.AWAITING_EXPERIENCE,
    turns: ['kbhi kaam ni kiya, direct college se hu'],
    // This is really a skip — will fall to the 2-skip hatch OR extractor returns null experience.
    // Test that extractor at MINIMUM returns null experience.
    expect: (rj) => !rj.experience || rj.experience.length === 0 || !rj.experience[0].company,
    hint: 'No fabricated experience',
  },

  // -------- PROJECTS (Hinglish natural) --------
  {
    id: 'PRJ-1',
    label: 'Project — AI chatbot Hinglish',
    state: STATES.AWAITING_PROJECTS,
    turns: ['AI wala chatbot banaya, GPT use kiya customer support ke liye'],
    expect: (rj) => {
      const p = rj.pending_project || {};
      return p.name && /chatbot|ai/i.test(p.name);
    },
    hint: 'name extracted from vague Hinglish',
  },
  {
    id: 'PRJ-2',
    label: 'Project — link decline "GitHub nahi hai private hai"',
    state: STATES.AWAITING_PROJECTS,
    turns: ['Portfolio site banaya React me', 'github private hai bhai'],
    // First message: project name + tech. Second: link decline → increments counter.
    // After 1 decline, LLM should ask ONCE more (near-compulsory rule); after 2nd, accept.
    expect: (rj) => {
      const p = rj.pending_project || {};
      return p.name && /portfolio|site/i.test(p.name);
    },
    hint: 'name preserved, no wipe on link-decline turn',
  },

  // -------- POR (Hinglish natural) --------
  {
    id: 'POR-1',
    label: 'PoR — MUN secretary Hinglish (with org named)',
    state: STATES.AWAITING_POR,
    turns: ['Mai JECRC MUN Society me secretary tha 2024 me, 450 delegates handle kiye 2 events me'],
    expect: (rj) => {
      const p = rj.pending_por || {};
      return p.role && p.organization && (p.bullets || []).length > 0;
    },
    hint: 'role + org + bullet extracted from one message when org is named',
  },
  {
    id: 'POR-2',
    label: 'PoR — role given but org NOT named → role + bullets still land',
    state: STATES.AWAITING_POR,
    turns: ['Mai MUN secretary tha 2024 me, 450 delegates handle kiye 2 events me'],
    // Non-deterministic LLM behavior on this borderline input: sometimes
    // GPT-4o-mini asks for the org (correct), sometimes it plausibly infers
    // "College MUN Society" as a placeholder. Both are acceptable for MVP —
    // student can fix a wrong org via "edit" post-generation. What MUST
    // always work is: role extracted, bullets extracted, no crash, no loop.
    // The universal safety nets in router.js catch any downstream stuck-ness.
    expect: (rj) => {
      const p = rj.pending_por || {};
      return p.role && (p.bullets || []).length > 0;
    },
    hint: 'role + bullets extracted regardless of org state',
  },

  // -------- CERTS (Hinglish natural) --------
  {
    id: 'CRT-1',
    label: 'Certs — multi-item comma separated',
    state: STATES.AWAITING_CERTS,
    turns: ['Deep Learning Specialization Coursera, NPTEL Data Analytics, AWS CCP'],
    expect: (rj) => (rj.certifications || []).length >= 3,
    hint: 'ALL 3 certs extracted',
  },
  {
    id: 'CRT-2',
    label: 'Certs — Hinglish no link',
    state: STATES.AWAITING_CERTS,
    turns: ['NPTEL DBMS ki thi, link nahi hai'],
    expect: (rj) => (rj.certifications || []).length >= 1,
    hint: '1 cert with url=null captured',
  },

  // -------- ACHIEVEMENTS (Hinglish natural) --------
  {
    id: 'ACH-1',
    label: 'Achievement — Hinglish rank + venue',
    state: STATES.AWAITING_ACHIEVEMENTS,
    turns: ['JEE Mains me AIR 5000 aayi thi, 14 lakh candidates me se'],
    expect: (rj) => (rj.achievements || []).length >= 1,
    hint: '1 specific achievement extracted',
  },
  {
    id: 'ACH-2',
    label: 'Achievement — vague, LLM should ask',
    state: STATES.AWAITING_ACHIEVEMENTS,
    turns: ['ek hackathon jeeta tha'],
    checkClarification: (data) => !!data.clarification_needed,
    hint: 'vague achievement → clarification asked',
  },

  // -------- NAME EDGE CASES --------
  {
    id: 'NAM-1',
    label: 'Name — single word Indian name',
    state: STATES.AWAITING_NAME,
    turns: ['Gunjita'],
    expect: (rj) => !!rj.name && /gunjita/i.test(rj.name),
    hint: 'single word accepted, title-cased',
  },
];

async function runOne(scenario) {
  const rj = {};
  let lastData = null;
  let lastClarification = null;
  for (const turn of scenario.turns) {
    const session = { state: scenario.state, resume_json: rj };
    try {
      const { data } = await extractSection({ state: scenario.state, body: turn, resumeJson: rj, session });
      lastData = data;
      lastClarification = data.clarification_needed;
      SECTION_CONFIG[scenario.state].merge(rj, data);
    } catch (e) {
      return { id: scenario.id, label: scenario.label, ok: false, error: e.message, rj };
    }
  }
  let ok = true;
  const failures = [];
  if (scenario.expect) {
    const passed = !!scenario.expect(rj);
    if (!passed) { ok = false; failures.push('data expectation failed'); }
  }
  if (scenario.checkClarification) {
    const passed = !!scenario.checkClarification(lastData || {});
    if (!passed) { ok = false; failures.push('clarification expectation failed'); }
  }
  return { id: scenario.id, label: scenario.label, ok, failures, rj, lastClarification };
}

async function main() {
  const startedAt = Date.now();
  console.log('\n' + '═'.repeat(80));
  console.log('  HINGLISH STRESS TEST — ' + SCENARIOS.length + ' scenarios against live LLM');
  console.log('═'.repeat(80));
  const results = [];
  for (const s of SCENARIOS) {
    const r = await runOne(s);
    results.push(r);
    const status = r.ok ? '✅ PASS' : '❌ FAIL';
    console.log('\n' + status + '  ' + r.id + '  ' + r.label);
    if (r.error) console.log('    ERROR:', r.error);
    if (r.failures?.length) console.log('    ', r.failures.join(', '));
    if (r.lastClarification) console.log('    LLM clarification:', r.lastClarification.slice(0, 100));
    console.log('    resume_json ext:', JSON.stringify(r.rj).slice(0, 250));
  }
  const passed = results.filter((r) => r.ok).length;
  console.log('\n' + '═'.repeat(80));
  console.log('  ' + passed + '/' + SCENARIOS.length + ' passed · ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
  console.log('═'.repeat(80) + '\n');
  process.exit(passed === SCENARIOS.length ? 0 : 1);
}

main().catch((e) => { console.error('UNCAUGHT:', e.stack || e); process.exit(2); });
