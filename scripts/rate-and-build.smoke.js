#!/usr/bin/env node
// Cross-mode contamination smoke. Merge-blocker check: can a single phone
// number go through rate mode + then build mode + then rate mode again
// without state leaking between modes?
//
// Assertions:
//   BLOCK A — rate mode entry, then cancel back to mode-select
//   BLOCK B — build mode from cancelled state, first Q&A step advances
//   BLOCK C — mid-build "rate my resume" text still triggers refusal
//   BLOCK D — reset → back to mode select, mode field cleared
//   BLOCK E — pick rate again on same phone, no stale rate.* data from previous
//   BLOCK F — REVIEW_EXISTING_RE is mode-aware (fires in build, quiet in rate)
//
// This is a state-machine test — no LLM. Uses parse (no LLM in --no-llm mode
// isn't available for real inline attachment; we accept the ~15s extract
// cost on the one attachment upload).

require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const path = require('path');
const { handle } = require('../src/state/router');
const { hashPhone } = require('../src/security/hash');
const { setSession, getSession } = require('../src/store/redis');
const { STATES } = require('../src/state/states');

// Stub payment link (rate mode calls createPaymentLink on "pay").
const payment = require('../src/payment');
payment.createPaymentLink = async () => ({ id: 'mock_' + Date.now(), short_url: 'https://mock.local/pay' });

const PDF_PATH = process.argv[2] || 'C:/Users/ACER/Downloads/meet_kabra_resume_.pdf';
if (!fs.existsSync(PDF_PATH)) { console.error(`PDF not found: ${PDF_PATH}`); process.exit(2); }

const PHONE = '+919999999997';
const phoneHash = hashPhone(PHONE);
const phoneFrom = PHONE.replace(/[^\d]/g, '');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, extra) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); failed++; failures.push(label); }
}
function truncate(s, n) { const t = String(s || ''); return t.length <= n ? t : t.slice(0, n) + '…'; }

