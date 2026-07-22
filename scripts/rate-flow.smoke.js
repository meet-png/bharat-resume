#!/usr/bin/env node
// End-to-end rate-flow smoke test. Simulates a real WhatsApp conversation by
// calling the state machine handle() with the same shape whatsapp.js does,
// including an attachment buffer. Uses Meet's real resume PDF to exercise
// the pipeline end-to-end.
//
// Steps:
//   1. First message (text) → expect mode-select prompt
//   2. Reply "2" → expect "send PDF" prompt
//   3. Send PDF attachment → expect "role?" prompt
//   4. Reply with role → expect score glimpse
//   5. Reply "pay" → expect payment link (mocked link OK)
//   6. Reply "cancel" → expect back-to-mode-select
//
// No WhatsApp send. No payment gateway. Just the router — proves the state
// machine flows correctly.
//
// Cost: 1 LLM extract + 1 role-fit LLM + 1 bullet-impact LLM + 1 grammar LLM
// = ~$0.003 per run. About 20-30 seconds total.

require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const path = require('path');
const { handle } = require('../src/state/router');
const { hashPhone } = require('../src/security/hash');
const { setSession, getSession } = require('../src/store/redis');
const { STATES } = require('../src/state/states');

// Mock the payment link creator so the smoke doesn't hit Cashfree / Razorpay.
// We stub via module-cache — replace before requiring rate-router (already
// loaded above by router.js, so this affects subsequent calls into it).
const payment = require('../src/payment');
payment.createPaymentLink = async () => ({
  id: 'mock_' + Date.now(),
  short_url: 'https://mock.cashfree.local/pay/abc123',
});

const PDF_PATH = process.argv[2] || 'C:/Users/ACER/Downloads/meet_kabra_resume_.pdf';
if (!fs.existsSync(PDF_PATH)) { console.error(`PDF not found: ${PDF_PATH}`); process.exit(2); }

const PHONE = '+919999999999';
const phoneHash = hashPhone(PHONE);
const phoneFrom = PHONE.replace(/[^\d]/g, '');

let passed = 0, failed = 0;
const failures = [];

function assert(cond, label, extra) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else {
    console.log(`  ✗ ${label}${extra ? `  — ${extra}` : ''}`);
    failed++; failures.push(label);
  }
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n) + '…';
}

async function step(label, callArgs, expectPredicate) {
  console.log(`\n─── ${label} ───`);
  const reply = await handle(callArgs);
  const text = typeof reply === 'string' ? reply : (reply && reply.text) || '';
  console.log(`  ← reply: "${truncate(text, 120)}"`);
  const s = await getSession(phoneHash);
  console.log(`  → session.state: ${s?.state}  session.mode: ${s?.mode}`);
  if (expectPredicate) {
    const ok = expectPredicate({ reply, text, session: s });
    if (!ok) {
      console.log(`  ✗ FAIL: expectation not met`);
      failures.push(label);
      failed++;
    } else {
      console.log(`  ✓ expectation met`);
      passed++;
    }
  }
  return { reply, text, session: s };
}

(async () => {
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(` rate-flow smoke: end-to-end state machine, no WhatsApp`);
  console.log(` PDF: ${path.basename(PDF_PATH)}`);
  console.log(`══════════════════════════════════════════════════════`);

  // Wipe any old session for this phone so runs are independent.
  await setSession(phoneHash, null).catch(() => {});

  // Step 1 — cold entry, text "hi" — expect mode-select prompt
  await step('Step 1 — cold entry', { phoneHash, body: 'hi', phoneFrom }, ({ text, session }) =>
    session?.state === STATES.AWAITING_MODE_SELECT && /mode|banao|rate|kya karna/i.test(text));

  // Step 2 — pick rate
  await step('Step 2 — pick rate mode', { phoneHash, body: '2', phoneFrom }, ({ text, session }) =>
    session?.state === STATES.RATE_AWAITING_PDF && session?.mode === 'rate' && /pdf|word|file bhejo|rate mode active/i.test(text));

  // Step 3 — upload PDF attachment
  const buffer = fs.readFileSync(PDF_PATH);
  await step('Step 3 — upload PDF', {
    phoneHash, body: '', phoneFrom,
    attachment: { buffer, filename: path.basename(PDF_PATH), mimeType: 'application/pdf', bytes: buffer.length },
  }, ({ text, session }) =>
    session?.state === STATES.RATE_AWAITING_ROLE && /role|target|kaun sa/i.test(text));

  // Step 4 — role
  await step('Step 4 — provide role', { phoneHash, body: 'Data Analyst', phoneFrom }, ({ text, session }) =>
    session?.state === STATES.RATE_SHOWING_SCORE && /score/i.test(text) && /₹49|₹ 49|49.*upi/i.test(text));

  // Step 5 — pay → expect payment intro with mock URL
  await step('Step 5 — pay', { phoneHash, body: 'pay', phoneFrom }, ({ text, session }) =>
    session?.state === STATES.RATE_AWAITING_PAYMENT && /mock.cashfree.local|https:\/\//.test(text));

  // Step 6 — cancel → expect return to mode select
  await step('Step 6 — cancel', { phoneHash, body: 'cancel', phoneFrom }, ({ text, session }) =>
    session?.state === STATES.AWAITING_MODE_SELECT && session?.mode == null);

  // Step 7 — "build" from mode select → build flow entry
  await step('Step 7 — switch to build mode', { phoneHash, body: 'build', phoneFrom }, ({ text, session }) =>
    session?.state === STATES.AWAITING_CONFIRM_START && session?.mode === 'build');

  // Cleanup
  await setSession(phoneHash, null).catch(() => {});

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(` Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('  ✅ Rate-flow state machine intact.');
  process.exit(0);
})().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
