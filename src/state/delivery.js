// Delivery pipeline. After rewrite produces resume_json_rewritten, this runs:
//   render HTML → PDF (Puppeteer) → watermark (raster pipeline, PRD §10) →
//   upload to Supabase Storage → return 60s signed URL.
// Saves the storage path + signed URL onto the session so the router can
// include <Media> in the Twilio TwiML reply.
const { renderHtml } = require('../resume/render');
const { htmlToPdf } = require('../resume/pdf');
const { watermarkPdf } = require('../resume/watermark');
const { checkRenderedHtml } = require('../resume/sanity');
const { uploadAndSign } = require('../store/storage');
const { createLimiter } = require('../util/limit');
const { config } = require('../config');
const { PDFDocument } = require('pdf-lib');
const logger = require('../logger');

// Count pages in a PDF buffer. Used by the Path 2 measure-then-compress flow:
// after the first render, if the resume overflows to page 2 and the caller
// provided an onOverflow callback, we re-rewrite with oneP:true and re-render
// once. Zero cost when the resume already fits on one page (~85% of cases).
async function pdfPageCount(pdfBuffer) {
  try {
    const doc = await PDFDocument.load(pdfBuffer);
    return doc.getPageCount();
  } catch (e) {
    logger.warn({ err: e.message }, 'pdfPageCount failed — defaulting to 1');
    return 1;
  }
}

// Bound concurrent render+watermark pipelines per process — each holds a
// Chromium page and rasterizes A4 at 3x, so a burst of inbound messages must
// queue here rather than stampede memory. See src/util/limit.js + config.
const renderLimit = createLimiter(config.RENDER_CONCURRENCY);

function objectPathFor(phoneHash, opts = {}) {
  const sub = String(phoneHash || 'anon').slice(0, 12);
  const stamp = Date.now();
  const tag = opts.clean ? 'clean' : 'wm';
  return `${sub}/v${stamp}_${tag}.pdf`;
}

// Runs the full PDF pipeline. On any step failure logs and returns null so the
// upstream caller can still send a text-only preview (graceful degrade).
async function deliverPdf(session, phoneHash, opts = {}) {
  const t0 = Date.now();
  const r = session.resume_json_rewritten;
  if (!r) {
    logger.warn({ phoneHash: String(phoneHash).slice(0, 12) }, 'deliverPdf: no rewritten resume; skipping');
    return null;
  }

  try {
    // Gate the whole CPU/memory-heavy stretch (Chromium render → raster
    // watermark → upload) through the limiter so concurrent deliveries queue
    // instead of running all at once. Wait time, if any, is logged below.
    const queuedAt = Date.now();
    const { objectPath, signedUrl, pdfBytes } = await renderLimit(async () => {
      const waitedMs = Date.now() - queuedAt;
      if (waitedMs > 100) {
        logger.info({ waitedMs, ...renderLimit.stats() }, 'render slot acquired after queue wait');
      }
      const html = renderHtml(r);
      // Pre-delivery sanity (ATS checklist §6 2026-06-24): scan the rendered
      // HTML's text layer for raw HTML entities (&amp; / &lt; / &gt; / etc.)
      // and check that recognisable section headings are present. NEVER
      // ship a PDF that would render literal "&amp;" in its text — the
      // checklist explicitly calls this out as a blocking defect.
      const sanity = checkRenderedHtml(html);
      if (!sanity.ok) {
        logger.error({ phoneHash: String(phoneHash).slice(0, 12), violations: sanity.violations }, 'sanity check failed — refusing to ship PDF');
        throw new Error('sanity check failed: ' + sanity.violations.map((v) => v.kind).join(','));
      }
      if (sanity.warnings && sanity.warnings.length > 0) {
        logger.warn({ phoneHash: String(phoneHash).slice(0, 12), warnings: sanity.warnings }, 'sanity warnings (not blocking delivery)');
      }
      let pdf = await htmlToPdf(html);

      // Path 2 measure-then-compress (2026-07-16). If the caller provided an
      // onOverflow callback and the first-pass render produced >1 page,
      // request a compressed resume from the callback and re-render ONCE.
      // Zero overhead when the resume already fits (~85% of cases).
      if (opts.onOverflow) {
        const pages = await pdfPageCount(pdf);
        if (pages > 1) {
          logger.info({ phoneHash: String(phoneHash).slice(0, 12), initialPages: pages }, 'first render overflowed — invoking compression callback');
          const compressed = await opts.onOverflow(session.resume_json_rewritten);
          if (compressed) {
            session.resume_json_rewritten = compressed;
            const compressedHtml = renderHtml(compressed);
            const sanity2 = checkRenderedHtml(compressedHtml);
            if (sanity2.ok) {
              pdf = await htmlToPdf(compressedHtml);
              const pagesAfter = await pdfPageCount(pdf);
              logger.info({ phoneHash: String(phoneHash).slice(0, 12), pagesAfter }, 'compression pass rendered');
            } else {
              logger.warn({ phoneHash: String(phoneHash).slice(0, 12), violations: sanity2.violations }, 'compressed render failed sanity — falling back to first-pass');
            }
          } else {
            logger.warn({ phoneHash: String(phoneHash).slice(0, 12) }, 'onOverflow callback returned no compression — shipping original');
          }
        }
      }

      if (!opts.clean) {
        // Pass the recipient's WhatsApp phone (session.phone_from) so the
        // watermark bakes the last-5 digits into the grid for accountability.
        // Falls back to a generic "DO NOT SHARE" line if phone is missing.
        pdf = await watermarkPdf(pdf, { phone: session && session.phone_from });
      }
      const path = objectPathFor(phoneHash, opts);
      const url = await uploadAndSign(path, pdf);
      return { objectPath: path, signedUrl: url, pdfBytes: pdf.length };
    });

    session.pdf_storage_path = objectPath;
    session.pdf_signed_url = signedUrl;
    session.pdf_versions = (session.pdf_versions || []).concat([{ path: objectPath, clean: !!opts.clean, at: Date.now() }]);

    logger.info({
      phoneHash: String(phoneHash).slice(0, 12),
      ms: Date.now() - t0,
      path: objectPath,
      clean: !!opts.clean,
      bytes: pdfBytes,
    }, 'pdf delivered');
    return { signedUrl, objectPath, bytes: pdfBytes };
  } catch (e) {
    logger.error({ phoneHash: String(phoneHash).slice(0, 12), err: e.message, stack: e.stack }, 'deliverPdf failed');
    return null;
  }
}

module.exports = { deliverPdf, objectPathFor };
