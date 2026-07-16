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
    instruction: `Extract the LinkedIn profile URL. Accept variants like "linkedin.com/in/foo" — normalize to full "https://linkedin.com/in/foo".

DECLINE HANDLING (CRITICAL — LinkedIn is OPTIONAL). If the message shows ANY sign that the student doesn't want to / can't share right now — English or Hinglish or short-form — set linkedin=null AND clarification_needed=null so the flow ADVANCES. Do NOT ask again, do NOT offer to wait, do NOT say "share when you can". Advance the flow.
Decline examples that MUST return {linkedin:null, clarification_needed:null}:
- "skip", "no", "nahi", "nope", "none"
- "abhi nahi", "abhi share ni krskti", "share nahi kar sakti", "share nahin kar sakta", "later batungi", "baad me batungi", "next time"
- "don't have", "nahi hai", "koi nahi", "not on linkedin", "linkedin nahi hai"
- "can't share right now", "not right now", "later", "abhi ni"

ONLY set clarification_needed when the student's message is truly ambiguous (e.g. a bare "?", "kya", "matlab") — never for a decline.`,
    shape: '{ "linkedin": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => { rj.linkedin = x.linkedin || null; },
  },

  AWAITING_GITHUB: {
    instruction: `Extract the GitHub profile URL. Accept "github.com/foo" — normalize to "https://github.com/foo".

DECLINE HANDLING (CRITICAL — GitHub is OPTIONAL). If the message shows ANY sign that the student doesn't want to / can't share right now — English or Hinglish or short-form — set github=null AND clarification_needed=null so the flow ADVANCES. Do NOT ask again, do NOT offer to wait, do NOT say "share when you can". Advance the flow.
Decline examples that MUST return {github:null, clarification_needed:null}:
- "skip", "no", "nahi", "nope", "none"
- "abhi nahi", "abhi share ni krskti", "share nahi kar sakti", "later batungi", "baad me", "next time"
- "don't have", "nahi hai", "koi nahi", "github nahi hai", "not on github"
- "can't share right now", "not right now", "later"

ONLY set clarification_needed when the student's message is truly ambiguous — never for a decline.`,
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
    // Merge by platform (case-insensitive). Previous version REPLACED the whole
    // array every turn, so a student who said "leetcode 500" on turn 1 then
    // added "codeforces 1600" on turn 2 lost the leetcode entry. Same bug class
    // as education merge (fixed 2026-07-16).
    merge: (rj, x) => {
      const incoming = Array.isArray(x.coding_profiles)
        ? x.coding_profiles.filter((c) => c && c.platform && (c.url || c.stat))
        : [];
      if (!Array.isArray(rj.coding_profiles)) rj.coding_profiles = [];
      const key = (p) => String(p).trim().toLowerCase();
      const byPlatform = new Map(rj.coding_profiles.map((c) => [key(c.platform), c]));
      for (const c of incoming) {
        const k = key(c.platform);
        if (byPlatform.has(k)) {
          const existing = byPlatform.get(k);
          if (c.url && !existing.url) existing.url = c.url;
          if (c.stat && !existing.stat) existing.stat = c.stat;
        } else {
          rj.coding_profiles.push(c);
          byPlatform.set(k, c);
        }
      }
    },
  },

  AWAITING_EDUCATION: {
    instruction: `Extract degree, college name, branch/major, and expected year of passing. Examples: degree "B.Tech" or "BCA" or "B.E."; branch "Computer Science", "Mechanical", "Data Science"; year "2026" or "Expected 2026". Use null for any field not stated. Do not invent.

MULTI-TURN CONTEXT (CRITICAL): the student is answering across multiple messages. Check the current_resume_json.education[0] above — if a field is ALREADY FILLED there, DO NOT ask for it again. Only ask for genuinely-missing fields.

SUFFICIENCY: once education[0] has BOTH college AND degree (branch and year are nice-to-have but not required to advance), set clarification_needed=null so the flow moves on. Do NOT keep asking for branch or year if the student has given college + degree.`,
    shape: '{ "education": { "degree": string | null, "college": string | null, "branch": string | null, "expected_year": string | null }, "clarification_needed": string | null }',
    merge: (rj, x) => {
      // CRITICAL: only copy NON-NULL fields. Previous Object.assign wiped
      // already-collected fields to null on every turn (real bug 2026-07-16:
      // student gave college on turn 1, degree on turn 2, and the degree-turn
      // merge overwrote college with null → bot re-asked for college forever).
      if (!rj.education) rj.education = [];
      if (!rj.education[0]) rj.education.push({});
      const src = x.education || {};
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (v != null && String(v).trim() !== '') rj.education[0][k] = v;
      }
    },
  },

  AWAITING_CGPA: {
    instruction: `Extract the academic score. Could be CGPA ("8.5", "9.2/10") or percentage ("85%"). Keep the original format the student used.

DECLINE HANDLING (CRITICAL — CGPA is OPTIONAL). Many freshers are between semesters, don't want to share, or just don't have a current score. If the message shows ANY sign of decline / deferral — English or Hinglish or short-form — set cgpa=null AND clarification_needed=null so the flow ADVANCES. Do NOT ask again, do NOT offer to wait, do NOT say "when you have it".
Decline examples that MUST return {cgpa:null, clarification_needed:null}:
- "skip", "no", "nahi", "nope", "none"
- "abhi nahi", "abhi results ni aaye", "results pending", "still awaiting", "1st sem hai", "abhi tak nahi mila"
- "later", "baad me batungi", "next time", "for now"
- "don't want to share", "share nahi karna", "personal", "nahi bataunga"
- "N/A", "not applicable", "haven't calculated"

ONLY set clarification_needed when the message is truly ambiguous (a bare "?" / "kya" / "matlab") — never for a decline or deferral.`,
    shape: '{ "cgpa": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!rj.education) rj.education = [];
      if (!rj.education[0]) rj.education.push({});
      if (x.cgpa) rj.education[0].cgpa = x.cgpa;
    },
  },

  // Optional coursework collection — single line; merges into education[0].coursework.
  AWAITING_COURSEWORK: {
    instruction: `Extract a coursework string from whatever the student names.

LIBERAL ACCEPTANCE — NEVER GATEKEEP. Anything the student types that names a course, topic, framework, or technical area COUNTS as coursework. Examples of valid replies that you MUST accept on the first turn:
- Classical course names: "DSA", "DBMS", "Operating Systems", "Computer Networks", "Discrete Math"
- Domain topics: "ML", "Deep Learning", "Statistics", "Linear Algebra", "Data Structures"
- Modern frameworks/tools named as study areas: "Fast API", "Prompt Engineering", "LangChain", "Spark", "Kafka", "ETL"
- Mixed lists: "Tools - power bi, eda" or "Prompt engineering, FastAPI, LangChain"
Title-case each item where reasonable. Preserve the student's separator if any. Comma-join if they used line breaks. Do NOT ask for "specific coursework" — whatever they said IS the coursework. The friend-test 2026-06-25 looped on "Fast API" being rejected — never reject a topic just because it isn't on a canonical academic-course list.

DECLINE HANDLING (CRITICAL — COURSEWORK is OPTIONAL): if the student declines or defers, set coursework=null AND clarification_needed=null so the flow ADVANCES. Never re-ask.
Decline examples that MUST return {coursework:null, clarification_needed:null}:
- "skip", "no", "nahi", "nope", "none", "kuch nahi"
- "abhi nahi", "yaad nahi", "yaad ni", "don't remember", "pata nahi", "no specific coursework"
- "later", "baad me", "next time", "for now"
- Empty / whitespace-only replies

ONLY set clarification_needed if the message is truly ambiguous (a bare "?" / "kya matlab"). Never for a decline.`,
    shape: '{ "coursework": string | null, "clarification_needed": string | null }',
    merge: (rj, x) => {
      if (!x.coursework) return;
      if (!rj.education) rj.education = [];
      if (!rj.education[0]) rj.education.push({});
      rj.education[0].coursework = x.coursework;
    },
  },

  AWAITING_SKILLS: {
    instruction: `Group the listed skills into 3-6 NAMED categories, ordered strongest/most-relevant first. The category LABELS must be TAILORED to the SPECIFIC target role/JD above — read what that role emphasizes and name the buckets so a recruiter for THAT role sees their own priorities reflected. Generic, interchangeable labels are a wasted signal; specific ones show focus. This is how strong real resumes do it.

ROLE-TAILORING THE LABELS (this is the important part — do not skip it):
Start from the JD's focus, then name buckets around it. Prefer a SPECIFIC, role-resonant name over a bland one whenever the skills support it:
  • Backend / distributed-systems role → "Languages", "Backend & Microservices", "Databases & Caching", "Infra & DevOps", "Messaging & APIs"   (NOT plain "Frameworks" / "Tools")
  • Data / ML role → "Languages", "ML / Deep Learning", "Data & Analytics", "MLOps & Tooling"
  • Frontend role → "Languages", "Frameworks & UI", "State & Tooling", "Testing"
  • Cloud / DevOps role → "Languages & Scripting", "Cloud & Infra", "CI/CD & Containers", "Observability"
  • Security role → "Languages", "Security & Architecture", "Tooling & Recon", "Cloud & Infra"
BEFORE → AFTER (what tightening looks like):
  Backend JD, skills {Spring Boot, Node.js, gRPC, Kafka, Docker, K8s, AWS}
    weak:   "Frameworks", "Tools", "Cloud"
    strong: "Backend & Microservices" (Spring Boot, Node.js), "Messaging & APIs" (gRPC, Kafka), "Infra & DevOps" (Docker, K8s, AWS)
Only fall back to a bland generic set ("Frameworks", "Tools") when the JD is genuinely generic or the skills truly don't cluster around a theme.

HARD RULES ON LABELS:
- NEVER use the label "Other", "Misc", or "Miscellaneous" — always pick a meaningful, specific category name. If something doesn't fit, name the category for what it IS (e.g. "Concepts", "Methodologies", "Coursework").
- A label may combine two related areas with "&" or "/" (e.g. "Databases & Caching", "CI/CD & Containers") — this is encouraged when it reads cleanly.
- Include EVERY skill the student mentioned; never drop one. Preserve the student's capitalization where reasonable.
- A category with no items should simply be omitted from the array (don't emit empty categories).

THIS IS A SIMPLE LIST STEP — DO NOT INTERROGATE.
Set clarification_needed to null whenever the message contains AT LEAST ONE skill (it almost always does). A short list IS complete and sufficient. NEVER ask for metrics, impact, proficiency levels, years of experience, examples, or "more" skills — that judgement happens later in the experience/projects steps, never here. Only set clarification_needed (a brief, friendly ask for their skills) if the message contains NO skills at all — e.g. it is empty, "skip", a question, or gibberish.`,
    shape: '{ "skills": [{ "category": string, "items": [string] }], "clarification_needed": string | null }',
    // Merge by category label (case-insensitive), dedupe items case-insensitively.
    // Previous REPLACE-every-turn wiped skills when a student added more on a
    // follow-up ("also add Tableau and Power BI" → wiped Python + SQL). Same
    // bug class as education merge (fixed 2026-07-16).
    merge: (rj, x) => {
      const incoming = Array.isArray(x.skills)
        ? x.skills.filter((c) => c && c.category && Array.isArray(c.items) && c.items.length)
        : [];
      if (!Array.isArray(rj.skills)) rj.skills = [];
      const key = (s) => String(s).trim().toLowerCase();
      const byCategory = new Map(rj.skills.map((c) => [key(c.category), c]));
      for (const cat of incoming) {
        const k = key(cat.category);
        if (byCategory.has(k)) {
          const existing = byCategory.get(k);
          existing.items = existing.items || [];
          const seen = new Set(existing.items.map(key));
          for (const item of cat.items) {
            const ik = key(item);
            if (ik && !seen.has(ik)) { existing.items.push(item); seen.add(ik); }
          }
        } else {
          rj.skills.push({ category: cat.category, items: [...cat.items] });
          byCategory.set(k, rj.skills[rj.skills.length - 1]);
        }
      }
    },
  },

  // EXPERIENCE — multi-bullet, multi-angle sufficiency. Drives bullet density.
  AWAITING_EXPERIENCE: {
    instruction: `Extract internship/job experience. tech_stack = the specific tools / libraries / methods the student actually used in THIS experience (not their global skills).

DATES FORMAT (CRITICAL — resume-grade only):
- The dates field MUST be a real month+year range or a bare year — anything a recruiter would accept on a resume. Examples that ARE valid: "May 2024 - Jul 2024", "Jan 2024 - Present", "May-Jul 2024", "2023-2024", "2024".
- A DURATION is NEVER a valid dates value. If the student writes "6 months", "6 mahine", "few months", "kuch mahine", "1 saal", "3 hafte" — dates is UNKNOWN. Set dates=null and put a clarification asking for the exact start and end months: "Kab se kab tak thi — start aur end month+year batayiye (jaise 'Jan 2024 - Jul 2024')?"
- Never guess a year the student didn't give.

ROLE SPECIFICITY:
- A bare "Intern" / "Trainee" is weak — infer the domain from the bullets when possible. Student describes API/backend work → "SWE Intern" or "Backend Intern". Student describes dashboards/SQL/data → "Data Analyst Intern". Student describes designs → "Design Intern". Student describes marketing/growth → "Marketing Intern". Only fall back to plain "Intern" when there is genuinely nothing to disambiguate.


PRE-CHECK BEFORE ASKING ANYTHING — STOP RE-ASKING FOR DETAIL THE STUDENT ALREADY GAVE:
Before you set clarification_needed, scan resume_json.experience[0].bullets (the PENDING entry, accumulating across turns). If those bullets ALREADY contain ≥2 distinct numbers / metrics across angles — e.g. "500+ customers", "10 hours saved", "50% accuracy", "₹3 L budget", "12,828 rows", "p99 400ms→120ms" — the entry IS sufficient: set clarification_needed = null. Do NOT ask the student for "impact" or "result" or "metric" when several are already present in pending bullets. The student notices instantly when the bot ignores detail they already gave; that's the friend-test bug from 2026-06-25.

TERSE METRIC FOLLOW-UPS ARE THE ANSWER, NOT GARBAGE:
A terse reply like "500+ satisfied customers", "10 hours saved", "50% improved", "600 users", "2% time saved", "10% accuracy improvement" is the answer to the question you just asked. It is a NEW BULLET for the pending experience. Extract it into bullets[] EXACTLY ONCE per turn and let merge append. NEVER return bullets: [] for a metric reply because you couldn't form a "full sentence" — the rewriter will phrase it later.

DEFLECTION HANDLING (Hindi/English):
If the student replies "upar dediya", "pehle bola", "already said", "already mentioned", "mentioned above", "see above", "I told you", "ek baar bata diya" — DO NOT re-ask. Re-evaluate pending bullets per PRE-CHECK above; if any metric is present, accept and set clarification_needed = null.

SUFFICIENCY for the experience entry — ALL THREE must hold:
  (a) role + company (who/where)
  (b) **TARGET 3 bullets** in the bullets array (god-level resumes carry 3 bullets per role; 2 is the absolute floor and only acceptable after a follow-up attempt the student couldn't fill — see DECISION TREE).
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
4. **<3 bullets BUT ≥2 angles already covered**:
     Ask ONE more targeted follow-up for an ADDITIONAL outcome — DIFFERENT from what's already there. Pick what's most likely to have a number:
       - "Koi aur outcome — technical challenge solve kiya, ya doosra metric?"
       - "Aapne <X> kaha — kya isme aur kuch — adoption, retention, ya scaling number?"
     If the student gives one → add as 3rd bullet → sufficient. If the student declines or has nothing more ("bas itna hi", "kuch nahi", "no", "skip", "pata nahi") → ACCEPT with 2 bullets, set clarification_needed = null. Never push for a 3rd bullet more than ONCE.
5. Any bullet has soft qualifier without a number → ask for specific number for THAT bullet.
6. ≥3 bullets AND ≥2 angles → clarification_needed = null.

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
    // Merge targets the LAST entry in experience[] (not always index 0) so the
    // multi-entry loop in the router can push a fresh slot for "agla internship"
    // and have subsequent turns accumulate into that new entry. Single-entry
    // flows (the common case) still work — first message creates index 0 and
    // every follow-up targets index 0 as before.
    merge: (rj, x) => {
      if (!x.experience) {
        if (!rj.experience) rj.experience = [];
        return;
      }
      if (!rj.experience) rj.experience = [];
      if (rj.experience.length === 0) rj.experience.push({});
      const exp = rj.experience[rj.experience.length - 1];
      for (const k of ['role', 'company', 'location', 'dates']) {
        if (x.experience[k]) exp[k] = x.experience[k];
      }
      if (Array.isArray(x.experience.bullets) && x.experience.bullets.length > 0) {
        // Dedupe by normalised text (drop **, lower, trim) — terse follow-ups
        // sometimes re-emit existing bullets alongside the new metric.
        const norm = (s) => String(s).replace(/\*\*/g, '').trim().toLowerCase();
        exp.bullets = exp.bullets || [];
        const seen = new Set(exp.bullets.map(norm));
        for (const b of x.experience.bullets) {
          const n = norm(b);
          if (n && !seen.has(n)) { exp.bullets.push(b); seen.add(n); }
        }
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

PRE-CHECK BEFORE ASKING ANYTHING — STOP ASKING FOR DETAIL THE STUDENT ALREADY GAVE:
Before you set clarification_needed, look at BOTH the current message AND resume_json.pending_project (which accumulates across turns). Check the UNION of bullets across the pending project + any number+noun pairs in the current message. If that union already contains ≥2 distinct metrics (row counts like "12,828 rows", percentages like "92% accuracy" or "-8.0% correction", currency like "₹3 lakh budget", user/scale/latency/throughput numbers like "500+ users", validation counts like "20/20 checks", table counts like "8-table schema") AND a link is sorted (github_url, demo_url, or _link_declined), the project is SUFFICIENT — set clarification_needed = null.

Do NOT ask for "aur outcome / accuracy / users ka number" when those numbers already appear in the current message or in pending_project.bullets. This is the single most damaging bug: the student says "500+ users, 92% accuracy" in one message; on the NEXT turn (link decline) the bot asks "koi aur outcome — accuracy ya users?" — the student instantly loses trust. If you can see the number in the conversation, treat it as GIVEN.

DEFLECTION HANDLING (Hindi/English):
If the student replies with a deflection meaning "I already told you" — patterns include "upar dediya", "pehle bola", "already said", "already mentioned", "mentioned above", "see above", "check above", "ek baar bata diya", "bola na", "I told you", "pehle hi bola" — DO NOT ask CASE A ("what did you build") or CASE D again. Re-evaluate pending_project.bullets per the PRE-CHECK above. If a metric is there, accept and set clarification_needed = null. If genuinely nothing quantitative is in pending_project, ask ONCE for a specific metric naming what you can already see ("Aapne <X> kaha tha — uska number kya tha?"), never a generic "what did you build?".

EXTRACTION DENSITY — DO NOT COMPRESS RICH MESSAGES:
When a single message contains MULTIPLE distinct quantifiable facts (e.g. "12,828 rows, 8-table schema, 20/20 validation, -8.0% correction, ₹18K Cr → ₹4.7K Cr"), extract EACH as its own bullet in the bullets array, preserving the exact numbers. Do NOT merge them into one summary line that loses metrics. Five facts → five bullets (the rewriter will compress later if needed; your job is to capture them all).

CASUAL HINGLISH METRIC MINING (CRITICAL — real bug 2026-07-17):
Students often bury metrics INSIDE a casual Hinglish sentence, not as bullet-formatted items. You MUST mine EVERY number+noun pair as a separate bullet. Examples of shapes to recognize:
- "500+ users hain" → bullet: "500+ users"
- "accuracy 92%" / "92% accuracy thi" → bullet: "92% accuracy"
- "50K daily transactions handle karte the" → bullet: "50K daily transactions handled"
- "failures 18% kam kiye" → bullet: "Reduced failures by 18%"
- "10 hafte me deploy" → bullet: "Deployed in 10 weeks"
- "₹3 lakh budget" → bullet: "₹3 lakh budget"
- "3rd rank aayi thi" → bullet: "3rd rank"

WORKED EXAMPLE (Hinglish embedded metrics):
  Input: "AI chatbot banaya GPT use kiya customer support ke liye 500+ users hain accuracy 92%"
  Extract: name="AI Chatbot", tech_stack=["GPT","AI"], bullets=["500+ users", "92% accuracy", "Built for customer support"]
  → 3 bullets across 2 angles (SCALE: 500+ users; QUALITY: 92% accuracy). Link is still missing → CASE C.

If the student's message contains ANY number attached to a noun/outcome, that number belongs in bullets. NEVER discard a metric because the sentence was casual or run-on. The single most damaging bug pattern for us is asking for a metric the student already stated — it makes the bot look like it isn't listening.


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
  (c) **TARGET 3 bullets** in bullets[], AND bullets span ≥2 distinct METRIC ANGLES across:
        SCALE / VOLUME — data points, users, records, requests, dataset size, transactions
        QUALITY        — accuracy %, F1, precision, error rate, NPS, % improvement
        IMPACT         — time saved, cost saved, business outcome, latency, throughput, deployed/shipped
      God-level resumes carry 3 bullets per project. 2 is the floor and only after a follow-up attempt the student couldn't fill (see CASE F below).
  (d) a link is sorted: github_url OR demo_url is a real URL, OR pending_project._link_declined === true.
      For technical roles we PREFER github_url (we enrich from it — see CASE C), but a demo URL or an explicit decline also satisfies (d) so we never hard-loop a student who only has a live link or a private repo.

GITHUB vs LIVE LINK:
A github.com repo URL goes in github_url. A DEPLOYED / LIVE / hosted URL (vercel.app, netlify.app, a custom domain, "live link", "deployed at") goes in demo_url. A project may have BOTH — capture each in its own field. For the CASE C link ask below, either a repo link or a live link satisfies requirement (d).

LINK-DECLINE DETECTION:
If the current message contains any of: "no link", "skip link", "private", "private repo", "no repo", "not public", "github nahi", "nahi link", "link nahi", "no github" — set link_declined = true in your output. Router persists this to pending_project._link_declined.

CLARIFICATION RULES (ask ONLY ONE missing piece per turn):

CASE A — only (a) missing (message has no project content):
  Ask only for what they built. Example: "Kya banaya tha project mein? Naam aur 1-2 lines."
  CASE A APPLIES ONLY when resume_json.pending_project has NO name yet. If a pending_project WITH a name already exists, the student's message is a FOLLOW-UP to that project (a metric, link, or detail) — merge it and continue from CASE C/D/E; never reset to CASE A.

CASE B — (a) present, (b) missing:
  Ask for tech / description. Example: "Kis tech / tool se banaya? Aur kya karta hai project?"

CASE C — (a) and (b) present, github_url missing:
  Ask ONLY for a link to the work. NEVER mention impact/accuracy/metric here.
  For TECHNICAL roles (software, data, engineering — this is v1's only audience), the GitHub REPO link is the PRIMARY ask EVERY TIME, because we auto-pull the project's tech, features, and any real numbers straight from the repo so the student doesn't have to describe it all. Ask for github_url even if a demo/deployed URL is already present (a repo and a demo are different things and we enrich from the repo).

  ** DECLINE-HANDLING (2026-07-13 rule — GitHub near-compulsory):
     Meet's diagnosis: most students write vaguely about their own projects, and the README is the single richest source of bullet material. So DO NOT accept a link decline on the first ask — many students will just tap "no link" out of habit and lose all that quality. ASK TWICE.

     Look at pending_project._link_ask_count (0 by default, incremented on each decline):
       • If _link_ask_count === 0 (fresh ask, first time asking for link):
           "GitHub repo ka link bhej dijiye — main repo ke README se aapke project ki tech, features aur numbers khud nikaal lunga, aap ko sab describe nahi karna padega. Deployed/live URL bhi chalega. Agar repo genuinely private hai to 'no link' bhejo."
       • If _link_ask_count === 1 (student already declined once — SECOND ask, softer):
           "Sure? Repo public ho to bhi share kar do — bina README ke bullets 40% weaker aate hain. Koi bhi demo/deployed URL bhi chalega. Agar sach mein kuch nahi share kar sakte to 'no link' bhejo, main aage badh jaunga."

     After the SECOND decline (i.e. student says "no link" while pending_project._link_ask_count is already 1), the router will set _link_declined=true and this becomes CASE D territory. Never ask for the link a third time — trust the student.

  Pick the artifact NATIVE to the role only for NON-technical roles (not in v1 scope, but kept for safety):
    - Marketing/Content: "Is kaam ka koi link hai — live campaign, published article, ya post? 'no link' agar nahi."
    - Design: "Portfolio / Behance / Dribbble ya live link? 'no link' agar private hai."
    - Sales/Finance/Ops/other: "Koi link ya proof of this work — live page, report, ya deck? 'no link' agar share nahi kar sakte."

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

CASE E — all four ✓ (≥3 bullets target, ≥2 angles, link sorted) → clarification_needed = null.

CASE F — link sorted, metric covered (≥2 angles), but ONLY 2 bullets:
  Ask ONE more follow-up to reach 3 bullets — pick something DIFFERENT from existing bullets:
    Tech: "Koi aur outcome — biggest technical challenge solve kiya, ya another concrete metric?"
    Tech (alt): "Architecture / design choice kya tha — kuch unique approach ya tradeoff?"
    Marketing: "Aur koi outcome — campaign ka indirect impact ya learning?"
    Design: "Aur koi outcome — adoption number ya UX learning?"
  If the student gives substance → add as 3rd bullet → sufficient. If they decline ("bas itna hi", "kuch nahi", "no", "skip", "pata nahi", "abhi koi nahi") → ACCEPT with 2 bullets, set clarification_needed = null. Never push for a 3rd bullet more than ONCE per project.

ENRICHMENT OVERRIDE (applies when GitHub repo data was fetched for this project):
The repo is CONTEXT to help you understand and DESCRIBE the project — it is NOT a substitute for the metric bar. Hold projects to the SAME standard as experience: a metric-free project is NOT done.
  - **Mine the README HARD — TARGET 3 distinct descriptive bullets** covering different angles. Do NOT settle for 2 when the README supports a 3rd. Author each bullet from a different concrete part of the README:
      (i)   WHAT it does — the one-line description of purpose plus the specific features section / module list / core feature list from the README. Anchor the project identity.
      (ii)  HOW it does it — architecture, key tech choices, integration / data-flow / scaling approach mentioned in the README. Be specific (e.g. "five-table star schema, weekly ETL refresh", not "well-structured data pipeline").
      (iii) ONE KEY ARCHITECTURAL DECISION OR FLAGSHIP FEATURE — a specific design move the README documents (e.g. "swappable storage layer", "JSON-schema contract for LLM calls", "FR-2 validation gate"). If the README is long enough to describe HOW it does it, it almost always contains a 3rd named decision or feature worth its own bullet.
    Plus pull any REAL numbers the README itself contains (stars, downloads, users, benchmarks, latency, accuracy, coverage, test counts) into a metric bullet, bolded with **…**. With a metric, that's 3-4 bullets BEFORE the student says anything more — and you should cap at 3 descriptive + 1 metric in the extraction (the rewriter will distill).
  - Repo-derived descriptive bullets DO NOT by themselves satisfy the project. Requirement (c) STILL stands: ≥2 angles minimum. A project described as "a habit tracker with a leaderboard" with no numbers is NOT sufficient.
  - If the README gave no hard metric, you MUST still ask the student ONCE (CASE D) for a quantifiable outcome native to this project — e.g. "DevHab kitne log use karte hain — daily active users ya signups? Koi performance number, GitHub stars, ya competition result?". Set clarification_needed to that question.
  - ONLY after that one ask: if the student gives a number, add it as a NEW bullet → sufficient. If the student clearly has none ("kuch nahi", "pata nahi", "no numbers", "skip", "none", "abhi koi nahi"), THEN accept the descriptive bullets and set clarification_needed = null. Never push for a metric more than that single time.
  - Then apply CASE F: if you're at 2 bullets and ≥2 angles, you may ask ONCE more for a 3rd substantive detail; accept either way.
  - If the student answers CASE C with a deployed/demo URL instead of a repo, or declines the link, accept it and move on — do not re-ask for GitHub.

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
      // Ask-twice rule for link decline (2026-07-13, near-compulsory GitHub).
      // First decline: increment counter, ask again. Second decline: set the
      // flag so CASE D fires and we stop asking. This trades one extra turn
      // for dramatically higher chance of getting a repo URL and mining the
      // README for high-quality bullets.
      if (x.link_declined === true) {
        p._link_ask_count = (p._link_ask_count || 0) + 1;
        if (p._link_ask_count >= 2) p._link_declined = true;
      }
      if (!x.project) return;
      for (const k of ['name', 'dates', 'github_url', 'demo_url']) {
        if (x.project[k]) p[k] = x.project[k];
      }
      if (Array.isArray(x.project.tech_stack) && x.project.tech_stack.length > 0) {
        const set = new Set([...(p.tech_stack || []), ...x.project.tech_stack]);
        p.tech_stack = [...set];
      }
      if (Array.isArray(x.project.bullets) && x.project.bullets.length > 0) {
        // Dedupe: on a follow-up turn the LLM often re-emits the existing
        // descriptive bullets alongside (or instead of) the new one. Append only
        // genuinely new bullets so a metric turn doesn't duplicate the description.
        const norm = (s) => String(s).replace(/\*\*/g, '').trim().toLowerCase();
        p.bullets = p.bullets || [];
        const seen = new Set(p.bullets.map(norm));
        for (const b of x.project.bullets) {
          const n = norm(b);
          if (n && !seen.has(n)) { p.bullets.push(b); seen.add(n); }
        }
      }
    },
  },

  // POR — multi-bullet, multi-angle. Pattern matches Meet's reference resume:
  // event count + participant count + named flagship items / outcomes.
  // Single pending POR entry accumulates across turns (like pending_project).
  AWAITING_POR: {
    instruction: `Extract a leadership / position-of-responsibility role. Examples of valid roles: "Class Representative", "Club Lead", "MUN Secretary", "Event Organizer", "NSS Coordinator", "Society Head", "Sports Captain", "Core Team Member".

PRE-CHECK BEFORE ASKING ANYTHING — STOP RE-ASKING FOR DETAIL THE STUDENT ALREADY GAVE:
Before you set clarification_needed, look at resume_json.pending_por. It accumulates across turns.
  - **If pending_por.role AND pending_por.organization are BOTH already set**, NEVER ask "Kya aapka role aur organization kya tha?" again. The role+org is filled — move on to the next missing piece (bullets / metrics).
  - **If pending_por.bullets ALREADY contain ≥2 distinct entries** (any combination of action statements + numbers — e.g. "Team handling", "Handle team of 50+ members", "Organised event"), the entry IS sufficient: set clarification_needed = null. The friend-test 2026-06-25 looped on this exact bug — six turns of bullets going into the void while the bot re-asked the same two questions.

TERSE FOLLOW-UPS ARE THE ANSWER, NOT GARBAGE:
A terse reply like "Team handling", "Organised event", "Handle team of 50+ members", "secured 3 sponsorships", "₹3 lakh budget", "450 delegates" IS the answer to the question you just asked — it's a NEW BULLET for the pending PoR. Extract it into bullets[] EXACTLY ONCE per turn; never return bullets: [] for a short reply because you couldn't form a "full sentence." The rewriter phrases it later.

DEFLECTION HANDLING (Hindi/English):
If the student replies "upar dediya" / "pehle bola" / "already said" / "mentioned above" / "ek baar bata diya" — DO NOT re-ask. Re-evaluate pending_por per PRE-CHECK above; if role+org and any bullets are present, accept and set clarification_needed = null.

SUFFICIENCY for the PoR entry — ALL THREE must hold:
  (a) role + organization (what role, which club/society/program)
  (b) ≥2 bullets in bullets[]
  (c) bullets span ≥2 distinct ANGLES across:
        SCALE — # events organized, # participants/delegates, budget handled, team size led
        QUALITY — named flagship outcomes ("flagship event X", "won inter-college Y"), deficit/excess metrics
        IMPACT — funds raised, sponsorships secured, attendees, retention, % growth year-over-year

Pending PoR entry lives in resume_json.pending_por (similar to pending_project). Merge new bullets into pending across turns. Once sufficient, router commits to por[] array.

DECISION TREE (one question per turn):
1. role + organization missing → ask both. ONCE only; if pending_por.role or pending_por.organization is set, skip to step 2.
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
        // Dedupe by normalised text — same fix as projects + experience.
        // Without this, a terse follow-up that the LLM re-emits as part of a
        // mixed bullets[] response will double-count the existing line.
        const norm = (s) => String(s).replace(/\*\*/g, '').trim().toLowerCase();
        p.bullets = p.bullets || [];
        const seen = new Set(p.bullets.map(norm));
        for (const b of x.por.bullets) {
          const n = norm(b);
          if (n && !seen.has(n)) { p.bullets.push(b); seen.add(n); }
        }
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

CRITICAL — MULTI-ITEM IN ONE MESSAGE: a single message frequently contains MULTIPLE certifications. You MUST extract EVERY cert you can identify — never drop one because it was on line 2 instead of line 1. Recognize all of these as separate entries:
  • Newline-separated:           "Neural Networks & Deep Learning
                                  Introduction to AI, Data Science & Ethics"   → 2 certs
  • Comma- or "and"-separated:   "Deep Learning Specialization, NPTEL DBMS, and AWS CCP"   → 3 certs
  • Numbered / bulleted:         "1) Deep Learning  2) NPTEL DBMS  3) AWS CCP"   → 3 certs
  • Mixed (name + URL pairs):    "Deep Learning — coursera.org/x  ;  NPTEL DBMS — nptel.in/y"   → 2 certs, each with its URL
NEVER drop a cert because it lacks a URL — capture { name, url: null } for each one. The router will follow up for missing links one-by-one.

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
  // Richer log so we can see what the scraper actually pulled — confirms the
  // README is reaching the LLM rather than being silently underused (Bug B 2026-06-24).
  logger.info({
    owner: parsed.owner,
    repo: parsed.repo,
    ok: !!repo,
    ms: Date.now() - t0,
    readmeChars: repo && repo.readme ? repo.readme.length : 0,
    descLen: repo && repo.description ? repo.description.length : 0,
    languages: repo && repo.languages ? repo.languages.join(',') : '',
    topicsCount: repo && repo.topics ? repo.topics.length : 0,
    stars: repo ? repo.stars : null,
  }, 'github enrichment');
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
    ? `\n\nGitHub repo data was fetched for the link in this message. This is VERIFIABLE primary-source material from the student's OWN repository — treat its contents as fact you may use to write the resume (this is NOT "inventing"). MINE it thoroughly so the student doesn't have to describe everything:
- Use description + README to write the descriptive bullet(s) on WHAT the project does, its core features, and the architecture/approach. This is CONTEXT — it does NOT make the project complete on its own.
- Fill tech_stack from languages + topics + frameworks/DBs/infra named in the README.
- Extract any REAL numbers in the README (users, latency, dataset size, accuracy, test coverage, stars/downloads, scale) into bullets, bolded with **…**. Never fabricate a metric that is not in the repo or the student's own words.
- If the README has NO hard numbers, you must STILL ask the student once for a quantifiable outcome before finalizing the project (see the ENRICHMENT OVERRIDE in the projects instruction) — a description alone is not a finished project bullet.

BOILERPLATE / TEMPLATE GUARD (critical — read before writing any bullet):
First judge whether the README is the student's OWN description of what they built, or just an UNMODIFIED scaffolding/framework template. Tell-tale signs of boilerplate: "This template provides a minimal setup", "Getting Started with Create React App", "npm run dev / build / preview" as the only content, default Vite / CRA / Next.js / Expo starter text, a list of framework plugins, a near-empty or license-only README, or text that describes the TOOL/FRAMEWORK rather than a specific application.
If the README is boilerplate/template text:
- Do NOT author bullets from it — those would describe the scaffolding, not the student's work, and a recruiter will spot it instantly. This is WORSE than no bullets.
- Keep tech_stack from languages (that part is real), but leave bullets to ONLY what the student themselves stated in their messages.
- Set clarification_needed asking what the project actually DOES and one concrete feature or outcome they built (e.g. "Repo se sirf template dikh raha hai — aapne is project mein khud kya banaya? 1-2 features ya kaam batao."). Do NOT mark the project sufficient on boilerplate alone.
Repo data:
${JSON.stringify({
        name: repoEnrichment.name,
        description: repoEnrichment.description,
        languages: repoEnrichment.languages,
        topics: repoEnrichment.topics,
        stars: repoEnrichment.stars,
        url: repoEnrichment.html_url,
        readme_excerpt: repoEnrichment.readme ? repoEnrichment.readme.slice(0, 2500) : null,
      })}\n`
    : '';

  const jdContextBlock = buildJdContext(session);

  // Conversational context: WHAT the student was just asked. Without this the
  // extraction is stateless — a terse reply like "Jan 2023 to Dec 2024" or
  // "Razorpay" carries no clue which field it answers, so the LLM drops it and
  // the router re-asks. This line gives the LLM the same context a human chat
  // would have: "you just asked X, so this reply IS X."
  let focusBlock = '';
  if (focus && state === 'AWAITING_PROJECTS') {
    focusBlock = `\n\nCONVERSATION CONTEXT: You JUST asked the student a follow-up about their CURRENT project — it is already in resume_json.pending_project. Their message below is the ANSWER to that follow-up (a metric, a link, a date, or a detail) for THAT SAME project, even if it doesn't repeat the project name. MERGE it into the existing pending_project: a number/outcome → add it as a NEW bullet; a repo/live URL → set github_url/demo_url. Do NOT treat this as a new project and do NOT fall back to asking "what did you build" (CASE A) — the project already exists. If the student signals they have no such number ("pata nahi", "no numbers", "kuch nahi", "skip", "none", "abhi nahi"), accept the existing bullets and set clarification_needed = null.`;
  } else if (focus) {
    focusBlock = `\n\nCONVERSATION CONTEXT: The student was JUST asked specifically for the "${focus}" of their experience. Their message below is almost certainly the answer to THAT — map it to "${focus}" even if stated tersely or as a bare fragment (a bare date range → dates; a bare company name → company; a bare job title → role). Fill that field; do not discard a short reply just because it isn't a full sentence.`;
  }

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

  // Seed pending_project.name from the repo when enrichment fired but the LLM
  // declined to author one (e.g. boilerplate README guard). Without a name the
  // follow-up reply has nothing to attach to via session.proj_focus, and the
  // next turn would restart as a brand-new project.
  if (
    repoEnrichment &&
    state === 'AWAITING_PROJECTS' &&
    result.data &&
    result.data.project &&
    !result.data.project.name &&
    repoEnrichment.name
  ) {
    result.data.project.name = repoEnrichment.name;
    if (!result.data.project.github_url && repoEnrichment.html_url) {
      result.data.project.github_url = repoEnrichment.html_url;
    }
  }

  return { ...result, repoEnrichment };
}

module.exports = { extractSection, SECTION_CONFIG };
