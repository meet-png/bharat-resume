# BHARAT RESUME — Build Progress

**Living build log.** Updated at the end of every Claude Code session so the next session can pick up cold without re-reading the entire repo. The source of truth for *what* to build is `BHARAT_RESUME_PRD.md`. This file tracks *how far* we are.

**Convention for Claude Code (every session):**
1. Read this file before touching code.
2. Read PRD sections referenced under "Next session — start here".
3. At end of session: update §1 status grid, append a §3 session entry, refresh §4 open questions, save the file. Keep it under ~250 lines — trim §3 once entries cross 30 days old.
4. **Before committing ANY change:** run `npm run check`. It must finish with `✅ ALL CHECKS PASSED — safe to commit`. If anything fails, fix the regression OR explicitly tell Meet what's broken and get permission to proceed — never silently commit with a red check. See §6 below for the contract.

---

## 1. Build sequence status (PRD §18)

| Day | Date | Milestone | Status | Notes |
|---|---|---|---|---|
| 1 | Thu 19 Jun | Scaffolding + WhatsApp echo | ✅ Done | Verified live: WhatsApp → Twilio Sandbox → ngrok (static domain `babble-fifteen-rust.ngrok-free.dev`) → Express → TwiML reply. |
| 2 | Fri 20 – Sun 21 Jun | State machine + info collection | ✅ Done | Full Phase 2 flow live: 13 sections, sufficiency-aware extraction, role-aware clarifications, GitHub repo enrichment for projects, 3-path JD (URL / role-name / generic / full JD text), Hinglish+English only (Latin script), 4 variants per state. 7-block offline smoke (`.runtime/smoke-router.js`) all pass. Verified end-to-end on WhatsApp. |
| 3 | Sat 21 Jun | LLM rewrite + JD scrape | ✅ Done | Generation pipeline runs in ~8s (scrape + keywords + rewrite). Rewriter voice locked to `docs/template-reference.md` (Meet's actual resume). Preview shows Meet-style summary, action-verb bullets with selective `**bold**` on metrics, real keyword intersection (not raw JD list). 4 field-test bugs fixed: name re-asked, project link never asked, cert link never asked, weak preview / inflated keyword stuffing. |
| 4 | Sun 22 Jun | PDF rendering + watermark | ✅ Done | WhatsApp delivers a real PDF: rewriter (Meet-template voice + 2-3 multi-angle bullets) → Handlebars HTML (Georgia + reference palette) → Puppeteer PDF → rasterized watermark → Supabase upload → 60s signed URL → Twilio `<Media>`. ~13s end-to-end. Six template-quality issues fixed (multi-metric bullets, per-entry tech stack inline italic, coursework state, achievement sufficiency, PoR pending accumulator, "Your skills matching the JD" labels real intersection). Regression contract live: `npm run check`. |
| 5 | Mon 23 Jun | ATS score + payment + edit loop | 🟡 Partial | **5.1 ATS scorer ✅** (rewards bullet density + metric count, not just keyword match). **5.2 Razorpay payment unlock ✅** — `pay` → ₹49 Payment Link → `payment_link.paid` webhook → clean (un-watermarked) PDF regenerated + pushed outbound via Twilio API. Idempotent against webhook retries (Redis dedupe lock + unmark-on-failure). State graph: DELIVERED → AWAITING_PAYMENT → PAID_COMPLETE. **5.3 free-text edit loop ⬜ next.** |
| 6 | Tue 24 Jun | Telemetry, dashboard, deploy, dry run | ⬜ Not started | |
| 7 | Wed 25 Jun | Launch to 100 | ⬜ Not started | |

Legend: ⬜ not started · 🟡 partial · ✅ done · 🔴 blocked

---

## 2. Current implementation state

**Working (verified end-to-end against live services):**
- Express server boots on `:3000` with pino logging, `helmet`, body-size cap, `trust proxy: 1`, and a startup banner that logs `routerMtime` so "old code still running" can never be a silent bug.
- `GET /health`, `POST /webhook/twilio` (signature-validated), `POST /webhook/razorpay` (HMAC verified), `GET /admin/metrics` (basic auth gated stub).
- Razorpay test-mode Payment Link round-trip verified; HMAC signature verifier proven correct against valid/tampered/missing.
- **Payment unlock (Day 5.2)**: `pay` in DELIVERED creates a ₹49 link (`src/payment/razorpay.js#createPaymentLink`, phone *hash* in `notes`, never the raw number). `POST /webhook/razorpay` verifies the HMAC, parses `payment_link.paid`, and `src/payment/fulfill.js#fulfillPayment` regenerates the clean PDF + pushes it outbound (`src/messaging/twilio.js#sendWhatsApp`). Idempotent: Redis `razorpay_paid:{payment_id}` NX lock (released on unexpected failure so Razorpay retries can re-run). Outbound send failure does NOT roll back a settled payment. `phone_from` persisted server-side on the session (private Redis only, never logged) so the async webhook can reach the student.
- Supabase Postgres: 4 tables + 2 indexes + RLS, `db/schema.sql` is source of truth. `resumes` storage bucket private.
- Upstash Redis (Mumbai): session store, JD cache key prefix, and rate limit (`30/60s per phone`) all wired. Helpers in `src/store/redis.js`.
- **Day 2 state machine** (`src/state/router.js`): full PRD §6 state graph, NEW/CONFIRM_START unified, `reset` seeds AWAITING_CONFIRM_START and replies with confirmation + welcome in one message. SKIP_RE handles `skip`/`no`/`nahi`/`nope`/`none`/`nothing`. Top-of-handler tracing with branch/state/bodyHead logs.
- **3-path JD step**: heuristic classifier routes input to `jd_url`, `jd_role` (short single-line, no JD markers), `jd_text` (long/markers/many commas), or `jd_generic` (no specific role). No extra LLM call — purely deterministic + free.
- **Role-aware extraction** (`src/llm/extract.js` `buildJdContext`): every per-section LLM call gets the JD/role context. Sufficiency check + targeted clarifications in `AWAITING_EXPERIENCE` and `AWAITING_PROJECTS`. Clarifications adapt the metric vocabulary to the target role — Marketing → reach/CTR/leads; Engineering → latency/scale/RPS; Civil → budget/timeline/safety; etc. Smoke `.runtime/smoke-router.js` Block 7 confirms 5/5 unique role-tailored clarifications.
- **GitHub project enrichment** (`src/enrichment/github.js`): when a student drops a `github.com/owner/repo` URL into the projects step, we fetch repo metadata + languages + README excerpt (best-effort, 4s timeout, GITHUB_TOKEN optional for rate limit), pass to LLM so it doesn't re-ask for tech stack.
- **Hinglish + English only**: Latin script enforced — `src/state/prompts.js` has 4 variants per state with `pickPrompt`/`pickMessage` random selection. Extract.js system prompt also bans Devanagari in `clarification_needed`. Smoke runs a Devanagari leak detector across every reply (0 leaks).
- **Cert simplification** (Decisions log 2026-06-21): collect `{name, url}` only. No more issuer/date follow-ups. Day 4 template will render as hyperlink (name = display, url = href).
- **PoR jargon removed**: "leadership/responsibility role" with examples, no "PoR" acronym anywhere.
- Pino logger redacts all known secret-bearing keys + auth/signature headers. PII (phone) sha256-hashed before logging.

**Scaffolded but not implemented (stubs throw, with `TODO Day N` markers):**
- `src/llm/{rewrite,edit,keywords}.js` — Day 3 (rewriter takes raw `resume_json` + JD context → impact-oriented English) / Day 5 (edit prompt for free-text edits)
- `src/jd/scrape.js` (Day 3 — Naukri Puppeteer scraper)
- Day 5.3: free-text edit loop (edit prompt → re-rewrite specific sections → regenerate watermarked PDF)
- `src/store/{postgres,storage}.js` — query helpers + signed-URL helpers
- `src/telemetry/events.js` (Day 6 — event taxonomy constant defined)
- `src/templates/resume.hbs` — head/contact only; sections TODO (Day 4)

**Not yet:**
- Railway deploy (Day 6 milestone). Local + ngrok-fronted dev is current setup.

---

## 3. Session log

### Session 1 — 2026-06-19 (Claude Opus 4.7)

**Did:**
- Created `C:\Users\ACER\bharat-resume`. Initial Next.js scaffold (wrong stack from before PRD was shared) wiped and replaced with PRD §16 Express layout.
- Wrote `package.json` with exact PRD §3 npm deps (+ `handlebars`, `sharp`, `pino-http` derived from PRD references). Node engines pinned to `>=20`.
- Wrote `.env.example` verbatim from PRD §17.
- Wrote `README.md` (stack summary + Decisions log section).
- Wrote `PROGRESS.md` (this file).
- Implemented Day 1 milestone code: `src/server.js`, `src/config.js`, `src/logger.js`, `src/routes/{twilio,razorpay,admin}.js`, plus all stubs for Days 2–6.
- Created `public/payment-success.html`.
- Installed GitHub CLI (`gh` 2.95.0) via winget.
- Started `npm install` (in background — large because of Puppeteer's Chromium download).

**Did not (deferred / blocked):**
- GitHub repo not yet created — waiting for confirmation of username `meet-png` and that pushing now (before any secrets land in `.env`) is OK.
- Could not test the running server end-to-end — Twilio sandbox not signed up yet.
- `gh auth login` not run — it's interactive; Meet will need to do it in their own terminal (or paste a PAT).

**Decisions made (also logged in README):**
- Scaffolded all PRD §16 files at once with stubs that `throw` + `TODO Day N` comments. Trade-off: a bit of noise now, but Claude in future sessions sees the full file map and knows exactly which PRD section to read for each unimplemented file.
- Added `handlebars`, `sharp`, `pino-http`, `helmet` to deps — implied by PRD §9 (template), §10 (watermark compositing), §3 (logging), and Meet's "security top-notch" mandate.
- Security hardening pulled forward from Day 5/6 to Day 1: webhook signature verification (both sides), basic auth, phone hashing, log redaction, helmet, body-size caps, `.gitignore` whitelist pattern. Trade-off: ~250 lines of code now vs. retrofitting later — worth it. SECURITY.md added as the single-page threat model.
- `src/state/prompts.js` only has the first 2 prompts seeded; Day 2 will fill the rest from PRD §5 Phase 2 table.

**Next session — start here:**
1. Read `BHARAT_RESUME_PRD.md` §6 (state machine), §7.1 (extraction prompt), §13.3 (Redis keys), §5 Phase 2 table. Note: §7.5 fallback dropped (single-provider OpenAI per Decisions log).
2. Implement `src/state/router.js#handle({ phoneHash, body })` — load Redis session, route by state, call LLM extract, transition, persist, return reply.
3. Implement `src/llm/client.js#complete()` — `gpt-4o-mini`, strict JSON mode (`response_format: { type: 'json_object' }`), one retry on parse failure with the same model.
4. Implement `src/llm/extract.js` for one section (name) end-to-end against real OpenAI key, then duplicate the pattern for the remaining 12.
5. Fill `src/state/prompts.js` from PRD §5 Phase 2 table (आप, ≤2 lines per prompt).
6. Wire `src/routes/twilio.js` to call `state/router#handle` instead of echoing.
7. Per-phone rate limit in Redis (PRD §13.3): 30 msg/60s.
8. Day 2 milestone: complete the full Q&A flow against Redis; eyeball the final `resume_json`.

### Session 3 — 2026-06-20 → 2026-06-21 (Claude Opus 4.7)

**Did (Day 2 implementation, fully verified):**
- Wrote `src/llm/client.js#complete()` (OpenAI gpt-4o-mini, strict JSON, single-provider retry on parse failure).
- Wrote `src/llm/extract.js` with declarative `SECTION_CONFIG` for all 13 Phase 2 states — each has its own LLM instruction, JSON shape hint, and merge function.
- Wrote `src/state/router.js#handle({ phoneHash, body })` — full state machine with rate limit, signature-protected webhook route, top-of-handler trace logging.
- Filled `src/state/prompts.js` with 3–5 Latin-script variants per state; added `pickPrompt`/`pickMessage` random selectors.
- Wired `src/routes/twilio.js` to call router; phone numbers sha256-hashed before any log line.
- Added `src/enrichment/github.js` (PRD-divergent module; logged in README Decisions log 2026-06-21) — fetches GitHub repo metadata + README excerpt when student drops a repo URL in projects step.
- Built `buildJdContext()` so every per-section extract gets the JD/role-name/JD-text/generic flag injected — clarifications and bucket-classification calibrate to the target role automatically.
- Built 3-path JD step with deterministic heuristic classifier: URL / role-name / full JD text / generic. Heuristic uses length + newline + JD markers + comma count.
- Implemented sufficiency check for Experience + Projects: LLM evaluates (a) who/where (b) action (c) impact; if any missing, asks ONE targeted question (not the whole question again). Examples for clarifications are role-derived, not hardcoded.
- Simplified Cert step to `name + url` only (no issuer/date follow-ups) — Day 4 template will render hyperlink. PRD §13.1 / §7.2 divergence logged in README.
- Dropped "PoR" acronym from prompts — plain language ("leadership/responsibility role").
- Fixed three bugs Meet found in field testing:
  1. **state=NEW fallthrough**: `reset` left state=NEW; main switch had no NEW branch → every subsequent message fell to beyondPhase2. Fixed by handling NEW alongside AWAITING_CONFIRM_START + making reset reply with confirmation + welcome in one message.
  2. **achievements loop**: SKIP_RE only matched "skip" literal; "no"/"nahi"/"none" looped. Expanded to all common negatives.
  3. **stale code running**: server boot now logs `routerMtime` so we can verify which version of state machine is live.
- `.runtime/smoke-router.js` extended to 7 blocks (reset regression, full 15-step flow, JD generic, achievement negatives, experience sufficiency, JD classification, role-aware clarifications). All pass.

**Surprises:**
- LLM was literally copying tech-flavored example phrases from the instruction (e.g., "intern, developer, designer"). Had to strip the examples and replace with role-derived patterns.
- ngrok+server processes survived several hours of laptop idle without dropping — better than expected on free tier.
- `Start-Process -RedirectStandardOutput` truncates the log on every restart — caused initial confusion ("server.log has no Twilio POSTs!" actually meant "old server wrote that log, new server truncated it"). Boot banner with `routerMtime` solves this for future restarts.

**Decisions made (also in README Decisions log):**
- 3-path JD (URL / role / generic / full JD) instead of just URL-or-text. Heuristic classifier — no extra LLM call.
- `pending_project` accumulator in projects step — message-by-message refinement until LLM says sufficient OR student types `done`/`skip`.
- GitHub enrichment is a NEW module not in PRD §16 — `src/enrichment/github.js`. Best-effort, never blocks. `GITHUB_TOKEN` added as optional env var.
- Cert schema diverges from PRD §13.1 — `{ name, url }` not `{ name, issuer, date }`. Day 4 template will adapt.
- Skill bucket schema kept stable (`languages/frameworks/tools/databases/other`) but content adapts to target role — for non-tech roles, role-appropriate items fall into `tools`/`other`.

**Next session — Day 3 (LLM rewrite + JD scrape):**
1. Read PRD §7.2 (rewriter prompt), §7.4 (JD keyword extractor), §8 (JD scraping), §9 (template), §10 (watermark).
2. Implement `src/llm/rewrite.js` — takes raw `resume_json` + JD context (role / text / keywords / generic) → returns `resume_json_rewritten` with action-verb bullets, impact-oriented summary, role-tailored framing. Use the same `buildJdContext` pattern.
3. Implement `src/llm/keywords.js` — extract top 15 hard skills/tools from `jd_text` or, for jd_role, infer typical keywords for that role.
4. Implement `src/jd/scrape.js` — Puppeteer Naukri scraper. Verify the live DOM selector first (PRD §20 open item). Cache by `sha256(url)` in Redis 24h.
5. Implement `src/store/postgres.js` insert/upsert helpers — start writing users + resumes rows at end of Phase 2.
6. Day 3 milestone: generation runs, produces `resume_json_rewritten` + a basic action-verb bulletified version. PDF render lands Day 4.



**Did:**
- Hit Day 1 milestone live: WhatsApp echo via Twilio Sandbox → ngrok static domain → Express → TwiML reply.
- Completed all 7 signups end-to-end (Twilio, ngrok, OpenAI, Supabase, Upstash, Razorpay) — Anthropic deferred (Decisions log entry).
- Wrote `db/schema.sql` and applied via Supabase SQL Editor. Enabled RLS on all tables as defense in depth.
- Fixed `src/config.js` to treat empty `.env` values as undefined (was crashing on `SUPABASE_URL=` empty after Twilio-only fill).
- Downloaded latest ngrok 3.39.8 manually (winget's 3.3.1 didn't know `--domain`); installed to `C:\Users\ACER\tools\ngrok\`. Static domain pinned.
- `.runtime/` directory holds dev/smoke scripts; gitignored. Three smoke tests live there: OpenAI, Supabase, Redis, Razorpay (with Payment Link + HMAC verify round-trip).
- Pino logger update silences ioredis URL leaks on connection failure (`r.on('error', () => {})` in smoke script).

**Surprises:**
- ngrok's free static domain creation now seems gated to paid; the auto-provisioned one each account gets at signup is the workable freebie.
- OpenAI billing is prepay-only since 2024; adding a card ≠ adding credits.
- Upstash's connection-string UI sometimes omits the `rediss://` scheme. Got Meet's redis password leaked into chat once; rotated immediately.

**Decisions made (also logged in README "Decisions log"):**
- Drop Anthropic for v1 (PRD §7.5 divergence). Single-provider OpenAI with same-model retry. Quality risk acceptable at 100-student scale.
- Empty `.env` values are now treated as undefined in `src/config.js` (via `z.preprocess`), so partial-fill `.env` doesn't crash boot.

**Open items / things to clean up:**
- ngrok 3.39.8 lives at a hand-installed path; if Meet ever runs `winget upgrade --all`, winget will reinstall the older 3.3.1 and PATH might prefer the wrong one. Long-term fix: uninstall the winget version. Skipped for now.
- The deprecated `--domain` flag works on 3.39.8 but logs a warning. Switch to `--url=https://...ngrok-free.dev` next ngrok restart.
- Razorpay live KYC needs to be kicked off by Meet in parallel (2-4 days). Not blocking.

---

### Session — 2026-06-21 (Day 5.2, Claude Opus 4.7)

**Did (Razorpay payment unlock, fully verified):**
- `createPaymentLink({ phoneHash })` — real Razorpay SDK, ₹49 (4900 paise) test-mode link. Phone **hash** (not number) goes in `notes.phone_hash` so the webhook maps back to a session without putting PII in Razorpay's dashboard.
- `POST /webhook/razorpay` now live: HMAC-verify → parse → branch on `payment_link.paid` → `fulfillPayment`. Non-payment events 200-acked and ignored. Bad JSON → 400.
- `src/payment/fulfill.js#fulfillPayment` — dedupe lock (NX) → load session → mark paid → regenerate clean PDF (`deliverPdf({ clean: true })`) → push outbound. Lock released on *unexpected* error so Razorpay retry re-runs; terminal cases (no hash / expired session) are acked. Outbound send wrapped in its own try so a delivery failure never rolls back a settled payment.
- `src/messaging/twilio.js#sendWhatsApp` — new outbound API client (inbound still uses TwiML; the post-payment PDF is async so it needs a REST push).
- Router: `pay` in DELIVERED → `createPaymentLink` → AWAITING_PAYMENT (link in reply). AWAITING_PAYMENT re-sends link on nudge. PAID_COMPLETE terminal. `phone_from` now persisted on every inbound for the webhook to use.
- New regression suite `.runtime/test-payment.js` (19 checks) registered in `check.js`. Covers signature accept/reject/tamper, real test-mode link creation, router pay-flow, clean-PDF fulfilment, idempotency (duplicate webhook = no-op), and graceful no-hash handling.

**Surprises:**
- Twilio `messages.create` to an unjoined sandbox number still returns a SID (queued) and consumes a send — so the test now nulls `phone_from` before fulfilment to avoid firing a real outbound on every `npm run check`. The send path is integration-tested manually instead.

**Decisions made (also in README Decisions log):**
- Lazy link creation (on `pay`), not auto-on-DELIVERED — avoids a Razorpay link for every student who never pays.
- Phone *hash* in Razorpay `notes`; raw number stays in private Redis session only.
- Idempotency via Redis NX lock with unmark-on-failure, rather than a Postgres payments-row check — simpler, and the session is already the source of truth at prototype scale.

**Next session — Day 5.3 (free-text edit loop):**
1. Read PRD §5 Phase 4 (edit loop), §7.3 (edit prompt).
2. `src/llm/edit.js` — take the rewritten resume + a free-text edit request → return a patched `resume_json_rewritten` (targeted, not full re-rewrite).
3. Router: `edit` in DELIVERED → AWAITING_EDIT_OR_DONE → apply edit → regenerate watermarked PDF → back to DELIVERED. Iteration cap (PRD §20 open item).
4. Add edit-loop regression to the suite.

## 4. Open questions for Meet

Carry these forward each session until resolved. Add new ones whenever a build decision needs Meet's input.

- [x] **GitHub username** — `meet-png`. Repo: https://github.com/meet-png/bharat-resume (public).
- [x] **Push policy** — end of each Claude Code session. One commit (or small batch).
- [x] **Twilio Sandbox** — signed up + joined + creds + webhook URL configured + Day 1 echo verified live.
- [x] **ngrok** — installed 3.39.8 manually at `C:\Users\ACER\tools\ngrok\ngrok.exe`. Authtoken registered. Static domain `babble-fifteen-rust.ngrok-free.dev` pinned.
- [x] **OpenAI** — key in `.env`; billing topped up; smoke verified.
- [x] **Anthropic** — **dropped for v1** per Decisions log.
- [x] **Supabase** — Mumbai project, schema applied via `db/schema.sql`, `resumes` private bucket, RLS enabled, connection verified.
- [x] **Upstash Redis** — Mumbai regional instance, TLS URL with `rediss://`, full round-trip verified. Password rotated once after a UI mishap.
- [x] **Razorpay test mode** — keys + webhook secret in `.env`. Test Payment Link creation verified; HMAC verifier proven correct.
- [ ] **🚩 LAUNCH-BLOCKER — Razorpay live KYC + UPI.** Meet to submit PAN/Aadhaar/bank in dashboard (2-4 day review). **Critical:** UPI is the only method our students use, and UPI is unavailable until the account is **activated** — and it does NOT reliably render in **test mode** at all (verified 2026-06-22 live e2e: card worked, UPI option simply absent on checkout). Our code restricts no methods; this is purely account/dashboard config. Path to launch: complete KYC → UPI enables in **live** mode → swap `rzp_test_*` → `rzp_live_*` keys + fresh live webhook secret in `.env` → re-verify a real ₹49 UPI payment before 25 Jun. Do NOT burn time chasing test-mode UPI.
- [ ] **🚩 LAUNCH-BLOCKER — webhook timeout vs. sync fulfillment.** Verified 2026-06-22: the `payment_link.paid` handler runs clean-PDF generation inline (~5.7s), exceeding Razorpay's ~5s webhook timeout. Razorpay aborts the first attempt and retries; fulfillment still completes on attempt 1 and the retry correctly dedupes (no double-send), so students ARE served — but every payment shows "failed then retried" in Razorpay's dashboard, which is noisy and fragile. Fix before launch: ack `200` immediately, run fulfilment async (enqueue or fire-and-forget after responding). Track as Day 5.3/hardening.
- [x] **Day 2 voice / variants** — Hinglish + English only (Latin script). 3–5 variants per state. Saathi tone confirmed acceptable.
- [x] **JD step paths** — 3 paths live (URL / role-name / generic) plus full JD text. Meet confirmed "we are good".
- [x] **Role-aware extraction** — confirmed across 5+ diverse roles in smoke; clarifications adapt to role-native metrics.
- [ ] **PRD §20 open items still open** — Naukri DOM selector (Day 3), ATS keyword count weighting (Day 5), edit iteration limit (Day 6).
- [ ] **GITHUB_TOKEN** — optional env var added to `.env.example`. Not set yet; unauthenticated GitHub API works at 60 req/hr — fine for prototype. Add token if we hit limits.

---

## 6. Regression contract — "must keep working"

`npm run check` runs `.runtime/check.js` which invokes five test files. They take ~2.5 min total and burn ~$0.05 of OpenAI per run. Each is a real end-to-end test against live OpenAI, Supabase, Redis, and (for payment) Razorpay test mode.

**The contract:** anything below is currently verified working. If a future edit breaks any of these, the check fails and you DO NOT commit until it's fixed (or Meet has explicitly approved the change in behavior).

### 6.0 `test-ats.js` — ATS scorer invariants, <1s (no LLM)
- **Thin resume** (1 vague bullet per entry, partial JD-keyword overlap) scores ≤ 70 total.
  Locks in Meet's rule: keyword match alone cannot push thin content to 90+.
- **Dense resume** (2-3 quantified bullets per entry, full JD-keyword overlap) reaches ≥ 80 total.
- **Empty resume** scores < 20 (degenerate case handled, no NaN).
- **Vague verbs** ("worked", "helped", "did") penalize impact score → < 30.
- **No JD keywords** → keyword_match defaults to neutral 50 (generic resume mode doesn't fail).

### 6.1 `smoke-router.js` — 8 blocks, ~75s
- **B1 reset regression**: `reset` → both messages, "hello" after reset, "haan" after reset routes into AWAITING_NAME.
- **B2 full Phase 2 happy path**: 16-step linear flow (incl. AWAITING_COURSEWORK after skills) lands in DELIVERED with PDF preview.
- **B3 JD generic mode**: "no specific role" sets `jd_generic`, advances to AWAITING_SKILLS.
- **B4 achievement negatives**: `no` / `nahi` / `nope` / `none` / `nothing` all accepted as skip-equivalents → reach delivery.
- **B5 experience sufficiency**: vague input stays in state with targeted follow-up; detailed input advances with merged data including company + metric.
- **B6 JD classification**: short-line → `role`, URL → `url`, long with markers → `jd`, generic phrase → `generic`. Heuristic only, no LLM.
- **B7 role-aware clarifications**: same vague input across 5+ diverse roles produces ≥3 unique role-tailored clarifications (Marketing → reach/CTR; Engineering → latency/scale; etc.).
- **B8 Day 3 generation pipeline**: rewrite + keyword extract complete in <15s; rewritten JSON preserves company names, metrics, no Devanagari leaks; preview text contains name + summary.

### 6.2 `test-all-4.js` — 4 bug-class regressions, ~25s
- **Bug 1 NAME accepted liberally**: "Meet Kabra" stored on first try, state advances to AWAITING_EMAIL.
- **Bug 2 PROJECT LINK before IMPACT**: vague project description triggers link question first, NEVER accuracy/metric. After "no link" decline, impact question fires.
- **Bug 3 CERT LINK required**: cert name without URL prompts for verification link; "no link" accepts and advances.
- **Bug 4 PREVIEW quality**: skills section present, all projects shown, "Your skills matching the JD" computes REAL intersection (no false short-keyword matches like "R" matching "Powe[r] BI"), bullets render `*bold*` via WhatsApp markup.

### 6.3 `test-day4.js` — end-to-end PDF delivery, ~25s
- State advances to DELIVERED; `resume_json_rewritten` populated.
- Reply is `{ text, media }` object; media is HTTPS signed URL.
- `pdf_storage_path` + `pdf_signed_url` on session.
- Within Twilio 15s webhook budget.
- Signed URL returns 200, `application/pdf` content-type, valid `%PDF-` header, >5KB.

### 6.4 `test-payment.js` — Razorpay unlock, ~15s
- **Webhook signature**: valid HMAC accepted; tampered sig / missing sig / tampered body all rejected.
- **createPaymentLink**: real test-mode call returns `plink_…` id + HTTPS `short_url` (skips gracefully if keys absent).
- **Router pay flow**: `pay` in DELIVERED → AWAITING_PAYMENT, `payment_link_url` stored, reply carries the URL, `phone_from` persisted.
- **fulfillPayment**: marks `paid`, records `razorpay_payment_id`, advances to PAID_COMPLETE, produces a `clean: true` PDF version; `no_phone_from` path returns ok (no crash).
- **Idempotency**: a second identical webhook is a no-op (`duplicate: true`). Missing `phone_hash` handled gracefully (no throw).
- **PAID_COMPLETE** is terminal (no router fallthrough).

### 6.5 Flake handling
LLM responses and Supabase uploads can intermittently fail under network jitter or rate limits. Policy: **re-run `npm run check` once** before assuming a real regression. If it fails twice in a row on the same check → real regression, fix.

**Flake sources (mitigated 2026-06-21):**
1. Rewrite timeout bumped from 11s → 13s after cold-start flakes. Critical path stays inside Twilio's 15s budget (parallel with keywords).
2. 3s cool-down between suites in `.runtime/check.js`. Without it, back-to-back LLM-heavy E2E tests produced ~1 transient failure per 3 runs (OpenAI/Puppeteer/Supabase didn't enjoy bursts). With the pause, two consecutive `npm run check` runs both green.

---

## 7. Files & locations cheat sheet

- PRD: `BHARAT_RESUME_PRD.md` (lives in Meet's `Downloads/`; not in repo).
- This file: `PROGRESS.md`.
- Decisions log: `README.md` → "Decisions log".
- Env shape: `.env.example`. Real `.env` is local-only (gitignored).
- Code layout: PRD §16 — `src/{routes,state,llm,jd,resume,payment,store,telemetry,templates}/`.
- Postgres schema source of truth: PRD §13.1 (apply manually in Supabase SQL editor for now; consider a `db/schema.sql` once Meet signs up).
- Regression check: `npm run check` → runs `.runtime/check.js` → runs three tests defined in §6. Must pass before any commit.
