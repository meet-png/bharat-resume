// Section-by-section info extraction from a single WhatsApp message. PRD §7.1.
// Declarative config per state: extraction instruction + JSON shape hint + merge function.
// Experience + Projects extractors include a sufficiency check — they ask the LLM to
// evaluate whether the gathered detail is enough, and to set clarification_needed
// to a TARGETED follow-up (asking only for the missing piece) when not.
const { complete } = require('./client');
const { fetchRepoFromUrl, parseRepo } = require('../enrichment/github');
const logger = require('../logger');

const SECTION_CONFIG = {
  AWAITING_NAME: {
    instruction: `Extract the student's full name. Title-case it (e.g., "Aditya Kumar", "Meet Kabra").

ACCEPT LIBERALLY. Valid names span many shapes in India:
- 1 word: "Madonna" (rare but valid)
- 2 words: "Meet Kabra", "Aditya Kumar"
- 3+ words: "Aditya Pratap Singh", "S. Ramanujan Iyer", "Dr. A.P.J. Abdul Kalam"
- With dots/apostrophes: "O'Connor", "M.K. Patel"

If the input is a 1-5 word string that reads like a person's name (letters, optional dots/apostrophes/hyphens, possibly title prefix like "Dr.", no digits, no symbols other than . ' -), ACCEPT it — set name to the title-cased version and clarification_needed to null.

ONLY set name=null and ask a clarification if the input is clearly NOT a name: a single word like "haan"/"yes"/"skip", gibberish ("asdfgh"), an email, a URL, a question. Even one-word inputs that look name-like should be accepted.`,
    shape: '{ "name": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => { if (x.name) rj.name = x.name; },
  },

  AWAITING_EMAIL: {
    instruction: 'Extract a valid email address. If the input is not a valid email format, set email to null and ask for it again.',
    shape: '{ "email": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => { if (x.email) rj.email = x.email; },
  },

  AWAITING_LINKEDIN: {
    instruction: 'Extract the LinkedIn profile URL. Accept variants like "linkedin.com/in/foo" — normalize to full "https://linkedin.com/in/foo". If "skip" or no link, set to null.',
    shape: '{ "linkedin": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => { rj.linkedin = x.linkedin || null; },
  },

  AWAITING_GITHUB: {
    instruction: 'Extract the GitHub profile URL. Accept "github.com/foo" — normalize to "https://github.com/foo". If "skip", set to null.',
    shape: '{ "github": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => { rj.github = x.github || null; },
  },

  // Competitive-programming / coding profiles. Optional, multi-platform.
  AWAITING_CODING_PROFILES: {
    instruction: `Extract competitive-programming / coding-practice profile links the student lists. Common platforms: LeetCode, Codeforces, CodeChef, HackerRank, HackerEarth, GeeksforGeeks (GFG), AtCoder, TopCoder, Kaggle, Codewars.

For each link the student gives, output { "platform": <clean platform name>, "url": <full https URL>, "stat": <count/rating string or null> }:
- Normalize bare domains/usernames to a full https URL (e.g. "leetcode.com/u/aditya" → "https://leetcode.com/u/aditya").
- Derive "platform" from the domain ("leetcode.com" → "LeetCode", "codeforces.com" → "Codeforces", "geeksforgeeks.org" → "GeeksforGeeks"). If a student names a platform but the URL is ambiguous, use the named platform.
- "stat" = any problem count, rating, rank, or badge the student MENTIONS for that platform — e.g. "470+ solved", "rating 1843", "Knight badge", "Guardian". Copy it verbatim into stat. If they give no number/rating for a platform, set stat to null. NEVER invent a count or rating.
- A student may give several — return all of them. A student may also give only a count without a link (e.g. "solved 500 on leetcode") — still capture it with url null and stat set.
- If the message is "skip", empty, or contains no recognizable coding-profile, return an empty array. Do NOT invent or guess a profile URL, and do NOT ask follow-up questions here — this step is optional.`,
    shape: '{ "coding_profiles": [{ "platform": string, "url": string | null, "stat": string | null }], "clarification_needed": string | null }',
    merge: (rj, x) => { rj.coding_profiles = Array.isArray(x.coding_profiles) ? x.coding_profiles.filter((c) => c && c.platform && (c.url || c.stat)) : []; },
  },

  AWAITING_EDUCATION: {
    instruction: 'Extract degree, college name, branch/major, and expected year of passing. Examples: degree "B.Tech" or "BCA" or "B.E."; branch "Computer Science", "Mechanical"; year "2026" or "Expected 2026". Use null for any field not stated. Do not invent.',
    shape: '{ "education": { "degree": string | null, "college": string | null, "branch": string | null, "expected_year": string | null }, "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!rj.education) rj.education = [];
      if (!rj.education[0]) rj.education.push({});
      Object.assign(rj.education[0], x.education || {});
    },
  },

  AWAITING_CGPA: {
    instruction: 'Extract the academic score. Could be CGPA ("8.5", "9.2/10") or percentage ("85%"). Keep the original format the student used.',
    shape: '{ "cgpa": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!rj.education) rj.education = [];
      if (!rj.education[0]) rj.education.push({});
      if (x.cgpa) rj.education[0].cgpa = x.cgpa;
    },
  },

  // Optional coursework collection — single line; merges into education[0].coursework.
  AWAITING_COURSEWORK: {
    instruction: `Extract a coursework string — a comma- or middle-dot-separated list of course names the student named (DSA, Operating Systems, ML, Statistics, etc.). Title-case items. Keep the original separator if the student used one. If "skip" or no clear coursework, set to null.`,
    shape: '{ "coursework": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!x.coursework) return;
      if (!rj.education) rj.education = [];
      if (!rj.education[0]) rj.education.push({});
      rj.education[0].coursework = x.coursework;
    },
  },

  AWAITING_SKILLS: {
    instruction: `Group the listed skills into 3-6 NAMED categories, ordered strongest/most-relevant first. Choose category labels that fit the TARGET ROLE in the JD context above — do NOT use a fixed generic set. This is how strong real resumes do it.

GUIDANCE ON LABELS (pick what fits; invent role-appropriate ones):
- Software/Backend: "Languages", "Frameworks", "Databases", "Tools / DevOps", "Cloud", "Security & Architecture"
- Data/AI/ML: "Languages", "ML / AI", "Data & BI", "Databases", "MLOps / Tools"
- Frontend/Mobile: "Languages", "Frameworks", "Styling / UI", "Tooling", "Testing"
- Non-tech (if ever): pick domain-native labels (e.g. Marketing → "Channels", "Analytics", "Martech Tools").

HARD RULES ON LABELS:
- NEVER use the label "Other", "Misc", or "Miscellaneous" — always pick a meaningful, specific category name. If something doesn't fit, name the category for what it IS (e.g. "Concepts", "Methodologies", "Coursework").
- A label may combine two related areas with "&" or "/" (e.g. "Databases & Streaming", "Tools / DevOps") — this is encouraged when it reads cleanly.
- Include EVERY skill the student mentioned; never drop one. Preserve the student's capitalization where reasonable.
- A category with no items should simply be omitted from the array (don't emit empty categories).

THIS IS A SIMPLE LIST STEP — DO NOT INTERROGATE.
Set clarification_needed to null whenever the message contains AT LEAST ONE skill (it almost always does). A short list IS complete and sufficient. NEVER ask for metrics, impact, proficiency levels, years of experience, examples, or "more" skills — that judgement happens later in the experience/projects steps, never here. Only set clarification_needed (a brief, friendly ask for their skills) if the message contains NO skills at all — e.g. it is empty, "skip", a question, or gibberish.`,
    shape: '{ "skills": [{ "category": string, "items": [string] }], "clarification_needed": string | null }',
    merge: (rj, x) => { rj.skills = Array.isArray(x.skills) ? x.skills.filter((c) => c && c.category && Array.isArray(c.items) && c.items.length) : []; },
  },

  // EXPERIENCE — multi-bullet, multi-angle sufficiency. Drives bullet density.
  AWAITING_EXPERIENCE: {
    instruction: `Extract internship/job experience. tech_stack = the specific tools / libraries / methods the student actually used in THIS experience (not their global skills).

SUFFICIENCY for the experience entry — ALL THREE must hold:
  (a) role + company (who/where)
  (b) ≥2 bullets in the bullets array
  (c) bullets span ≥2 distinct METRIC ANGLES across:
        SCALE / VOLUME — data points, users, records, teams, budget, transactions, requests
        QUALITY        — accuracy %, correctness rate, error reduction, NPS, % improvement
        IMPACT         — time saved, cost saved, business outcome, deployed/shipped, decisions enabled

If the message extends existing pending experience (already in resume_json.experience[0]), MERGE — append new bullets, never overwrite prior good fields.

EACH NEW FOLLOW-UP ANSWER → ONE NEW BULLET. Do NOT merge multiple metrics into a single bullet at extraction time. Let the rewriter compose final phrasing.

DECISION TREE (one question per turn):
1. role+company missing → ask for them. Adapt example role titles to TARGET ROLE.
2. <1 bullet present → ask for the concrete action they did. "Specific kya kaam kiya tha waha?"
3. <2 bullets OR all bullets cover the SAME angle:
     Identify the missing angle from the three above. Ask ONE targeted question for THAT angle:
       Missing SCALE: "Kitna data tha / kitne users / kitne records / kitna budget? Specific number do."
       Missing QUALITY: "Kya accuracy / quality / effectiveness mili — % ya concrete metric?"
       Missing IMPACT: "Isse kitna time / cost bacha, ya kya business outcome aaya?"
     Adapt vocabulary to TARGET ROLE domain (marketing → CTR/leads; eng → latency/RPS; civil → safety/timeline; etc.).
4. Any bullet has soft qualifier without a number → ask for specific number for THAT bullet.
5. All three sufficient → clarification_needed = null.

WORKED EXAMPLE:
Initial: "Worked at Razorpay as SWE intern May-Jul 2025, built a payment retry service in Node.js"
  Extract: role="SWE Intern", company="Razorpay", dates="May-Jul 2025", tech_stack=["Node.js"], bullets=["Built a Node.js payment retry service"]
  → 1 bullet, action only. Missing scale, quality, impact.
  → "Kitne daily transactions handle karte the / kitna data scale tha?"

Follow-up: "around 50K daily transactions"
  Extract: bullets=["Handled ~50K daily transactions"] (new bullet)
  Merged total: 2 bullets covering action + scale. Still missing quality OR impact.
  → "Failures kitne % reduce hue, ya kya specific outcome aaya?"

Follow-up: "reduced failed transactions by 18%"
  Extract: bullets=["Reduced failed transactions by 18%"]
  Merged: 3 bullets covering action + scale + impact. SUFFICIENT.
  → clarification_needed = null.

Apply same role-awareness as before: clarification vocabulary, action verbs, example titles all calibrate to TARGET ROLE.`,
    shape: '{ "experience": { "role": string | null, "company": string | null, "location": string | null, "dates": string | null, "bullets": [string], "tech_stack": [string] } | null, "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!x.experience) {
        if (!rj.experience) rj.experience = [];
        return;
      }
      if (!rj.experience) rj.experience = [];
      if (!rj.experience[0]) rj.experience.push({});
      const exp = rj.experience[0];
      for (const k of ['role', 'company', 'location', 'dates']) {
        if (x.experience[k]) exp[k] = x.experience[k];
      }
      if (Array.isArray(x.experience.bullets) && x.experience.bullets.length > 0) {
        exp.bullets = (exp.bullets || []).concat(x.experience.bullets);
      }
      if (Array.isArray(x.experience.tech_stack) && x.experience.tech_stack.length > 0) {
        const set = new Set([...(exp.tech_stack || []), ...x.experience.tech_stack]);
        exp.tech_stack = [...set];
      }
    },
  },

  // PROJECTS — example-driven; LLM follows worked examples rather than abstract rules.
  // The "link before impact" sequencing + cross-turn link-decline tracking are the tricky parts.
  AWAITING_PROJECTS: {
    instruction: `Extract ONE project per message. tech_stack = whatever tools/tech/methods/platforms the student used (works for tech AND non-tech roles).

LIBERAL NAME EXTRACTION:
Any noun phrase from what the student made counts as a valid project name. Title-case it. Examples:
- "Made a project on sales prediction" → name = "Sales Prediction"
- "Built a chatbot for customer support" → name = "Customer Support Chatbot"
- "Worked on a portfolio site" → name = "Portfolio Site"
- "Created an ETL pipeline for retail" → name = "Retail ETL Pipeline"
Only set name=null if the message has no information about what was built.

A project is SUFFICIENT only when all four are true:
  (a) name (extracted liberally as above)
  (b) tech_stack OR a description of what it does
  (c) ≥2 bullets in bullets[], AND bullets span ≥2 distinct METRIC ANGLES across:
        SCALE / VOLUME — data points, users, records, requests, dataset size, transactions
        QUALITY        — accuracy %, F1, precision, error rate, NPS, % improvement
        IMPACT         — time saved, cost saved, business outcome, latency, throughput, deployed/shipped
  (d) github_url OR demo_url is a real URL, OR pending_project._link_declined === true

GITHUB vs LIVE LINK:
A github.com repo URL goes in github_url. A DEPLOYED / LIVE / hosted URL (vercel.app, netlify.app, a custom domain, "live link", "deployed at") goes in demo_url. A project may have BOTH — capture each in its own field. For the CASE C link ask below, either a repo link or a live link satisfies requirement (d).

LINK-DECLINE DETECTION:
If the current message contains any of: "no link", "skip link", "private", "private repo", "no repo", "not public", "github nahi", "nahi link", "link nahi", "no github" — set link_declined = true in your output. Router persists this to pending_project._link_declined.

CLARIFICATION RULES (ask ONLY ONE missing piece per turn):

CASE A — only (a) missing (message has no project content):
  Ask only for what they built. Example: "Kya banaya tha project mein? Naam aur 1-2 lines."

CASE B — (a) present, (b) missing:
  Ask for tech / description. Example: "Kis tech / tool se banaya? Aur kya karta hai project?"

CASE C — (a) and (b) present, (d) missing AND _link_declined NOT true:
  Ask ONLY for a link to the work. NEVER mention impact/accuracy/metric here.
  Pick the artifact NATIVE to the TARGET ROLE — do NOT default to GitHub for non-technical roles:
    - Technical role: "GitHub repo link ya deployed URL? 'no link' agar private hai."
    - Marketing/Content: "Is kaam ka koi link hai — live campaign, published article, ya post? 'no link' agar nahi."
    - Design: "Portfolio / Behance / Dribbble ya live link? 'no link' agar private hai."
    - Sales/Finance/Ops/other: "Koi link ya proof of this work — live page, report, ya deck? 'no link' agar share nahi kar sakte."
  Only mention GitHub/repo when the TARGET ROLE is clearly technical (software, data, engineering). Otherwise ask for a generic link/proof.

CASE D — link sorted AND <2 bullets OR <2 distinct angles in existing bullets:
  Identify which angle is missing from the existing bullets. Ask ONE targeted question for THAT angle.
  EACH FOLLOW-UP ANSWER → ONE NEW BULLET. Do NOT merge multiple metrics into a single bullet.
  Examples (adapt to TARGET ROLE):
    Tech project missing SCALE: "Kitna data tha — dataset size, users, ya requests count?"
    Tech project missing QUALITY: "Exact accuracy / F1 kya thi — 85%? 92%?"
    Tech project missing IMPACT: "Latency / throughput / time saved kya tha?"
    Marketing missing SCALE: "Audience reach kya thi — kitne impressions / users?"
    Marketing missing QUALITY: "CTR / conversion rate kitna improve hua?"
    Marketing missing IMPACT: "Pipeline / revenue / leads kitne aaye?"
    Design missing SCALE: "Kitne users tak pahuncha?"
    Design missing QUALITY: "A/B test result kya tha?"
    Design missing IMPACT: "Adoption / conversion lift kitna?"
    Civil/Mech missing SCALE: "Project size — budget, sq ft, units?"
    Civil/Mech missing QUALITY: "Safety / spec compliance outcome?"
    Civil/Mech missing IMPACT: "Timeline saved / cost reduced kitna?"
    Adapt to any role — pick metrics native to that domain.

CASE E — all four ✓ (≥2 bullets, ≥2 angles, link sorted) → clarification_needed = null.

WORKED EXAMPLES (study these — they show exactly what to output):

Example 1 — fresh message with vague impact and no link:
  Input: "Made a project on sales prediction using python, used machine learning, got good accuracy"
  Your output:
    project: { name: "Sales Prediction", tech_stack: ["Python","Machine Learning"], bullets: ["got good accuracy"], github_url: null, dates: null }
    link_declined: false
    clarification_needed: "GitHub link bhej dijiye? Ya deployed URL / demo? 'no link' agar private hai."
  (This is CASE C. Do NOT ask about accuracy yet — link comes first.)

Example 2 — follow-up: student declines link:
  pending_project before: { name: "Sales Prediction", tech_stack: ["Python","ML"], bullets: ["got good accuracy"], github_url: null }
  Input: "no link"
  Your output:
    project: {} (no new fields)
    link_declined: true
    clarification_needed: "Cool. Exact accuracy number kya tha — 85%? 92%?"
  (This is CASE D. After link declined, NOW ask for specific number.)

Example 3 — follow-up: student gives link, GitHub repo data is included in context:
  pending_project before: same as above
  Input: "https://github.com/aditya/sales-pred"
  Context has GitHub repo data: { description: "Sales prediction model with 91.2% test accuracy using XGBoost", languages: ["Python","Jupyter"] }
  Your output:
    project: { github_url: "https://github.com/aditya/sales-pred", bullets: ["Built sales prediction model with **91.2% test accuracy** using XGBoost"] }
    link_declined: false
    clarification_needed: null
  (CASE E. README provided the metric; bullets enriched. All four ✓.)

ROLE-NATIVE METRICS for CASE D — adapt to TARGET ROLE in JD context:
- Marketing: reach, CTR, conversions, leads, pipeline.
- Engineering: latency, scale (RPS/users), uptime, bug count reduced.
- Design: users affected, adoption %, conversion lift, A/B test result.
- Sales: revenue, deals, quota %.
- Civil/Mech: budget, sq ft, timeline saved, safety/quality outcome.
- Medical/Teaching: people served, outcome improved, program scaled.
- Other domains: pick a metric native to that field. Never default to software metrics.`,
    shape: '{ "project": { "name": string | null, "tech_stack": [string], "dates": string | null, "github_url": string | null, "demo_url": string | null, "bullets": [string] } | null, "link_declined": boolean, "clarification_needed": string | null }',
    // Merge into pending_project (not projects[]). Router decides when to commit.
    merge: (rj, x) => {
      if (!rj.pending_project) rj.pending_project = {};
      const p = rj.pending_project;
      // Persist link-decline flag across turns.
      if (x.link_declined === true) p._link_declined = true;
      if (!x.project) return;
      for (const k of ['name', 'dates', 'github_url', 'demo_url']) {
        if (x.project[k]) p[k] = x.project[k];
      }
      if (Array.isArray(x.project.tech_stack) && x.project.tech_stack.length > 0) {
        const set = new Set([...(p.tech_stack || []), ...x.project.tech_stack]);
        p.tech_stack = [...set];
      }
      if (Array.isArray(x.project.bullets) && x.project.bullets.length > 0) {
        p.bullets = (p.bullets || []).concat(x.project.bullets);
      }
    },
  },

  // POR — multi-bullet, multi-angle. Pattern matches Meet's reference resume:
  // event count + participant count + named flagship items / outcomes.
  // Single pending POR entry accumulates across turns (like pending_project).
  AWAITING_POR: {
    instruction: `Extract a leadership / position-of-responsibility role. Examples of valid roles: "Class Representative", "Club Lead", "MUN Secretary", "Event Organizer", "NSS Coordinator", "Society Head", "Sports Captain".

SUFFICIENCY for the PoR entry — ALL THREE must hold:
  (a) role + organization (what role, which club/society/program)
  (b) ≥2 bullets in bullets[]
  (c) bullets span ≥2 distinct ANGLES across:
        SCALE — # events organized, # participants/delegates, budget handled, team size led
        QUALITY — named flagship outcomes ("flagship event X", "won inter-college Y"), deficit/excess metrics
        IMPACT — funds raised, sponsorships secured, attendees, retention, % growth year-over-year

Pending PoR entry lives in resume_json.pending_por (similar to pending_project). Merge new bullets into pending across turns. Once sufficient, router commits to por[] array.

DECISION TREE (one question per turn):
1. role + organization missing → ask both.
2. <1 bullet → ask for concrete action: "Kya specific kaam kiya tha is role mein?"
3. <2 bullets OR all bullets cover the same angle → ask for the missing angle:
     Missing SCALE: "Kitne events organize kiye / kitne participants the / kitna budget?"
     Missing QUALITY: "Koi flagship event ya named outcome — top kya achieve kiya?"
     Missing IMPACT: "Sponsorships / funds raised / member growth — koi specific number?"
4. Any vague bullet → ask for specific number for that bullet.
5. All ≥2 bullets covering ≥2 angles + role+org present → clarification_needed = null.

WORKED EXAMPLE:
Initial: "I was MUN secretary at our college MUN society 2024"
  Extract: role="MUN Secretary", organization="College MUN Society", dates="2024", bullets=[]
  → 0 bullets. Ask: "Specific kya kaam kiya tha — events organize kiye, team coordinate kiye?"

Follow-up: "organized 2 MUNs with 450+ delegates total, secured ₹3 lakh budget"
  Extract: bullets=["Organized 2 MUNs with 450+ delegates", "Secured ₹3 lakh budget"]
  → 2 bullets, angles = scale (delegates) + scale (budget). Still need quality OR impact.
  → "Koi flagship event ya named outcome — zero deficit, sponsorship deals, etc?"

Follow-up: "secured 8 sponsorships, zero budget deficit"
  Extract: bullets=["Secured 8 sponsorships", "Closed with zero budget deficit"]
  → Merged: 4 bullets covering scale + impact + quality. SUFFICIENT.
  → clarification_needed = null.`,
    shape: '{ "por": { "role": string | null, "organization": string | null, "dates": string | null, "bullets": [string] } | null, "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!x.por) return;
      if (!rj.pending_por) rj.pending_por = {};
      const p = rj.pending_por;
      for (const k of ['role', 'organization', 'dates']) {
        if (x.por[k]) p[k] = x.por[k];
      }
      if (Array.isArray(x.por.bullets) && x.por.bullets.length > 0) {
        p.bullets = (p.bullets || []).concat(x.por.bullets);
      }
    },
  },

  // CERTS — name + URL. Day 4 template renders as hyperlink.
  // Verification URL is genuinely required so the cert isn't a dangling unverifiable claim;
  // student can explicitly say "no link" to bypass.
  AWAITING_CERTS: {
    instruction: `Extract certifications. Each entry needs a name AND a verification URL (or an explicit "no link" from the student).

Rules:
- name = course/cert title (e.g., "Deep Learning Specialization", "NPTEL Data Analytics with Python", "AWS Certified Solutions Architect")
- url = the verification URL (Coursera / NPTEL / Udemy / Credly / AWS / etc.). If the student didn't share one, url = null.
- Return an ARRAY — one or many from a single message.
- Do NOT extract or invent issuer/date as separate fields. The URL contains that info implicitly; the rendered resume will be a hyperlink (name as visible text, url as link).

Sufficiency check:
- If EVERY cert in the new message has either a url OR the student explicitly said "no link"/"skip link"/"private" → clarification_needed = null.
- If ANY cert is missing a url and the student didn't bypass → set clarification_needed to a SHORT Hinglish/English follow-up asking ONLY for the link(s).

Example clarifications (adapt — don't copy verbatim):
- "Verification link bhej dijiye '<cert name>' ke liye? Coursera / NPTEL / Credly wala URL. 'no link' agar nahi hai."
- "Got the cert name — share the verification URL too? (Coursera / NPTEL / etc.) Or 'no link' if unavailable."

If "no link" / "skip" / "private" arrives in response, accept the cert(s) with url=null and clarification_needed=null.`,
    shape: '{ "certifications": [{ "name": string, "url": string | null }], "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!rj.certifications) rj.certifications = [];
      if (Array.isArray(x.certifications) && x.certifications.length > 0) {
        rj.certifications = rj.certifications.concat(x.certifications);
      }
    },
  },

  // ACHIEVEMENTS — each entry must be SPECIFIC: named competition / rank-or-number / scale.
  // Vague achievements ("won a hackathon") get pushed back for specifics.
  AWAITING_ACHIEVEMENTS: {
    instruction: `Extract notable achievements, ranks, prizes, awards. Each is a short factual string in the achievements array.

A "specific" achievement contains AT LEAST TWO of:
  - Named entity (competition, exam, hackathon, paper venue, scholarship name)
  - Number / rank / percentile (AIR 77, 98.45 percentile, top 1%, 470+ problems solved)
  - Scale context (out of 14L candidates, across 50 colleges, 1500 participants)

SUFFICIENCY CHECK:
- If ALL extracted achievements are specific (each has ≥2 of the three) → clarification_needed = null.
- If ANY achievement is vague (e.g., "won a hackathon", "got a prize", "topped the class") → ask ONE follow-up listing the vague items and asking for missing specifics.

CLARIFICATION EXAMPLES (adapt to what's vague):
- "Konsa hackathon? Rank kya thi, kitne teams compete kar rahi thi?"
- "Konsa exam — JEE / NEET / GATE / CAT? Rank ya percentile kya thi?"
- "Konsa competition — venue / scale batayiye."

When the follow-up arrives, REPLACE the vague achievement(s) with the specific version — don't keep both.`,
    shape: '{ "achievements": [string], "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!Array.isArray(x.achievements) || x.achievements.length === 0) return;
      rj.achievements = (rj.achievements || []).concat(x.achievements);
    },
  },
};

