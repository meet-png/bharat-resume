# Rate Mode — Architecture Reference

**Purpose:** hand a future Claude session (or a human maintainer) the complete mental model of rate mode in one file. Load this before touching any `src/rate/*` code.

**Ship date:** merged from `feature/v2-rate-mode` after Day 9 (2026-07-23).

---

## 1. What rate mode is (product-level)

- **User story:** student uploads their existing resume PDF → gets a 10-point score with source-cited issues → pays ₹49 → receives an improved PDF + a full audit trail showing every BEFORE/AFTER and why.
- **The single invariant that makes it un-scam-able:** nothing in the output that isn't traceable to the student's original resume text. Enforced structurally by `src/rate/verify.js`, not by a prompt.
- **Positioning vs build mode:** build mode is "chat with me and I'll make a resume." Rate mode is "you upload a resume, I improve it." Same infrastructure downstream (payment, watermark, WhatsApp send).

---

## 2. End-to-end flow

```
[student]        [state]                [next]
   │
   │ "hi"
   ▼
AWAITING_MODE_SELECT
   │
   │ "2" / "rate"           ─────► RATE_AWAITING_PDF
   │
   │ [PDF upload]           ─────► parse → extract → RATE_AWAITING_ROLE
   │                                (refuse if Canva template / image / etc.)
   │
   │ "Data Analyst"         ─────► scoreAll() → RATE_SHOWING_SCORE
   │                                (glimpse: score + top-3 issues + ₹49 CTA)
   │
   │ "pay"                  ─────► createPaymentLink({flow:'rate'}) → RATE_AWAITING_PAYMENT
   │
   │ [pays on Cashfree]
   │
   ▼ [webhook fires]
fulfillPaymentByMode()
   │
   │ session.mode==='rate'  ─────► fulfillRatePayment()
   │
   │ paid=true persisted    ─────► improveResume() + rescore
   │
   │ deliverPdf(clean:true) ─────► renders via v1 pipeline → Supabase → signed URL
   │
   │ send PDF + audit chunks over WhatsApp
   │
   ▼
RATE_DELIVERED (terminal)
```

Cancel path: `cancel` from any rate state → `AWAITING_MODE_SELECT`, session.rate cleared, payment link URL cleared.

---

## 3. File-by-file responsibility map

Every file's job in one line. Load the file when the incident category matches.

| File | Owns | Load when |
|---|---|---|
| `src/rate/parse.js` | Buffer → text/lines with source anchors; 3-layer fallback; multi-column + Canva detection; refuse reasons | Parse failure, bad PDF, Canva template |
| `src/rate/extract.js` | Parsed text → `resume_json` via LLM; `source_line` on every bullet; post-extract quality check | Extraction empty or wrong shape |
| `src/rate/lexicon.js` | Action verbs (145), fillers (26), India regex (CGPA/board%), metric-unit regex, canonical section names | Scoring seems off, add new verb or filler |
| `src/rate/score.js` | Deterministic 6-point scorer; cache_key by content hash; issue objects with source_line | Score doesn't discriminate; add/remove a check |
| `src/rate/score-llm.js` | LLM 4-point add-on: bullet impact (1.0) + role fit (2.0) + grammar (1.0); jd_intel reused from v1 keywords.js | Role-fit low or too aggressive |
| `src/rate/score-combined.js` | `scoreAll()` merges deterministic + LLM into total 10.0 | Anywhere the WhatsApp bot or fulfillment needs "the score" |
| `src/rate/verify.js` | **The moat.** `verify()` blocks fabrications. `checkContentPreservation()` blocks over-compression. `extractNumericAtoms/TechAtoms/ProperNouns` are the atom extractors | Improver output looks wrong; verifier rejecting legit rewrites |
| `src/rate/improver.js` | `improveSection()`: LLM improve → verify → retry-with-guidance → safeFallback. Verb-only fallback when both LLM passes fail | Improvements over-eager or too conservative |
| `src/rate/improve-resume.js` | Whole-resume pipeline: 4 sections in parallel; audit trail per bullet | Adding a new section to improve, or debugging cross-section leaks |
| `src/rate/audit.js` | `renderAuditText()` + `renderAuditJson()`. Student-facing before/after report, auto-chunked for WhatsApp | Audit copy tuning, PDF renderer design |
| `src/rate/fulfill.js` | `fulfillRatePayment()`: post-payment path. Idempotent, retry-safe, integrates with v1 deliverPdf | Delivery not firing; PDF not landing after payment |
| `src/state/rate-prompts.js` | Every WhatsApp message rate mode sends (mode select, refuse variants, glimpse, pay intro, cancel) | Wording change, new refuse reason |
| `src/state/rate-router.js` | Rate-mode state machine handler. Parallel to build router | Bug in rate-mode conversation flow |
| `src/state/router.js` | Build-mode state machine + mode-select block at top + mode dispatch. **Only file where v2 edits v1** | Cross-mode contamination, mode-select bug |
| `src/state/states.js` | STATES enum + RATE_STATES set + NEXT_STATE (build only) | Adding a new state |
| `src/payment/dispatch.js` | `fulfillPaymentByMode()`: session lookup → dispatch to build or rate fulfillment | Webhook not routing correctly |
| `src/routes/cashfree.js` + `razorpay.js` | Webhook verification + phone_hash resolution + call to `fulfillPaymentByMode` | Payment not fulfilling; signature failing |
| `src/routes/whatsapp.js` | Inbound webhook. Downloads PDF/DOCX attachments in RATE_AWAITING_PDF or AWAITING_MODE_SELECT; refuses at transport otherwise | Attachment upload broken |
| `src/messaging/meta.js` | `sendWhatsApp()` + `downloadMedia()` (10MB cap, bearer-auth 2-step CDN fetch) | Meta CDN download error |
| `data/tech-dictionary.json` | ~400 tech tokens + 30 aliases for the verifier | Verifier rejecting legit tech; add new stack |

