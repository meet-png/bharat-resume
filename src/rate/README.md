# src/rate — v2 rate mode

Read this in order:

- **parse.js** — buffer → text/lines. 3-layer fallback: pdfjs (primary) → pdf-parse (fallback) → refuse. Refuse fires when word count < 100 (probable image-based PDF). Multi-column detection flags ATS-hostile layouts. Link annotations from pdfjs (LinkedIn/GitHub/project URLs) are merged inline into the line text so the display "LinkedIn" arrives as "LinkedIn (https://linkedin.com/in/xyz)". NO LLM.
- **extract.js** — parsed lines → `resume_json` with `source_line` anchors on every bullet. Matches v1 schema for `src/resume/render.js` compat (call `flattenForRender()` to convert `bullets[].text → string[]`). Two invariants: **grounded** (nothing invented) and **anchored** (every bullet cites its line).
- **lexicon.js** — action-verb dictionary + filler-phrase list + India regex tokens (CGPA, 10th/12th %) + canonical section headers + metric-unit regex. Pure data, no logic. Grow freely.
- **score.js** — deterministic scorer. Same input → byte-equal output, always. Returns `{ score_deterministic, subscores, issues, meta }` with 6 checks producing 6.0 of the total 10.0. Cache-key = `sha256(text + role + RUBRIC_VERSION)`. Bump `RUBRIC_VERSION` to invalidate cached scores.
- **score-llm.js** — LLM scorer. 3 subscores adding 4.0 to the total 10.0: bullet impact judgment (1.0, LLM 0/1/2 per bullet), role fit vs jd_intel keywords (2.0, deterministic coverage after one LLM jd_intel call), grammar polish (1.0, hard-error only). Temperature 0; the true determinism guarantee comes from Redis caching on the caller side.
- **score-combined.js** — merges deterministic + LLM into the total 10.0 score. `scoreAll(input) → { score, subscores, issues, meta }`. This is what WhatsApp bot + audit report generator will call.
- **verify.js** — content-atom fabrication verifier. Deterministic. Every rewritten bullet passes through here BEFORE it can be rendered into a paid PDF. Extracts atoms (numbers with units, currency, tech tokens with alias collapse, proper nouns) from the rewrite; verifies each against the original bullet + full source resume. Returns `{ ok, unverified_atoms, details }`. Any unverified atom → caller MUST reject the rewrite. This is the moat.
- **`data/tech-dictionary.json`** — seed of ~400 tech tokens + 30 aliases (K8s↔Kubernetes, JS↔JavaScript, GH Actions↔GitHub Actions, etc.). Grow by appending; when the verifier rejects a legitimate proper noun in prod, add it here.
- **`scripts/rate-verify.test.js`** — regression suite: 10 legitimate rewrites (must PASS) + 10 fabrication attempts (must FAIL). Wired into `.runtime/check.js` and exposed as `npm run test:rate-verify`. If a fabrication ever slips through, this catches it BEFORE commit.
- **improver.js** — LLM rewriter with mandatory verifier gate. `improveSection(...) → { improved: [{ original, improved, mode, verified, changes }] }`. Batches bullets by section (up to 8 per call). Every output bullet passes through `verify.js`. On failure, retries ONCE with an even stricter prompt that cites the flagged atoms; on second failure, falls back to `safeFallback()` — a deterministic verb-strengthener that only replaces filler openings (Worked on → Built, Responsible for → Owned, etc.) and never adds content.
- **improve-resume.js** — whole-resume improvement pipeline. `improveResume(input) → { resume_json_improved, audit, meta }`. Sections run in parallel; verifier runs per-bullet inside each section so a fabrication in one section can't propagate. `audit[]` is what the audit-report generator consumes: `{ section, entry_label, source_line, original, improved, mode, verified, unverified, changes }` per bullet.
- **audit.js** — student-facing report generator. `renderAuditText({ audit, role, scoreBefore, scoreAfter, meta }) → { text, chunks, char_count, tally }` produces WhatsApp-friendly text with BEFORE/AFTER quotes per bullet, source_line anchors, entry labels, and change reasons. Auto-chunks on section boundaries when >3900 chars. `renderAuditJson(...)` returns the same content structured for a future PDF renderer.

## Day 1 evidence

