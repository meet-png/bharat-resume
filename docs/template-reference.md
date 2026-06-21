# Template Reference — Meet's Resume

**Source:** `final_resume (1).docx` (provided by Meet 2026-06-21).
**Purpose:** Day 4 PDF template AND Day 3 rewriter both pull tone/format from this. Anything in PRD §9 that conflicts with what's here — **this file wins**, the PRD §9 spec was a placeholder.

The raw analysis lives at `.runtime/meet_resume_analysis.json` (gitignored — re-runnable from `.runtime/analyze-docx.js` if the .docx is in `C:\Users\ACER\Downloads\`).

---

## 1. Visual design

### Font
**Georgia throughout.** Not Source Serif / Inter (PRD §9.1 override).

### Color palette
| Hex | Use |
|---|---|
| `#1A3A5C` | Name, hyperlinks (LinkedIn, GitHub, LeetCode, project titles, cert titles) |
| `#111111` | Section headers, body text, bullet text |
| `#555555` | Secondary text (degree line, org name in experience header, summary body) |
| `#888888` | Date metadata, tech-stack subtitle, coursework line, separator pipes |

### Type scale (pt)
| Element | Size | Weight | Color |
|---|---|---|---|
| Name | 18 | bold | `#1A3A5C` |
| Contact row | 8 | regular | `#555555` body, `#1A3A5C` underline links, `#888888` pipes |
| Section header | 9 | bold | `#111111` |
| Body / bullet | 9 | regular (with selective bold) | `#111111` |
| Date / tech-stack / coursework | 8 | regular | `#888888` |

### Page
- Single column. Tab stops for right-aligned dates.
- Center-aligned header (name + contact). Everything else left-aligned.
- Section headers ALL CAPS, bold, **no underline rule** below (PRD §9.2 wanted a 0.5pt rule — Meet's actual has none).

---

## 2. Section structure & order

```
Header        (name + contact row, centered)
SUMMARY       (one dense paragraph)
EDUCATION     (institution+date / degree / coursework)
TECHNICAL SKILLS (categorized — see §3 below)
EXPERIENCE    (role+org+date / bullets)
PROJECTS      ([GitHub] Title + date / tech subtitle / bullets)
CERTIFICATIONS (Cert Name + issuer + date, one per line)
```

POR + Achievements aren't in Meet's actual resume — his PoR content lives inside EXPERIENCE (MUN Society as Project Lead). For BHARAT RESUME we keep POR + Achievements as optional sections — they collapse cleanly when empty (PRD §9.3).

### Education block
```
<College Name (bold #111111 9pt)>      <tab>     <Jul 2023 – May 2027 (Expected)  #888888 8pt>
<B.Tech — Computer Science, … #555555 9pt>
<Relevant coursework: (bold #888888 8pt)> <DBMS · DSA · ... (regular #888888 8pt)>
```

### Skills section
Meet uses **domain-tuned buckets**, not the generic 5:
```
Languages:     Python, SQL (CTEs, Window Functions), R, TypeScript, Git
ML / AI:       Scikit-learn, XGBoost, SARIMAX, K-means, NLP, LLM APIs, Claude API, …
Data & BI:     Pandas, NumPy, Power BI (DAX), Tableau, Streamlit, Plotly, Excel, ETL Pipelines
Databases:     PostgreSQL, Supabase, Schema Design, Data Warehouse, SQL Query Optimisation
CI/CD & Tools: GitHub Actions, gitleaks, Pytest, Pre-commit hooks, Zod, Next.js
```
Pattern: `<Label (bold)>: <items, comma-separated>`. Two-space gap after the colon.

Our PRD §7.2 schema is `{ languages, frameworks, tools, databases, other }`. **Action item:** rewriter should re-label/regroup based on JD context — for a data role, render "ML / AI" + "Data & BI" buckets even if user data lands in `frameworks` / `tools` / `other`. (Day 4 template work.)

### Experience block
```
<Role (bold #111111)>  ·  <Organization (#555555)>    <tab>    <Dates  |  Location (#888888 8pt)>
• <bullet body — selective bold on metric/outcome>
• <bullet>
• <bullet>
```

### Project block
```
[GitHub](link, underlined #1A3A5C 8pt)  <Project Name (#111111 9pt bold; underlined if title is itself a hyperlink)>    <tab>    <Date #888888 8pt>
<Tech1 · Tech2 · Tech3   #888888 8pt>          ← space-middot-space separator
• <bullet — selective bold>
• <bullet>
```

### Certification line (no bullets — one per row)
```
<Cert Name (underlined #1A3A5C 9pt)>  —  <Issuer (#555555 9pt)>    <tab>    <Date #888888 8pt>
```
Two-space dash sandwich: `<spaces>—<spaces>` between cert name and issuer.

---

## 3. Voice & tone — for the Day 3 rewriter

This is the most important part. The rewriter prompt should pattern-match this voice closely.

### Summary voice
- **Dense with metrics.** Every claim has a number behind it.
- **Three-part shape per shipped item:** *what I built* → *what it does* → *outcome with metric*.
- **First person is fine** when the input is naturally first-person. PRD §7.2 said "third-person factual" — for our v1 we keep third-person default for safety, but allow first-person if the student's bullets clearly read that way.
- **Ends with a punchy thesis** that frames the body as evidence (e.g., "I learn by shipping — every system above has real numbers, not adjectives, behind it.").

Meet's actual summary, annotated:
> "I build data and AI systems end-to-end — instrumented ETL pipelines, schema-driven LLM contracts, and dashboards that defend a falsifiable claim.
> In 2026 I shipped three:
> [item 1] a trade-data warehouse (12,828 rows, 20/20 validation) that overturned the industry's 'September peak' assumption and re-priced a ₹18,310 Cr claim to a grade-adjusted ₹4,711 Cr via a live Streamlit dashboard;
> [item 2] an autonomous Claude sales agent booking calls at ~$0.04/conversation, 15%+ booking rate, >85% prompt-cache hit ratio — replacing a $3–6K/mo human SDR at <$30/mo;
> [item 3] an ICP-grounded content pipeline scraping audience vocabulary across 5 platforms and cutting copywriting cost ~99% on Gemini Flash.
> I learn by shipping — every system above has real numbers, not adjectives, behind it."

### Bullet voice
**The signature move: selective bolding on the metric/outcome — NEVER on the action verb.**

Markdown convention in `resume_json_rewritten`: bullets are plain strings with `**bold**` markers around the metric phrase(s). The PDF template renders `**...**` as `<strong>`.

Bullet shape patterns:
1. **Verb + context + em-dash + bolded outcome:**
   `Directed Rajasthan's largest student MUN — 450+ delegates, 15-member team, ₹3,00,000+ budget — **zero budget deficit** and zero day-of failures across two consecutive editions.`

2. **Verb + bolded metric + mechanism + ";" + second action with bolded metric:**
   `Secured **8+ sponsorships** through stakeholder presentations; coached **15 committee directors** and staff under real-time pressure.`

3. **Verb + technical description + em-dash + bolded outcome (packed):**
   `Architected a weekly-refreshing ETL pipeline ingesting 5 trade data sources into an 8-table star schema — **12,828 rows, 20/20 validation checks on cold run**.`

4. **Triple-action with semicolons and selective bolds:**
   `Achieved **>85% prompt-cache hit ratio** via byte-stable prompts; JSON Schema contract **eliminated parsing errors**; orchestrator-side URL injection killed a prompt-injection attack class.`

Action verbs in use (palette to draw from):
**Architected, Built, Shipped, Directed, Secured, Chaired, Coached, Debunked, Achieved, Scraped, Compressed, Reverse-engineered, Eliminated, Deployed, Compressed, Cut, Corrected, Overturned, Replaced.**

### Punctuation rules
- Em-dash (`—`) introduces the outcome/result; surround with single spaces.
- Semicolon (`;`) chains independent clauses inside one bullet.
- Middle dot (`·`) separates tech-stack items.
- Curly quotes (`'`, `"`) over straight.
- Indian numerals when relevant: `₹3,00,000`, `₹18,310 Cr`.

### What's NOT in the voice
- No soft-skill phrases ("team player", "passionate").
- No padding adjectives ("very", "extremely", "highly").
- No vague verbs ("worked on", "helped with", "assisted").
- No claim without a number, unless the claim is a deliverable name.

---

## 4. Schema deltas from current `resume_json_rewritten`

What Meet's template uses that our schema doesn't yet capture:

| Field | What | Action |
|---|---|---|
| `contact.leetcode` | Fifth contact link in header | Add to schema; ask in `AWAITING_LINKEDIN`/`AWAITING_GITHUB` follow-up or as a new state. Low priority. |
| `education[].coursework` | "Relevant coursework: …" line under degree | Add to schema; optional, derive from skills + role on rewrite if missing. |
| Bullet `**...**` markers | Selective bold on metric | **No schema change needed** — rewriter emits markdown-bold inside the bullet string; Day 4 template parses it. |
| Skills bucket *labels* | "ML / AI", "Data & BI" instead of generic | Day 4 template-level: rename buckets dynamically based on JD context. Keep raw schema stable. |
| Project tech as subtitle | `Tech1 · Tech2 · Tech3` line | Already in schema (`projects[].tech_stack`). Day 4 template renders with `·` separator. |

---

## 5. Day 3 + Day 4 action items derived from this

**Day 3 — rewriter prompt** (`src/llm/rewrite.js`):
- Add the "selective bold on metric" convention with example bullets in the prompt.
- Reinforce em-dash-then-outcome structure.
- Update the example action verbs to Meet's palette (Architected, Directed, Achieved, etc.) — drop generic "led" / "helped".
- Summary prompt: three-part shape (claim → mechanism → result) with explicit thesis closer when material allows it.

**Day 4 — template** (`src/templates/resume.hbs` + CSS):
- Georgia font via Google Fonts (`@import 'https://fonts.googleapis.com/css2?family=Georgia'` — actually Georgia is a websafe system font; can fall back to `Georgia, 'Times New Roman', serif`).
- Exact color palette + type scale above.
- Center-aligned header, ALL-CAPS section labels (no rule), tab-stop right alignment for dates.
- Skills bucket labels: render dynamically based on what skills landed where.
- Markdown-bold (`**`) → `<strong>` in bullets.
- Section collapse: skipped sections drop entirely (no empty header).

**Day 2 retrofit** (optional):
- Add `AWAITING_LEETCODE` between GITHUB and EDUCATION? Low priority — can be inferred from username conventions or just dropped if not common.
- Add a `coursework` question in `AWAITING_EDUCATION` follow-up? Already covered by the current single-message education prompt; LLM may already pull it if mentioned.
