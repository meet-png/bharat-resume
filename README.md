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
