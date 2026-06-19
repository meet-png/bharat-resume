# BHARAT RESUME — Build Progress

**Living build log.** Updated at the end of every Claude Code session so the next session can pick up cold without re-reading the entire repo. The source of truth for *what* to build is `BHARAT_RESUME_PRD.md`. This file tracks *how far* we are.

**Convention for Claude Code (every session):**
1. Read this file before touching code.
2. Read PRD sections referenced under "Next session — start here".
3. At end of session: update §1 status grid, append a §3 session entry, refresh §4 open questions, save the file. Keep it under ~250 lines — trim §3 once entries cross 30 days old.

---

## 1. Build sequence status (PRD §18)

| Day | Date | Milestone | Status | Notes |
|---|---|---|---|---|
| 1 | Thu 19 Jun | Scaffolding + WhatsApp echo | ✅ Done | Verified live: WhatsApp → Twilio Sandbox → ngrok (static domain `babble-fifteen-rust.ngrok-free.dev`) → Express → TwiML reply. Slightly into Day 2 calendar-wise; not a blocker. |
| 2 | Fri 20 Jun | State machine + info collection | 🟡 In progress | OpenAI key signup next. |
| 3 | Sat 21 Jun | LLM rewrite + JD scrape | ⬜ Not started | |
| 4 | Sun 22 Jun | PDF rendering + watermark | ⬜ Not started | |
| 5 | Mon 23 Jun | ATS score + payment + edit loop | ⬜ Not started | |
| 6 | Tue 24 Jun | Telemetry, dashboard, deploy, dry run | ⬜ Not started | |
| 7 | Wed 25 Jun | Launch to 100 | ⬜ Not started | |

Legend: ⬜ not started · 🟡 partial · ✅ done · 🔴 blocked

---

## 2. Current implementation state

**Working (verified end-to-end against live services):**
- Express server boots on `:3000` with pino logging, `helmet`, body-size cap, and `trust proxy: 1`.
- `GET /health` → `{ ok: true, ts: ... }`.
- `POST /webhook/twilio` → **signature-validated**; Day 1 echo flow verified live via WhatsApp → Twilio Sandbox → ngrok (static `babble-fifteen-rust.ngrok-free.dev`) → Express → TwiML reply.
- `POST /webhook/razorpay` → **HMAC-SHA256 signature validated**; verifier proven correct (accepts valid, rejects tampered, rejects missing) via `.runtime/smoke-razorpay.js`.
- Razorpay Payment Link create-and-cancel verified against test-mode API.
- Supabase: 4 tables + 2 indexes + RLS enabled (`db/schema.sql` applied); `resumes` storage bucket created (private). Service-role connection verified.
- Upstash Redis (Mumbai): connection, `SET`/`GET`/`EXPIRE`/`DEL` verified; TTL semantics confirmed (required for the 24h session pattern). Redis 8.2.0.
- OpenAI: `gpt-4o-mini` smoke call returned in <1s for $0.000004; on track for PRD's ₹0.10-0.15/resume.
- `GET /admin/metrics` → **Basic Auth gated**; handler stub (Day 6).
- `src/state/states.js` — full state constants + linear Phase 2 transition table.
- `src/jd/parse.js` — Naukri URL detector + generic URL guard.
- `src/security/{hash,twilioSignature,basicAuth}.js` — phone hashing, webhook validation, admin auth.
- Pino logger redacts secrets and PII fields by default. `src/config.js` tolerates empty `.env` values (zod preprocess).

**Scaffolded but not implemented (stubs throw, with `TODO Day N` markers pointing at PRD sections):**
- `src/state/router.js` (Day 2) · `src/state/prompts.js` (partial — first 2 prompts; Day 2 to fill rest)
- `src/llm/{client,extract,rewrite,edit,keywords}.js` (Day 2–5)
- `src/jd/scrape.js` (Day 3 — Naukri Puppeteer scraper)
- `src/resume/{render,pdf,watermark,ats_score}.js` (Day 4–5)
- `src/payment/razorpay.js` (Day 5)
- `src/store/{postgres,redis,storage}.js` — clients/getters in place; query helpers TODO
- `src/telemetry/events.js` (Day 6 — event taxonomy constant defined)
- `src/templates/resume.hbs` — head/contact only; sections TODO (Day 4)

**Not yet:**
- Railway deploy (Day 6 milestone)
- Day 2 implementation work: state router, LLM extraction/rewrite, prompts.js fill-in (PRD §5 Phase 2 table)
- Day 3+: JD scraper, PDF render, watermark, ATS scorer, edit loop, telemetry, metrics dashboard

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

### Session 2 — 2026-06-19 evening → 2026-06-20 early morning (Claude Opus 4.7)

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
- [ ] **Razorpay live KYC** — Meet to submit PAN/Aadhaar/bank in dashboard. 2-4 day review. Run in parallel; not blocking.
- [ ] **PRD §20 open items** — Naukri DOM selector (Day 3), ATS keyword count weighting (Day 5), edit iteration limit (Day 6), per-prompt tone tuning (Day 2). Resolve as we hit each.

---

## 5. Files & locations cheat sheet

- PRD: `BHARAT_RESUME_PRD.md` (lives in Meet's `Downloads/`; not in repo).
- This file: `PROGRESS.md`.
- Decisions log: `README.md` → "Decisions log".
- Env shape: `.env.example`. Real `.env` is local-only (gitignored).
- Code layout: PRD §16 — `src/{routes,state,llm,jd,resume,payment,store,telemetry,templates}/`.
- Postgres schema source of truth: PRD §13.1 (apply manually in Supabase SQL editor for now; consider a `db/schema.sql` once Meet signs up).
