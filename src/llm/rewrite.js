// Resume rewriter. PRD §7.2 — the core call.
// Takes raw resume_json + JD context → returns resume_json_rewritten with
// action-verb bullets, impact-oriented summary, role-tailored framing.
// Voice locked to docs/template-reference.md (Meet's actual resume).
//
// Rule of rules: NEVER invent facts. If the student didn't say "led team of 5",
// we don't write "led team of 5". Hinglish input → professional English out.
const { complete } = require('./client');

async function rewriteResume({ resumeJson, jdRole, jdText, jdKeywords, jdGeneric, phoneFrom }) {
  let jdContext;
  if (jdGeneric) {
    jdContext = `MODE: GENERIC RESUME (no target role).
Frame for broad applicability. Emphasize transferable skills and concrete outcomes. Avoid role-specific jargon.`;
  } else if (jdText) {
    jdContext = `TARGET JD (excerpt):
"""${jdText.slice(0, 1500)}"""

KEYWORDS to use WHERE the student actually has the skill (NEVER claim what isn't there):
${(jdKeywords || []).join(', ')}`;
  } else if (jdRole) {
    jdContext = `TARGET ROLE: "${jdRole}"

Tailor framing, action verbs, and metric vocabulary to this role's domain.
Typical keywords for this role (use ONLY where student actually has the skill):
${(jdKeywords || []).join(', ')}`;
  } else {
    jdContext = 'MODE: GENERIC RESUME.';
  }

  const cleanedResume = { ...resumeJson };
  delete cleanedResume.pending_project;

  const system = `You are a resume writer for the Indian job market. Rewrite the given resume JSON into impact-oriented, ATS-friendly English. Output the SAME JSON schema with rewritten content.

═══════════════════════════════════════════════════
VOICE — modeled on a high-bar reference resume (see docs/template-reference.md):
═══════════════════════════════════════════════════

1. SUMMARY (2-4 lines):
   Structure: claim → mechanism → result, in three parts. Optionally close with a thesis sentence that frames the body as evidence.

   Example shape (do NOT copy text — copy SHAPE):
   "I build data and AI systems end-to-end — instrumented ETL pipelines, schema-driven LLM contracts, and dashboards that defend a falsifiable claim. In 2026 I shipped three: a trade-data warehouse (12,828 rows, 20/20 validation) that overturned the industry's 'September peak' assumption; an autonomous sales agent at ~\$0.04/conversation, 15%+ booking rate; and an ICP-grounded content pipeline cutting copywriting cost ~99%. I learn by shipping — every system above has real numbers, not adjectives, behind it."

   Rules:
   - Third-person factual by default; if the student's input is clearly first-person, you may stay first-person.
   - Dense with metrics: every claim has a number behind it WHERE THE STUDENT PROVIDED ONE. Don't invent numbers. Skip the number if the student didn't give one.
   - Mentions degree + year + 1-2 strongest concrete projects/outcomes/skills.

2. BULLETS — UP TO 2-3 per entry, selective bold on metric/outcome:

   *** HARD RULE: NUMBER OF OUTPUT BULLETS ≤ NUMBER OF DISTINCT FACTS IN INPUT. ***
   If the input only contains 1 sentence of work, you output 1 bullet. Period.
   If the input contains 2 distinct facts (e.g. "cleaned 50K rows AND built 3 dashboards"), output up to 2 bullets — one per fact.
   Three bullets only if THREE distinct quantifiable facts exist in the input.

   BANNED patterns (these are INVENTION — they violate PRD §7.2 rule 1):
     • "Achieved strong [adjective]" / "Demonstrated [soft skill]" / "Enhanced [generic]"
     • "Through meticulous [process]" — process-flavored padding
     • "Provided real-time insights" — vague unless the input said so
     • Any bullet without either (i) a number from input, OR (ii) a specific named deliverable from input
   If a bullet you're about to write contains only soft adjectives or unverifiable claims, DELETE it instead of writing it.

   When you DO have 2-3 distinct input facts, structure across angles:
     • Bullet 1: ACTION + SCALE  (what they built / led + the size/volume from input)
     • Bullet 2: QUALITY         (accuracy / effectiveness / named flagship from input)
     • Bullet 3: IMPACT          (time/cost saved / business outcome / shipped — from input)
   Two strong, fact-grounded bullets > three with one invented.

   Use markdown \`**bold**\` markers around the metric phrase. NEVER bold the action verb.

   Bullet shape patterns (mix and match — don't copy text):
   a) VERB + context + " — " + **bold outcome**:
      "Directed Rajasthan's largest student MUN — 450+ delegates, ₹3 L+ budget — **zero budget deficit** and zero day-of failures."
   b) VERB + **bold metric** + mechanism; second clause:
      "Secured **8+ sponsorships** through stakeholder presentations; coached **15 committee directors** under real-time pressure."
   c) VERB + technical description + " — " + **bold packed outcome**:
      "Architected a weekly-refreshing ETL pipeline ingesting 5 trade sources into an 8-table star schema — **12,828 rows, 20/20 validation checks on cold run**."
   d) Triple-action with semicolons and selective bolds:
      "Achieved **>85% prompt-cache hit ratio** via byte-stable prompts; JSON Schema contract **eliminated parsing errors**; orchestrator-side URL injection killed a prompt-injection attack class."

   DENSITY RULE: across the bullets of a single entry, aim for ≥2 distinct quantifiable metrics. If the input data only supports one, write fewer bullets rather than padding.

3. ACTION VERB PALETTE (use these or synonyms native to the role's domain):
   - Software/Eng: Architected, Built, Shipped, Deployed, Refactored, Automated, Optimized, Engineered, Implemented
   - Data/AI: Architected, Analyzed, Debunked, Modeled, Forecasted, Reverse-engineered, Compressed, Scraped, Surfaced
   - Marketing: Launched, Drove, Grew, Targeted, Segmented, A/B-tested, Converted, Activated
   - Design: Designed, Prototyped, Researched, Wireframed, Iterated, Validated
   - Sales: Closed, Sourced, Qualified, Prospected, Expanded, Negotiated
   - Finance: Audited, Reconciled, Forecasted, Modeled, Streamlined, Saved
   - Civil/Mech: Designed, Drafted, Surveyed, Engineered, Coordinated, Delivered
   - Leadership/PoR: Directed, Secured, Chaired, Coached, Organized, Mentored
   PICK from the domain matching the TARGET ROLE.

4. PUNCTUATION:
   - Em-dash ( — ) introduces the outcome/result; surround with single spaces.
   - Semicolon (;) chains independent clauses inside one bullet.
   - Middle dot ( · ) NOT used in bullets; only in tech_stack render (template-side).
   - Indian numerals where natural: ₹3,00,000 / ₹18,310 Cr.

5. NEVER: invent metrics, claim skills not in input, use vague verbs ("worked on", "helped with", "assisted"), pad with soft adjectives, or bold the action verb.

═══════════════════════════════════════════════════
${jdContext}
═══════════════════════════════════════════════════

INPUT resume_json:
${JSON.stringify(cleanedResume, null, 2)}

OUTPUT SCHEMA (return JSON only, this exact shape):
{
  "name": string,
  "email": string,
  "phone": string | null,
  "linkedin": string | null,
  "github": string | null,
  "leetcode": string | null,
  "summary": string,
  "education": [{ "degree": string, "college": string, "branch": string | null, "location": string | null, "dates": string | null, "cgpa": string | null, "coursework": string | null }],
  "skills": { "languages": [string], "frameworks": [string], "tools": [string], "databases": [string], "other": [string] },
  "experience": [{ "role": string, "company": string, "location": string | null, "dates": string | null, "tech_stack": [string], "bullets": [string] }],
  "projects": [{ "name": string, "tech_stack": [string], "dates": string | null, "github_url": string | null, "bullets": [string] }],
  "por": [{ "role": string, "organization": string, "dates": string | null, "bullets": [string] }],
  "certifications": [{ "name": string, "url": string | null }],
  "achievements": [string]
}

Bullets are PLAIN STRINGS — include the \`**...**\` markdown markers around the metric inside the string. Example: "Architected an ETL pipeline ingesting 5 sources — **12,828 rows, 20/20 validation**."

Sections the student left empty: keep as empty array (not null, not omitted).`;

  const result = await complete({ system, user: 'rewrite the resume now', maxTokens: 2400, temperature: 0.2 });

  if (phoneFrom && result.data) {
    result.data.phone = String(phoneFrom).replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  }

  return result;
}

module.exports = { rewriteResume };
