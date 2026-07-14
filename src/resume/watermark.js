// Non-removable, anti-copy, anti-screenshot watermark. PRD §10 + design 2026-07-15.
// Pipeline: render PDF → rasterize each page at ~216 DPI → composite a THREE-LAYER
// watermark via sharp → re-bundle as image-only PDF using pdf-lib. Result has NO
// selectable text layer (no /Font, no Tj operators for content). Whatever a
// student sees is baked into pixels — copy-paste from any viewer produces nothing.
//
// Why three layers (2026-07-15 upgrade from a single subtle grid):
//   1. Central diagonal bands ("SAMPLE — PAY ₹49 TO UNLOCK") — dominant enough
//      that a screenshot is visibly a demo and unusable in any recruiter context.
//   2. Dense repeating grid alternating "SAMPLE" and the student's identifiable
//      phone tail ("PREVIEW FOR …NNNNN") — dense enough that watermark strokes
//      overlap actual text characters, which defeats modern PDF-viewer OCR
//      (iOS Live Text / Android Copy Text / Adobe OCR) by mixing the watermark
//      into any OCR output as noise.
//   3. The phone-tail line makes screenshots socially awkward to share — the
//      recipient sees a specific number tagged onto every page, so leaking a
//      watermarked preview identifies the leaker. Accountability substitute for
//      the FLAG_SECURE screenshot-block that banking apps use but that WhatsApp
//      does not expose to third-party message senders.
//
// The PAID-TIER pipeline skips watermarkPdf entirely and ships the clean,
// text-parseable PDF (so ATS can read it) — that's the ₹49 unlock driver.
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { pdfToPng } = require('pdf-to-png-converter');
const logger = require('../logger');

// Extract the last-5 digits of a phone identifier for the personally-identifiable
// stamp. Accepts any WhatsApp-shaped input ("whatsapp:+919876543210",
// "+919876543210", "919876543210"). Returns null if fewer than 5 digits available
// (e.g. no phone_from on the session) — watermark falls back to a generic
// "DO NOT SHARE" line so accountability is soft-degraded rather than crashing.
function last5DigitsOf(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 5) return null;
  return digits.slice(-5);
}

// XML-escape any text we splat into an SVG <text> node. Phone digits are safe,
// but the constant strings contain "—" and "₹"; the fixed strings are ASCII-safe
// at the entity level (nothing to escape). This helper exists so any future
// dynamic string in the watermark can't inject SVG markup.
function xmlSafe(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build the three-layer SVG overlay. Sized to the rasterized page dimensions
// (pixels), so the returned SVG composites 1:1 with the page PNG.
function buildWatermarkSvg(width, height, opts = {}) {
  const phoneTail = opts.phoneLast5;
  const parts = [];

  // ---------- Layer 1: two central diagonal bands (dominant) ----------
  // Bands span the middle third of the page. They're the "screenshot is
  // obviously fake" defense — visible from 10 ft away, obviously not a real
  // resume anyone could send to a recruiter.
  const bandFont = Math.round(width * 0.055);     // ~136px on a 2480-wide A4 raster
  const bandOpacity = 0.32;
  const bandColor = '#B03030';                    // dark red (industry-standard "DRAFT" stamp color)
  const bandYs = [Math.round(height * 0.35), Math.round(height * 0.72)];
  const bandCX = Math.round(width / 2);
  for (const cy of bandYs) {
    parts.push(
      `<text x="${bandCX}" y="${cy}" text-anchor="middle" ` +
        `transform="rotate(-30 ${bandCX} ${cy})" ` +
        `font-size="${bandFont}" fill="${bandColor}" fill-opacity="${bandOpacity}" ` +
        `font-family="Arial, sans-serif" font-weight="bold" letter-spacing="6">` +
        `SAMPLE — PAY ₹49 TO UNLOCK` +
      `</text>`
    );
  }

  // ---------- Layer 2: dense repeating grid, alternating SAMPLE and PHONE ----------
  // Denser than the pre-2026-07-15 grid (18% × 7% spacing vs old 45% × 13%).
  // Density is the OCR-defeat mechanism: watermark strokes cross most actual
  // text characters, so any viewer OCR that tries to extract content ends up
  // with SAMPLE / phone text interleaved into whatever it OCR'd — unusable.
  const gridFont = Math.round(width * 0.024);     // ~60px
  const gridOpacity = 0.22;
  const sampleColor = '#B03030';                  // matches band; consistent brand of warning
  const phoneColor = '#404040';                   // dark gray — reads as data, not warning
  const stepX = Math.round(width * 0.32);         // ~3 tiles per row on A4
  const stepY = Math.round(height * 0.075);       // ~13 rows down the page
  const phoneLine = phoneTail
    ? xmlSafe(`PREVIEW FOR …${phoneTail}`)
    : xmlSafe('PREVIEW COPY — DO NOT SHARE');
  const sampleLine = xmlSafe('SAMPLE — PAY ₹49');
  let rowIdx = 0;
  for (let y = -stepY; y < height + stepY; y += stepY) {
    const isPhoneRow = rowIdx % 2 === 1;
    const rowText = isPhoneRow ? phoneLine : sampleLine;
    const color = isPhoneRow ? phoneColor : sampleColor;
    for (let x = -stepX; x < width + stepX; x += stepX) {
      parts.push(
        `<text x="${x}" y="${y}" transform="rotate(-30 ${x} ${y})" ` +
          `font-size="${gridFont}" fill="${color}" fill-opacity="${gridOpacity}" ` +
          `font-family="Arial, sans-serif" font-weight="bold" letter-spacing="4">` +
          `${rowText}` +
        `</text>`
      );
    }
    rowIdx++;
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`
  );
}

// opts.phone: raw WhatsApp identifier of the RECIPIENT (session.phone_from), used
// to bake the last-5 digits into the watermark for accountability. Optional —
// missing phone degrades to a generic "DO NOT SHARE" line.
async function watermarkPdf(pdfBuffer, opts = {}) {
  if (!pdfBuffer || pdfBuffer.length === 0) throw new Error('watermarkPdf: empty buffer');
  const t0 = Date.now();

  const phoneLast5 = last5DigitsOf(opts.phone);
  const pages = await pdfToPng(pdfBuffer, { viewportScale: 3.0 }); // ~3x = ~216 DPI for A4
  if (!pages || pages.length === 0) throw new Error('watermarkPdf: pdfToPng returned no pages');

  const newPdf = await PDFDocument.create();

  for (const page of pages) {
    const pageBuf = page.content;
    const meta = await sharp(pageBuf).metadata();
    const svg = buildWatermarkSvg(meta.width, meta.height, { phoneLast5 });

    const composited = await sharp(pageBuf)
      .composite([{ input: svg, top: 0, left: 0 }])
      .png()
      .toBuffer();

    const img = await newPdf.embedPng(composited);
    // pdf-lib uses pt (1pt = 1/72 inch). A4 = 595.28 × 841.89 pt.
    // Embed image at A4 page size regardless of rasterized pixel dims so the
    // recipient's viewer renders exact A4 output.
    const pdfPage = newPdf.addPage([595.28, 841.89]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }

  const out = Buffer.from(await newPdf.save());
  logger.info({
    ms: Date.now() - t0,
    pages: pages.length,
    bytes: out.length,
    phoneTagged: !!phoneLast5,
  }, 'watermark applied');
  return out;
}

module.exports = { watermarkPdf, buildWatermarkSvg, last5DigitsOf };