| PDF | Layer | Words | Time | Cost | Anchors | Verdict |
|---|---|---|---|---|---|---|
| meet_kabra_resume_.pdf (615 words) | pdfjs | 610 | 17.9s | $0.00137 | 100% valid | ✅ full extract |
| resume (6).pdf (Aditya, 256 words) | pdfjs | 256 | 7.3s | $0.00064 | 100% valid | ✅ full extract; college genuinely absent from source (correctly left null) |

## Day 2 evidence — deterministic scorer

| PDF | Deterministic | ATS | Contact | Content | Polish | Issues | Determinism |
|---|---|---|---|---|---|---|---|
| Meet's (dense tech) | **5.5 / 6** | 2.0/2 | 0.5/1 | 2.0/2 | 1.0/1 | 4 (2 pdfjs-URL + 2 India-fresher) | ✓ byte-equal on re-score |
| Aditya's (fresher basic) | **4.9 / 6** | 2.0/2 | 0.5/1 | 1.4/2 | 1.0/1 | 8 (2 pdfjs-URL + 3 metric-less bullets + 2 India + density) | ✓ byte-equal on re-score |

Correctly discriminated: Meet's dense metric-rich bullets earned full Content Quality; Aditya's project bullets are cited by source_line 30/32/34 as metric-less. Both scores byte-identical across re-runs (same-input-same-output guarantee met).

## Day 3 evidence — full 10-point score

| PDF | Total (target: Backend SWE) | Det | LLM | Content-LLM | Role Fit | Grammar | Contact (post-URL-fix) |
|---|---|---|---|---|---|---|---|
| Meet's (dense tech) | **8.4 / 10** | 5.9/6 | 2.5/4 | 0.83/1 | 0.73/2 | 0.90/1 | **0.90/1** (was 0.50) |
| Aditya's (fresher basic) | **7.4 / 10** | 4.9/6 | 2.5/4 | 0.57/1 | 0.89/2 | 1.00/1 | 0.50/1 (Aditya's PDF has no hyperlink annotations) |

The Day 3 URL-annotation merge lifted Meet's Contact from 0.5 → 0.9 (LinkedIn + GitHub URLs now extracted from the PDF's link annotations, not just display text). It also populated all 3 project github_url fields for Meet's projects — previously all null.

Role Fit correctly LOW for Meet at "Backend SWE" (his resume is Python/data-focused, missing Java/Node/Spring). This is a feature: the score honestly tells the student "your resume isn't tuned for this specific role."

## Known punch list

- **~~URL extraction~~** — SHIPPED in Day 3. Link annotations merged inline.
- **~~CGPA `/10` denominator~~** — SHIPPED in Day 2. Scored as india_cgpa_missing_denominator.
- **Achievements vs. certifications overlap** — soft semantic issue; sometimes the LLM buckets a "won hackathon" line under achievements when the source uses "CERTIFICATIONS". Fix if it hurts a real student.
- **Multi-column detection heuristic**: tuned at 25% of lines showing internal gaps > 15% page width. Not yet tested against a Canva 2-column template — need a fixture.
- **Role Fit non-determinism**: jd_intel comes from a single LLM call that varies slightly run-to-run. Cache jd_intel by `sha256(role)` in Redis (30d TTL) on the caller side to lock this down.
- **~~Improver over-compression~~** — SHIPPED in Day 6. `checkContentPreservation()` in `verify.js` rejects rewrites that drop >15% of source atoms or shrink below 65% of original length. Improver retries once with targeted guidance, then falls back to `safeFallback()`.

## Bench

```bash
# Day 1
node scripts/rate-parse.js <path.pdf|path.docx>
node scripts/rate-parse.js <path.pdf> --no-llm                     # parse only, no OpenAI cost

# Day 2 — deterministic 6-point score
node scripts/rate-score.js <path.pdf> --role "Backend Engineer"
node scripts/rate-score.js <path.pdf> --role "Data Analyst" --verify-cache   # scores twice, byte-compares

# Day 3 — full 10-point (deterministic 6 + LLM 4). ~10s + ~$0.002.
node scripts/rate-score.js <path.pdf> --role "Backend Engineer" --llm

# Day 4 — fabrication verifier regression suite. No LLM. Runs in ~200ms.
npm run test:rate-verify

# Day 5 — full improve pipeline: parse → extract → improve → per-bullet diff + verifier verdicts
node scripts/rate-improve.js <path.pdf> --role "Data Analyst"

# Day 6 — full pipeline WITH re-score (before/after) and audit report
node scripts/rate-improve.js <path.pdf> --role "Data Analyst" --audit
```
