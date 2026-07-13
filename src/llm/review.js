// ATS Reviewer agent. Final stage of the multi-agent pipeline (2026-07-13).
//
// Takes the polished resume + JD Intelligence profile + raw student input.
// Produces 2-4 CONCRETE, ACTIONABLE improvement suggestions that go into the
// preview under "To improve with your edits". These drive edit-loop adoption
// which drives conversion.
//
// What the reviewer catches that the deterministic scorer cannot:
//   • JD-specific missing keywords the student COULD honestly include (e.g.
//     Excel for a KPMG Data Analyst role; SAP for a Big-4 finance role).
//     Deterministic scorer sees the current match rate but doesn't know what
//     the JD emphasises.
//   • Generic verbs ("worked on", "helped with") that survived the rewrite.
//   • Bullets thin on metrics that could have been asked for.
//   • Missing sections a JD strongly implies (a Data Analyst resume with no
//     projects listed but a rich GitHub — flag it).
//
// What the reviewer must NEVER do:
//   • Suggest inventing metrics ("say you led a team of 10").
//   • Suggest claiming skills the student didn't mention.
//   • Suggest structural rewrites (that's the rewriter's job).
//   • Produce more than 4 suggestions (too many = ignored).
//
// Failure mode: return { suggestions: [] } and let the deterministic scorer's
// suggestions carry the preview. Never throws.
const { complete } = require('./client');
const logger = require('../logger');

