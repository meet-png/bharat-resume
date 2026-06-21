# BHARAT RESUME

WhatsApp-first AI resume builder for Indian college students. The student chats with **Saathi** in Hindi / English / Hinglish; Saathi extracts info, scrapes the target JD, rewrites everything into impact-oriented English, returns a watermarked PDF, and unlocks a clean version after a ₹49 UPI payment.

Spec: `BHARAT_RESUME_PRD.md` (v1 Prototype, 19 June 2026). Target cohort: 100 JECRC University students. Target ship: 25 June 2026.

## Stack

Node 20 LTS · Express · Twilio Sandbox (WhatsApp) · Upstash Redis · Supabase (Postgres + Storage) · OpenAI `gpt-4o-mini` (default) · Anthropic `claude-sonnet-4-6` (fallback) · Puppeteer (Naukri scrape + HTML→PDF) · Razorpay Payment Links (test mode) · Railway (host).

## Local setup

```bash
npm install
cp .env.example .env       # fill in keys
npm run dev                 # starts on :3000
```

Expose `/webhook/twilio` to Twilio Sandbox via ngrok during local dev:

```bash
ngrok http 3000
# paste https URL + /webhook/twilio into Twilio Sandbox config
```

## Build sequence (PRD §18)

- **Day 1 (19 Jun)** — Scaffolding + `/webhook/twilio` echo
- **Day 2 (20 Jun)** — State machine + info collection
- **Day 3 (21 Jun)** — LLM rewrite + Naukri scrape
- **Day 4 (22 Jun)** — PDF rendering + watermark
- **Day 5 (23 Jun)** — ATS score + payment + edit loop
- **Day 6 (24 Jun)** — Telemetry, `/admin/metrics`, Railway deploy, dry run
- **Day 7 (25 Jun)** — Launch to 100

## Project layout

See PRD §16. One-line summary: `src/` is split by concern — `state/`, `llm/`, `jd/`, `resume/`, `payment/`, `store/`, `telemetry/`, `templates/`. Routes live in `src/routes/`.

## Decisions log

Mid-build choices that diverged from PRD defaults or resolved an Open Item (PRD §20). Append, don't rewrite.

- 2026-06-19 — Scaffolded with PRD §16 layout. Day 1 only implements `/health` and `/webhook/twilio` echo; all other files are stubs with TODO markers referencing PRD sections.
- 2026-06-20 — **PRD §7.5 divergence: dropping Anthropic fallback for v1.** Single-provider routing: `gpt-4o-mini` with strict JSON mode for everything; on JSON parse failure, retry once with `gpt-4o-mini` itself (different seed). If quality issues surface during the 100-student test, escalate to `gpt-4o` (same provider) or re-add Anthropic. Saves a signup, an SDK, and ~$5 prepay; loses provider-outage redundancy (acceptable at prototype scale). `ANTHROPIC_API_KEY` in `.env` stays blank — config already tolerates that.
- 2026-06-21 — **PRD §5 step 7 amended: JD step has 3 paths.** Student can send (a) a full Naukri URL / JD text, (b) just the role name ("Data Analyst", "Marketing Manager"), or (c) "no specific role" for a generic resume. Heuristic classifier in `src/state/router.js#classifyJdInput` — no extra LLM call. Stored in session as `jd_url` / `jd_role` / `jd_text` / `jd_generic`.
- 2026-06-21 — **PRD §13.1 divergence: certifications collected as `{name, url}` only.** Day 4 template renders as hyperlink (name = display, url = href). No issuer/date follow-up — Meet's UX call to reduce friction.
- 2026-06-21 — **New module `src/enrichment/github.js`** (not in PRD §16). Fetches GitHub repo metadata + README excerpt when a student drops a repo URL during projects step; LLM uses it to fill tech_stack and bullets without re-prompting. Best-effort, 4s timeout, never blocks. `GITHUB_TOKEN` added as optional env var.
- 2026-06-21 — **Hinglish + English only (Latin script).** All `PROMPTS` and `MESSAGES` rewritten without Devanagari. `pickPrompt` / `pickMessage` random-select from 3–5 variants per state for conversational variety. `clarification_needed` from LLM also Latin-only (enforced via system prompt).
- 2026-06-21 — **Role-aware extraction.** Every per-section LLM call gets the target role/JD context via `buildJdContext()` in `src/llm/extract.js`. Sufficiency checks for Experience and Projects ask role-native questions (marketing → reach/CTR; engineering → latency/scale; etc.) instead of hardcoded tech-flavored examples.
- 2026-06-21 — **Day 5.2 payment unlock design.** `pay` lazily creates a ₹49 Razorpay Payment Link (not auto-on-DELIVERED — avoids a link for every student who never converts). The student's phone **hash** (not the raw number) goes in the link's `notes` so the `payment_link.paid` webhook can map back to a Redis session without leaking PII into Razorpay's dashboard; the raw `whatsapp:+91…` address lives only in the private Redis session (`phone_from`, never logged). Fulfilment regenerates the clean (un-watermarked) PDF and pushes it via an outbound Twilio REST call (`src/messaging/twilio.js`) since the webhook is async and can't use TwiML. Idempotency is a Redis `razorpay_paid:{payment_id}` NX lock, released on *unexpected* failure so Razorpay's retry can re-run; a failed outbound send never rolls back a settled payment. State graph: DELIVERED → AWAITING_PAYMENT → PAID_COMPLETE.
- 2026-06-21 — **Lean WhatsApp preview (PRD §5 Phase 4 amended).** Original PRD design surfaced a content-rich text preview alongside the watermarked PDF. Problem: the preview is plain WhatsApp text that anyone can long-press → copy → paste into Word, bypassing the ₹49 unlock entirely. Replaced with a tight CTA caption: student name + ATS score + JD-match count (tease only) + watermark/ATS-unreadable framing + edit/pay CTA. PDF is the only surface where rewritten content (bullets, summary, project descriptions) lives. Trade-off: one extra tap for the student to see the work; eliminates the copy-paste leak. Storage isn't doubled — watermarked PDF is generated for everyone (1 per user); clean PDF is generated only on payment.
