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
    instruction: 'Extract the student\'s full name. Title-case it (e.g., "Aditya Kumar"). If the message is too short or unclear, set name to null and add a clarification.',
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

  // PROJECTS — sufficiency + role-aware + GitHub repo enrichment.
  AWAITING_PROJECTS: {
    instruction: `Extract details for ONE project. tech_stack means "tools/tech/methods used" — for non-tech projects (marketing campaign, design portfolio piece, civil engineering work) it holds whatever tools/methods/platforms were actually used.

Required pieces for "sufficient":
  (a) name
  (b) what it accomplishes + the key tools/tech/methods used (calibrated to TARGET ROLE context above)
  (c) at least one bullet describing the student's concrete contribution or measurable impact

If a "GitHub repo data" block appears in context, USE IT to fill tech_stack, what-it-does, and bullets — that's why we fetched it. Do not re-ask the student for tech stack if the repo already lists languages.

If the message extends an existing pending_project (already in resume_json.pending_project), MERGE — don't discard.

After extraction, evaluate sufficiency:
- If (a), (b), (c) present → clarification_needed = null.
- If missing → set clarification_needed to a TARGETED Hinglish/English follow-up asking ONLY for the missing piece.

CRITICAL — DO NOT copy these examples verbatim. They're patterns to ADAPT to the TARGET ROLE:
  - Tech project, missing impact: "Kitne users ne use kiya, kya perf improvement mili, kya scale handle kiya?"
  - Marketing project, missing impact: "Campaign reach kya thi, CTR / conversion kitna improve hua?"
  - Design project, missing impact: "Kitne users tak pahuncha, adoption kitna increase hua, A/B test result?"
  - Sales project, missing impact: "Pipeline / revenue kitna grow kiya, deal size kya thi?"
  - Civil/mech project, missing impact: "Project size (budget, sq ft, timeline saved)? Safety / quality outcome?"
  - For other domains, ask for the metric NATIVE to that field.

Same role-tailoring for "missing contribution" and "missing description". NEVER re-ask everything. NEVER assume tech bias if the role isn't tech.`,
    shape: '{ "project": { "name": string | null, "tech_stack": [string], "dates": string | null, "github_url": string | null, "bullets": [string] } | null, "clarification_needed": string | null }',
    // Merge into pending_project (not projects[]). Router decides when to commit.
    merge: (rj, x) => {
      if (!rj.pending_project) rj.pending_project = {};
      if (!x.project) return;
      const p = rj.pending_project;
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

  // CERTS — drastically simplified per Meet's feedback. Just name + URL.
  // Day 4 template renders as hyperlink (name = display text, url = href).
  // Don't ask for issuer or date — they're inferable from URL or irrelevant.
  AWAITING_CERTS: {
    instruction: `Extract certifications. Each entry needs ONLY a name and a verification URL.

Rules:
- name = course/cert title (e.g., "Deep Learning Specialization", "AWS Certified Solutions Architect").
- url = the verification URL the student shared (Coursera/NPTEL/Udemy/AWS Credly/etc.). If they only gave a name and no link, url = null.
- Return an ARRAY — could be one or many from one message.
- Do NOT extract or invent issuer/date as separate fields. The URL contains that info implicitly; the rendered resume will be a hyperlink (name as visible text, url as link).
- clarification_needed = null unless name itself is unclear.`,
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