// If the user dropped a github.com URL into a project message, fetch repo data and
// pass it to the LLM as context. Best-effort: failures are silent, LLM falls back
// to the user's text alone.
async function maybeEnrichProject(state, body) {
  if (state !== 'AWAITING_PROJECTS') return null;
  const parsed = parseRepo(body);
  if (!parsed) return null;
  const t0 = Date.now();
  const repo = await fetchRepoFromUrl(body);
  logger.info({ owner: parsed.owner, repo: parsed.repo, ok: !!repo, ms: Date.now() - t0 }, 'github enrichment');
  return repo;
}

// Builds the JD context block injected into every extraction prompt so the LLM
// can calibrate sufficiency, clarifications, and categorization to the target role.
// Accepts ANY role — no normalization, no validation. Trusting the LLM to handle
// "Quantum ML Researcher" the same as "Marketing Intern" or "Chartered Accountant".
function buildJdContext(session) {
  if (!session) return '';
  if (session.jd_role) {
    return `\n\nTARGET ROLE: "${session.jd_role}"\nCalibrate everything to this role:\n- Sufficiency judgment: what counts as "impact" varies by role. For a Marketing role think reach/CTR/conversions; for Engineering think scale/latency/uptime; for Sales think revenue/pipeline; for Design think users/adoption/conversion; for Finance think cost saved/audit findings. Apply the role-appropriate yardstick.\n- Clarification questions: ask for metrics native to the target role (not generic ones).\n- Skill categorization: when ambiguous, lean toward what this role would value.\n- NEVER reject or judge a role as invalid. Every role on earth is legitimate — calibrate intelligently to it.`;
  }
  if (session.jd_text) {
    const excerpt = session.jd_text.length > 1200 ? session.jd_text.slice(0, 1200) + '…' : session.jd_text;
    return `\n\nTARGET JD (excerpt):\n"""${excerpt}"""\nCalibrate clarifications and sufficiency to what THIS JD specifically values. Bias skill categorization, expected metrics, and tone toward the JD's stated requirements.`;
  }
  if (session.jd_url) {
    return `\n\nTARGET JD URL: ${session.jd_url} (full text will be scraped Day 3). For now, treat as a typical role at that URL's domain — common skills, generic metrics.`;
  }
  if (session.jd_generic) {
    return `\n\nNO SPECIFIC ROLE TARGET — generic resume mode. Don't bias toward any field; ask for broadly useful detail (concrete actions, measurable outcomes) without forcing role-specific framing.`;
  }
  return '';
}

