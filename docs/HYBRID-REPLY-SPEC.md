# Hybrid LLM-Reply Architecture — Spec v1

**Author:** Meet + Saathi-build crew (Claude)
**Date:** 2026-06-25
**Status:** Approved — implementation gated behind `HYBRID_REPLY` env flag, default OFF.
**Owner file ([log lives in](../PROGRESS.md)):** PROGRESS.md updates each phase.

---

## 1. Why we're doing this — the loop bug class

Friend-test 2026-06-25 surfaced the same bug in three different states within a week:

| Date       | State                  | Symptom                                                                       |
| ---------- | ---------------------- | ----------------------------------------------------------------------------- |
| 2026-06-23 | `AWAITING_PROJECTS`    | Student gave "300 signups" as follow-up. Bot dropped it, re-asked for impact. |
| 2026-06-25 | `AWAITING_EXPERIENCE`  | Student gave 6 metrics across 6 turns. Bot looped on "any number?".           |
| 2026-06-25 | `AWAITING_POR`         | Student gave role + outcome. Bot ignored outcome, re-asked.                   |

Root cause is structural, not a flaw in any one prompt. The current per-state extractor (`src/llm/extract.js`) is asked to do **two jobs in one JSON call**:

1. **Extract structured fields** from the student's free-text reply.
2. **Decide what to say next** via `clarification_needed`.

When job (2) goes wrong — LLM hallucinates a re-ask, ignores a filled field, treats a terse number as "not enough sentence to bullet" — the router copy-pastes that broken text back to the student. Loop.

We've patched this three times with PRE-CHECK + TERSE-METRIC + DEFLECTION rules added to the same prompt. Each fix is surgical and works, but every new section needs the same patch. Whack-a-mole.

**The hybrid architecture separates the two jobs structurally so this class of bug becomes impossible to express.**

---

## 2. Architecture: current vs proposed

### Current (Phase 2 — Day 2 build)
```
inbound → router.handle()
   → extractSection()             ← JSON: {data, clarification_needed}
   → merge data into resume_json
   → if clarification_needed: reply = clarification_needed   ← LLM-written text
     else: advance state; reply = pickPrompt(next_state)     ← static template
   → send reply
```

The `clarification_needed` text is the offender. It is LLM-generated but produced WITHOUT seeing the full `resume_json` snapshot the way a reply layer would — the extractor sees only the current turn + the section it's filling, and decides "is this enough?" with no role context, no awareness of what other slots are filled, no conversation memory.

### Proposed (Phase 3 — Hybrid v1)
```
inbound → router.handle()
   → extractSection()             ← JSON: {extracted_fields, missing}
                                    no clarification_needed; pure extraction
   → merge into resume_json
   → router decides: section sufficient? advance? loop? skip?
   → respond({                    ← NEW: src/llm/respond.js
       state, prev_state,
       resume_json,               ← FULL snapshot post-merge
       student_last,              ← the message we just processed
       decision,                  ← 'advance' | 'loop_more' | 'still_missing' | 'ack_save'
       session_flags,             ← exp_more_pending, proj_focus, jd_role, etc.
       history,                   ← last 4 turns (optional v1, required v2)
     })                            → { reply: string, voice_tag: string }
   → sanity-check reply (length, fabrication, language)
   → fall back to pickPrompt() / canned text on any failure
   → send reply
```

**Key inversion:** loop prevention moves from "patching the extractor's text output" (whack-a-mole) to "the reply layer cannot ask for what's already filled, by construction, because it sees what's filled".

---

## 3. The `respond()` contract — invariants we will not violate

### Input
```js
respond({
  state,          // current state, e.g. STATES.AWAITING_EXPERIENCE
  prev_state,     // state BEFORE this turn's transition (may equal state if no transition)
  resume_json,    // FULL post-merge snapshot — incl. pending_project, pending_por, name, etc.
  student_last,   // raw inbound text this turn (already trimmed)
  decision,       // 'advance' | 'loop_more' | 'still_missing' | 'ack_save' | 'skip_ack' | 'reset_ack'
  missing,        // string[] — fields/aspects still needed for THIS state (extractor's report)
  session_flags,  // { jd_role, jd_text, jd_generic, exp_more_pending, certs_more_pending, proj_focus, ... }
  history,        // [{role:'user'|'bot', text:string}] last 4 turns; may be empty in v1
}) → Promise<{ reply: string, voice_tag: string, used_llm: boolean }>
```

