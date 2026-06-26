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

   Example shape (do NOT copy text — copy SHAPE and VOICE):
   "Data and AI engineer who builds systems end-to-end — instrumented ETL pipelines, schema-driven LLM contracts, and dashboards that defend a falsifiable claim. Shipped a trade-data warehouse (12,828 rows, 20/20 validation) that overturned the 'September peak' assumption, an autonomous sales agent at ~\$0.04/conversation with a 15%+ booking rate, and an ICP-grounded content pipeline cutting copywriting cost ~99%. Every system has real numbers, not adjectives, behind it."

   Rules:
   - VOICE: standard resume summary voice — IMPERSONAL / implied-first-person. NEVER write the student's name. NEVER use third-person pronouns (he/she/they/"his/her") and NEVER narrate them by name ("Priya is a…", "Rohan developed…"). Also avoid explicit "I/my". Lead with a role noun or skill phrase: "Data analyst skilled in Looker and BigQuery who reduced query runtime from 40s to 6s…" — exactly how the reference resume templates read.
   - **OPENER RULE (banned vs preferred):** the FIRST sentence determines whether the summary punches or feels generic. BAN these opener patterns: "B.Tech student passionate about…", "Final-year student interested in…", "Aspiring [role] with a passion for…", "Highly motivated individual…", "Enthusiastic learner…", "Driven student…". PREFER: open with a ROLE NOUN + most distinctive concrete fact from input — a shipped artifact + its metric, a competition result, a domain credential. Example shapes (copy SHAPE, not text): "Backend engineer who shipped a payment retry service handling **50K daily transactions** at Razorpay — reduced failures 18%, p99 latency 400ms → 60ms." OR "MUN Secretary General who directed Rajasthan's largest student MUN — **450+ delegates, ₹3L+ budget, zero deficit across two editions**." The strongest single fact GOES FIRST.
   - Dense with metrics: every claim has a number behind it WHERE THE STUDENT PROVIDED ONE. Don't invent numbers. Skip the number if the student didn't give one.
   - Mentions degree + year + 1-2 strongest concrete projects/outcomes/skills.
   - Closing sentence (optional but recommended for strong inputs): a single thesis line that frames the body as evidence — e.g. "Every system has real numbers, not adjectives, behind it." Use sparingly; only when the body actually supports the claim.

2. BULLETS — **TARGET 3 per entry** (god-level resumes carry 3 per role / project), selective bold on metric/outcome:

   *** BULLET-COUNT TABLE (use this verbatim — no ad-hoc compression) ***
   Count the DISTINCT substantive facts in the input for this entry (each named scale/scope, each metric, each named outcome, each named scope of leadership counts as ONE fact). Then:
     • Input has 1 fact          → 1 bullet.
     • Input has 2 facts         → 2 bullets — OR 3 bullets if you can SPLIT one fact across angles (e.g. scale + financial scope) without restating the same content. Prefer 3 if the role + scale supports it (see ROLE-IMPLICIT RESPONSIBILITY below).
     • Input has 3+ facts        → exactly 3 bullets, one per substantive fact, distributed across SCALE, QUALITY, IMPACT angles. **NEVER compress 5 facts into 2 bullets by grouping** — the recruiter loses the metric density and the bullet reads as a wall of text.
   God-level reference resumes consistently show 3 bullets per entry. 2 is the floor and only acceptable when the input GENUINELY has <3 distinct facts AND no role-implicit responsibility can be honestly named.

   *** ROLE-IMPLICIT RESPONSIBILITY (carve-out for the "honest 3rd bullet") ***
   When the input has 2 substantive facts AND you can identify a responsibility that is INHERENTLY part of the stated role + scale, you MAY write a 3rd qualitative bullet describing that responsibility. Strict ceiling:
     • Allowed: name a responsibility the role unambiguously includes by virtue of its scope/scale/title — e.g. for a 15-member team lead at a 450-delegate event: "Coordinated logistics across hospitality, substantive, and external-affairs committees in the lead-up and during conference"; for a SWE Intern with a deployed service: "Participated in code review and sprint planning across the platform team"; for a Marketing Intern with a campaign: "Coordinated creative review with design and brand stakeholders on each campaign drop".
     • FORBIDDEN: inventing any NUMBER not in the input (15→25, ₹3L→₹5L). FORBIDDEN: claiming any OUTCOME the student did not state (no fabricated "secured 8 sponsorships", no fabricated "reduced cost by 30%"). FORBIDDEN: naming a skill, tool, or technology not stated. FORBIDDEN: claiming participation in something the student did not mention (e.g. don't say "presented to faculty" if they didn't say so).
     • This rule is about NAMING THE RESPONSIBILITY, never about METRICS. If the role doesn't unambiguously imply a responsibility, do NOT invent one — write 2 bullets honestly.
     • Voice for the 3rd bullet: DESCRIPTIVE / qualitative, no bold metric, no numbers. It should read as filling-out-the-role, not making-something-up.

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

   PROJECT bullets — ANCHOR IDENTITY without compressing:
   The FIRST bullet of a PROJECT must establish WHAT the project IS (the one-line
   description / core feature from the input or README) AND fold ONE primary
   metric into that SAME bullet when one exists. Never reduce a project to naked
   numbers with no statement of what it is — that reads as incomplete.
   **DO NOT pack every metric into bullet 1.** Additional substantive facts get
   their own bullets (bullet 2, bullet 3) — preserve depth, don't collapse it.
     Input: description "gamified habit-tracker with streaks & leaderboard"
            + metrics "300 signups", "1200+ habits tracked"
     WRONG: • About 300 developers signed up.   • 1200+ habits tracked.   (drops identity)
     ALSO WRONG: ONE bullet with all 5 facts crammed in — reads as a wall of text.
     RIGHT (2 facts): • Built DevHab, a gamified habit-tracker with streaks and a leaderboard — **300+ signups**, **1200+ habits tracked**.
     RIGHT (5 facts → 3 bullets):
       • Built Jodhpur Export Intelligence, ingesting 5 trade sources into an 8-table star schema — **12,828 rows** on cold run.
       • Authored **20/20 validation checks** catching every anomaly before downstream pipelines consumed the data.
       • Applied a **-8.0% statistical correction** that revised the headline export figure from **₹18,310 Cr → ₹4,711 Cr**.
   Rule of thumb: identity + 1 metric in bullet 1; one substantive fact each in bullets 2 and 3.

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
  "coding_profiles": [{ "platform": string, "url": string | null, "stat": string | null }],
  "summary": string,
  "education": [{ "degree": string, "college": string, "branch": string | null, "location": string | null, "dates": string | null, "cgpa": string | null, "coursework": string | null }],
  "skills": [{ "category": string, "items": [string] }],
  "experience": [{ "role": string, "company": string, "location": string | null, "dates": string | null, "tech_stack": [string], "bullets": [string] }],
  "projects": [{ "name": string, "tech_stack": [string], "dates": string | null, "github_url": string | null, "demo_url": string | null, "bullets": [string] }],
  "por": [{ "role": string, "organization": string, "dates": string | null, "bullets": [string] }],
  "certifications": [{ "name": string, "url": string | null }],
  "achievements": [string]
}

