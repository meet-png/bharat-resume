// Pre-delivery sanity check. Per the ATS checklist 2026-06-24:
// "Before finalizing any document, run a self-check: search the full extracted
//  text for the literal substrings &amp;, &lt;, &gt;, &quot;, &#. If any are
//  found, treat this as a blocking defect and fix before output."
//
// We don't need to extract text from the PDF — Puppeteer's PDF text layer is
// a faithful rendering of the HTML's text nodes (tags drop out, text remains).
// So the cheapest, most reliable scan is on the HTML's text content directly.
//
// We strip everything between `<` and `>` (HTML tags + attributes — which
// legitimately contain things like href="...&amp;..." that AREN'T a bug),
// then assert no entity-shaped substrings remain in the visible text layer.
//
// Returns { ok: true } on pass, or { ok: false, violations: [...] } on fail.

const ENTITY_PATTERNS = [
  /&amp;/,
  /&lt;/,
  /&gt;/,
  /&quot;/,
  /&apos;/,
  /&#\d+;/,
  /&#x[0-9a-fA-F]+;/,
];

// Standard ATS-recognisable section headings. Required when the corresponding
// section is present in the rendered HTML (heuristic: we look for the section
// header text in the HTML and assert it's spelled in a recognisable form).
const STANDARD_HEADINGS = [
  /summary/i,
  /education/i,
  /technical skills|skills/i,
  /experience|work experience|professional experience/i,
  /projects/i,
  /certifications|courses/i,
  /achievements|awards|honors/i,
];

function stripTags(html) {
  // Drop the head entirely (title / style / meta aren't in the visible PDF),
  // then drop every remaining <tag ...> block. Replace each removed run with
  // a space so sibling text doesn't fuse.
  return String(html || '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

// One-pass entity decoder mirroring render.decodeEntities — kept inline so
// sanity has zero coupling to render.js. We decode BEFORE scanning so a
// legitimate "&amp;" in HTML source (which the browser renders as "&") does
// NOT trigger a false positive; we only flag entities that would still be
// visible as literal "&amp;" / "&lt;" / etc. in the PDF text layer (i.e. when
// the HTML source contained "&amp;amp;" — a double-escape bug).
function decodeOnce(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 0));
}

function checkRenderedHtml(html) {
  if (!html || typeof html !== 'string') {
    return { ok: false, violations: [{ kind: 'empty-html', detail: 'render produced no HTML' }] };
  }
  // The PDF text layer is the browser-rendered text — entities collapse to
  // their character once. So a single decode pass on the stripped HTML
  // mirrors what's actually visible. If THAT still contains "&amp;" etc.,
  // the HTML source had a double-escape ("&amp;amp;") — a real defect.
  const text = decodeOnce(stripTags(html));
  const violations = [];

  // Entity-leak scan — the trust-critical check.
  for (const pat of ENTITY_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      const idx = text.indexOf(m[0]);
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + m[0].length + 30);
      violations.push({
        kind: 'html-entity-leak',
        entity: m[0],
        context: text.slice(start, end).replace(/\s+/g, ' ').trim(),
      });
    }
  }

  // Soft check (does NOT block delivery — recorded as a warning the caller
  // can log). A thin resume with only a summary or only education legitimately
  // has fewer recognisable headings; we don't refuse to ship it. We block
  // ONLY on the trust-critical class: entity leaks in the visible text layer.
  const warnings = [];
  const recognisedHeadings = STANDARD_HEADINGS.filter((re) => re.test(html));
  if (recognisedHeadings.length === 0) {
    warnings.push({ kind: 'no-recognisable-section-headings', detail: 'none of the standard ATS section names matched — likely a near-empty resume' });
  }

  return violations.length === 0
    ? { ok: true, warnings }
    : { ok: false, violations, warnings };
}

// Render an HTML string to the same plain-text the PDF reader / ATS would see:
// strip head + tags, then decode HTML entities once (the browser would do this
// on its own when displaying the PDF).
function htmlToVisibleText(html) {
  return decodeOnce(stripTags(html));
}

module.exports = { checkRenderedHtml, stripTags, htmlToVisibleText, ENTITY_PATTERNS };
