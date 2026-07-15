// Multi-agent resume rewriter. PRD §7.2 architecture upgraded 2026-07-13.
// Elaboration mandate added 2026-07-16 — see rewriteBody prompt "ELABORATION
// MANDATE" section. Applies ONLY to experience / projects / por bullets.
//
// The rewriter runs in TWO PASSES orchestrated by state/generator.js:
//
//   Pass 1 — rewriteBody   : rewrites every section EXCEPT the summary.
//                             Consumes: raw resume_json (incl. per-project
//                             readme_excerpt) + JD Intelligence profile.
//                             Reason for split: the summary must reflect the
//                             POLISHED body, not the raw input. Doing both in
//                             one call means the summary is authored from the
//                             raw input and never sees its own body — result
//                             feels detached and generic.
//
//   Pass 2 — rewriteSummary : takes the polished body + JD intel and authors
//                             ONLY the summary. Opens with the JD's role_noun,
//                             leads with the strongest body fact aligned to
//                             THAT role's angle (not the strongest fact overall).
//                             Live-test 2026-07-13: single-pass rewriter picked
//                             MUN as the opener for a Data Analyst JD because
//                             MUN scale looked more "distinctive"; two-pass
//                             with JD role_noun as an opener rule fixes it.
//
// Rule of rules: NEVER invent facts. The rules that used to live in the
// single-call prompt (voice, bullet-count table, ROLE-IMPLICIT carve-out,
// PROJECT ANCHOR IDENTITY, action-verb palette) are preserved verbatim in
// rewriteBody. rewriteSummary is a smaller focused prompt.
const { complete } = require('./client');
const logger = require('../logger');

// Length observability for the ELABORATION MANDATE (2026-07-16). The prompt
// enforces 280-char max per bullet in experience / projects / por. This helper
// scans the rewritten body and logs any bullets that overshoot (over-elaboration)
// or fall well under 60 chars (under-elaboration signal — LLM was probably
// too cautious). Non-blocking: just observability so we can tune the prompt
// if drift is observed in production.
const BULLET_MAX_CHARS = 280;
const BULLET_MIN_CHARS = 60;
function checkElaborationBounds(body) {
  if (!body || typeof body !== 'object') return { over: 0, under: 0 };
  const sections = [
    ['experience', 'role'],
    ['projects', 'name'],
    ['por', 'role'],
  ];
  let over = 0;
  let under = 0;
  const details = [];
  for (const [section, labelField] of sections) {
    const entries = Array.isArray(body[section]) ? body[section] : [];
    entries.forEach((entry, i) => {
      const label = entry && entry[labelField] ? String(entry[labelField]).slice(0, 40) : `${section}[${i}]`;
      const bullets = Array.isArray(entry && entry.bullets) ? entry.bullets : [];
      bullets.forEach((b, bi) => {
        const s = typeof b === 'string' ? b : String(b || '');
        if (s.length > BULLET_MAX_CHARS) {
          over++;
          details.push({ section, entry: label, bullet: bi, len: s.length, kind: 'over' });
        } else if (s.length < BULLET_MIN_CHARS && s.length > 0) {
          under++;
          details.push({ section, entry: label, bullet: bi, len: s.length, kind: 'under' });
        }
      });
    });
  }
  if (over > 0 || under > 0) {
    logger.warn({ over, under, details: details.slice(0, 10) }, 'elaboration bounds — bullets outside target length window');
  }
  return { over, under };
}