Bullets are PLAIN STRINGS — include the \`**...**\` markdown markers around the metric inside the string. Example: "Architected an ETL pipeline ingesting 5 sources — **12,828 rows, 20/20 validation**."

SKILLS: keep every item the student listed — NEVER add a skill they didn't provide. You MAY rename or merge the category labels to read sharply for the target role (e.g. "Other" → "ML / AI" or "Tools / DevOps"), and order categories strongest-first. Never emit a category labelled "Other"/"Misc".

CONTACT FIELDS (name, email, linkedin, github, leetcode, coding_profiles, phone): echo them unchanged — they are re-attached verbatim downstream regardless, so do not alter URLs or counts.

Sections the student left empty: keep as empty array (not null, not omitted).`;

  const result = await complete({ system, user: 'rewrite the resume now', maxTokens: 2400, temperature: 0.2 });

  // Contact identifiers are user-provided FACTS, not prose to "improve". The
  // rewriter is allowed to drop/normalize them, and an LLM silently mutating a
  // URL (or hallucinating a username) puts a wrong link on someone's resume.
  // Re-attach them verbatim from the source JSON so the model can never touch
  // them — name/email/links are deterministic, not generated.
  if (result.data) {
    if (resumeJson.name)  result.data.name = resumeJson.name;
    if (resumeJson.email) result.data.email = resumeJson.email;
    result.data.linkedin = resumeJson.linkedin || null;
    result.data.github   = resumeJson.github || null;
    result.data.leetcode = resumeJson.leetcode || null;
    result.data.coding_profiles = Array.isArray(resumeJson.coding_profiles) ? resumeJson.coding_profiles : [];
    if (phoneFrom) {
      result.data.phone = String(phoneFrom).replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
    }

    // Competitive-programming is highest-signal as an achievement WITH counts,
    // not just a contact link (see top tech resumes). If the student gave any
    // stat (problem count / rating), synthesize one factual achievement bullet
    // deterministically — never via the LLM, so the numbers can't be inflated.
    const withStats = result.data.coding_profiles.filter((c) => c && c.platform && c.stat);
    if (withStats.length > 0) {
      const parts = withStats.map((c) => `${c.platform}: **${c.stat}**`);
      const bullet = `Competitive programming — ${parts.join('; ')}.`;
      if (!Array.isArray(result.data.achievements)) result.data.achievements = [];
      const already = result.data.achievements.some((a) => /competitive programming/i.test(String(a)));
      if (!already) result.data.achievements.unshift(bullet);
    }
  }

  return result;
}

module.exports = { rewriteResume };
