# Migration Plan — Twilio Sandbox → Meta WhatsApp Cloud API

**Status:** PLANNING (no code written yet). Author: Claude Opus 4.7, 2026-06-22.
**Owner:** Meet. **Gated on:** a dedicated SIM (bought 2026-06-22, ~24h to activate).

This document is the single source of truth for the migration. It is written so we
can execute it over several days without losing context, and so nothing in the
existing (working, tested) bot breaks on the way.

---

## 0. TL;DR

- **Why:** Twilio sandbox forces every student to send a `join <code>` first — unacceptable for a 100-student pilot. Leaving the sandbox costs $20. Meta Cloud API has **no join code** on a registered number, **no BSP markup**, and its **async-only** model is the architecture we need at scale anyway.
- **The core change:** inbound flips from **synchronous TwiML reply** → **ack-200-immediately + send reply via Graph API**. Everything else (the state machine, LLM, PDF pipeline, payments, telemetry) is provider-agnostic and does **not** change.
- **Safety net:** we keep Twilio fully intact behind a `WHATSAPP_PROVIDER` flag. Flip back instantly if anything goes wrong. Both providers call the same `handle()`.
- **For the pilot you only need the migration.** The queue/Puppeteer-pool scaling work is designed here but deliberately **deferred** — you do not need it for 100 students.

---

## 1. What stays exactly the same (the blast-radius boundary)

These are **untouched** by the migration — this is why the risk is contained:

- `src/state/router.js#handle({ phoneHash, body, phoneFrom })` — the whole state machine. Provider-agnostic. **Signature unchanged.**
- `src/llm/*`, `src/resume/*` (render/pdf/watermark), `src/state/generator.js`, `src/state/delivery.js` — generation + PDF pipeline.
- `src/payment/*` and `POST /webhook/razorpay` — payments.
- `src/telemetry/*`, `src/store/*` — telemetry + storage + Redis (one tiny TTL tweak, see §4.4).
- The **6 regression suites** (`npm run check`) — they call `handle()` directly and inject `deps.send`, so they never touch the Twilio route or the live sender. **They must stay green at every step; that is our regression gate.**

If a change starts reaching into any of the above beyond what this plan specifies, stop — the boundary has been crossed.

---

## 2. Target architecture

```
        INBOUND (student → us)                       OUTBOUND (us → student)
   ┌─────────────────────────────┐            ┌──────────────────────────────┐
   │ Meta → POST /webhook/whatsapp│            │ messaging/index.js (router)  │
   │  1. verify X-Hub-Signature-256│           │   picks provider by config   │
   │  2. 200 OK  *immediately*    │            │   ├── meta.js   (Graph API)  │
   │  3. dedupe on message id     │            │   └── twilio.js (REST)  ←keep│
   │  4. parse → {phoneHash,body, │            └──────────────┬───────────────┘
   │     phoneFrom}               │                           │
   │  5. handle() → reply         │───────────────────────────┘
   │  6. send reply via provider  │   (fire-and-forget after the 200 for pilot;
   └─────────────────────────────┘    BullMQ job for scale — see §6)
```

**Key shift:** today the reply rides back in the HTTP response (TwiML). With Meta we **acknowledge first, then send a separate outbound message**. The post-payment path already works this way, so half the system is already proven.

---

## 3. New & changed files

### New files
| File | Purpose |
|---|---|
| `src/routes/whatsapp.js` | Meta inbound webhook. `GET` = verify-token challenge; `POST` = events (raw body for HMAC, dedupe, ack-first, then process). |
| `src/messaging/meta.js` | Outbound via Graph API: `sendText`, `sendDocument` (PDF as `document` w/ caption), and a normalized `sendMessage({to,text,mediaUrl})`. |
| `src/messaging/index.js` | Provider selector. Exports `sendMessage(...)` that dispatches to meta or twilio by `config.WHATSAPP_PROVIDER`. |
| `src/security/metaSignature.js` | `verifyMetaSignature(rawBody, header, appSecret)` — HMAC-SHA256, constant-time compare. Mirrors `razorpay.js` verify. |
| `.runtime/test-meta.js` | Suite: signature accept/reject/tamper, GET-challenge, inbound parse, outbound payload shape, dedupe. Provider unit tests — no live calls. |

