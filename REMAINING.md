# BHARAT RESUME — What's Left End-to-End

Last refreshed: **2026-07-17**. Living checklist. Keep this canonical for "what's next" questions — PROGRESS.md is the session log, this is the roadmap.

Convention: `[ ]` = open · `[x]` = done · `[~]` = in progress · `[!]` = blocker · `[?]` = decision needed

---

## 0. Immediate — before the 100-student broadcast

- [ ] **Meet's own live-flow test on new number** (+91 91163 94657) — 30-step script drafted in 2026-07-17 conversation. Validates: education merge fix · Hinglish decline for LinkedIn/GitHub/CGPA · skills accumulation · dates format enforcement (rejects "6 mahine") · projects metric mining · 2-skip escape · interstitial "wait 30s" · existing-resume refusal · file-attachment refusal · payment → clean PDF delivery.
- [ ] **First 3-5 friends onboarding** (~24h feedback loop). Send bot number + short intro. Read every conversation, patch anything that breaks. Do NOT broadcast to 100 before this.
- [ ] **100-student broadcast** via approved Marketing template. Meta free-tier gives 250 marketing conversations/month — 100 fits comfortably (expected ₹0 charge). Meet the template ID: `bharat_resume_pilot_*` (approved 2026-07-13).
- [ ] **Watch Railway logs during broadcast** — live tail filtered on `inbound whatsapp`, `openai request failed`, `naukri scrape: failed`, `payment_succeeded`.
- [ ] **Watch `/admin/metrics` dashboard** — auto-refreshes every 30s. LIVE-now card = 3-min window, "in-conversation" = 15-min. Both are accurate (last_active_at now bumped on every message).
- [ ] **Watch Meta WhatsApp Manager quality rating** — green must stay green. If it drops to yellow, pause and diagnose blocks.

## 1. Product bugs / UX known-open

- [?] **Path 2 — 1-page enforcement for rich resumes.** Infrastructure landed (`oneP` param on rewriteBody, compact CSS override, Puppeteer margin passthrough) but Meet's own 2-page resume still ships 2 pages after Tier A/B/C. Three options:
  - **(a) Accept 2 pages for genuinely rich content** — safest, zero risk of dropping bullets.
  - **(b) Deterministic tail-trim** — drop achievements → cap bullets → shrink font. Guaranteed 1 page, opinionated.
  - **(c) Ship as-is and revisit after pilot** — see whether 100 students actually complain first.
  - Meet's lean: (c) → decide based on real feedback.
- [ ] **Business-persona expansion** deferred to P2 (post-pilot). Bot mechanically works (10/10 business personas in load test) but prompts + rewriter tuned for tech. Needs 4-5 real business resumes from Meet's network as tuning corpus before v2 IIM/BBA launch.

## 2. Payments / infra hardening (non-blocking, do post-broadcast)

- [ ] **Server-side amount verification on Razorpay webhook** — defense-in-depth (~20 lines in `src/routes/razorpay.js`). HMAC already prevents forgery so not critical, but good hygiene.
- [ ] **Meta WhatsApp `@bharatresume` username** — Meta gates on account age + organic traffic. Retry ~30 days post-pilot.
- [ ] **Path 2 tuning** if Meet picks option (b) above.
- [x] **Interstitial "wait 20-30s" message** during GENERATING (shipped 2026-07-17, commit `23f3489`).
- [x] **File attachment refusal** (shipped 2026-07-17, commit `9177934`).
- [x] **Existing-resume rate/review/modify refusal** (shipped 2026-07-17, commit `9177934`).
- [x] **Universal 2-skip escape hatch** across all Phase 2 states (shipped 2026-07-16, commit `6030304`).
- [x] **LIVE dashboard accuracy** — bump on every message, tighter window, secondary count (shipped 2026-07-16, commit `1f5952f`).

## 3. GitHub content polish

- [ ] Demo GIF at the top of README (screen recording of a chat → PDF).
- [ ] Logo (Bharat Resume brand asset — square + horizontal versions).
- [ ] LICENSE file (Meet chose: MIT? Apache 2.0? — decide before it goes viral).
- [ ] Contributing section (or explicit "closed source, PRs not accepted" if that's the direction).
- [ ] Repo topics on GitHub (`whatsapp-bot`, `resume-builder`, `india`, `ats`, `openai`, `express`).

## 4. Social media presence

- [ ] Secure `@bharatresume` handles across IG / LinkedIn / X / YouTube BEFORE broadcast (squatter risk).
- [ ] Bios written for each (short + role: "WhatsApp AI resume builder for Indian students. ₹49. saathi 🙏").
- [ ] Announcement post on Meet's personal LinkedIn once ≥5 friends have used it (real testimonial angle).

## 5. IP protection (before public broadcast — squatter risk)

- [ ] **Startup India DPIIT registration** (free, ~7 days). Unlocks 80% trademark filing discount.
- [ ] **Trademark "Bharat Resume"** at ipindia.gov.in — classes 9 (software) + 41 (education services) + 42 (SaaS/tech). ~₹4,500/class with DPIIT vs ₹9,000/class without. Total ~₹13,500 with DPIIT across 3 classes. ™ symbol usable from filing day; ® in 18-24 months.
- [ ] **Domain purchase** — `bharatresume.in` (and `.com` if available). ~₹800-2,000. Currently only on Railway subdomain.
- [ ] **Copyright registration** at copyright.gov.in — bundle: code (Section 2(o)) + resume template + brand assets. ~₹5,000 total. Automatic on creation in India but registration strengthens court evidence.

## 6. Post-pilot analytics

- [ ] **PROGRESS.md** update at end of every session (convention already in place — session log at §3).
- [ ] **Weekly funnel review** — students / paid / conversion % / revenue / avg ATS / drop-off state.
- [ ] **Failed-conversation deep-dive** — read Railway logs for students who abandoned; classify why; fix systemic ones.

## 7. Regression test suite state

- [x] `scripts/stress-hinglish.js` — 23 scenarios × live LLM · 23/23 pass · commit `2152593` and updated in `14e995e`. Opt-in (`node scripts/stress-hinglish.js`, ~$0.10, ~45s). Run after any LLM prompt change or merge function change.
- [x] `.runtime/e2e-happy-path.js` — full 15-state Q&A → PDF · 16/16 pass · commit history recent.
- [x] `.runtime/test-day4.js` — PDF pipeline · 14/14 pass.
- [x] `.runtime/test-payment.js` — payment webhook + clean PDF fulfillment · 30/30 pass.
- [x] `npm run check` — the full suite runs via `.runtime/check.js`. NOT in git (`.runtime/` is gitignored).

---

## Bot number for reference
**+91 91163 94657** · Display name: "Bharat Resume" · Meta WABA ID `1001892455948101` · Phone Number ID `1213931418470162`.

## Dashboard
`https://bharat-resume-production.up.railway.app/admin/metrics` · Login: `meet` / Railway env `ADMIN_PASSWORD`.

## Repo
`https://github.com/meet-png/bharat-resume` · main branch auto-deploys to Railway on push.
