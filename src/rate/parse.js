// Text extraction for rate-mode PDFs / docx. NO LLM here — deterministic only.
//
// Contract:
//   parse(buffer, { filename }) → { text, lines, meta }
//     text     — reconstructed plain text of the whole document
//     lines    — [{ n, text }] with 1-indexed line numbers, used as source
//                anchors so every downstream fix/change/citation can point
//                back at the student's original wording.
//     meta     — { layer, layerName, wordCount, pageCount, multiColumn,
//                  refuse, refuseReason }
//
// Layers (in order):
//   1  pdfjs-dist  — primary; preserves positional info for line reconstruction
//   2  pdf-parse   — fallback; different heuristic, sometimes wins on odd PDFs
//   3  refuse      — <100 words after both = probably image-based; graceful say-no
//
// pdfjs-dist v6 is pure ESM. This module is CommonJS. We use dynamic import().
// Loader is memoized so we pay the ~150ms cold-start once per process.

const path = require('path');
const logger = require('../logger');

const MIN_WORDS = 100; // < this = "probably image PDF" → refuse

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

// Group text items on the same visual line. PDF y-coordinates are floats and
// the same visual line can have items with y differing by a few units due to
// subscripts, superscripts, or font baseline shift — so we bin by rounded y
// within a small tolerance (2 pt is generous but reliable across templates).
function groupItemsByLine(items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const y = Math.round(it.transform[5] / 2) * 2; // 2pt bin
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(it);
  }
  // Sort each group by x (left to right)
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.transform[4] - b.transform[4]);
  }
  // Sort groups by y descending (PDF origin is bottom-left → we want top first)
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, arr]) => ({ y, items: arr }));
}

// Join items in a line group into a single string. Insert a space when the
// x-gap between consecutive items exceeds a heuristic threshold (roughly one
// half-em). Without this, tightly-set text becomes "BuiltBackendAPI" rather
// than "Built Backend API".
function joinLineItems(items) {
  let out = '';
  let lastRight = -Infinity;
  for (const it of items) {
    const x = it.transform[4];
    const gap = x - lastRight;
    if (out && gap > 2) out += ' ';
    out += it.str;
    lastRight = x + (it.width || 0);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Heuristic: if a substantial fraction of visual lines contain a large x-gap
// inside them, the document is probably multi-column. Multi-column layouts
// confuse ATS parsers and our own linear reader — flag so the caller can
// warn the student.
function detectMultiColumn(pages) {
  let bigGapLines = 0;
  let totalLines = 0;
  for (const page of pages) {
    const pageWidth = page.width || 600;
    const gapThreshold = pageWidth * 0.15; // > 15% of page width = probable column break
    for (const line of page.lines) {
      totalLines++;
      const items = line.items;
      for (let i = 1; i < items.length; i++) {
        const prevRight = items[i - 1].transform[4] + (items[i - 1].width || 0);
        const gap = items[i].transform[4] - prevRight;
        if (gap > gapThreshold) { bigGapLines++; break; }
      }
    }
  }
  if (totalLines === 0) return false;
  return bigGapLines / totalLines > 0.25;
}

// PDF Link annotations give us the underlying hrefs that the text-content
// stream strips. For each annotation we compute the centroid of its rect,
// then match it to the line whose y-range covers that centroid — that's the
// line the hyperlink was drawn on. We then append the URL inline (in
// parentheses) to that line's text, so the downstream LLM extractor sees
// "LinkedIn (https://linkedin.com/in/xyz)" instead of just "LinkedIn".
//
// Why append in parentheses instead of emitting a separate URL list:
// (a) preserves the source_line anchor invariant — the URL lives on the same
// line as the display text it labels;
// (b) keeps the schema unchanged (still just { n, text });
// (c) lets sanitizeUrls() in extract.js coerce the URL slot correctly.
function mergeAnnotationsIntoLines(pageLines, annotations) {
  if (!annotations || annotations.length === 0) return;
  const linkAnnots = annotations.filter((a) => a && a.subtype === 'Link' && a.url && typeof a.url === 'string');
  if (linkAnnots.length === 0) return;

  for (const ann of linkAnnots) {
    // pdfjs annotation rect is [x1, y1, x2, y2] in PDF user-space units.
    // Y-axis: bottom-left origin. The line's y (from transform[5]) is the
    // baseline of the first item, so we test the centroid.
    const rect = ann.rect;
    if (!rect || rect.length < 4) continue;
    const cx = (rect[0] + rect[2]) / 2;
    const cy = (rect[1] + rect[3]) / 2;

    // Find the line whose items best overlap this centroid. Prefer overlap
    // by y-tolerance (baseline within 4pt) AND x-overlap (cx within any
    // item's horizontal span).
    let bestLine = null;
    let bestScore = -Infinity;
    for (const pl of pageLines) {
      const dy = Math.abs(pl.y - cy);
      if (dy > 6) continue;
      // Check any item straddles cx
      let overlaps = false;
      for (const it of pl.items) {
        const x1 = it.transform[4];
        const x2 = x1 + (it.width || 0);
        if (cx >= x1 - 2 && cx <= x2 + 2) { overlaps = true; break; }
      }
      const score = (overlaps ? 100 : 0) - dy;
      if (score > bestScore) { bestScore = score; bestLine = pl; }
    }
    if (!bestLine) continue;

    // Don't append if this URL is already present in the line text
    const url = ann.url.trim();
    if (bestLine.text.includes(url)) continue;
    bestLine.text = `${bestLine.text} (${url})`;
  }
}

async function parsePdfjs(buffer) {
  const pdfjs = await loadPdfjs();
  // pdfjs-dist v6 uses standard fonts bundled inside its package. In Node we
  // need to point verbosity down to keep the LLM logs clean.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    isEvalSupported: false, // hard belt-and-braces defense against font-embedded JS in the PDF
  }).promise;

  const pages = [];
  const lines = [];
  let lineNum = 0;

  for (let pageIdx = 1; pageIdx <= doc.numPages; pageIdx++) {
    const page = await doc.getPage(pageIdx);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const groups = groupItemsByLine(content.items);
    const pageLines = groups.map((g) => ({ y: g.y, items: g.items, text: joinLineItems(g.items) }));

    // Merge in link-annotation hrefs on the same line as the display text —
    // recovers LinkedIn/GitHub/project URLs that the text-content stream strips.
    let annotations;
    try { annotations = await page.getAnnotations(); } catch { annotations = []; }
    mergeAnnotationsIntoLines(pageLines, annotations);

    for (const pl of pageLines) {
      if (!pl.text) continue;
      lineNum++;
      lines.push({ n: lineNum, page: pageIdx, text: pl.text });
    }
    pages.push({ width: viewport.width, height: viewport.height, lines: pageLines });
  }

  const text = lines.map((l) => l.text).join('\n');
  const wordCount = (text.match(/\S+/g) || []).length;

  return {
    text,
    lines,
    meta: {
      pageCount: doc.numPages,
      wordCount,
      multiColumn: detectMultiColumn(pages),
    },
  };
}

