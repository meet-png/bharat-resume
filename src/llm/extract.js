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

  AWAITING_SKILLS: {
    instruction: `Categorize the listed skills into 5 buckets. The buckets are guidelines — adapt their meaning to the TARGET ROLE in the JD context above:

- languages: programming languages for tech roles (Python, Java, JS) OR human languages if role-relevant (translation, customer-facing)
- frameworks: software frameworks (React, Django, Node) for tech roles OR domain methodologies for non-tech (Agile, Six Sigma, Design Thinking, GTM frameworks)
- tools: any tool/software they use, calibrated to the role — Git/Docker for engineers; Figma/Sketch for designers; HubSpot/Mailchimp/Salesforce for marketers/sales; Excel/SAP/Tableau for finance/analysts; AutoCAD/SolidWorks for civil/mech engineers
- databases: data stores (mostly relevant for tech/data roles; empty otherwise)
- other: anything else relevant — domain expertise, certifications mentioned, soft skills, regulatory knowledge, methodologies

Include EVERY skill the student mentioned. When ambiguous about which bucket, prefer "tools" or "other" — never drop a skill, and never force a non-tech skill into a tech bucket. Preserve student's capitalization where reasonable. Empty array if a category genuinely has nothing.`,
    shape: '{ "skills": { "languages": [string], "frameworks": [string], "tools": [string], "databases": [string], "other": [string] }, "clarification_needed": string | null }',
    merge: (rj, x) => { rj.skills = x.skills || { languages: [], frameworks: [], tools: [], databases: [], other: [] }; },
  },

  // EXPERIENCE — sufficiency-aware AND role-aware. Clarification phrasing must
  // adapt to whatever target role is in JD context (no hardcoded tech bias).
  AWAITING_EXPERIENCE: {
    instruction: `Extract internship/job experience. Required pieces for "sufficient":
  (a) role + company (who/where)
  (b) ≥1 bullet describing what they DID (concrete action specific to the target role's domain)
  (c) impact: a measurable outcome relevant to the target role (see TARGET ROLE / JD block above), OR a concrete deliverable shipped

If the message ADDS to an existing partial experience already in resume_json.experience[0], merge — do NOT discard prior good fields. Bullets append.

After extraction, evaluate sufficiency:
- If (a), (b), AND (c) are present → clarification_needed = null (we advance).
- If something is missing → clarification_needed = a SHORT, Hinglish/English, Latin-script question targeted at ONLY the missing piece.

CRITICAL — DO NOT copy these examples verbatim. They're patterns to adapt to the TARGET ROLE:
  - If target role is marketing-flavored: missing impact → ask about campaign reach, CTR, leads, conversions, pipeline
  - If target role is engineering-flavored: missing impact → ask about latency, scale (RPS / QPS / users), uptime, perf delta, bug count reduced
  - If target role is sales-flavored: missing impact → ask about revenue, quota %, deals closed, pipeline created
  - If target role is design-flavored: missing impact → ask about users affected, adoption %, conversion lift, A/B test result
  - If target role is finance/ops-flavored: missing impact → ask about cost saved, audit findings, time-to-close, error rate
  - If target role is civil/mechanical/non-software engineering: missing impact → ask about project size, budget, timeline saved, safety/quality outcome
  - If target role is medical/teaching/social: missing impact → ask about patients/students/people served, outcome improved, program scaled
  - For roles not in the above buckets: pick a metric NATIVE to that role's industry — don't default to software metrics.

Same role-awareness for "missing action" (ask for an action verb appropriate to the role) and "missing role" (give example titles from the target role's domain, not generic tech examples).

NEVER re-ask the whole thing.`,
    shape: '{ "experience": { "role": string | null, "company": string | null, "location": string | null, "dates": string | null, "bullets": [string] } | null, "clarification_needed": string | null }',
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
  (c) at least one bullet with a SPECIFIC NUMBER ("85%", "200 users", "12K rows") — soft qualifiers ("good", "many", "great", "fast") do NOT count
  (d) github_url is a real URL, OR pending_project._link_declined === true

LINK-DECLINE DETECTION:
If the current message contains any of: "no link", "skip link", "private", "private repo", "no repo", "not public", "github nahi", "nahi link", "link nahi", "no github" — set link_declined = true in your output. Router persists this to pending_project._link_declined.

CLARIFICATION RULES (ask ONLY ONE missing piece per turn):

CASE A — only (a) missing (message has no project content):
  Ask only for what they built. Example: "Kya banaya tha project mein? Naam aur 1-2 lines."

CASE B — (a) present, (b) missing:
  Ask for tech / description. Example: "Kis tech / tool se banaya? Aur kya karta hai project?"

CASE C — (a) and (b) present, (d) missing AND _link_declined NOT true:
  Ask ONLY for the link. NEVER mention impact/accuracy/metric here.
  Examples:
    "GitHub link bhej dijiye? Ya deployed URL / demo? 'no link' agar private hai."
    "Repo link ya live URL? 'no link' agar nahi share kar sakte."

CASE D — link sorted (URL present OR _link_declined=true) AND (c) vague/missing:
  Ask ONLY for a specific number. Adapt to the project type and TARGET ROLE.
  Examples:
    Tech project: "Cool. Exact accuracy number kya tha — 85%? 92%?"
    Marketing: "Campaign reach kya thi, CTR kitna improve hua?"
    Design: "Kitne users tak pahuncha, adoption / conversion lift kya tha?"

CASE E — all four ✓ → clarification_needed = null.

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
    shape: '{ "project": { "name": string | null, "tech_stack": [string], "dates": string | null, "github_url": string | null, "bullets": [string] } | null, "link_declined": boolean, "clarification_needed": string | null }',
    // Merge into pending_project (not projects[]). Router decides when to commit.
    merge: (rj, x) => {
      if (!rj.pending_project) rj.pending_project = {};
      const p = rj.pending_project;
      // Persist link-decline flag across turns.
      if (x.link_declined === true) p._link_declined = true;
      if (!x.project) return;
      for (const k of ['name', 'dates', 'github_url']) {
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

  AWAITING_POR: {
    instruction: 'Extract a leadership/responsibility role. Role e.g. "Class Representative", "Club Lead", "MUN Secretary", "Event Organizer". Organization is the college/club/society name. Bullets are factual descriptions of what they did. NEVER invent.',
    shape: '{ "por": { "role": string | null, "organization": string | null, "dates": string | null, "bullets": [string] } | null, "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!rj.por) rj.por = [];
      if (x.por && (x.por.role || x.por.organization)) rj.por.push(x.por);
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

  AWAITING_ACHIEVEMENTS: {
    instruction: 'Extract notable achievements, ranks, prizes, awards as an array of short factual strings. Each entry should be one specific accomplishment.',
    shape: '{ "achievements": [string], "clarification_needed": string | null }',
    merge: (rj, x) => { rj.achievements = (rj.achievements || []).concat(x.achievements || []); },
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

async function extractSection({ state, body, resumeJson, session }) {
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

  const system = `You are extracting structured resume data from a student's WhatsApp message. The student types in English, Hinglish (Roman-script Hindi), or sometimes pure Hindi. Extract ONLY what they explicitly stated or what's verifiable from GitHub repo data when provided. Do not invent metrics, claims, or skills.

Current state: ${state}
Current resume_json (already collected; for context only): ${JSON.stringify(resumeJson)}${jdContextBlock}${enrichmentBlock}

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
