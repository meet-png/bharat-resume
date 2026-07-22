// Rate-mode message templates. Kept separate from build-mode prompts.js so
// changes here can't accidentally affect the build flow. All text is
// Hinglish-first with English fallbacks — matches Meet's voice for JECRC
// pilot audience.

const modeSelect = () =>
  'Namaste 🙏 Bharat Resume me swagat hai.\n\n' +
  'Kya karna hai?\n\n' +
  '*1️⃣  Naya resume banao*  — 20 min ka chat, aap details doge, main ATS-ready PDF banaunga\n' +
  '*2️⃣  Existing rate karvao* — apna PDF resume bhejo, score + fixes dunga, ₹49 me clean version + full report\n\n' +
  'Reply karo: *"1"* / *"build"* / *"naya banao"* — for building\n' +
  '            *"2"* / *"rate"* / *"rate karvao"* — for rating existing\n\n' +
  '_Note: File / photo bhejni ho to option 2 (rate) select kariye._';

const askForPdf = () =>
  '📊 *Rate mode active*\n\n' +
  'Apna resume PDF ya Word (.docx) file bhejo — main:\n' +
  '  • ATS-friendly score dunga (out of 10)\n' +
  '  • Top 3 problems highlight karunga\n' +
  '  • ₹49 pay karne pe: full 8-point report + clean improved PDF + audit trail\n\n' +
  '_Note: Text-based PDF chahiye (Canva image-based templates parse nahi ho paate). File size 10MB tak._\n' +
  '_Type "cancel" to switch back to mode selection._';

const askForRole = () =>
  '👍 Resume mil gaya. Ab batao — *kaun sa role target kar rahe ho?*\n\n' +
  'Examples:\n' +
  '  • Backend Software Engineer\n' +
  '  • Data Analyst\n' +
  '  • Product Manager\n' +
  '  • ML Engineer\n' +
  '  • Business Analyst\n\n' +
  '_Role bataao — score aur suggestions role-tuned honge._\n' +
  '_Type "cancel" to start over._';

const parsing = () =>
  '⏳ Resume parse ho raha hai — 15-25 seconds, please wait…';

const scoring = () =>
  '⏳ Scoring in progress — parsing, extracting content, checking ATS compliance, JD fit… ~30 seconds.';

// Refuse-parse message — sent when parse.js layer 3 fires (image-based PDF,
// too little text, etc.). Include the specific reason so the student knows
// what to fix.
const refusePdf = (reason) => {
  const reasonLine = reason === 'text-too-thin-probably-image-pdf'
    ? '  • Aisa lagta hai ye PDF image-based hai (Canva templates aksar aise hote hain — text nahi read ho sakta).'
    : reason === 'no-text-extractable'
    ? '  • Is PDF se koi text extract nahi ho paaya.'
    : `  • Parse issue: ${reason}`;
  return (
    '⛔ Ye PDF process nahi ho paaya.\n\n' +
    reasonLine + '\n\n' +
    'Try karo:\n' +
    '  • Word file (.docx) me export karke bhejo\n' +
    '  • Text-based PDF me convert kariye (Google Docs → Download → PDF)\n' +
    '  • Ya *"build"* likhkar naya resume banao chat me\n\n' +
    'Apna resume dobara bhejo, ya "cancel" karo.'
  );
};

const refuseNonPdf = () =>
  '📎 File format supported nahi hai.\n\n' +
  'Rate mode me PDF ya DOCX file chahiye. Photo / image / voice note kaam nahi karenge — ATS bhi image-based resume reject karta hai.\n\n' +
  'Text-based PDF ya Word file bhejo.';

const askForPdfNoText = () =>
  '📎 Text message aa gaya, but rate mode me *PDF ya Word file* chahiye.\n\n' +
  'Apna resume file attach karke bhejo. Ya:\n' +
  '  • *"build"* — naya resume banane ke liye\n' +
  '  • *"cancel"* — start over';

// Renders score + top 3 issues + pay CTA. Called from rate-router after scoring.
function renderScoreGlimpse({ score, subscores, issues, role, unlockAmount = 49 }) {
  const lines = [];
  lines.push(`📊 *Score: ${score.toFixed(1)} / 10*`);
  lines.push(`Target role: ${role}\n`);

  // Compact subscore lines (2 columns for readability)
  lines.push('Sub-scores:');
  for (const [key, sub] of Object.entries(subscores)) {
    const label = String(sub.label || key).padEnd(38);
    lines.push(`  ${label}  ${sub.earned.toFixed(1)} / ${sub.max.toFixed(1)}`);
  }
  lines.push('');

  const top = (issues || []).slice(0, 3);
  if (top.length > 0) {
    lines.push('*Top fixes (full report has more):*');
    for (let i = 0; i < top.length; i++) {
      const it = top[i];
      const src = it.source_line ? ` (line ${it.source_line})` : '';
      lines.push(`\n${i + 1}️⃣  [${it.severity}]${src}`);
      lines.push(`     ${String(it.why).slice(0, 180)}`);
      lines.push(`     _Cost: ${String(it.cost).slice(0, 120)}_`);
    }
  } else {
    lines.push('_No critical issues found — the paid report will show minor polish opportunities._');
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━');
  lines.push(`💳 *₹${unlockAmount} UPI unlock:*`);
  lines.push('  • Full 8-point report (all fixes)');
  lines.push('  • Clean improved PDF (no watermark)');
  lines.push('  • Audit trail — every change cites your original line');
  lines.push('');
  lines.push('Reply *"pay"* to unlock, or *"cancel"* to start over.');
  return lines.join('\n');
}

const payIntro = ({ payUrl, unlockAmount = 49 }) =>
  `💳 *₹${unlockAmount} UPI payment link:*\n\n${payUrl}\n\n` +
  'UPI / GPay / PhonePe — any Indian payment app kaam karega.\n\n' +
  '_Payment complete hote hi improved PDF + audit report bhej dunga._';

const improving = () =>
  '⏳ Improvements running — extracting, verifying every atom traces to your source, generating clean PDF. ~30-45 seconds.';

const cancelled = () =>
  '↩ Rate mode se bahar aa gaye.\n\n' +
  'Type *"build"* to create a new resume from scratch, or *"rate"* to try rating again with a different file.';

const notNow = () =>
  '_Rate mode se cancel ho gaya. Type "rate" to start again or "build" for new resume._';

module.exports = {
  modeSelect,
  askForPdf,
  askForRole,
  parsing,
  scoring,
  refusePdf,
  refuseNonPdf,
  askForPdfNoText,
  renderScoreGlimpse,
  payIntro,
  improving,
  cancelled,
  notNow,
};
