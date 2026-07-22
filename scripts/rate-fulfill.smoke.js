#!/usr/bin/env node
// Rate-mode payment fulfillment smoke. Simulates a paid webhook by:
//   1. Parsing + extracting a real PDF
//   2. Seeding a session in Redis as if the student had gone through
//      mode-select → PDF → role → score → and just paid.
//   3. Calling fulfillPaymentByMode() the same way the webhook route would.
//   4. Capturing the outbound sends (mock deps.send) so we can inspect what
//      the student would receive (PDF URL + audit report chunks).
//
// Hits real OpenAI + real Supabase + real Puppeteer. ~30-45s. ~$0.005.
//
// Usage:  node scripts/rate-fulfill.smoke.js [path.pdf] [--role "Data Analyst"]

require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const path = require('path');
const { parse } = require('../src/rate/parse');
const { extract } = require('../src/rate/extract');
const { scoreAll } = require('../src/rate/score-combined');
const { hashPhone } = require('../src/security/hash');
const { setSession, getSession, unmarkPaymentProcessed } = require('../src/store/redis');
const { STATES } = require('../src/state/states');
const { fulfillPaymentByMode } = require('../src/payment/dispatch');

function parseArgs(argv) {
  const out = { role: 'Data Analyst' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') { out.role = argv[++i] || out.role; continue; }
    if (a.startsWith('--')) continue;
    rest.push(a);
  }
  out.pathArg = rest[0] || 'C:/Users/ACER/Downloads/meet_kabra_resume_.pdf';
  return out;
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, extra) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); failed++; failures.push(label); }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.pathArg)) { console.error(`PDF not found: ${args.pathArg}`); process.exit(2); }

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(` rate-fulfill smoke: webhook → improve → PDF → audit`);
  console.log(` PDF: ${path.basename(args.pathArg)}`);
  console.log(` role: ${args.role}`);
  console.log(`══════════════════════════════════════════════════════\n`);

  const PHONE = '+919999999998'; // distinct from rate-flow smoke to avoid Redis collisions
  const phoneHash = hashPhone(PHONE);
  const phoneFrom = PHONE.replace(/[^\d]/g, '');
  const paymentId = 'test_pay_' + Date.now();
  const linkId = 'test_link_' + Date.now();

  // Fresh state — clear old session + any dedupe lock from prior run.
  await setSession(phoneHash, null).catch(() => {});
  await unmarkPaymentProcessed(paymentId).catch(() => {});

  console.log('─── STEP 1: parse + extract + score (mirrors what rate-router would have done) ───');
  const buffer = fs.readFileSync(args.pathArg);
  const parsed = await parse(buffer, { filename: path.basename(args.pathArg) });
  assert(!parsed.meta.refuse, `parse layer 1 succeeds (${parsed.meta.wordCount} words, ${parsed.meta.pageCount}p)`);
  if (parsed.meta.refuse) { console.log(`  reason: ${parsed.meta.refuseReason}`); process.exit(1); }

  const ex = await extract({ lines: parsed.lines });
  assert(!!ex.resume_json, 'extract produced resume_json');
  const scored = await scoreAll({
    text: parsed.text, parseMeta: parsed.meta,
    resume_json: ex.resume_json, role: args.role, roleType: 'tech',
  });
  console.log(`  score_before = ${scored.score.toFixed(1)} / 10`);

  console.log('\n─── STEP 2: seed session in RATE_AWAITING_PAYMENT (as if student just tapped "pay") ───');
  await setSession(phoneHash, {
    state: STATES.RATE_AWAITING_PAYMENT,
    mode: 'rate',
    phone_from: phoneFrom,
    payment_link_id: linkId,
    payment_link_url: 'https://mock/pay',
    rate: {
      source_text: parsed.text,
      source_lines: parsed.lines,
      resume_json: ex.resume_json,
      parse_meta: parsed.meta,
      role: args.role,
      score_before: scored.score,
      score_subscores: scored.subscores,
      score_issues: scored.issues,
      score_cache_key: scored.meta.cache_key,
    },
    resume_json: { pending_project: null },
    resume_json_rewritten: null,
    pdf_versions: [],
    paid: false,
    pilot: false,
    created_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
    edits_free_used: 0,
    edits_paid_used: 0,
  });
  const seeded = await getSession(phoneHash);
  assert(seeded && seeded.mode === 'rate', 'session seeded as rate mode');

  console.log('\n─── STEP 3: capture outbound sends (mock deps.send) ───');
  const sent = [];
  const mockSend = async ({ to, body, mediaUrl }) => {
    sent.push({ to, body, mediaUrl });
  };

  console.log('\n─── STEP 4: dispatch webhook (fulfillPaymentByMode) ───');
  const t0 = Date.now();
  let result;
  try {
    result = await fulfillPaymentByMode({ phoneHash, paymentId, linkId }, { send: mockSend });
  } catch (e) {
    console.error(`  ✗ fulfillPaymentByMode threw: ${e.message}`);
    process.exit(1);
  }
  const elapsed = Date.now() - t0;
  console.log(`  fulfilled in ${elapsed}ms`);
  console.log(`  result: ${JSON.stringify(result, null, 2)}`);

  console.log('\n─── STEP 5: assertions ───');
  assert(result && result.ok, 'result.ok is true', result ? JSON.stringify(result) : 'no result');
  assert(result && result.sent === true, 'result.sent === true');

  const finalSession = await getSession(phoneHash);
  assert(finalSession && finalSession.state === STATES.RATE_DELIVERED, `final state === RATE_DELIVERED (got ${finalSession?.state})`);
  assert(finalSession && finalSession.paid === true, 'session.paid = true persisted');
  assert(finalSession && finalSession.rate && finalSession.rate.audit && finalSession.rate.audit.length > 0, `audit trail persisted (${finalSession?.rate?.audit?.length || 0} rows)`);
  assert(finalSession && finalSession.rate && finalSession.rate.resume_json_improved != null, 'improved resume_json persisted');
  assert(finalSession && finalSession.resume_json_rewritten != null, 'session.resume_json_rewritten wired for v1 delivery');

  assert(sent.length >= 2, `≥2 outbound messages sent (got ${sent.length})`);
  const withMedia = sent.filter((m) => !!m.mediaUrl);
  assert(withMedia.length === 1, `exactly 1 message has media (the PDF); got ${withMedia.length}`);
  if (withMedia.length > 0) {
    console.log(`  ✓ PDF URL: ${withMedia[0].mediaUrl}`);
  }
  const textOnly = sent.filter((m) => !m.mediaUrl);
  assert(textOnly.length >= 1, `≥1 text-only message (audit report chunks); got ${textOnly.length}`);

  // Print previews of each outbound message
  console.log('\n─── STEP 6: outbound preview ───');
  for (let i = 0; i < sent.length; i++) {
    const m = sent[i];
    console.log(`\n  msg #${i + 1}${m.mediaUrl ? ' (PDF attached)' : ''}:`);
    console.log('  ' + String(m.body || '').slice(0, 280).replace(/\n/g, '\n  '));
    if (m.body && m.body.length > 280) console.log(`  … (+${m.body.length - 280} more chars)`);
  }

  // Cleanup
  await setSession(phoneHash, null).catch(() => {});

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(` Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('  ✅ Rate-fulfill pipeline intact.');
  process.exit(0);
})().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