### Changed files (surgical)
| File | Change |
|---|---|
| `src/config.js` | Add `WHATSAPP_PROVIDER` (`meta`\|`twilio`, default `twilio`), `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WABA_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (default `v21.0`). All optional (empty-as-undefined) so existing `.env` still boots. |
| `src/server.js` | Mount `/webhook/whatsapp` (raw body, like razorpay) **before** the JSON parser. Keep `/webhook/twilio` mounted (rollback). |
| `src/payment/fulfill.js` | Import the sender from `messaging/index.js` instead of `messaging/twilio.js` (one line). Now provider-agnostic. |
| `src/security/hash.js` | Normalize by stripping **all** non-digits (drop the `+`) so Twilio `whatsapp:+9199…` and Meta wa_id `9199…` hash **identically**. Safe now (no real users; sessions are ephemeral 24h) — **must be done before launch, never after.** |
| `.env.example` | Document the new Meta vars with comments. **No real secrets.** |

> Note: `src/routes/twilio.js` and `src/messaging/twilio.js` are **left in place**. We do not delete Twilio until the pilot proves Meta end-to-end.

---

## 4. The tricky bits (where migrations usually break) — and how we handle each

### 4.1 Async ack vs. processing — Meta retries on slow/failed acks
Meta **retries** the webhook if we don't return `2xx` fast. If we processed inline (like Twilio TwiML), a 13s generation would trigger a retry → **double processing** → two PDFs, two messages.
**Fix:** return `200` *before* doing any work. Then process. This is mandatory, not optional.

### 4.2 Duplicate delivery → inbound dedupe
Because of retries (and Meta's at-least-once delivery), the same inbound `messages[0].id` can arrive twice.
**Fix:** Redis `NX` lock on the message id (exactly the pattern already used for `razorpay_paid:{id}` in `store/redis.js`). First arrival processes; duplicates are dropped. Add `markInboundProcessed(messageId)` / short TTL (e.g., 1h).

### 4.3 Outbound media — Meta fetches the link, and our signed URL is 60s
Twilio fetched our Supabase signed URL within 60s and it worked. Meta also fetches `document.link` server-side, but timing is less predictable, and Meta may retry the fetch.
**Fix (pilot):** bump the PDF signed-URL TTL from 60s → **300s** for the Meta path (small change in `store/storage.js` / `delivery.js`).
**Fix (robust, later):** upload the PDF to Meta first (`POST /{phone_number_id}/media`) → get a `media_id` → send by id. No public URL needed, most reliable. Deferred unless we see fetch failures.

### 4.4 Message shape mapping
- Today the router returns `string` (text) or `{ text, media }` (PDF + caption).
- Meta mapping:
  - `string` → `type:"text"` message.
  - `{ text, media }` → `type:"document"` message with `document.link = media`, `filename = "resume.pdf"`, `caption = text`. (One message, same UX as Twilio's `<Media>` + body.)
- WhatsApp text cap is 4096 chars; our longest output is <900. Safe.

### 4.5 Phone-number format
- Twilio `From` = `whatsapp:+919999999999`. Meta `messages[0].from` = wa_id `919999999999` (no `+`, no prefix).
- `session.phone_from` must store whatever the **active provider's send API** expects: Twilio wants `whatsapp:+91…`; Meta wants the bare wa_id. The provider adapter owns this formatting; `phone_from` stores the provider-native address.
- With the `hash.js` normalization fix (§3), the **hash is identical across providers**, so sessions/telemetry stay consistent.

### 4.6 Signature security parity
- Twilio: HMAC-SHA1 over URL+params (`twilioSignature.js`).
- Meta: HMAC-SHA256 over the **raw request body**, header `X-Hub-Signature-256: sha256=…`, key = **App Secret**. Constant-time compare. Same security posture, different mechanics. Reject on mismatch; in dev with no secret, warn-and-skip (mirrors existing pattern).

### 4.7 24h customer-service window & templates
- Our flow is **reactive** — the student always messages first, we reply within seconds → inside the free-form 24h window. **No template needed for the pilot.**
- Only out-of-window case: post-payment push >24h after the student's last message (rare; payments land in minutes). For the paid launch, pre-approve **one utility template** as a fallback. Not needed for the no-payment pilot.

---

## 5. Execution order (each step ends green on `npm run check`)

1. **Config + abstraction (no behavior change).** Add env vars; create `messaging/index.js` that currently just re-exports the Twilio sender. Point `fulfill.js` at it. Run check → green. *(Twilio still 100% live.)*
2. **Meta outbound adapter** `messaging/meta.js` + unit tests (mock `fetch`). No live calls. Check green.
3. **Meta signature verify** `metaSignature.js` + tests (known HMAC vectors). Check green.
4. **Meta inbound route** `routes/whatsapp.js`: GET challenge, POST verify→ack→dedupe→parse→`handle()`→`sendMessage`. Mount in `server.js`. Behind `WHATSAPP_PROVIDER`, default still `twilio`. Check green.
5. **hash.js normalization** fix + confirm suites green (they seed their own hashes, so they stay internally consistent).
6. **Live smoke on Meta TEST number** (≤5 verified recipients) — *can be done before the SIM is ready* using Meet's own number as a test recipient. Prove: inbound received, ack fast, reply text + PDF document delivered, dedupe works.
7. **Flip `WHATSAPP_PROVIDER=meta`** once the real SIM/number is registered. Update webhook URL in Meta dashboard to our endpoint. Re-verify a full real conversation.
8. **Pilot.** Keep Twilio as instant rollback for the whole pilot window.

**Rollback at any point:** set `WHATSAPP_PROVIDER=twilio` (and re-point Twilio webhook). Zero code change.

---

## 6. Scaling audit — what breaks at 500–1000 students / ~50 concurrent

I scanned the whole pipeline. **Good news: the messaging provider is never the bottleneck — our own inline generation is.** Findings, ranked by severity:

### 🔴 S1 — Inline generation in the request path *(the big one)*
`router.js#tryGenerate` runs rewrite (~13s ceiling) + Puppeteer PDF (~5–6s) **inline**, and the Razorpay webhook fulfils inline (~5.7s, already flagged as a launch-blocker). At ~50 concurrent this means CPU/timeout pileups.
**Fix:** the Meta migration *already* moves us to ack-then-process. The full scale fix is a **job queue** — **BullMQ on Redis** (we already run Redis): webhook → ack → enqueue `{phoneHash, body}`; a **worker** runs `handle()` and sends the reply. Send an instant *"✍️ bana raha hoon, ~10s…"* message so the student isn't left waiting while queued. **Group jobs by `phoneHash`** so one user's messages process in order (also fixes S4).
**When:** at scale, *not* for the 100 pilot. The async migration is the down payment that makes this a clean add, not a rewrite.

