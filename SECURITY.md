# Security

Posture for BHARAT RESUME (PRD v1 prototype). Last reviewed: 2026-06-19.

## Threat model (one-paragraph)

We accept inbound WhatsApp messages from students, run them through external LLM APIs, scrape Naukri job pages, generate PDFs of personal resumes, and process ₹49 UPI payments. Our highest-risk assets are: (1) student PII inside resume JSON, (2) third-party API credentials (OpenAI, Anthropic, Twilio, Razorpay, Supabase), (3) the Razorpay webhook (anyone forging it could mark a free user as paid). Our most likely attacker is a script kiddie scanning the public repo for leaked keys or hitting our endpoints unauthenticated; a determined attacker would attempt webhook forgery or prompt injection.

## Controls in place

| Risk | Control | Where |
|---|---|---|
| Secret leak in repo | `.gitignore` blocks `.env*` with `.env.example` whitelisted; no real keys ever in tracked files | `.gitignore` |
| Secret leak in logs | Pino `redact` paths for auth headers, signature headers, all `*.secret`/`*.token`/`*.password`/`*.apiKey`, and every named config key | `src/logger.js` |
| Raw phone numbers in storage / logs | SHA-256 hash before persisting; short hash (12 chars) for log correlation | `src/security/hash.js`, used in `src/routes/twilio.js` |
| Forged Twilio webhook | `X-Twilio-Signature` validation against full URL + body params, behind proxy via `trust proxy` | `src/security/twilioSignature.js` |
| Forged Razorpay webhook | HMAC-SHA256 over raw body, `crypto.timingSafeEqual` compare | `src/payment/razorpay.js`, `src/routes/razorpay.js` |
| Public admin dashboard | HTTP Basic Auth with constant-time compare; rejected with 503 in production if password unset | `src/security/basicAuth.js`, applied in `src/routes/admin.js` |
| Header-based fingerprinting / common web vulns | `helmet` defaults; `x-powered-by` disabled | `src/server.js` |
| Oversized request bodies | `express.json` / `express.urlencoded` capped at 100kb | `src/server.js` |
| LLM prompt injection | LLM responses constrained to strict JSON mode (PRD §7.5); output validated against schema before persistence | TODO Day 2 |
| Abuse / spam from a single phone | Per-phone rate limit in Redis: 30 messages / 60s (PRD §13.3) | TODO Day 2 |

## Controls planned (per build day)

- **Day 2**: zod validation of every LLM output before merging into `resume_json`; per-phone Redis rate limit.
- **Day 3**: Puppeteer sandbox flags (`--no-sandbox` only if running as non-root in container); user-agent rotation isn't a security control but reduces blocking.
- **Day 4**: Signed Supabase URLs at 60s TTL — already specified in PRD §5 Phase 3.
- **Day 5**: Verify Razorpay payment status server-side before marking paid, not just from webhook payload.
- **Day 6**: `npm audit` clean on deploy; Railway env vars set, never in repo.

## What we do NOT defend against (and why)

- **Sophisticated scraping defeat**: a determined attacker can OCR the watermarked PDF. PRD §10 names this — the rasterization makes it expensive enough that ₹49 is the cheaper option for a real student.
- **DDoS**: Railway absorbs basic floods; we don't run our own WAF in v1.
- **Account takeover**: there are no student accounts — the only auth surface is admin basic auth, scoped to Meet.

## Secret handling — checklist for Meet

- [ ] `.env` is local-only. Never commit. Confirm with `git ls-files | grep -i env$` before every push (should return only `.env.example`).
- [ ] Never paste a real key into PRD, README, PROGRESS.md, or commit messages. If a key leaks, rotate immediately:
  - Twilio: console.twilio.com → Account → API keys → revoke + regenerate.
  - OpenAI: platform.openai.com/api-keys → revoke + new key.
  - Anthropic: console.anthropic.com → API Keys → delete + new.
  - Supabase: dashboard → Project Settings → API → regenerate `service_role`.
  - Razorpay: dashboard → Settings → API Keys → regenerate.
- [ ] Railway env vars are the source of truth in production. Set them in the Railway dashboard, not by uploading a `.env` file.
- [ ] When sharing the repo URL publicly, do a final `git log -p | grep -i -E '(api[_-]?key|secret|token|password)'` — should turn up zero hits.

## Responsible disclosure

Found something? Email **meetkabra149@gmail.com** with the subject `[bharat-resume security]`. No bug-bounty in v1 but legitimate reports get a thank-you and a fix within 72h.