### Allowed behaviors
1. Ask a role-aware follow-up question (e.g., for an MUN Sec-Gen: "how many people in core team? events organized? sponsorship handled?" — not generic "what specific work?").
2. Acknowledge what the student just said in warm, brief, Latin-script Hinglish-or-English voice.
3. Summarize what's now in `resume_json` to confirm save ("Got it — Marketing Intern at Acme, 200% signup growth ✓").
4. Suggest a CATEGORY (not specific facts) the student might add ("Any budget you handled? Sponsorship secured? Flagship event?").
5. Confirm a transition forward ("Onto projects now — share one at a time.").
6. Offer the multi-entry "add another or done?" loop wording role-naturally.

### Forbidden behaviors (HARD RULES)
1. **No fabricated facts.** Reply must not contain any number, date, name, organization, role, or specific outcome that is NOT present in `resume_json` OR `student_last`.
2. **No draft bullets shown for student approval** ("Here's a bullet: ...OK?"). The line is fragile and most students will rubber-stamp.
3. **No claim of verification.** Never write "verified", "confirmed", "I checked your repo", etc.
4. **No re-ask of a filled slot.** If `resume_json` already has `name`, the reply cannot ask for name. Enforced by post-LLM sanity check, not just prompt discipline.
5. **No script other than Latin.** Hinglish in Roman letters only (project rule from prompts.js header).
6. **Length cap: 600 chars.** Hard truncate at 600 if the LLM overruns; consider that a failure for telemetry.

### Output shape
```json
{
  "reply":     "string — the actual WhatsApp message text",
  "voice_tag": "ask_impact | ack_save | ask_link | confirm_transition | loop_more_entry | role_followup | skip_ack | reset_ack"
}
```
`voice_tag` is a diagnostics label so we can dashboard reply distributions per state and catch monotony or runaway tag patterns.

### Sanity gate (runs on every respond() result before send)
- `length(reply) ≤ 600` else fallback.
- Reply must not contain any **digit run ≥ 2** that isn't also present in `student_last` OR a string field of `resume_json`. (Single digits in "20s", "3rd", "1 of 3" are OK.)
- Reply must not contain any **Devanagari** (regex `/[ऀ-ॿ]/`) else fallback.
- For every already-filled field on `resume_json`, the reply must not include its **field-reask keyword** (regex per slot, e.g. for `email`: `/\bemail\s*(id|address|kya|share|drop|please)/i`). If it does, fallback.
- On any sanity failure: log a warn with the failed check + voice_tag, then **silently fall back to the canned `pickPrompt()` / `clarification_needed` path**. The student never sees a sanity failure.

---

## 4. Autofill — the answer to "can it autofill content?"

**Yes — but in the form of *skilled elicitation*, never *hallucinated drafts*.** This is the most important boundary in the whole spec.

Student says: *"Secretary General in JMS, did some team stuff"*

#### ❌ What we will NOT do (hallucinated autofill)
> *"Led a 50-member core team in JMS MUN; organized 3 conferences with 200+ delegates; secured ₹3L in sponsorships."*

The 50, 3, 200, ₹3L are LLM common sense about typical MUN Sec-Gen activities. Reads great. Sounds professional. **Fabrication.** Once one student notices made-up data on their PDF, word spreads in JECRC and the product is dead.

#### ✅ What we WILL do (skilled elicitation via `respond()`)
> *"Sec-Gen in JMS is a real-deal role. Three quick things, just numbers if you remember: (1) Roughly how many in your core team? (2) How many MUNs / events you organized? (3) Any budget you handled or sponsorship secured? Whatever you actually did, I'll phrase it sharp."*

`respond()` uses LLM domain knowledge about *what a MUN Sec-Gen typically does* to **ask sharper questions**, surfacing real numbers a student wouldn't have volunteered. The numbers themselves come from the student. Then `src/llm/rewrite.js` (untouched) phrases those real numbers into strong bullets.

#### The line in the sand
| Activity                                                              | Allowed?         | Reason                                              |
| --------------------------------------------------------------------- | ---------------- | --------------------------------------------------- |
| Ask role-tailored questions ("budget handled?" for an MUN sec-gen)    | ✅                | LLM knowledge of role; no claim made yet            |
| Rephrase student's actual stated facts into sharper bullets           | ✅ (in `rewrite.js`) | Already happens; preserved                          |
| Suggest CATEGORIES of facts the student should add                    | ✅                | Generic prompt, no specific fact attached           |
| Acknowledge save with the student's own words echoed back             | ✅                | Echo only — nothing new minted                      |
| Fill in a typical number (50, 200, ₹3L) for any unmentioned metric    | ❌                | Fabrication                                         |
| Write a bullet about an activity the student never mentioned          | ❌                | Fabrication                                         |
| Generate a draft bullet for "sound right? confirm?"                   | ❌ (in v1)        | Borderline — most students rubber-stamp. Defer.     |

Enforcement: **the no-fabrication check in §3 sanity gate is a structural barrier, not just a system-prompt rule**. Even if the prompt drift causes the LLM to invent a number, the regex sanity check catches digits not present in `student_last`/`resume_json` and triggers fallback.

