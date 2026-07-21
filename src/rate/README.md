# src/rate — v2 rate mode

Read this in order:

- **parse.js** — buffer → text/lines. 3-layer fallback: pdfjs (primary) → pdf-parse (fallback) → refuse. Refuse fires when word count < 100 (probable image-based PDF). Multi-column detection flags ATS-hostile layouts. NO LLM.
- **extract.js** — parsed lines → `resume_json` with `source_line` anchors on every bullet. Matches v1 schema for `src/resume/render.js` compat (call `flattenForRender()` to convert `bullets[].text → string[]`). Two invariants: **grounded** (nothing invented) and **anchored** (every bullet cites its line).
- **lexicon.js** — action-verb dictionary + filler-phrase list + India regex tokens (CGPA, 10th/12th %) + canonical section headers + metric-unit regex. Pure data, no logic. Grow freely.
- **score.js** — deterministic scorer. Same input → byte-equal output, always. Returns `{ score_deterministic, subscores, issues, meta }` with 6 checks producing 6.0 of the total 10.0 (LLM adds 4.0 in Day 3). Cache-key = `sha256(text + role + RUBRIC_VERSION)`. Bump `RUBRIC_VERSION` to invalidate cached scores.

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

## Known Day-2 punch list

- **URL extraction**: pdfjs' text-content stream only gives display text ("LinkedIn", "[GitHub]") not the underlying href. Sanitizer in extract.js currently nulls these so they don't render as visible garbage — but we can do better by pulling `page.getAnnotations()` (link annotations) and merging positions back into the text. Then a bare "LinkedIn" without an underlying URL is a legitimate ATS-compliance flag; a real URL fills the slot.
- **Achievements vs. certifications overlap**: sometimes the LLM buckets a "won hackathon" line under achievements when the source uses "CERTIFICATIONS" — soft, semantic.
- **CGPA format**: extractor captures whatever's written; scoring should later flag missing `/10` denominator as an India-specific check.
- **Multi-column detection heuristic**: tuned at 25% of lines showing internal gaps > 15% page width. Not yet tested against a Canva 2-column template — Day 3 task.

## Bench

```bash
# Day 1
node scripts/rate-parse.js <path.pdf|path.docx>
node scripts/rate-parse.js <path.pdf> --no-llm                     # parse only, no OpenAI cost

# Day 2
node scripts/rate-score.js <path.pdf> --role "Backend Engineer"
node scripts/rate-score.js <path.pdf> --role "Data Analyst" --verify-cache   # scores twice, byte-compares
```