async function extractSection({ state, body, resumeJson, session, focus }) {
  const cfg = SECTION_CONFIG[state];
  if (!cfg) throw new Error(`No extractor configured for state ${state}`);

  // Pull GitHub repo metadata if applicable. Adds latency (~500-1500ms) but
  // dramatically improves project extraction quality.
  const repoEnrichment = await maybeEnrichProject(state, body);
  const enrichmentBlock = repoEnrichment
    ? `\n\nGitHub repo data fetched for this URL (use to fill tech_stack and bullets):\n${JSON.stringify({
        name: repoEnrichment.name,
        description: repoEnrichment.description,
        languages: repoEnrichment.languages,
        topics: repoEnrichment.topics,
        stars: repoEnrichment.stars,
        url: repoEnrichment.html_url,
        readme_excerpt: repoEnrichment.readme ? repoEnrichment.readme.slice(0, 1500) : null,
      })}\n`
    : '';

  const jdContextBlock = buildJdContext(session);

  // Conversational context: WHAT the student was just asked. Without this the
  // extraction is stateless — a terse reply like "Jan 2023 to Dec 2024" or
  // "Razorpay" carries no clue which field it answers, so the LLM drops it and
  // the router re-asks. This line gives the LLM the same context a human chat
  // would have: "you just asked X, so this reply IS X."
  const focusBlock = focus
    ? `\n\nCONVERSATION CONTEXT: The student was JUST asked specifically for the "${focus}" of their experience. Their message below is almost certainly the answer to THAT — map it to "${focus}" even if stated tersely or as a bare fragment (a bare date range → dates; a bare company name → company; a bare job title → role). Fill that field; do not discard a short reply just because it isn't a full sentence.`
    : '';

  const system = `You are extracting structured resume data from a student's WhatsApp message. The student types in English, Hinglish (Roman-script Hindi), or sometimes pure Hindi. Extract ONLY what they explicitly stated or what's verifiable from GitHub repo data when provided. Do not invent metrics, claims, or skills.

Current state: ${state}
Current resume_json (already collected; for context only): ${JSON.stringify(resumeJson)}${jdContextBlock}${focusBlock}${enrichmentBlock}

INSTRUCTION: ${cfg.instruction}

Return ONLY valid JSON in this exact shape:
${cfg.shape}

CRITICAL VOICE RULES for clarification_needed:
- Write in HINGLISH or ENGLISH using LATIN SCRIPT ONLY.
- NEVER use Devanagari. Romanize: "haan" not "हाँ", "naam" not "नाम".
- Tone: warm and casual, elder-cousin energy. Use "aap" not "tu".
- One short sentence — this goes straight to WhatsApp.
- When asking for metrics/impact, ask in terms NATIVE to the TARGET ROLE (see context above). Don't ask a marketer about RPS or a backend engineer about CTR.

If the message is unclear or insufficient, set the relevant data field to null and put a short Latin-script follow-up question in clarification_needed. Otherwise clarification_needed must be null.

Respond with JSON only, no surrounding prose, no markdown fences.`;

  const result = await complete({ system, user: body });
  return { ...result, repoEnrichment };
}

module.exports = { extractSection, SECTION_CONFIG };