---

## 5. Integration with the state machine

### What changes in `src/llm/extract.js`
**Nothing structurally.** The PRE-CHECK + TERSE-METRIC + DEFLECTION rules added 2026-06-25 stay — they're harmless when hybrid is on, and load-bearing when hybrid is off. The extractor continues to return `clarification_needed` text; the router just ignores it when hybrid is on and uses respond() instead. **This is critical for rollback safety: flip `HYBRID_REPLY=0` and we're back to the working system instantly.**

### What changes in `src/state/router.js`
- New helper `composeReply({ session, prev_state, decision, student_last, fallback })`:
  ```js
  // Tries respond() if HYBRID_REPLY=1 and sanity passes; else returns fallback.
  // Fallback is the SAME string the legacy path would have returned.
  async function composeReply(args) { ... }
  ```
- Every place that currently does `return pickPrompt(...)` or `return clarification_needed` is wrapped:
  ```js
  return await composeReply({ session, prev_state, decision, student_last, fallback: clarification_needed });
  ```
- The `decision` parameter is computed by the router (it already knows whether it just transitioned, looped, acked save). respond() reads it as a hint, not a directive.

### What changes in `src/state/prompts.js`
**Nothing.** All canned prompts stay as fallbacks. Forever. Never remove them.

### What changes in `src/state/states.js`
**Nothing.** Same states, same transitions.

### Where `respond()` is reached (in router order)
The router will call `composeReply()` instead of returning the raw fallback in these locations:
- `AWAITING_CONFIRM_START` → after `yes` (greeting)
- All `PHASE_2_STATES` general-collection handler (15 of them) — both `clarification_needed` and success paths
- `AWAITING_PROJECTS` — clarification + saved + done paths
- `AWAITING_EXPERIENCE` — clarification + impact-substitute + multi-entry-loop paths
- `AWAITING_POR` — same
- `AWAITING_CERTS` — same + link-followups + multi-entry-loop
- `DELIVERED` post-delivery help text (optional, low priority)
- `AWAITING_EDIT_OR_DONE` reply path (optional, low priority)

Out of scope for v1: payment-state replies (`AWAITING_PAYMENT`, `PAID_COMPLETE`) — they have legal/financial implications and the canned text is correct.

---

## 6. Cost & latency

### Cost
- **Current (per resume, ~30 turns):** ~$0.045 in extract + $0.005 in rewrite ≈ **$0.05**.
- **Proposed (per resume, ~30 turns):** ~$0.045 in extract + ~$0.045 in respond() + $0.005 in rewrite ≈ **$0.10**.
- 2× per resume. Still negligible against the ₹49 (≈ $0.59) revenue target — gross margin per paid resume is preserved.
- We will use `gpt-4o-mini` (config.LLM_PRIMARY) for respond() too. No new model dependency.

### Latency
- One additional ~700-1500ms sequential LLM call per turn.
- For impact: a turn that today takes 1.2s end-to-end (extract → reply) will take ~2.4s. Within WhatsApp UX tolerance; no perceived hang.
- Optimization deferred to v2: parallel respond() that speculatively drafts both "advance" and "still_missing" replies, picks the one matching the resolved decision.

### Budget guardrail
- `respond()` will hard-cap `maxTokens: 250`. (~600 chars is well under that, but the cap protects against runaway loops in the model.)
- Per-session counter: if a session burns more than 60 respond() calls (sanity ceiling for a 30-turn flow with retries), fall back to canned for the rest of the session. Logs alert.

---

## 7. Migration plan (rollout safety)

**Principle: the running system must keep working at every commit. Flag-off is identical to today's behavior.**

### Phase A — Scaffolding (this PR / session)
1. Add `src/llm/respond.js` with the full implementation, sanity gates, fallback.
2. Add `HYBRID_REPLY` env flag (default `false`) in `src/config.js`.
3. Add `composeReply()` helper in router.js that is a **pure pass-through to the legacy fallback** when flag is off. **No behavioral change yet.**
4. Wire `composeReply()` at all return sites in router.js — they pass the legacy reply as `fallback`. Flag-off behavior identical to today.
5. `npm run check` — all 10+ suites green. Commit.

### Phase B — Test under flag-on locally (next session)
1. Add `.runtime/test-respond.js`: isolated unit-style suite for respond() — sanity gate, fabrication check, fallback path, length cap.
2. Run `HYBRID_REPLY=1 node .runtime/smoke-router.js` and `HYBRID_REPLY=1 node .runtime/e2e-happy-path.js`. Both must finish; we assess reply quality manually.
3. Hand-test a friend flow with the impact loop bug — confirm no loop. Confirm warmth.
4. If broken, fix respond.js prompt. **Never modify the per-state extractor in this phase.**

