// Twilio webhook signature validation.
// Twilio signs every webhook with X-Twilio-Signature using HMAC-SHA1 over the full URL + sorted form params.
// Reject anything that doesn't validate. Behind Railway/ngrok proxies we reconstruct the public URL.
const twilio = require('twilio');
const { config } = require('../config');

function validateTwilioRequest(req, res, next) {
  if (!config.TWILIO_AUTH_TOKEN) {
    if (config.NODE_ENV === 'production') {
      req.log.error('TWILIO_AUTH_TOKEN missing in production — rejecting');
      return res.status(503).send('twilio auth not configured');
    }
    req.log.warn('TWILIO_AUTH_TOKEN missing — skipping signature validation (dev only)');
    return next();
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) return res.status(403).send('missing signature');

  // Public URL behind a proxy: trust x-forwarded-proto/host (set app.set('trust proxy', 1) in server.js).
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.originalUrl}`;

  const valid = twilio.validateRequest(config.TWILIO_AUTH_TOKEN, signature, url, req.body || {});
  if (!valid) {
    req.log.warn({ url }, 'invalid twilio signature');
    return res.status(403).send('invalid signature');
  }
  next();
}

module.exports = { validateTwilioRequest };