async function reviewResume({ rewritten, jdIntel, rawResume }) {
  if (!rewritten) return { suggestions: [] };

  // Build a compact view of what's on the resume — full JSON is too heavy for
  // a review pass. Skills + counts + first-bullet-of-each-entry are enough for
  // the reviewer to spot the common gaps.
  const summary = {
    role_noun_target: jdIntel && jdIntel.role_noun,
    role_domain: jdIntel && jdIntel.domain,
    jd_prioritized_skills: (jdIntel && jdIntel.top_prioritized_skills) || [],
    jd_keywords: (jdIntel && jdIntel.keywords) || [],
    jd_key_responsibilities: (jdIntel && jdIntel.key_responsibilities) || [],
    resume_summary: rewritten.summary || '',
    resume_skills: rewritten.skills || [],
    resume_experience_count: (rewritten.experience || []).length,
    resume_experience_first_bullets: (rewritten.experience || []).map((e) => (e.bullets || [])[0]).filter(Boolean),
    resume_projects: (rewritten.projects || []).map((p) => ({ name: p.name, tech_stack: p.tech_stack, first_bullet: (p.bullets || [])[0], bullet_count: (p.bullets || []).length })),
    resume_por_count: (rewritten.por || []).length,
    resume_certifications: (rewritten.certifications || []).map((c) => c.name),
    resume_achievements_count: (rewritten.achievements || []).length,
  };

  // Skills the student actually has (for the "honestly could include" logic).
  const flatSkills = new Set();
  for (const cat of Array.isArray(rewritten.skills) ? rewritten.skills : []) {
    for (const item of cat.items || []) flatSkills.add(String(item).toLowerCase().trim());
  }
  const flatSkillsList = [...flatSkills];

  const system = `You are a senior recruiter reviewing a candidate's resume against a target JD. You produce TWO things:

  (A) 2-4 SHORT, CONCRETE improvements the candidate can apply through the free-text edit loop. Shown as "To improve with your edits".
  (B) 4-5 INTERVIEW HOT TOPICS specific to THIS candidate's resume + this JD. Shown as "Prep for interview".

CRITICAL RULES:

1. **NO SUGGESTIONS THAT REQUIRE INVENTION.** You may say "if you also know Excel, add it to your Data & BI skills — the JD asks for it" because Excel is likely a real skill for a Data Analyst candidate. You may NEVER say "add that you led a team of 10" or "add that you increased revenue by 30%" — those would be fabricated.

2. **JD-ANCHORED.** Every suggestion should reference why it matters for THIS JD. Example: "The JD emphasizes stakeholder communication — add one bullet to your MUN role explicitly naming presentations to committee directors" (good — anchored). NOT "make bullets more impactful" (bad — vague).

3. **ACTIONABLE THROUGH CHAT.** The student will apply your suggestion by sending a natural-language edit to the bot ("add Excel to my Data & BI skills"; "add a bullet about presenting to 15 committee directors"). Suggestions like "reformat entire projects section" are NOT actionable in one edit — skip.

4. **BE SPECIFIC.** Wrong: "add more metrics." Right: "The 'Guar Export' project mentions ₹ but no percentage — if you know the accuracy or the tonnage volume you analysed, add it."

5. **NEVER RECOMMEND ADDING A SKILL / TOOL / RESPONSIBILITY the student clearly does not have.** If the JD wants SAS and the student's stack is 100% Python/Streamlit/Power BI with no SAS anywhere, do NOT suggest adding SAS. That would push them to lie.

6. **PRIORITIZE:**
   a. Missing JD keywords the student PLAUSIBLY has (Excel, PowerPoint, communication with stakeholders).
   b. Thin bullets that could be enriched with facts that likely exist (e.g. project without user count → "if you have signup or user numbers, add them").
   c. Generic language that survived the rewrite ("enhanced participant engagement" → "if you have a specific outcome metric, replace this with it").
   d. Section imbalance (2 projects for a 0-2 yr Data Analyst role is fine; 0 projects with a GitHub link is a gap — flag).

7. **VOICE:** short, direct, conversational — the bot will paste them into WhatsApp. 12-25 words each. No preamble. No "You should…" — start with an imperative or a noun.

═══════════════════════════════════════════════════
JD + RESUME SNAPSHOT:
═══════════════════════════════════════════════════
${JSON.stringify(summary, null, 2)}

Skills the student explicitly listed (do NOT suggest anything outside these unless it's a universally-assumed skill for the role like Excel for a Data Analyst):
${flatSkillsList.join(', ') || '(none)'}

═══════════════════════════════════════════════════
PART B — INTERVIEW HOT TOPICS (new 2026-07-13)
═══════════════════════════════════════════════════
Produce 4-5 CONCRETE topics the recruiter or interviewer is likely to probe THIS specific candidate on, given THIS specific resume AND JD. Different resumes → different topics. Rules:

  1. **Anchor to real content on the resume.** If the candidate has a SARIMAX forecasting project, "time-series forecasting: stationarity, ARIMA vs SARIMAX, MAPE tuning" is a hot topic. If they have a payment retry service, "idempotency, exactly-once semantics, exponential backoff design" is a hot topic. If they have MUN leadership, "stakeholder management under budget pressure" is a hot topic. Never generic ("data structures", "system design") — always tied to something the candidate ACTUALLY did.
  2. **Weighted toward the JD's role and domain.** For a Data Analyst KPMG-consulting JD, prep is heavier on stakeholder communication + SQL + Excel + business framing; for a Backend Engineer JD, heavier on scale/latency/architecture; etc.
  3. **Actionable prep angle in ONE line.** For each topic, phrase as "Topic name — the specific angle to prep." Example: "Time-series forecasting — walk through your SARIMAX choice, why not ARIMA/Prophet, and how you'd interpret a MAPE of 25%."
  4. **Never invent capability.** If the candidate has NOT shown proficiency in a topic, don't include it. Do NOT tell them to "prep system design" if their resume shows no system-design work.
  5. **Length:** 15-30 words per topic. Total 4-5 topics.

═══════════════════════════════════════════════════

Return JSON exactly:
{
  "suggestions":     [string, 2-4 items],
  "interview_topics":[string, 4-5 items]
}

Zero suggestions is ALSO valid if the resume genuinely leaves nothing to improve — return an empty array for suggestions. But interview_topics should ALWAYS be populated (there is always SOMETHING an interviewer will probe on).`;

  try {
    const result = await complete({ system, user: 'produce suggestions AND interview topics now', maxTokens: 900, temperature: 0.3 });
    const data = result.data || {};
    const suggestions = Array.isArray(data.suggestions)
      ? data.suggestions.slice(0, 4).map((s) => String(s).trim()).filter((s) => s.length > 8 && s.length < 300)
      : [];
    const interview_topics = Array.isArray(data.interview_topics)
      ? data.interview_topics.slice(0, 5).map((s) => String(s).trim()).filter((s) => s.length > 8 && s.length < 300)
      : [];
    logger.info({ suggestionCount: suggestions.length, topicCount: interview_topics.length }, 'reviewer produced suggestions + interview topics');
    return { suggestions, interview_topics, usage: result.usage };
  } catch (e) {
    logger.warn({ err: e.message }, 'reviewer failed — falling back to deterministic suggestions only');
    return { suggestions: [], interview_topics: [] };
  }
}

module.exports = { reviewResume };