---

## 4. State field cheat sheet (`session.rate`)

Everything rate mode stashes on the session lives under `session.rate`:

```js
session.rate = {
  source_text,        // full parsed text
  source_lines,       // [{ n, page, text }] — source_line anchor targets
  resume_json,        // extracted structure with source_line anchors on bullets
  parse_meta,         // { pageCount, multiColumn, letterSpacedHeaders, canvaPlaceholder, ... }
  role,               // string, mandatory
  score_before,       // number 0-10
  score_after,        // number 0-10, set only after fulfillment
  score_subscores,    // { ats_compliance, contact_structure, ... }
  score_issues,       // sorted issue objects
  score_cache_key,    // sha256(text + role + RUBRIC_VERSION)
  resume_json_improved,  // set during fulfillment; matches v1 shape after flattenForRender
  audit,              // improve-resume audit trail; consumed by renderAuditText
};
```

`cancel` clears the whole `session.rate` object plus `session.payment_link_id/url`. `reset` clears the whole session.

---

## 5. The 3 non-negotiable guarantees

**A. No fabrication.** Every atom (number, tech token, proper noun) in the improved output must appear in the original. Enforced by `verify.js`. Regression suite (`scripts/rate-verify.test.js`) proves this before every commit — 20 fixtures, 10 legit + 10 fabrication attempts, all must go the right way. If a fabrication ever slips through, that suite catches it BEFORE it reaches a student.

**B. No over-compression.** Rewrites can't drop >15% of source atoms or shrink below 65% of original length. Enforced by `checkContentPreservation()` in verify.js. Same retry-then-fallback path as fabrication rejection.

**C. Honest re-score.** The "after" score shown in the audit report is a real re-computation of the improved resume — never a projected number. Runs post-improvement in `fulfillRatePayment()` before delivery.

---

## 6. Bench commands

```bash
# Parse only (no LLM cost) — layer used, word count, multi-col flag, refuse reason
node scripts/rate-parse.js <path.pdf> --no-llm

# Full parse + LLM extract → resume_json
node scripts/rate-parse.js <path.pdf>

# Score (deterministic 6.0)
node scripts/rate-score.js <path.pdf> --role "Backend Engineer" --verify-cache

# Score (full 10.0 with LLM)
node scripts/rate-score.js <path.pdf> --role "Data Analyst" --llm

# Improve pipeline (parse → extract → improve → per-bullet diff + verifier)
node scripts/rate-improve.js <path.pdf> --role "Data Analyst"

# Improve + re-score + student-facing audit report
node scripts/rate-improve.js <path.pdf> --role "Data Analyst" --audit

# Fabrication regression (200ms, no LLM). Runs in pre-commit check.
npm run test:rate-verify

# End-to-end state machine (no WhatsApp, no payment gateway)
node scripts/rate-flow.smoke.js [path.pdf]

# End-to-end fulfillment (real Puppeteer + real Supabase, mocked outbound send)
node scripts/rate-fulfill.smoke.js [path.pdf] [--role "Data Analyst"]

# Cross-mode contamination check (rate + build + rate on same phone)
node scripts/rate-and-build.smoke.js [path.pdf]
```