### Phase C — Pilot ramp (after Phase B looks clean)
1. Default `HYBRID_REPLY=1` for `PILOT_MODE=true` sessions only. Production paid sessions stay flag-off until pilot proves it.
2. Send Meet a friend-test invite. Watch for 24-48h of pilot traffic.
3. Telemetry events for: respond() success, respond() fallback (with reason), sanity-gate fails (by check type).

### Phase D — Full default (week 2)
1. Default flag to true everywhere.
2. Keep canned `prompts.js` as eternal fallback.
3. Do not delete the PRE-CHECK rules in extract.js — they're cheap and defensive.

### Rollback
At ANY phase, `HYBRID_REPLY=0` in Railway → instant return to legacy behavior. No code redeploy needed. This is the whole reason for the flag.

---

## 8. Anti-regression strategy

### Existing tests (must stay green throughout)
- `npm run check` runs the 10+ runtime suites (smoke-router, e2e-happy-path, test-edit-isolation, test-render-sanity, test-day4, test-ats, test-payment, test-bug2, test-all-4, smoke-pilot, smoke-meta, smoke-redis, smoke-security, smoke-supabase, smoke-razorpay).
- All must pass with `HYBRID_REPLY=0` (i.e. default) at every commit.
- Edit-isolation suite (`test-edit-isolation.js`, 59 assertions) — extra-critical because edit pathway is untouched.

### New tests added
- `.runtime/test-respond.js` (created in Phase B): exercises respond() in isolation.
  - Fabrication check: input student_last="hi" + resume_json with no projects → respond reply must not contain any number.
  - Length cap: assert reply ≤ 600 chars.
  - Latin-only: assert no Devanagari.
  - No-reask: input resume_json with `email: 'm@x.com'` → reply (called for AWAITING_LINKEDIN state) must not match `/email/i`.
  - Fallback: simulate openai SDK error → composeReply() returns the fallback string verbatim.
- Smoke-router additions: re-run the existing happy path with `HYBRID_REPLY=1`. Assert state transitions and final delivery — relax assertions on exact reply STRINGS (since they're now LLM-generated), keep assertions on STATE and on resume_json shape.

### Acceptance gates
1. Flag-off: all existing tests green.
2. Flag-on: smoke-router + e2e-happy-path complete; final PDF renders with intact resume_json structure; ATS score not degraded (compare to flag-off baseline ±5).
3. Friend test: re-run the experience-loop / PoR-loop scenarios from 2026-06-25. They must NOT loop.

---

## 9. What this is NOT (scope discipline)

- **Not "Full ChatGPT mode" (one long conversation, model drives state via tool calls).** That's a v3+ project. Out of scope; the state machine stays the spine.
- **Not a rewrite of `src/llm/rewrite.js`.** Resume bullet generation untouched. Anti-fabrication rules there stay as-is.
- **Not a removal of canned prompts.** prompts.js is the eternal fallback. Treat as part of the SLA.
- **Not new state additions.** Same 21 states.
- **Not a deletion of the PRE-CHECK / TERSE-METRIC rules in extract.js.** They're cheap, harmless, and still run when flag is off — and they reduce respond()'s job to "reply" (not "salvage missed extraction"), which is the right division of labor.
- **Not a model change.** Same `gpt-4o-mini`.

---

## 10. Open questions (decide as we go)

1. **History depth.** v1: pass nothing. v2: pass last 4 turns. v3: full session log. Start small — most loops are single-turn confusion that don't need history.
2. **Voice for payment states.** Conservative answer: leave canned. Revisit if students complain the payment ask feels robotic.
3. **Streaming.** WhatsApp doesn't support streaming, so it doesn't help UX. Not worth it.
4. **Multilingual.** Out of scope until pilot data tells us we have non-Hinglish users.

---

## 11. Decision log

- **2026-06-25 — Choose Hybrid v1 over "Full ChatGPT" (v3+).** Reason: hybrid preserves the state machine (which is correct for a billing/payment/PDF-delivery workflow), kills the loop class (which is what's actually hurting students), and is rollback-safe via env flag. Full ChatGPT mode is a bigger rewrite that would require redesigning payment + delivery integration, and we don't need it to make the bot 10x better. Revisit after 100-student pilot.
- **2026-06-25 — Use `gpt-4o-mini` for respond() (not 4o, not Claude).** Reason: cost (~$0.0015/call), latency (~700ms), and same model as everywhere else. If quality is insufficient in Phase B, upgrade selectively.
- **2026-06-25 — Sanity gates are structural (regex/length) not LLM-judge.** Reason: an LLM-judge for the gate doubles cost and has the same fabrication risk we're trying to prevent. Hard regex checks are cheap, deterministic, testable.
