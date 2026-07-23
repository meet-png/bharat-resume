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

// Refuse-parse message — sent when parse.js layer 3 fires. Include a specific
// reason line so the student knows exactly what to fix. Each branch below
// corresponds to a `refuseReason` returned by src/rate/parse.js.
const refusePdf = (reason) => {
  let reasonLine, tip;
  switch (reason) {
    case 'canva-placeholder-template':
      reasonLine = '  • Ye Canva ka *empty template* lagta hai — placeholder text (Lorem ipsum, "hello@reallygreatsite.com", "+123-456-7890") abhi tak fill nahi hua.';
      tip = '  • Canva me apni details fill karo (name, email, real experience), export karo, phir bhejo.\n' +
            '  • Ya *"build"* likhkar chat me apna resume banao — main directly ATS-ready PDF banaunga.';
      break;
    case 'canva-multi-column-template':
      reasonLine = '  • Ye Canva ka *2-column decorative template* lagta hai — sidebar (skills/contact) aur main column ka mix. ATS parsers aur hamara reader dono is layout ko theek se nahi padh sakte.';
      tip = '  • Simple single-column resume banao — Word / Google Docs ka basic template best hai.\n' +
            '  • Ya *"build"* likhkar chat me ATS-friendly resume banwao — free/₹49 me clean version.';
      break;
    case 'canva-letter-spaced-headers':
      reasonLine = '  • Section headers me spaces hain ("P R O F I L E", "S K I L L S") — ye Canva template signal hai. ATS parsers is format ko section headers ke roop me nahi pehchante.';
      tip = '  • Simple resume template use karo jisme section headers plain hon ("PROFILE", "SKILLS").\n' +
            '  • Ya *"build"* likhkar chat me apna resume banwao.';
      break;
    case 'multi-column-layout':
      reasonLine = '  • Ye 2-column layout hai — visual me sundar dikhta hai but ATS parsers aur hamara reader dono column order jumble kar dete hain.';
      tip = '  • Single-column layout me export karo, phir bhejo.\n' +
            '  • Ya *"build"* likhkar chat me apna resume banwao.';
      break;
    case 'text-too-thin-probably-image-pdf':
      reasonLine = '  • Aisa lagta hai ye PDF image-based hai (scanned / phone se photo liya hua / Canva image export).';
      tip = '  • Text-based PDF chahiye — Google Docs / Word se "Save As PDF" karo, screenshot / scan nahi.\n' +
            '  • Ya *"build"* likhkar chat me naya resume banwao.';
      break;
    case 'no-text-extractable':
      reasonLine = '  • Is PDF se koi text extract nahi ho paaya — pura file image-based ya encrypted hai.';
      tip = '  • Word (.docx) file bhejo, ya text-based PDF export karo.\n' +
            '  • Ya *"build"* likhkar chat me naya resume banwao.';
      break;
    case 'docx-too-thin':
      reasonLine = '  • Ye Word file bahut chhoti hai (100 words se kam) — probably empty template ya galat file.';
      tip = '  • Complete resume file bhejo.\n' +
            '  • Ya *"build"* likhkar chat me apna resume banwao.';
      break;
    case 'docx-error':
      reasonLine = '  • Word file read nahi ho paayi — file corrupt ya password-protected ho sakti hai.';
      tip = '  • File dobara save karke bhejo (Save As → new file).\n' +
            '  • Ya *"build"* likhkar chat me apna resume banwao.';
      break;
    default:
      reasonLine = `  • Parse issue: ${reason || 'unknown'}`;
      tip = '  • Simple single-column PDF ya .docx file bhejo.\n' +
            '  • Ya *"build"* likhkar chat me apna resume banwao.';
  }
  return (
    '⛔ Ye file process nahi ho paayi.\n\n' +
    reasonLine + '\n\n' +
    '*Solution:*\n' +
    tip + '\n\n' +
    'Dobara file bhejo, ya "cancel" karo.'
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

// ─── Score glimpse (student-facing) ─────────────────────────────────────
// Design rules (per Meet 2026-07-23 feedback):
//   1. Short + crisp. No sub-score dump — that's internal noise.
//   2. Cluster identical issues (three "no metric" bullets show as ONE line
//      listing the source lines, not three separate identical entries).
//   3. Section-level count breakdown — "where are the problems".
//   4. Total count + severity distribution up top for scannability.
//   5. Payment CTA emphasizes the LOCKED count so paying feels concrete.

const CATEGORY_TO_SECTION = {
  content_missing_metric:     'Content',
  content_low_impact:         'Content',
  content_weak_verb:          'Content',
  content_filler_phrase:      'Content',
  content_metric_density_low: 'Content',
  content_no_bullets:         'Content',
  role_fit_missing_keywords:  'Role fit',
  ats_multi_column:           'Structure',
  ats_weak_structure:         'Structure',
  polish_page_count_high:     'Polish',
  polish_date_format_inconsistent: 'Polish',
  polish_grammar:             'Polish',
  contact_email_missing:      'Contact',
  contact_phone_missing:      'Contact',
  contact_linkedin_missing:   'Contact',
  contact_linkedin_legacy_format: 'Contact',
  contact_github_missing:     'Contact',
  india_cgpa_missing:         'India fields',
  india_cgpa_missing_denominator: 'India fields',
  india_boards_missing:       'India fields',
};

const CATEGORY_SHORT = {
  content_missing_metric:     'bullets missing metrics',
  content_low_impact:         'low-impact bullets',
  content_weak_verb:          'weak verbs',
  content_filler_phrase:      'filler phrases',
  content_metric_density_low: 'low metric density',
  content_no_bullets:         'no bullets found',
  role_fit_missing_keywords:  'role-fit gaps',
  ats_multi_column:           'multi-column layout',
  ats_weak_structure:         'weak section structure',
  polish_page_count_high:     'page count over 1',
  polish_date_format_inconsistent: 'inconsistent date format',
  polish_grammar:             'grammar issues',
  contact_email_missing:      'email missing',
  contact_phone_missing:      'phone missing',
  contact_linkedin_missing:   'LinkedIn URL missing',
  contact_linkedin_legacy_format: 'LinkedIn legacy /pub/ format',
  contact_github_missing:     'GitHub URL missing',
  india_cgpa_missing:         'CGPA missing',
  india_cgpa_missing_denominator: 'CGPA /10 denominator missing',
  india_boards_missing:       '10th/12th % missing',
};

function sevWeight(s) { return s === 'CRITICAL' ? 3 : s === 'MEDIUM' ? 2 : 1; }

function clusterIssues(issues) {
  const groups = new Map();
  for (const iss of (issues || [])) {
    const key = iss.category;
    if (!groups.has(key)) {
      groups.set(key, {
        category: key,
        section: CATEGORY_TO_SECTION[key] || 'Other',
        short: CATEGORY_SHORT[key] || key,
        severity: iss.severity,
        lines: [],
        count: 0,
      });
    }
    const g = groups.get(key);
    g.count++;
    if (sevWeight(iss.severity) > sevWeight(g.severity)) g.severity = iss.severity;
    if (iss.source_line) g.lines.push(iss.source_line);
  }
  return [...groups.values()].sort((a, b) => sevWeight(b.severity) - sevWeight(a.severity));
}

function sectionCounts(clusters) {
  const m = new Map();
  for (const c of clusters) m.set(c.section, (m.get(c.section) || 0) + c.count);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function renderScoreGlimpse({ score, issues, role, unlockAmount = 49 }) {
  const clusters = clusterIssues(issues);
  const total = clusters.reduce((n, c) => n + c.count, 0);
  const critical = clusters.reduce((n, c) => n + (c.severity === 'CRITICAL' ? c.count : 0), 0);
  const medium   = clusters.reduce((n, c) => n + (c.severity === 'MEDIUM' ? c.count : 0), 0);
  const minor    = clusters.reduce((n, c) => n + (c.severity === 'MINOR' ? c.count : 0), 0);

  const lines = [];
  lines.push(`📊 *Score: ${score.toFixed(1)} / 10*  ·  ${role}`);
  lines.push('');

  if (total === 0) {
    lines.push('✨ Kuch bhi critical nahi mila — resume already strong hai.');
    lines.push('');
    lines.push(`Minor polish ke liye ₹${unlockAmount} unlock kariye, ya *"cancel"* karo.`);
    return lines.join('\n');
  }

  lines.push(`*${total} issues found*  ·  🔴 ${critical} critical  ·  🟡 ${medium} medium  ·  🟢 ${minor} minor`);
  lines.push('');

  lines.push('📌 *Where the problems are:*');
  for (const [section, n] of sectionCounts(clusters)) {
    lines.push(`   • ${section} — ${n} issue${n > 1 ? 's' : ''}`);
  }
  lines.push('');

  lines.push('*Biggest fixes needed:*');
  const shown = clusters.slice(0, 4);
  for (const c of shown) {
    const sev = c.severity === 'CRITICAL' ? '🔴' : c.severity === 'MEDIUM' ? '🟡' : '🟢';
    let linesTxt = '';
    if (c.lines.length) {
      const shownLines = c.lines.slice(0, 5).join(', ');
      linesTxt = c.count > 1
        ? ` — ${c.count}× (lines ${shownLines}${c.lines.length > 5 ? '…' : ''})`
        : ` — line ${c.lines[0]}`;
    } else if (c.count > 1) {
      linesTxt = ` — ${c.count}×`;
    }
    lines.push(`   ${sev} ${c.short}${linesTxt}`);
  }
  const remaining = clusters.length - shown.length;
  if (remaining > 0) {
    lines.push(`   … +${remaining} more categor${remaining > 1 ? 'ies' : 'y'} in the full report`);
  }
  lines.push('');

  lines.push('━━━━━━━━━━━━━━━');
  lines.push(`🔓 *₹${unlockAmount} unlock:*`);
  lines.push(`   • All ${total} issues addressed`);
  lines.push('   • Clean improved PDF (no watermark)');
  lines.push('   • Full audit — every change cites your original line');
  lines.push('');
  lines.push('Reply *"pay"*  ·  *"change role"*  ·  *"cancel"*');
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

// Proactive missing-link prompt (post-extract, pre-role). Shown ONLY when
// detectMissingLinks() found something worth asking for. Every missing link
// is optional — student can reply "skip" and we proceed without them, but
// the score will honestly reflect the gap.
function askForMissingLinks(missing) {
  const lines = [];
  lines.push('📎 *Kuch important links missing hain aapke resume me:*');
  lines.push('');
  for (const m of missing) {
    lines.push(`   • ${m.label}${m.hint ? `  _(${m.hint})_` : ''}`);
  }
  lines.push('');
  lines.push('*Ek message me sab bhejo* — mein sab identify kar lunga:');
  lines.push('   `linkedin.com/in/yourname github.com/yourname github.com/yourname/project-repo`');
  lines.push('');
  lines.push('Ya *"skip"* likho — score aayegi lekin missing-links flag ho jayegi.');
  return lines.join('\n');
}

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
  askForMissingLinks,
};
