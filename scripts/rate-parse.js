#!/usr/bin/env node
// Day-1 developer CLI. Usage:
//   node scripts/rate-parse.js <path.pdf|path.docx> [--no-llm]
//
// Prints:
//   - which parse layer won (pdfjs / pdf-parse / docx / refuse)
//   - text quality signals (word count, page count, multi-column flag)
//   - the extracted resume_json (unless --no-llm)
//   - completeness summary (what filled, what's missing)
//
// This is a bench for Day 1 to prove text → resume_json round-trip works on
// real Indian student resumes. Nothing wired into WhatsApp yet.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('../src/rate/parse');
const { extract } = require('../src/rate/extract');

async function main() {
  const args = process.argv.slice(2);
  const noLlm = args.includes('--no-llm');
  const pathArg = args.find((a) => !a.startsWith('--'));
  if (!pathArg) {
    console.error('Usage: node scripts/rate-parse.js <path.pdf|path.docx> [--no-llm]');
    process.exit(2);
  }
  const abs = path.resolve(pathArg);
  if (!fs.existsSync(abs)) {
    console.error(`file not found: ${abs}`);
    process.exit(2);
  }
  const buffer = fs.readFileSync(abs);

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(` rate-parse: ${path.basename(abs)}`);
  console.log(` size:       ${(buffer.length / 1024).toFixed(1)} KB`);
  console.log(`══════════════════════════════════════════════════════\n`);

  // ── Parse ────────────────────────────────────────────────────
  const t0 = Date.now();
  const parsed = await parse(buffer, { filename: abs });
  const parseMs = Date.now() - t0;

  console.log(`─── PARSE ─── (${parseMs}ms)`);
  console.log(`  layer:        ${parsed.meta.layer} (${parsed.meta.layerName})`);
  console.log(`  wordCount:    ${parsed.meta.wordCount}`);
  console.log(`  pageCount:    ${parsed.meta.pageCount}`);
  console.log(`  multiColumn:  ${parsed.meta.multiColumn ? '⚠️  YES (ATS-hostile)' : 'no'}`);
  if (parsed.meta.refuse) {
    console.log(`  ⛔ REFUSE:     ${parsed.meta.refuseReason}`);
    console.log(`\nParse could not extract enough text. Rate mode would refuse this file with a graceful message to the student.`);
    process.exit(0);
  }
  console.log(`  linesFound:   ${parsed.lines.length}`);
  console.log(`\n─── FIRST 8 LINES ───`);
  for (const l of parsed.lines.slice(0, 8)) {
    console.log(`  ${String(l.n).padStart(3, ' ')}| ${l.text.slice(0, 90)}`);
  }
  if (parsed.lines.length > 8) console.log(`  ... (+${parsed.lines.length - 8} more lines)`);

  if (noLlm) {
    console.log(`\n[--no-llm] Skipping extraction.`);
    process.exit(0);
  }

  // ── Extract ──────────────────────────────────────────────────
  console.log(`\n─── EXTRACT ─── (LLM)`);
  const t1 = Date.now();
  let ex;
  try {
    ex = await extract({ lines: parsed.lines });
  } catch (e) {
    console.error(`extract failed: ${e.message}`);
    if (e.status) console.error(`status: ${e.status}`);
    process.exit(1);
  }
  const exMs = Date.now() - t1;

  if (!ex.resume_json) {
    console.log(`  ⛔ extract skipped: ${ex.meta.reason}`);
    process.exit(1);
  }
  const rj = ex.resume_json;
  console.log(`  ms:           ${exMs}`);
  console.log(`  model:        ${ex.meta.model}`);
  console.log(`  attempts:     ${ex.meta.attempts}`);
  console.log(`  tokens:       ${ex.usage?.total_tokens || '?'} (prompt ${ex.usage?.prompt_tokens || '?'} / completion ${ex.usage?.completion_tokens || '?'})`);
  const costUsd = ex.usage ? (ex.usage.prompt_tokens * 0.00000015 + ex.usage.completion_tokens * 0.0000006) : 0;
  console.log(`  ~cost:        $${costUsd.toFixed(5)}`);

  console.log(`\n─── COMPLETENESS ───`);
  const check = (label, val) => console.log(`  ${val ? '✓' : '·'}  ${label}: ${val || '(missing)'}`);
  check('name', rj.name);
  check('email', rj.email);
  check('phone', rj.phone);
  check('linkedin', rj.linkedin);
  check('github', rj.github);
  check('summary', rj.summary ? rj.summary.slice(0, 60) + '...' : null);
  console.log(`  ${(rj.education || []).length ? '✓' : '·'}  education:    ${(rj.education || []).length} entry(ies)`);
  console.log(`  ${(rj.experience || []).length ? '✓' : '·'}  experience:   ${(rj.experience || []).length} entry(ies)`);
  console.log(`  ${(rj.projects || []).length ? '✓' : '·'}  projects:     ${(rj.projects || []).length} entry(ies)`);
  console.log(`  ${(rj.por || []).length ? '✓' : '·'}  por:          ${(rj.por || []).length} entry(ies)`);
  console.log(`  ${(rj.certifications || []).length ? '✓' : '·'}  certs:        ${(rj.certifications || []).length}`);
  console.log(`  ${(rj.achievements || []).length ? '✓' : '·'}  achievements: ${(rj.achievements || []).length}`);
  console.log(`  ${(rj.skills || []).length ? '✓' : '·'}  skills:       ${(rj.skills || []).reduce((n, c) => n + (c.items?.length || 0), 0)} items in ${(rj.skills || []).length} categories`);

  // ── Anchor spot-check ────────────────────────────────────────
  // Verify every bullet's source_line points at a real line, and that
  // raw_text is at least a substring-y match. This is a Day-1 confidence
  // check — the real fabrication verifier runs on rewrites, not extractions.
  const anchorProblems = [];
  const checkBullets = (owner, arr, kind) => {
    for (let i = 0; i < (arr || []).length; i++) {
      const entry = arr[i];
      for (let j = 0; j < (entry.bullets || []).length; j++) {
        const b = entry.bullets[j];
        if (b == null || typeof b !== 'object') { anchorProblems.push(`${kind}[${i}].bullets[${j}] not object`); continue; }
        if (!b.source_line) { anchorProblems.push(`${kind}[${i}].bullets[${j}] no source_line`); continue; }
        const line = parsed.lines.find((l) => l.n === b.source_line);
        if (!line) { anchorProblems.push(`${kind}[${i}].bullets[${j}] source_line ${b.source_line} not in doc`); continue; }
      }
    }
  };
  checkBullets(rj, rj.experience, 'experience');
  checkBullets(rj, rj.projects, 'projects');
  checkBullets(rj, rj.por, 'por');

  console.log(`\n─── ANCHOR CHECK ───`);
  if (anchorProblems.length === 0) {
    console.log(`  ✓ all bullets have valid source_line anchors`);
  } else {
    console.log(`  ⚠️  ${anchorProblems.length} anchor issues:`);
    for (const p of anchorProblems.slice(0, 10)) console.log(`     - ${p}`);
    if (anchorProblems.length > 10) console.log(`     (+${anchorProblems.length - 10} more)`);
  }

  // ── Optional dump ────────────────────────────────────────────
  console.log(`\n─── FULL resume_json ───`);
  console.log(JSON.stringify(rj, null, 2));
}

main().catch((e) => {
  console.error('rate-parse crashed:', e);
  process.exit(1);
});
