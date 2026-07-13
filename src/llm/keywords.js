// JD Intelligence agent.
//
// Was a plain keyword extractor (PRD §7.4). Upgraded 2026-07-13 to a first-
// class "JD intelligence" pass that also produces the role_noun the summary
// should lead with, the top JD-prioritized skills, the business domain, and
// the key responsibilities. Everything downstream (body rewrite, summary
// rewrite, reviewer) consumes this JD profile — one intelligence pass, many
// specialized consumers, instead of every stage re-parsing the JD.
//
// Three input modes:
//   1. jdText present → parse the JD text end-to-end.
//   2. jdRole only    → infer a typical profile for that role at fresher level.
//   3. jdGeneric      → empty profile; downstream uses transferable framing.
const { complete } = require('./client');
const logger = require('../logger');

// Empty-but-typed profile so downstream code never has to null-check.
function emptyIntel(role) {
  return {
    keywords: [],
    role_noun: role || 'candidate',
    role_title: role || 'unknown',
    domain: 'generic',
    experience_level: 'fresher',
    key_responsibilities: [],
    top_prioritized_skills: [],
  };
}

async function extractKeywords({ jdText, jdRole, jdGeneric }) {
  if (jdGeneric) return { ...emptyIntel('generic'), role_title: 'generic' };

  let source;
  let mode;
  if (jdText) {
    source = `JD TEXT:\n"""${jdText.slice(0, 3500)}"""`;
    mode = 'from_jd_text';
  } else if (jdRole) {
    source = `ROLE TITLE: "${jdRole}"
No JD text was provided. Infer a realistic profile for a typical "${jdRole}" role at fresher / junior level in the Indian market — the tools an ATS would look for, the domain, the responsibilities. Don't bias toward software unless the role is software.`;
    mode = 'from_role_name';
  } else {
    return emptyIntel();
  }

  const system = `You are a hiring-side analyst extracting a structured intelligence profile from a job description. Downstream, a resume rewriter will use this profile to (a) lead the summary with the correct role noun, (b) order the candidate's skills by JD relevance, (c) mine the candidate's projects for JD-aligned angles, and (d) let a reviewer flag missing keywords. Be specific and honest — no filler.

═══════════════════════════════════════════════════
${source}
═══════════════════════════════════════════════════

Return JSON exactly in this shape (no extra keys, no prose):

{
  "keywords": [string, max 15],
  "role_noun": string,
  "role_title": string,
  "domain": string,
  "experience_level": "fresher" | "junior" | "mid" | "senior",
  "key_responsibilities": [string, 3-5 items],
  "top_prioritized_skills": [string, 5-10 items]
}

Field guidance:

- **keywords** — the top 15 HARD SKILLS an ATS would scan for. Programming languages, specific tools, frameworks, libraries, platforms, industry software (AutoCAD, SAP, HubSpot, SAS, Excel, Power BI, Tableau, dbt, etc.), certifications, methodologies. **Include Excel explicitly if a Data Analyst / Analyst / Consulting role** — it is almost always required and often not stated in JDs because it is assumed. EXCLUDE soft skills, years-of-experience phrases, "good fit" language.

- **role_noun** — the SHORT NOUN the resume summary should open with. Copy the JD's own words. Examples: "Data Analyst" (not "Someone who analyzes data"), "Business Analyst", "Financial Analyst", "Software Engineer", "Marketing Associate", "Consultant", "Full-Stack Developer". Two words max where possible. This is what will literally appear as the first word(s) of the resume summary. Get it right.

- **role_title** — the FULL title as written in the JD (e.g. "Data Analyst — Consulting, KPMG India").

- **domain** — the business domain / industry. Examples: "big-four consulting and audit", "commercial banking", "e-commerce", "SaaS", "IT services", "manufacturing", "pharmaceutical", "government". Be specific — this drives the tone of the rewrite.

- **experience_level** — "fresher" (0 yr), "junior" (0-2 yr), "mid" (3-5 yr), "senior" (6+ yr). Look for the "years of experience" phrase in the JD.

- **key_responsibilities** — 3-5 short verb-led phrases from the JD describing what the person will actually DO. Examples: "Build client-facing dashboards in Power BI", "Analyze large financial datasets", "Present findings to stakeholders". These will get echoed in the summary and referenced by the reviewer.

- **top_prioritized_skills** — order the 5-10 skills the JD emphasizes MOST STRONGLY — not just present, but core to daily work. Order matters (top-of-list = most important). Used to reorder the candidate's own skill list to lead with JD-aligned tools. Include Excel/SQL/Power BI if this is a data role; include client-communication skills if it's a consulting role; etc.

Rules:
- Do NOT invent skills that a real JD for this role would not include.
- For non-software roles, keywords must reflect that domain (SAP for finance, AutoCAD for civil, SAS for insurance stats, etc.) — never default to a software stack.
- role_noun MUST match how a real recruiter refers to the role. "Data Analyst" not "Data Analysis Person". No adjectives, no "aspiring", no "junior" (that's experience_level's job).`;

  try {
    const result = await complete({ system, user: 'extract JD intelligence profile now', maxTokens: 900 });
    const data = result.data || {};
    // Sanitise + cap.
    const intel = {
      keywords: Array.isArray(data.keywords) ? data.keywords.slice(0, 15).map(String) : [],
      role_noun: String(data.role_noun || jdRole || 'candidate').trim(),
      role_title: String(data.role_title || jdRole || 'unknown').trim(),
      domain: String(data.domain || 'generic').trim(),
      experience_level: ['fresher', 'junior', 'mid', 'senior'].includes(data.experience_level)
        ? data.experience_level : 'fresher',
      key_responsibilities: Array.isArray(data.key_responsibilities)
        ? data.key_responsibilities.slice(0, 5).map(String) : [],
      top_prioritized_skills: Array.isArray(data.top_prioritized_skills)
        ? data.top_prioritized_skills.slice(0, 10).map(String) : [],
    };
    logger.info({
      mode, roleNoun: intel.role_noun, domain: intel.domain,
      kwCount: intel.keywords.length, responsibilityCount: intel.key_responsibilities.length,
    }, 'jd intel extracted');
    return intel;
  } catch (e) {
    logger.warn({ err: e.message }, 'jd intel extraction failed; returning empty profile');
    return emptyIntel(jdRole);
  }
}

module.exports = { extractKeywords };