// ─────────────────────────────────────────────────────────────────────────
// JD context block used by both passes. Priority: JD intel > jd text > role.
// ─────────────────────────────────────────────────────────────────────────
function buildJdContextBlock({ jdIntel, jdText, jdRole, jdKeywords, jdGeneric }) {
  if (jdGeneric) {
    return `MODE: GENERIC RESUME (no target role).
Frame for broad applicability. Emphasize transferable skills and concrete outcomes. Avoid role-specific jargon.`;
  }
  if (jdIntel && jdIntel.role_noun && jdIntel.role_noun !== 'candidate') {
    return `TARGET JD PROFILE (structured intelligence from the JD text):
  - Role noun (open the summary with this exact noun): "${jdIntel.role_noun}"
  - Full title: "${jdIntel.role_title || jdIntel.role_noun}"
  - Domain: ${jdIntel.domain || 'generic'}
  - Experience level target: ${jdIntel.experience_level || 'fresher'}
  - Key responsibilities the JD calls out:
    ${(jdIntel.key_responsibilities || []).map((r) => `• ${r}`).join('\n    ') || '• (none extracted)'}
  - JD-prioritized skills (ORDER matters — most important first). Use these ONLY where the student actually has the skill; NEVER invent:
    ${(jdIntel.top_prioritized_skills || []).join(', ') || '(none)'}
  - Full keyword list from the JD (same rule — only where student has the skill):
    ${(jdIntel.keywords || jdKeywords || []).join(', ') || '(none)'}

${jdText ? `Full JD excerpt for phrasing cues (do NOT copy verbatim):\n"""${jdText.slice(0, 1500)}"""` : ''}`;
  }
  if (jdText) {
    return `TARGET JD (excerpt):
"""${jdText.slice(0, 1500)}"""

Keywords to use WHERE the student actually has the skill (NEVER claim what isn't there):
${(jdKeywords || []).join(', ')}`;
  }
  if (jdRole) {
    return `TARGET ROLE: "${jdRole}"

Tailor framing, action verbs, and metric vocabulary to this role's domain.
Typical keywords for this role (use ONLY where student actually has the skill):
${(jdKeywords || []).join(', ')}`;
  }
  return 'MODE: GENERIC RESUME.';
}

// ─────────────────────────────────────────────────────────────────────────
// Prepare projects with README excerpts inlined into the input the LLM sees.
// The extractor already stored readme_excerpt on each project via router.js;
// here we make the LLM aware of it as first-class fact-material, not just an
// afterthought. If a project has NO readme_excerpt, this is a no-op.
// ─────────────────────────────────────────────────────────────────────────
function inlineReadmesForRewrite(resumeJson) {
  const clone = { ...resumeJson };
  delete clone.pending_project;
  if (!Array.isArray(clone.projects)) return clone;
  clone.projects = clone.projects.map((p) => {
    if (!p) return p;
    const project = { ...p };
    // The rewriter reads readme_excerpt inline (not by fetching); the extractor
    // captured it at the moment the student mentioned the repo. If we ever add
    // an "update project" flow, we should re-capture here.
    if (project.readme_excerpt && project.readme_excerpt.length > 100) {
      // Cap the excerpt at 1800 chars per project so 4 projects fit in prompt
      // context without pushing us into a longer/slower call.
      project.readme_excerpt = String(project.readme_excerpt).slice(0, 1800);
    }
    return project;
  });
  return clone;
}