async function step(label, callArgs) {
  const reply = await handle(callArgs);
  const text = typeof reply === 'string' ? reply : (reply && reply.text) || '';
  const s = await getSession(phoneHash);
  console.log(`  ⟶ ${label}: reply="${truncate(text, 80)}" state=${s?.state} mode=${s?.mode}`);
  return { reply, text, session: s };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' CROSS-MODE SMOKE — rate + build + rate on the same phone');
  console.log('══════════════════════════════════════════════════════');

  await setSession(phoneHash, null).catch(() => {});

  // ─── BLOCK A: rate mode entry ───────────────────────────────
  console.log('\n─── BLOCK A: rate entry + PDF upload + cancel ───');
  let r;
  r = await step('cold hi', { phoneHash, body: 'hi', phoneFrom });
  assert(r.session?.state === STATES.AWAITING_MODE_SELECT, 'A1: cold entry → AWAITING_MODE_SELECT');
  assert(r.session?.mode == null, 'A2: mode not set yet');

  r = await step('pick rate', { phoneHash, body: '2', phoneFrom });
  assert(r.session?.state === STATES.RATE_AWAITING_PDF, 'A3: rate picked → RATE_AWAITING_PDF');
  assert(r.session?.mode === 'rate', 'A4: session.mode = rate');

  const buffer = fs.readFileSync(PDF_PATH);
  r = await step('upload PDF', {
    phoneHash, body: '', phoneFrom,
    attachment: { buffer, filename: path.basename(PDF_PATH), mimeType: 'application/pdf', bytes: buffer.length },
  });
  assert(r.session?.state === STATES.RATE_AWAITING_ROLE, 'A5: PDF ingested → RATE_AWAITING_ROLE');
  assert(!!(r.session?.rate?.resume_json), 'A6: session.rate.resume_json populated');
  assert(!!(r.session?.rate?.source_text), 'A7: session.rate.source_text populated');

  r = await step('cancel', { phoneHash, body: 'cancel', phoneFrom });
  assert(r.session?.state === STATES.AWAITING_MODE_SELECT, 'A8: cancel → AWAITING_MODE_SELECT');
  assert(r.session?.mode == null, 'A9: cancel clears session.mode');
  assert(r.session?.rate == null, 'A10: cancel clears session.rate (no leak into build mode)');
  assert(r.session?.payment_link_url == null, 'A11: cancel clears payment_link_url');

  // ─── BLOCK B: build mode entry from same phone after rate cancel ───
  console.log('\n─── BLOCK B: enter build mode from cancelled rate ───');
  r = await step('pick build', { phoneHash, body: 'build', phoneFrom });
  assert(r.session?.state === STATES.AWAITING_CONFIRM_START, 'B1: build picked → AWAITING_CONFIRM_START');
  assert(r.session?.mode === 'build', 'B2: session.mode = build');
  // Cross-contamination check: rate.resume_json should still be null (cancelled)
  assert(r.session?.rate == null, 'B3: no rate.* leak from previous rate session');
  // Build mode has its own resume_json — should be empty pending_project
  assert(r.session?.resume_json != null, 'B4: build resume_json exists (fresh)');

  // ─── BLOCK C: mid-build, "rate my resume" text → mode-aware refusal ───
  console.log('\n─── BLOCK C: mid-build "rate my resume" text → build-mode refusal ───');
  r = await step('build: "rate my resume karo"', { phoneHash, body: 'rate my resume karo', phoneFrom });
  const refusedText = r.text;
  assert(/rate|review|score|abhi nahi|Namaste/i.test(refusedText), 'C1: refusal text fired');
  assert(r.session?.mode === 'build', 'C2: still in build mode (refusal did not switch modes)');
  assert(r.session?.state === STATES.AWAITING_CONFIRM_START, 'C3: state unchanged after refusal');

  // ─── BLOCK D: reset → back to mode-select ─────────────────
  console.log('\n─── BLOCK D: reset from build mode ───');
  r = await step('reset', { phoneHash, body: 'reset', phoneFrom });
  assert(r.session?.state === STATES.AWAITING_MODE_SELECT, 'D1: reset → AWAITING_MODE_SELECT');
  assert(r.session?.mode == null, 'D2: reset clears mode');

  // ─── BLOCK E: pick rate AGAIN on same phone, verify no stale data ───
  console.log('\n─── BLOCK E: pick rate again, verify fresh session ───');
  r = await step('pick rate again', { phoneHash, body: 'rate', phoneFrom });
  assert(r.session?.state === STATES.RATE_AWAITING_PDF, 'E1: rate picked again → RATE_AWAITING_PDF');
  assert(r.session?.mode === 'rate', 'E2: session.mode = rate');
  // Fresh session should NOT have leftover data from previous rate mode
  assert(!r.session?.rate?.resume_json, 'E3: no stale rate.resume_json from previous session');
  assert(!r.session?.rate?.score_before, 'E4: no stale rate.score_before');
  assert(r.session?.paid !== true, 'E5: paid flag NOT set (was never paid in test)');

  // ─── BLOCK F: nudge text at RATE_AWAITING_PDF → no build refusal fired ───
  console.log('\n─── BLOCK F: text in RATE_AWAITING_PDF ("rate my resume karo") → nudge, NOT refusal ───');
  r = await step('text in rate mode', { phoneHash, body: 'rate my resume karo', phoneFrom });
  // In rate mode this should NOT trigger REVIEW_EXISTING_RE refusal — it should
  // go through rate-router and get the "send PDF file" nudge.
  assert(r.session?.mode === 'rate', 'F1: still in rate mode');
  assert(r.session?.state === STATES.RATE_AWAITING_PDF, 'F2: still awaiting PDF');
  // Build-mode refusal contains "abhi nahi" or "Namaste 🙏". Nudge contains "PDF" / "Word file".
  const isBuildRefusal = /Namaste 🙏.*ye bot sirf.*naya resume BANATA/i.test(r.text);
  assert(!isBuildRefusal, 'F3: build-mode "we don\'t rate resumes" refusal did NOT fire in rate mode');
  assert(/PDF|word|file|attach/i.test(r.text), 'F4: rate-mode nudge (PDF/file prompt) fired instead');

  // Cleanup
  await setSession(phoneHash, null).catch(() => {});

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(` Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`\n FAILED: ${failures.join(', ')}`); process.exit(1); }
  console.log('  ✅ No cross-mode contamination. Merge-safe.');
  process.exit(0);
})().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
