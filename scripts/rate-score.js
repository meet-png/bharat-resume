#!/usr/bin/env node
// Dev CLI. Usage:
//   node scripts/rate-score.js <path.pdf|path.docx> --role "Backend Engineer"
//   node scripts/rate-score.js <path.pdf> --role "..." --llm       # full 10-point (adds ~10s + $0.001)
//   node scripts/rate-score.js <path.pdf> --role "..." --verify-cache
//
// Runs: parse → extract → score → prints report. With --llm, adds the LLM
// scorer for the full 10-point rubric.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('../src/rate/parse');
const { extract } = require('../src/rate/extract');
const { score, cacheKey, RUBRIC_VERSION } = require('../src/rate/score');
const { scoreAll } = require('../src/rate/score-combined');

function parseArgs(argv) {
  const out = { role: 'Software Engineer', roleType: 'tech' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') { out.role = argv[++i] || out.role; continue; }
    if (a === '--role-type') { out.roleType = argv[++i] || out.roleType; continue; }
    if (a === '--verify-cache') { out.verifyCache = true; continue; }
    if (a === '--llm') { out.llm = true; continue; }
    if (a.startsWith('--')) continue;
    rest.push(a);
  }
  out.pathArg = rest[0];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pathArg) {
    console.error('Usage: node scripts/rate-score.js <path.pdf|path.docx> --role "Backend Engineer" [--role-type tech|business|other] [--verify-cache]');
    process.exit(2);
  }
  const abs = path.resolve(args.pathArg);
  if (!fs.existsSync(abs)) { console.error(`file not found: ${abs}`); process.exit(2); }
  const buffer = fs.readFileSync(abs);

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(` rate-score: ${path.basename(abs)}`);
  console.log(` role:       ${args.role} (${args.roleType})`);
  console.log(` rubric:     ${RUBRIC_VERSION}`);
  console.log(`══════════════════════════════════════════════════════\n`);

  const parsed = await parse(buffer, { filename: abs });
  console.log(`─── PARSE ─── layer=${parsed.meta.layerName} words=${parsed.meta.wordCount} pages=${parsed.meta.pageCount} multiColumn=${parsed.meta.multiColumn}`);
  if (parsed.meta.refuse) { console.log(`  ⛔ REFUSE: ${parsed.meta.refuseReason}`); process.exit(0); }

  const t0 = Date.now();
  const ex = await extract({ lines: parsed.lines });
  console.log(`─── EXTRACT ─── ${Date.now() - t0}ms tokens=${ex.usage?.total_tokens || '?'}`);
  if (!ex.resume_json) { console.log(`  ⛔ extract skipped: ${ex.meta.reason}`); process.exit(1); }

  if (args.llm) {
    console.log(`\n─── FULL 10-POINT SCORING (deterministic + LLM) ───`);
    const t0 = Date.now();
    const full = await scoreAll({
      text: parsed.text,
      parseMeta: parsed.meta,
      resume_json: ex.resume_json,
      role: args.role,
      roleType: args.roleType,
    });
    console.log(`\n────────────────────────────────────────`);
    console.log(`  TOTAL SCORE:  ${full.score.toFixed(1)} / ${full.max.toFixed(1)}`);
    console.log(`    deterministic: ${full.score_deterministic.toFixed(1)} / 6.0`);
    console.log(`    LLM:           ${full.score_llm.toFixed(1)} / 4.0`);
    console.log(`────────────────────────────────────────\n`);
    for (const [key, sub] of Object.entries(full.subscores)) {
      const bar = '█'.repeat(Math.round((sub.earned / sub.max) * 10)) + '░'.repeat(10 - Math.round((sub.earned / sub.max) * 10));
      console.log(`  ${sub.label.padEnd(40)} ${sub.earned.toFixed(2)} / ${sub.max.toFixed(1)}  [${bar}]`);
    }
    console.log(`\n  scoring time: ${Date.now() - t0}ms`);
    if (full.meta.role_fit && full.meta.role_fit.role_noun) {
      const rf = full.meta.role_fit;
      console.log(`  role fit meta: role="${rf.role_noun}" domain="${rf.domain}" skills=${rf.skills_coverage}% bullets=${rf.bullets_coverage}% missing=${rf.missing_keywords?.slice(0,5).join(', ') || 'none'}`);
    }
    console.log(`\n─── ISSUES (${full.issues.length}) ───`);
    for (const iss of full.issues) {
      const src = iss.source_line ? `line ${iss.source_line}` : 'structural';
      console.log(`  ${iss.severity.padEnd(8)} [${iss.category}] (${src})`);
      console.log(`    why:  ${iss.why}`);
      console.log(`    cost: ${iss.cost}`);
      console.log('');
    }
    console.log(`─── META ───`);
    console.log(`  cache_key: ${full.meta.cache_key.slice(0, 24)}…`);
    return;
  }

  const s = score({
    text: parsed.text,
    parseMeta: parsed.meta,
    resume_json: ex.resume_json,
    role: args.role,
    roleType: args.roleType,
  });

  console.log(`\n─── DETERMINISTIC SCORE: ${s.score_deterministic} / ${s.max_deterministic} ───\n`);
  for (const [key, sub] of Object.entries(s.subscores)) {
    const bar = '█'.repeat(Math.round((sub.earned / sub.max) * 10)) + '░'.repeat(10 - Math.round((sub.earned / sub.max) * 10));
    console.log(`  ${sub.label.padEnd(38)} ${sub.earned.toFixed(1)} / ${sub.max.toFixed(1)}  [${bar}]`);
  }

  console.log(`\n─── ISSUES (${s.issues.length}) ───`);
  for (const iss of s.issues) {
    const src = iss.source_line ? `line ${iss.source_line}` : 'structural';
    console.log(`  ${iss.severity.padEnd(8)} [${iss.category}] (${src})`);
    console.log(`    why:  ${iss.why}`);
    console.log(`    cost: ${iss.cost}`);
    console.log('');
  }

  console.log(`─── META ───`);
  console.log(`  bullets:      ${s.meta.bullets_total}`);
  console.log(`  cache_key:    ${s.meta.cache_key.slice(0, 24)}…`);

  if (args.verifyCache) {
    console.log(`\n─── DETERMINISM CHECK ─── (scoring twice, byte-compare)`);
    const s2 = score({
      text: parsed.text,
      parseMeta: parsed.meta,
      resume_json: ex.resume_json,
      role: args.role,
      roleType: args.roleType,
    });
    const a = JSON.stringify({ score: s.score_deterministic, sub: s.subscores, iss: s.issues, key: s.meta.cache_key });
    const b = JSON.stringify({ score: s2.score_deterministic, sub: s2.subscores, iss: s2.issues, key: s2.meta.cache_key });
    if (a === b) console.log(`  ✓ identical (${a.length} bytes)`);
    else { console.log(`  ✗ DIFFER — determinism broken`); process.exit(1); }
  }
}

main().catch((e) => { console.error('rate-score crashed:', e); process.exit(1); });