### 🔴 S2 — Puppeteer: one browser, unbounded pages
`resume/pdf.js` reuses a browser singleton but opens a `newPage()` per request with **no concurrency cap**. 10+ simultaneous renders ≈ OOM (each Chromium page ~50–100 MB).
**Fix:** cap concurrent renders with a semaphore (`p-limit`, e.g. 3–5) — even inside one worker. Longer term, a dedicated render service or a managed HTML→PDF API. **When:** with S1.

### 🟠 S3 — No horizontal-scale story
Single Railway process does web + generation. Sessions are already external (Redis ✓), so the **web tier is already stateless** — good.
**Fix:** split **web** (stateless, N instances) from **workers** (M instances) once the queue (S1) exists. **When:** at scale.

### 🟠 S4 — Session read-modify-write race
`handle()` reads the session at the top and writes at the end — **not atomic**. A student double-tapping send can drop an update.
**Fix:** per-`phoneHash` Redis lock around the cycle, **or** (cleaner) BullMQ per-phone job ordering from S1. **When:** with S1 (mostly free once jobs are per-phone).

### 🟠 S5 — PDF storage grows unbounded
Every generation/edit writes a new PDF object; nothing is ever deleted. At 1000 students × multiple edits this bloats Supabase storage.
**Fix:** delete prior versions when a new one is produced, **or** a Supabase storage lifecycle/cron to purge objects older than N days (signed URLs are short-lived; the objects persist). **When:** before paid launch.