// ─────────────────────────────────────────────────────────────────────────
// PASS 1: body rewrite.
// Rewrites every section EXCEPT the summary. The summary field is written back
// as an empty string; PASS 2 (rewriteSummary) fills it in.
// ─────────────────────────────────────────────────────────────────────────
async function rewriteBody({ resumeJson, jdIntel, jdRole, jdText, jdKeywords, jdGeneric, phoneFrom }) {
  const jdContext = buildJdContextBlock({ jdIntel, jdText, jdRole, jdKeywords, jdGeneric });
  const cleanedResume = inlineReadmesForRewrite(resumeJson);

  const system = `You are a resume writer for the Indian job market. Rewrite the given resume JSON into impact-oriented, ATS-friendly English. Output the SAME JSON schema with rewritten content. **DO NOT write the summary field in this pass — leave it as empty string ""; a separate final pass will author it after the body is finalized.**

═══════════════════════════════════════════════════
GOAL — HIGHEST POSSIBLE ATS SCORE, WITHOUT GAMING:
═══════════════════════════════════════════════════
Your output will be scored by a deterministic ATS scorer that rewards:
  (a) Density of QUANTIFIED bullets — numbers, percentages, counts, scale, duration.
  (b) Strong action verbs (the palette below).
  (c) JD-keyword presence WHERE the student actually has the skill (matching exact tokens the JD uses).
  (d) Section completeness (skills categorized, education with degree+year, experience+projects with specific facts).
  (e) Surface area — bullets that read substantive (≥ ~10 words) and carry one named outcome.

Aim for the highest possible score by writing GENUINELY STRONG CONTENT — never by:
  • Stuffing JD keywords into bullets where the student doesn't have that skill (recruiter spots it instantly; product loses credibility).
  • Inventing metrics not in the input (450 → 800).
  • Padding with soft adjectives to inflate word count.
  • Renaming a tool the student didn't use to a JD-matched keyword.
ATS optimization is a SIDE EFFECT of authentic resume quality. Write for the recruiter; the scorer will reward you.


═══════════════════════════════════════════════════
VOICE — modeled on a high-bar reference resume (see docs/template-reference.md):
═══════════════════════════════════════════════════

1. SUMMARY — **DO NOT WRITE IT IN THIS PASS.**
   Leave the "summary" field as the empty string. A separate specialist pass will author it after seeing your finalized body. If you write anything in the summary field, it will be discarded.

2. BULLETS — **TARGET 3 per entry** (god-level resumes carry 3 per role / project), selective bold on metric/outcome:

   *** BULLET-COUNT TABLE (use this verbatim — no ad-hoc compression) ***
   Count the DISTINCT substantive facts in the input for this entry (each named scale/scope, each metric, each named outcome, each named scope of leadership counts as ONE fact). Then:
     • Input has 1 fact          → 1 bullet.
     • Input has 2 facts         → 2 bullets — OR 3 bullets if you can SPLIT one fact across angles (e.g. scale + financial scope) without restating the same content. Prefer 3 if the role + scale supports it (see ROLE-IMPLICIT RESPONSIBILITY below).
     • Input has 3+ facts        → exactly 3 bullets, one per substantive fact, distributed across SCALE, QUALITY, IMPACT angles. **NEVER compress 5 facts into 2 bullets by grouping** — the recruiter loses the metric density and the bullet reads as a wall of text.
   God-level reference resumes consistently show 3 bullets per entry. 2 is the floor and only acceptable when the input GENUINELY has <3 distinct facts AND no role-implicit responsibility can be honestly named.

   *** ELABORATION MANDATE (Experience + Projects + PoR — 2026-07-16, applies to these THREE sections only) ***

   HARD RULE for every bullet in experience[], projects[], and por[]: fold in ROLE-INHERENT elaboration to bring the bullet to full professional weight, within a hard **280-character cap** (~2 lines on the A4 template). This replaces the older "MAY write a 3rd bullet" carve-out — elaboration is now the DEFAULT behavior, not a permission.

   Why: student inputs are often terse ("mentored MUN participants", "Vice Chair at MUN", "worked at X"). A recruiter-scanned resume feels thin when bullets are direct restatements of a 5-word input. Role-inherent elaboration adds the definitional context of the role — what someone in that role by definition does — which is honest AND makes the resume feel authored, not typed.

   THREE-STEP PROCESS FOR EVERY BULLET:
     1. Start with the WHAT — action verb + core fact from the student's input (all input metrics preserved verbatim, wrapped in **bold**).
     2. Fold in ROLE-INHERENT context — one of: (a) qualities developed by the role ("public speaking, diplomacy, negotiation" for MUN mentor), (b) a responsibility inherent to the role ("moderating committee sessions" for a Chair, "code review and sprint planning" for a SWE Intern on a deployed service), (c) scope-inherent coordination ("cross-functional efforts across substantive, hospitality, external-affairs verticals" for a MUN Project Lead of 450+ delegates).
     3. Stay ≤ 280 characters. If elaboration pushes over, TRIM the elaboration — never trim the student's original fact/metric.

   BRIGHT LINE — SAFE vs UNSAFE elaboration:

   SAFE (role-inherent — TRUE BY DEFINITION of the role, regardless of who holds it):
     ✓ MUN mentor           → "developing public speaking, diplomacy, and negotiation skills"
     ✓ MUN Chair role       → "moderating committee sessions, facilitating structured debate"
     ✓ SWE Intern on prod   → "participating in code review and sprint planning across the platform team"
     ✓ 15-member Project Lead at 450-delegate MUN → "coordinating cross-functional efforts across substantive, hospitality, and external-affairs verticals"
     ✓ Marketing Intern     → "collaborating with the brand and creative teams on content-calendar planning"
     ✓ Data Analyst intern  → "translating business requirements into repeatable data models with functional stakeholders"

   UNSAFE (specific factual claims — CANNOT invent, must be in student's input):
     ✗ Invented NUMBERS not in input        (400 → 500; 15 → 25; ₹3L → ₹5L)
     ✗ Named TOOLS/FRAMEWORKS not in input  ("using Robert's Rules of Order", "with Jira", "using Node.js" when the student didn't say Node.js)
     ✗ Named OUTCOMES not in input          ("won Best Delegate", "secured 8 sponsorships", "zero day-of failures")
     ✗ Named AUDIENCES not in input         ("presented to MEA officials", "briefed the VP of Engineering")
     ✗ Named INTERACTIONS not in input      ("collaborated with SME advisors", "reported to CTO")

   THE BRIGHT LINE: role-DEFINING qualities (what the ROLE IS) are SAFE. Person-SPECIFIC instances (what THIS student did) require input evidence. If in doubt whether an elaboration is definitional or specific, PREFER the safer phrasing (a domain-quality noun over a named framework/tool).

   METRIC-RICH INPUT — polish path only:
   If the student's raw input for a specific entry already contains ≥1 quantified fact (any number, %, currency amount, scale like "50K/day"), the elaboration is OPTIONAL — the priority is (a) action-verb-first, (b) grammar polish, (c) preserved metric bolded. Add role-inherent context ONLY if there is headroom under 280 chars. NEVER sacrifice a metric to add elaboration.

   JD-RELEVANCE PRIORITY (when picking an elaboration angle):
   When multiple role-inherent angles are available, pick the one that aligns with the JD's key_responsibilities or top_prioritized_skills. Example — for a Data Analyst JD, an MUN Sec-Gen bullet should elaborate with "cross-functional stakeholder management" (JD-relevant angle) rather than "diplomacy skills" (role-inherent but off-target for this JD). If no JD signal aligns, pick the role-inherent angle most native to the role.

   WORKED EXAMPLES (Input → Elaborated Output — these are the SHAPES; do not copy text):

   Experience (metric-rich → polish path):
     Input: "SWE Intern at Razorpay, May-Jul 2025, built a payment retry service that reduced failed transactions by 18% on 50K daily transactions"
     Output bullet: "Engineered a payment retry service at Razorpay handling **50K daily transactions** — **18% reduction** in failed retries across production traffic."
     Optional 2nd bullet (role-inherent): "Participated in code review and sprint planning cycles across the payments platform team."

   Experience (terse → elaboration path):
     Input: "Content Marketing Intern at Zomato for 3 months"
     Output bullet 1: "Contributed as Content Marketing Intern at Zomato over a **3-month** term, authoring campaign copy for brand-marketing initiatives."
     Output bullet 2: "Collaborated with the brand and creative teams on content-calendar planning and pre-launch reviews."

   Project (rich input, README present):
     Input: "Built DevHab — a gamified habit-tracker with streaks and a leaderboard. 300 signups. 1200 habits tracked."
     Output bullet 1: "Built DevHab, a gamified habit-tracker with streaks and a leaderboard — **300+ signups**, **1200+ habits tracked**."
     Output bullet 2: "Designed the loop-completion reward system driving repeated engagement across the launch cohort."
     Output bullet 3: "Modeled the streak-recovery flow to sustain engagement when users missed daily targets."

   Project (terse input):
     Input: "Made a resume builder chatbot on WhatsApp using OpenAI"
     Output bullet: "Architected a WhatsApp-native resume builder on top of the OpenAI API, delivering ATS-optimized PDF resumes through an end-to-end conversational pipeline."

   PoR (matches recruiter-tier polish):
     Input: "Mentored 400 students in MUN workshops"
     Output bullet: "Mentored **400+ students** across Model United Nations workshops, developing public speaking, diplomacy, and negotiation skills for competitive committee simulations."

     Input: "Vice Chair at two MUN conferences and Chair at one"
     Output bullet: "Appointed as Vice Chair for two MUN conferences and Chairperson for one, moderating committee sessions and facilitating structured debate across delegates."

     Input: "Led 15-member team as Project Lead at MUN, 450 delegates, ₹3L budget"
     Output bullet 1: "Directed a **15-member core team** to execute Rajasthan's largest student MUN — **450+ delegates**, **₹3L+ budget**."
     Output bullet 2: "Coordinated cross-functional efforts across substantive, hospitality, and external-affairs verticals in the lead-up to the conference."
     Output bullet 3: "Facilitated stakeholder alignment across sub-committee leads under a fixed conference timeline."

   Notice in the outputs above:
     • Every input fact/metric is PRESERVED VERBATIM (metrics bolded).
     • Elaboration adds ROLE-INHERENT context (what ANYONE in that role does).
     • NO invented numbers, NO unnamed tools, NO unnamed outcomes.
     • Every bullet stays under 280 characters.

   FORBIDDEN PATTERNS that violate the mandate:
     ✗ Copying the student's input verbatim without folding in role-inherent context — this is the anti-pattern the mandate exists to fix.
     ✗ Adding elaboration that names a specific tool/framework/outcome the student did NOT state, even when it would be "typical" for the role.
     ✗ Padding with soft adjectives ("effectively", "successfully", "diligently", "meticulously") to inflate length — those ARE the anti-pattern.
     ✗ Exceeding 280 chars per bullet — density kills readability.

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

   *** PROJECT bullets — README MINING (critical, new 2026-07-13) ***
   For any project whose input contains a \`readme_excerpt\` field, treat that README text as VERIFIABLE primary-source material from the student's own repo — mine it aggressively for bullet content. The extractor already tried once but rewrote sparingly; you now have the full excerpt and can author DEEPER bullets. Specifically:
     - Look for named ARCHITECTURE DECISIONS (star schema, ETL pipeline, event-driven, JSON Schema contract, streaming pipeline, RAG, etc.) — surface them in a bullet.
     - Look for named KEY FEATURES that make the project distinctive (validation gate, re-forecast slider, HITL loop, kill-switch, dedupe lock, etc.).
     - Look for CONCRETE NUMBERS in the README (row counts, validation counts, test coverage %, users, forecast horizon, cost per unit) — these ARE fact-material; use them, bolded with \`**...**\`.
     - Look for the DOMAIN insight or debunking (e.g. "the industry's September peak assumption was actually -8% below annual avg").
   NEVER fabricate numbers absent from the README. Every metric in a bullet must trace back to either the README text or the student's own messages.

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
   - Consulting: Advised, Structured, Diagnosed, Mapped, Presented, Facilitated, Modeled
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
JD-AWARE SKILLS PRIORITIZATION (new 2026-07-13):
═══════════════════════════════════════════════════
Look at the JD-prioritized skills list in the JD profile above. Within each of the student's skill CATEGORIES, REORDER items so that JD-prioritized skills come FIRST. Example — student has Python, R, SQL, Excel in "Languages" and JD prioritizes SQL + Excel: output "SQL, Excel, Python, R". Never REMOVE a skill the student listed, and NEVER ADD a skill the student did not list. Ordering only.

You MAY rename or merge category labels to read sharply for the target role (e.g. "Other" → "ML / AI" or "Tools / DevOps"), and order CATEGORIES strongest-first for THIS JD. Never emit a category labelled "Other" / "Misc".

═══════════════════════════════════════════════════
${jdContext}
═══════════════════════════════════════════════════

INPUT resume_json (each project may have a readme_excerpt with primary-source project material):
${JSON.stringify(cleanedResume, null, 2)}

OUTPUT SCHEMA (return JSON only, this exact shape — SUMMARY MUST BE EMPTY STRING):
{
  "name": string,
  "email": string,
  "phone": string | null,
  "linkedin": string | null,
  "github": string | null,
  "leetcode": string | null,
  "coding_profiles": [{ "platform": string, "url": string | null, "stat": string | null }],
  "summary": "",
  "education": [{ "degree": string, "college": string, "branch": string | null, "location": string | null, "dates": string | null, "cgpa": string | null, "coursework": string | null }],
  "skills": [{ "category": string, "items": [string] }],
  "experience": [{ "role": string, "company": string, "location": string | null, "dates": string | null, "tech_stack": [string], "bullets": [string] }],
  "projects": [{ "name": string, "tech_stack": [string], "dates": string | null, "github_url": string | null, "demo_url": string | null, "bullets": [string] }],
  "por": [{ "role": string, "organization": string, "dates": string | null, "bullets": [string] }],
  "certifications": [{ "name": string, "url": string | null }],
  "achievements": [string]
}

Bullets are PLAIN STRINGS — include the \`**...**\` markdown markers around the metric inside the string. Example: "Architected an ETL pipeline ingesting 5 sources — **12,828 rows, 20/20 validation**."

CONTACT FIELDS (name, email, linkedin, github, leetcode, coding_profiles, phone): echo them unchanged — they are re-attached verbatim downstream regardless, so do not alter URLs or counts.

Sections the student left empty: keep as empty array (not null, not omitted).

Do NOT copy the readme_excerpt field to the output — it is fact-material for you, not a resume field.`;

  const result = await complete({ system, user: 'rewrite the body now (leave summary empty)', maxTokens: 2400, temperature: 0.2 });

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
    // Strip readme_excerpt / repo_description / repo_languages if the LLM
    // accidentally echoed them into the output projects — they are input-side
    // metadata, not resume content.
    if (Array.isArray(result.data.projects)) {
      result.data.projects = result.data.projects.map((p) => {
        if (!p) return p;
        const { readme_excerpt, repo_description, repo_languages, ...clean } = p;
        return clean;
      });
    }

    // Force empty summary — Pass 2 will fill it.
    result.data.summary = '';

    // Competitive-programming achievement synthesis (unchanged from single-pass).
    const withStats = result.data.coding_profiles.filter((c) => c && c.platform && c.stat);
    if (withStats.length > 0) {
      const parts = withStats.map((c) => `${c.platform}: **${c.stat}**`);
      const bullet = `Competitive programming — ${parts.join('; ')}.`;
      if (!Array.isArray(result.data.achievements)) result.data.achievements = [];
      const already = result.data.achievements.some((a) => /competitive programming/i.test(String(a)));
      if (!already) result.data.achievements.unshift(bullet);
    }

    // Elaboration mandate observability (2026-07-16). Logs bullets outside the
    // 60-280 char target window so we can tune the prompt if the LLM drifts.
    checkElaborationBounds(result.data);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// PASS 2: summary rewrite.
// Takes the POLISHED BODY + JD intel and authors ONLY the summary field.
// Opens with the JD role_noun. Leads with the strongest body fact aligned to
// that role's angle (not the strongest fact overall). Impersonal voice.
// ─────────────────────────────────────────────────────────────────────────
async function rewriteSummary({ body, jdIntel, jdText, jdRole, jdGeneric, rawResume }) {
  if (!body) return { data: { summary: '' } };

  const jdContext = buildJdContextBlock({ jdIntel, jdText, jdRole, jdGeneric, jdKeywords: jdIntel ? jdIntel.keywords : [] });
  const roleNoun = jdIntel && jdIntel.role_noun && jdIntel.role_noun !== 'candidate' ? jdIntel.role_noun : (jdRole || null);

  // Distil the body to what actually matters for summary authoring — the
  // polished bullets, the strongest skills, the strongest project names.
  // Keeps the prompt tight and forces the LLM to reason from the body, not
  // re-derive from the raw input.
  const distilled = {
    name: body.name,
    education: (body.education || []).map((e) => ({ degree: e.degree, college: e.college, branch: e.branch, dates: e.dates, cgpa: e.cgpa })),
    skills: body.skills,
    experience: (body.experience || []).map((e) => ({ role: e.role, company: e.company, dates: e.dates, bullets: e.bullets })),
    projects: (body.projects || []).map((p) => ({ name: p.name, tech_stack: p.tech_stack, bullets: p.bullets })),
    por: (body.por || []).map((p) => ({ role: p.role, organization: p.organization, bullets: p.bullets })),
    achievements: body.achievements || [],
  };

  const system = `You are a senior resume editor. You have the POLISHED BODY of a resume in front of you plus the JD's structured profile. Your one job: author the SUMMARY (2-4 lines) that will sit at the top.

CORE RULES (non-negotiable):

1. **OPEN WITH THE JD's ROLE NOUN.** ${roleNoun ? `The FIRST WORDS of the summary MUST be "${roleNoun}" (verbatim) or a very close synonym, followed by "skilled in / who / with…" and the strongest supporting body facts.` : 'Open with a role noun that reflects what the student built, not a generic student descriptor.'} This is critical — the JD is targeting this role, and the recruiter scans the first line for a match. If the JD says "Data Analyst" and the body's strongest single fact is a large MUN, the opener is STILL "Data Analyst who…" and the MUN goes in the supporting clause. Never invert this.

2. **IMPERSONAL voice.** Never write the student's name. Never use "I / my / me". Never use third-person pronouns (he/she/they). Lead with the role noun or a skill phrase. Every reference resume shape is impersonal — copy the shape:
   - "Data analyst skilled in Looker and BigQuery who reduced query runtime from 40s to 6s…"
   - "Backend engineer who shipped a payment retry service handling 50K daily transactions…"

3. **THREE-PART SHAPE**: claim → mechanism → result. Optionally close with a thesis line ("Every system has real numbers, not adjectives, behind it.") ONLY when the body actually supports it. Bullet-drop the summary; make each sentence carry weight.

4. **METRIC DENSITY**: every claim has a number behind it where the body has one. Pull the strongest numbers from the polished bullets (bolded metrics you can quote). Do NOT invent numbers. If the strongest body fact has no number, phrase it as a named artifact rather than a hollow adjective.

5. **BANNED OPENERS** (auto-reject if you write one): "B.Tech student passionate about", "Final-year student interested in", "Aspiring [role] with a passion for", "Highly motivated individual", "Enthusiastic learner", "Driven student", "Student pursuing…". PREFER: open with the JD role noun + concrete strongest fact.

6. **BAN OF UNSUPPORTED CLAIMS**: only claims backed by the polished body are permitted. If the body doesn't have a project in the JD's domain, don't PRETEND one exists. The rule is honest opening, not aspirational opening.

7. **LENGTH**: 2-4 lines. Aim for 3. Dense with facts, not adjectives.

═══════════════════════════════════════════════════
${jdContext}
═══════════════════════════════════════════════════

POLISHED BODY (this is your only source of truth for facts; you MAY quote metrics that appear in the bullets, bolded with \`**...**\`):
${JSON.stringify(distilled, null, 2)}

Return JSON exactly:
{ "summary": string }

Nothing else. No prose, no code fence.`;

  const result = await complete({ system, user: 'author the summary now', maxTokens: 500, temperature: 0.25 });

  if (!result.data || typeof result.data.summary !== 'string') {
    return { data: { summary: '' }, usage: result.usage };
  }
  return { data: { summary: result.data.summary.trim() }, usage: result.usage };
}

// ─────────────────────────────────────────────────────────────────────────
// Back-compat facade for any caller that still expects a single rewriteResume
// call producing the whole resume. Runs Pass 1, then Pass 2, and stitches
// the summary into the body. Preserves the old return shape { data, usage }.
// ─────────────────────────────────────────────────────────────────────────
async function rewriteResume({ resumeJson, jdRole, jdText, jdKeywords, jdGeneric, jdIntel, phoneFrom }) {
  const bodyRes = await rewriteBody({ resumeJson, jdIntel, jdRole, jdText, jdKeywords, jdGeneric, phoneFrom });
  if (!bodyRes.data) return bodyRes;

  const sumRes = await rewriteSummary({
    body: bodyRes.data,
    jdIntel, jdText, jdRole, jdGeneric,
    rawResume: resumeJson,
  });
  bodyRes.data.summary = (sumRes.data && sumRes.data.summary) || '';
  return bodyRes;
}

module.exports = { rewriteResume, rewriteBody, rewriteSummary };
