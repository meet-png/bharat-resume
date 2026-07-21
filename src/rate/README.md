# src/rate — v2 rate mode

Read this in order:

- **parse.js** — buffer → text/lines. 3-layer fallback: pdfjs (primary) → pdf-parse (fallback) → refuse. Refuse fires when word count < 100 (probable image-based PDF). Multi-column detection flags ATS-hostile layouts. NO LLM.
- **extract.js** — parsed lines → `resume_json` with `source_line` anchors on every bullet. Matches v1 schema for `src/resume/render.js` compat (call `flattenForRender()` to convert `bullets[].text → string[]`). Two invariants: **grounded** (nothing invented) and **anchored** (every bullet cites its line).

## Day 1 evidence

| PDF | Layer | Words | Time | Cost | Anchors | Verdict |
|---|---|---|---|---|---|---|
| meet_kabra_resume_.pdf (615 words) | pdfjs | 610 | 17.9s | $0.00137 | 100% valid | ✅ full extract |
| resume (6).pdf (Aditya, 256 words) | pdfjs | 256 | 7.3s | $0.00064 | 100% valid | ✅ full extract; college genuinely absent from source (correctly left null) |

## Known Day-2 punch list

- **URL extraction**: pdfjs' text-content stream only gives display text ("LinkedIn", "[GitHub]") not the underlying href. Sanitizer in extract.js currently nulls these so they don't render as visible garbage — but we can do better by pulling `page.getAnnotations()` (link annotations) and merging positions back into the text. Then a bare "LinkedIn" without an underlying URL is a legitimate ATS-compliance flag; a real URL fills the slot.
- **Achievements vs. certifications overlap**: sometimes the LLM buckets a "won hackathon" line under achievements when the source uses "CERTIFICATIONS" — soft, semantic.
- **CGPA format**: extractor captures whatever's written; scoring should later flag missing `/10` denominator as an India-specific check.
- **Multi-column detection heuristic**: tuned at 25% of lines showing internal gaps > 15% page width. Not yet tested against a Canva 2-column template — Day 3 task.

## Bench

```bash
node scripts/rate-parse.js <path.pdf|path.docx>
node scripts/rate-parse.js <path.pdf> --no-llm    # parse only, no OpenAI cost
```
