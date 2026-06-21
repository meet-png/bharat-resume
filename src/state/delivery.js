// Delivery pipeline. After rewrite produces resume_json_rewritten, this runs:
//   render HTML → PDF (Puppeteer) → watermark (raster pipeline, PRD §10) →
//   upload to Supabase Storage → return 60s signed URL.
// Saves the storage path + signed URL onto the session so the router can
// include <Media> in the Twilio TwiML reply.
const { renderHtml } = require('../resume/render');
const { htmlToPdf } = require('../resume/pdf');
const { watermarkPdf } = require('../resume/watermark');
const { uploadAndSign } = require('../store/storage');
const logger = require('../logger');

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
    const html = renderHtml(r);
    let pdf = await htmlToPdf(html);
    if (!opts.clean) {
      pdf = await watermarkPdf(pdf);
    }
    const objectPath = objectPathFor(phoneHash, opts);
    const signedUrl = await uploadAndSign(objectPath, pdf);

    session.pdf_storage_path = objectPath;
    session.pdf_signed_url = signedUrl;
    session.pdf_versions = (session.pdf_versions || []).concat([{ path: objectPath, clean: !!opts.clean, at: Date.now() }]);

    logger.info({
      phoneHash: String(phoneHash).slice(0, 12),
      ms: Date.now() - t0,
      path: objectPath,
      clean: !!opts.clean,
      bytes: pdf.length,
    }, 'pdf delivered');
    return { signedUrl, objectPath, bytes: pdf.length };
  } catch (e) {
    logger.error({ phoneHash: String(phoneHash).slice(0, 12), err: e.message, stack: e.stack }, 'deliverPdf failed');
    return null;
  }
}

module.exports = { deliverPdf, objectPathFor };
