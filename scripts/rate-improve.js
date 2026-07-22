#!/usr/bin/env node
// Day-5 dev CLI. Usage:
//   node scripts/rate-improve.js <path.pdf|path.docx> --role "Backend Engineer"
//
// Runs parse → extract → improveResume(); prints a per-bullet before/after
// diff with the verifier verdict (llm | llm-retry | safe-fallback | unchanged
// | skipped) so the improvement path is fully auditable end-to-end.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('../src/rate/parse');
const { extract } = require('../src/rate/extract');
const { improveResume } = require('../src/rate/improve-resume');

function parseArgs(argv) {
  const out = { role: 'Software Engineer' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') { out.role = argv[++i] || out.role; continue; }
    if (a.startsWith('--')) continue;
    rest.push(a);
  }
  out.pathArg = rest[0];
  return out;
}

const MODE_ICONS = {
  llm:              '✓',
  'llm-retry':      '↻',
  'safe-fallback':  '⚠',
  unchanged:        '·',
  skipped:          '⊘',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pathArg) {
    console.error('Usage: node scripts/rate-improve.js <path.pdf|path.docx> --role "Backend Engineer"');
    process.exit(2);
  }
  const abs = path.resolve(args.pathArg);
  if (!fs.existsSync(abs)) { console.error(`file not found: ${abs}`); process.exit(2); }
  const buffer = fs.readFileSync(abs);

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(` rate-improve: ${path.basename(abs)}`);
  console.log(` role:         ${args.role}`);
  console.log(`══════════════════════════════════════════════════════\n`);

  const parsed = await parse(buffer, { filename: abs });
  console.log(`─── PARSE ─── layer=${parsed.meta.layerName} words=${parsed.meta.wordCount} pages=${parsed.meta.pageCount}`);
  if (parsed.meta.refuse) { console.log(`  ⛔ REFUSE: ${parsed.meta.refuseReason}`); process.exit(0); }

  const ex = await extract({ lines: parsed.lines });
  if (!ex.resume_json) { console.log(`  ⛔ extract skipped: ${ex.meta.reason}`); process.exit(1); }
  console.log(`─── EXTRACT ─── model=${ex.meta.model} tokens=${ex.usage?.total_tokens || '?'}`);

  const t0 = Date.now();
  const result = await improveResume({
    resume_json: ex.resume_json,
    sourceText: parsed.text,
    role: args.role,
  });
  console.log(`─── IMPROVE ─── ${Date.now() - t0}ms`);
  const c = result.meta.counts;
  console.log(`  bullets:        ${c.total}`);
  console.log(`  ✓ llm:          ${c.llm || 0}`);
  console.log(`  ↻ llm-retry:    ${c['llm-retry'] || 0}`);
  console.log(`  ⚠ safe-fallback: ${c['safe-fallback'] || 0}`);
  console.log(`  · unchanged:    ${c.unchanged || 0}`);
  console.log(`  ⊘ skipped:      ${c.skipped || 0}`);
  console.log(`  unverified:     ${c.unverified}   ← MUST be 0 (else the moat leaked)`);

  console.log(`\n─── PER-BULLET DIFF ───`);
  for (const a of result.audit) {
    const icon = MODE_ICONS[a.mode] || '?';
    const src = a.source_line ? `line ${String(a.source_line).padStart(3)}` : 'no anchor';
    console.log(`\n${icon} [${a.section}] ${src}  (${a.entry_label})`);
    console.log(`   BEFORE: ${a.original}`);
    console.log(`   AFTER:  ${a.improved}`);
    if (a.changes) console.log(`   why:    ${a.changes}`);
    if (!a.verified) console.log(`   ⛔ UNVERIFIED atoms: ${a.unverified.join(', ')}`);
  }

  console.log(`\n─── SUMMARY ───`);
  const anyUnverified = result.audit.some((a) => !a.verified);
  if (anyUnverified) {
    console.log(`  ✗ Some bullets left unverified — improver leaked a fabrication. Should never happen.`);
    process.exit(1);
  }
  const llmSuccess = (c.llm || 0) + (c['llm-retry'] || 0);
  console.log(`  ✓ ${llmSuccess}/${c.total} bullets improved by LLM + verifier`);
  console.log(`  ✓ ${(c['safe-fallback'] || 0)}/${c.total} bullets safe-fallback`);
  console.log(`  · ${(c.unchanged || 0)}/${c.total} bullets left unchanged`);
  console.log(`  Total time: ${result.meta.elapsed_ms}ms`);
}

main().catch((e) => { console.error('rate-improve crashed:', e); process.exit(1); });
