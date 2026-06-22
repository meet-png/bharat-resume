// Supabase Storage upload + signed URL. PRD §3, §5 Phase 3 step 5.
// Signed URLs use a 300s TTL — Meta's Cloud API fetches the document link
// server-side AFTER we ack the webhook (async send), so the URL must outlive
// that round-trip; Twilio fetched synchronously and was fine on 60s. 5 min is
// still short enough to make scraping the bucket pointless. See
// docs/META_MIGRATION_PLAN.md §4 (media TTL).
const { getClient } = require('./postgres');
const { config } = require('../config');
const logger = require('../logger');

const BUCKET = config.SUPABASE_STORAGE_BUCKET || 'resumes';
const SIGNED_URL_TTL_SEC = 300;

// Upload a PDF buffer to Supabase Storage at the given object path.
// Returns the upload result (or throws).
async function uploadPdf(objectPath, buffer, opts = {}) {
  if (!buffer || buffer.length === 0) throw new Error('uploadPdf: empty buffer');
  const client = getClient();
  // ArrayBuffer was the most reliable shape for supabase-js v2 + Node 18+
  // native fetch in our testing. Blob worked sometimes; Buffer flaked frequently.
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const { data, error } = await client.storage.from(BUCKET).upload(objectPath, ab, {
        contentType: 'application/pdf',
        upsert: opts.upsert !== false,
        cacheControl: '60',
        duplex: 'half',
      });
      if (error) { lastErr = error; throw error; }
      logger.info({ ms: Date.now() - t0, objectPath, bytes: buffer.length, attempt }, 'pdf uploaded');
      return data;
    } catch (e) {
      lastErr = e;
      logger.warn({ err: e.message, attempt, msSoFar: Date.now() - t0 }, `storage upload attempt ${attempt} failed`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  logger.error({ err: lastErr?.message, objectPath, bytes: buffer.length }, 'storage upload failed (all retries)');
  throw lastErr;
}

// Create a short-lived signed URL Twilio can fetch.
async function createSignedUrl(objectPath, ttlSec = SIGNED_URL_TTL_SEC) {
  const client = getClient();
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(objectPath, ttlSec);
  if (error) {
    logger.error({ err: error.message, objectPath }, 'signed URL failed');
    throw error;
  }
  return data.signedUrl;
}

// Convenience: upload + sign in one call.
async function uploadAndSign(objectPath, buffer, ttlSec = SIGNED_URL_TTL_SEC) {
  await uploadPdf(objectPath, buffer);
  return createSignedUrl(objectPath, ttlSec);
}

module.exports = { uploadPdf, createSignedUrl, uploadAndSign, BUCKET, SIGNED_URL_TTL_SEC };
