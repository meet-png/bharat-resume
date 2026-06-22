// Meta webhook signature verification. Meta signs every webhook POST with
// X-Hub-Signature-256 = 'sha256=' + HMAC_SHA256(rawBody, APP_SECRET). We must
// hash the EXACT raw bytes Meta sent, so the route mounts express.raw before
// this runs and we verify req.body (a Buffer). Timing-safe compare.
const crypto = require('crypto');
const { config } = require('../config');

function verifyMetaSignature(req, res, next) {
  if (!config.META_APP_SECRET) {
    if (config.NODE_ENV === 'production') {
      req.log.error('META_APP_SECRET missing in production — rejecting');
      return res.status(503).send('meta auth not configured');
    }
    req.log.warn('META_APP_SECRET missing — skipping signature validation (dev only)');
    return next();
  }

  const header = req.headers['x-hub-signature-256'];
  if (!header || !header.startsWith('sha256=')) {
    req.log.warn('meta webhook: missing/invalid signature header');
    return res.status(403).send('missing signature');
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
  const expected = 'sha256=' + crypto.createHmac('sha256', config.META_APP_SECRET).update(raw).digest('hex');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    req.log.warn('meta webhook: signature mismatch');
    return res.status(403).send('invalid signature');
  }
  next();
}

module.exports = { verifyMetaSignature };