async function parsePdfParse(buffer) {
  // pdf-parse: pure text, no positional info. Used only as a fallback when
  // pdfjs returns near-empty text (sometimes happens with old / non-standard
  // PDF producers where pdfjs' text-layer extraction misses runs).
  const pdfParse = require('pdf-parse');
  const res = await pdfParse(buffer);
  const raw = res.text || '';
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    lines.push({ n: lines.length + 1, page: null, text: t });
  }
  const wordCount = (raw.match(/\S+/g) || []).length;
  return {
    text: lines.map((l) => l.text).join('\n'),
    lines,
    meta: { pageCount: res.numpages || 1, wordCount, multiColumn: false },
  };
}

async function parseDocx(buffer) {
  const mammoth = require('mammoth');
  const res = await mammoth.extractRawText({ buffer });
  const raw = res.value || '';
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    lines.push({ n: lines.length + 1, page: null, text: t });
  }
  const wordCount = (raw.match(/\S+/g) || []).length;
  return {
    text: lines.map((l) => l.text).join('\n'),
    lines,
    meta: { pageCount: 1, wordCount, multiColumn: false },
  };
}

// Public. `buffer` is a Node Buffer (or Uint8Array). `filename` is optional
// and only used to pick DOCX vs PDF; the actual bytes are always trusted over
// the extension because a student can upload `resume.pdf` that's actually docx.
async function parse(buffer, { filename = '' } = {}) {
  const ext = path.extname(filename).toLowerCase();
  const isDocx = ext === '.docx' || ext === '.doc';

  if (isDocx) {
    try {
      const r = await parseDocx(buffer);
      if (r.meta.wordCount < MIN_WORDS) {
        return { ...r, meta: { ...r.meta, layer: 3, layerName: 'refuse', refuse: true, refuseReason: 'docx-too-thin' } };
      }
      return { ...r, meta: { ...r.meta, layer: 1, layerName: 'docx' } };
    } catch (e) {
      logger.warn({ err: e.message }, 'parse.docx failed');
      return { text: '', lines: [], meta: { layer: 3, layerName: 'refuse', wordCount: 0, pageCount: 0, multiColumn: false, refuse: true, refuseReason: 'docx-error' } };
    }
  }

  // PDF path
  let r1;
  try {
    r1 = await parsePdfjs(buffer);
  } catch (e) {
    logger.warn({ err: e.message }, 'parse.pdfjs failed');
    r1 = null;
  }
  if (r1 && r1.meta.wordCount >= MIN_WORDS) {
    return { ...r1, meta: { ...r1.meta, layer: 1, layerName: 'pdfjs' } };
  }

  // Fallback
  let r2;
  try {
    r2 = await parsePdfParse(buffer);
  } catch (e) {
    logger.warn({ err: e.message }, 'parse.pdf-parse failed');
    r2 = null;
  }
  if (r2 && r2.meta.wordCount >= MIN_WORDS) {
    return { ...r2, meta: { ...r2.meta, layer: 2, layerName: 'pdf-parse' } };
  }

  const wc = Math.max(r1?.meta.wordCount || 0, r2?.meta.wordCount || 0);
  return {
    text: '',
    lines: [],
    meta: {
      layer: 3,
      layerName: 'refuse',
      wordCount: wc,
      pageCount: r1?.meta.pageCount || r2?.meta.pageCount || 0,
      multiColumn: r1?.meta.multiColumn || false,
      refuse: true,
      refuseReason: wc === 0 ? 'no-text-extractable' : 'text-too-thin-probably-image-pdf',
    },
  };
}

module.exports = { parse, MIN_WORDS };
