// Non-removable watermark. PRD §10.
// Pipeline: render PDF → rasterize each page at 300 DPI → composite diagonal
// "BHARAT RESUME" text grid via sharp → re-bundle as image-only PDF using
// pdf-lib. The result has no selectable text and the watermark is baked into
// pixels, so it can't be removed by extracting and re-rendering text.
//
// This is the FREE-TIER pipeline. The PAID-TIER skips this and ships the
// text-parseable original PDF (so ATS can read it) — that's the ₹49 unlock
// driver (PRD §10.3).
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { pdfToPng } = require('pdf-to-png-converter');
const logger = require('../logger');

// PRD §10.1: BHARAT RESUME, caps, diagonal grid, angle -30°, opacity 0.12,
// color #888888, ~200px spacing.
function buildWatermarkSvg(width, height) {
  // 300 DPI A4 ≈ 2480 × 3508 px. Scale font size + spacing to page dimensions.
  const fontPx = Math.round(width * 0.030);      // ~75 px on 2480-wide page
  const stepX  = Math.round(width * 0.45);       // ~3 columns of diagonal text
  const stepY  = Math.round(height * 0.13);      // ~7-8 rows
  const texts = [];
  for (let y = -stepY; y < height + stepY; y += stepY) {
    for (let x = -stepX; x < width + stepX; x += stepX) {
      const cx = x;
      const cy = y;
      texts.push(
        `<text x="${cx}" y="${cy}" transform="rotate(-30 ${cx} ${cy})" ` +
        `font-size="${fontPx}" fill="#888888" fill-opacity="0.12" ` +
        `font-family="Arial, sans-serif" font-weight="bold" ` +
        `letter-spacing="4">BHARAT RESUME</text>`
      );
    }
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${texts.join('')}</svg>`
  );
}

async function watermarkPdf(pdfBuffer) {
  if (!pdfBuffer || pdfBuffer.length === 0) throw new Error('watermarkPdf: empty buffer');
  const t0 = Date.now();

  const pages = await pdfToPng(pdfBuffer, { viewportScale: 3.0 }); // ~3x = ~216 DPI for A4
  if (!pages || pages.length === 0) throw new Error('watermarkPdf: pdfToPng returned no pages');

  const newPdf = await PDFDocument.create();

  for (const page of pages) {
    const pageBuf = page.content;
    const meta = await sharp(pageBuf).metadata();
    const svg = buildWatermarkSvg(meta.width, meta.height);

    const composited = await sharp(pageBuf)
      .composite([{ input: svg, top: 0, left: 0 }])
      .png()
      .toBuffer();

    const img = await newPdf.embedPng(composited);
    // pdf-lib uses pt (1pt = 1/72 inch). A4 = 595.28 × 841.89 pt.
    // Embed image at A4 page size regardless of rasterized pixel dims.
    const pdfPage = newPdf.addPage([595.28, 841.89]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }

  const out = Buffer.from(await newPdf.save());
  logger.info({ ms: Date.now() - t0, pages: pages.length, bytes: out.length }, 'watermark applied');
  return out;
}

module.exports = { watermarkPdf, buildWatermarkSvg };