### 🟡 S6 — Free-tier ceilings
Upstash Redis (command/connection limits) and Supabase (Postgres connections, storage, egress) free tiers will throttle at this volume. supabase-js uses pooled PostgREST (fine), but telemetry writes once per event.
**Fix:** move both to paid tiers; batch telemetry if needed. **When:** at scale.

### 🟡 S7 — Resilience polish
`llm/client.js` has no 429/backoff handling; `checkRateLimit` uses 3 Redis round-trips per message (could be 1 Lua script).
**Fix:** add exponential backoff on OpenAI 429; collapse rate-limit to one atomic script. **When:** at scale.

### Rough monthly cost at ~1000 students
OpenAI ≈ $50–100 · Supabase+Upstash paid ≈ $25–50 · Railway (web+worker) ≈ $20–50 · Meta messaging: student-initiated service convos are cheap/low-tier. **All modest** — nothing here is a financial wall.

### Scaling verdict
You are **architecturally close**: sessions are externalized, the pipeline is modular, telemetry is non-blocking. The single structural debt is **inline generation (S1/S2)**. The Meta migration moves us to the async shape that makes the queue a clean drop-in later. **Do the migration now; defer S1–S7 until you commit to scale.** Don't over-build for 100 students.

---

## 7. How to get Meta WhatsApp Cloud API (do this while the SIM activates)

You already have the **Bharat Resume Business Portfolio** — that's the slow part done. Order of operations:

1. **Meta Developer account** → developers.facebook.com → log in with the Facebook account that owns the Business Portfolio.
2. **Create an App** → "My Apps" → Create App → type **Business** → name it (e.g., "Bharat Resume Bot") → link it to your **Bharat Resume** Business Portfolio.
3. **Add the WhatsApp product** → in the app dashboard, "Add product" → **WhatsApp** → Set up. This auto-creates/links a **WhatsApp Business Account (WABA)** and gives you a **temporary access token + a test number** (the ≤5-recipient one — dev only).
4. **Grab the dev credentials** (App dashboard → WhatsApp → API Setup):
   - **Phone number ID** (the test number's id) → `META_PHONE_NUMBER_ID`
   - **Temporary token** (24h) → `META_WHATSAPP_TOKEN` (we'll swap for a permanent one in step 8)
   - **WABA ID** → `META_WABA_ID`
   - Add **your own phone** as a verified test recipient so we can smoke-test before the SIM is live.
5. **App Secret** → App dashboard → Settings → Basic → **App Secret** (reveal) → `META_APP_SECRET` (used to verify inbound signatures).
6. **Configure the webhook** → WhatsApp → Configuration → Edit:
   - **Callback URL:** `https://<ngrok-or-railway>/webhook/whatsapp`
   - **Verify token:** any random string you choose → also put it in `.env` as `META_VERIFY_TOKEN` (Meta will GET-challenge it).
   - **Subscribe** to the **messages** field.
7. **When the SIM activates (real number):** WhatsApp → API Setup → **Add phone number** → enter the new number → verify via OTP → set the **display name** ("Bharat Resume", goes to review). This real number is the one with **no join code**. Update `META_PHONE_NUMBER_ID` to this number's id.
8. **Permanent token (before pilot, not the 24h dev token):** Business Settings → **System Users** → create a system user → assign the app + WABA → **Generate token** with `whatsapp_business_messaging` + `whatsapp_business_management` scopes → this is your long-lived `META_WHATSAPP_TOKEN`.
9. **Business verification:** can run in parallel; needed to *raise* limits and for the paid scale-up, **not** to start the pilot (student-initiated service messages work at the entry tier).

**Hand me, when ready (NOT in chat — put them in `.env` yourself, tell me only that they're set):**
`META_PHONE_NUMBER_ID`, `META_WABA_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_WHATSAPP_TOKEN`. I never need to see the secret values.

---

## 8. Open decisions for Meet
- [ ] Approve this plan / adjust scope.
- [ ] Confirm we keep Twilio as rollback through the whole pilot (recommended: yes).
- [ ] Pilot media: bump signed-URL TTL to 300s (simple) vs. pre-upload media_id (robust). Recommend: **TTL bump for pilot**, revisit if fetches fail.
- [ ] Defer all of §6 (S1–S7) until post-pilot scale decision (recommended: yes).