---

## 7. Common failure modes + where to look

| Symptom | Likely cause | Where to look |
|---|---|---|
| Student's PDF parses but extraction returns empty/broken | Multi-column Canva template that slipped past parse-layer detection | `parse.js` — `detectMultiColumn` / `detectLetterSpacedHeaders`; `extract.js` — `checkExtractionQuality` |
| "Rate my resume" text in build mode still triggers the "we don't rate" refusal | Mode-aware guard broken | `router.js` — `REVIEW_EXISTING_RE` check must be gated on `session.mode === 'build'` |
| PDF upload doesn't work; student gets attachment refused | State not in `RATE_AWAITING_PDF` or `AWAITING_MODE_SELECT` | `whatsapp.js` — `stateAcceptsAttachment` |
| Payment succeeds but no PDF delivered | `fulfillPaymentByMode` didn't route to `fulfillRatePayment` | `dispatch.js` — check `session.mode` and `session.state.startsWith('RATE_')` |
| Improved bullet contains something not in source | Verifier gap | Add a fixture to `scripts/rate-verify.test.js` reproducing it, then patch `verify.js` |
| Score fluctuates run-to-run for same PDF | Uncached; cache jd_intel by role in Redis | `score-combined.js` (or wire Redis cache in `score-llm.js#scoreRoleFit`) |
| WhatsApp truncation on audit report | Chunk boundary too aggressive | `audit.js` — `MAX_WHATSAPP_CHARS` (currently 3900) |
| Meta CDN download fails / hangs | Token expired or rate limit | `meta.js` — `downloadMedia` throws with the Meta HTTP status |
| Dashboard shows 0 rate metrics | Event names not in allowlist | `telemetry/events.js` — `EVENT_NAMES` set |

---

## 8. When to add a new state / prompt / event

**New state**: `states.js` (add to `STATES` + `RATE_STATES` set) → `rate-router.js` (case in `handleRateInner` switch) → `rate-prompts.js` (any new messages). Never touch build's state machine.

**New prompt**: `rate-prompts.js` only. Every message rate mode ever sends should live there.

**New refuse reason**: `parse.js` returns it in `meta.refuseReason` → `rate-prompts.js#refusePdf` adds a case with a Hinglish message + solution tip. Log the reason via `logEvent({ eventName: 'rate_parse_refused', payload: { reason }})`.

**New event name**: `telemetry/events.js#EVENT_NAMES`. Otherwise `logEvent` silently drops it.

**New improve heuristic**: think hard about which failure mode. Fabrication? → new fixture in `rate-verify.test.js` + patch `verify.js`. Over-compression? → tune thresholds in `checkContentPreservation`. Improver getting lazy? → tune `IMPROVER_SYSTEM` in `improver.js`.

---

## 9. Non-goals (v2 rate mode does NOT do these)

- **OCR on image PDFs.** Layer 3 refuse fires. Adding OCR is a Day 10+ decision — accuracy is fickle and adds 10-30s of latency.
- **Modify a resume without a new score.** Rate mode always re-scores after improvement. Rejecting this simplification would break the "honest number" guarantee.
- **Edit loop after payment.** Not yet wired for rate mode. Building it means: (a) audit trail as edit input, (b) mode-aware edit budget. Deferred; the improved+audit combo is enough for launch.
- **Multi-column PDF un-jumble.** Chaotic layouts refuse gracefully. Attempting to reconstruct reading order is a research problem, not a v2 problem.
- **Non-tech role rubrics.** `roleType: 'tech'` is hardcoded in `rate-router.js`. Business/design/etc. rubrics are a post-pilot expansion.

---

## 10. Regression contract (before every commit)

Three suites; all must be green:

1. `npm run test:rate-verify` — fabrication guard (200ms, no LLM). Wired into `.runtime/check.js`.
2. `node scripts/rate-flow.smoke.js` — end-to-end state machine (~30s, real LLM).
3. `node scripts/rate-fulfill.smoke.js` — payment fulfillment (~30-45s, real Puppeteer + Supabase + LLM). Optional if only prompt/state changes; mandatory before merging to main.

Cross-mode: `node scripts/rate-and-build.smoke.js` — proves no contamination when the same phone flips between modes. Mandatory before any change to `router.js` or `dispatch.js`.
