// Delivery pipeline. After rewrite produces resume_json_rewritten, this runs:
//   render HTML → PDF (Puppeteer) → watermark (raster pipeline, PRD §10) →
//   upload to Supabase Storage → return 60s signed URL.
// Saves the storage path + signed URL onto the session so the router can
// include <Media> in the Twilio TwiML reply.
const { renderHtml } = require('../resume/render');
const { htmlToPdf } = require('../resume/pdf');
const { watermarkPdf } = require('../resume/watermark');
const { uploadAndSign } = require('../store/storage');
const { createLimiter } = require('../util/limit');
const { config } = require('../config');
const logger = require('../logger');

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
      let pdf = await htmlToPdf(html);
      if (!opts.clean) {
        pdf = await watermarkPdf(pdf);
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
