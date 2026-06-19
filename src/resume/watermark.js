// Non-removable watermark pipeline. PRD §10.
// Approach: render PDF → rasterize each page at 300 DPI → composite diagonal
// "BHARAT RESUME" text via sharp → re-bundle with pdf-lib. Output is image-only PDF;
// ATS cannot parse, which is the conversion driver (PRD §10.2 last paragraph).
// TODO Day 4.

async function watermarkPdf(_pdfBuffer) {
  throw new Error('watermarkPdf not implemented (Day 4)');
}

module.exports = { watermarkPdf };
