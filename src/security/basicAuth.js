// HTTP Basic Auth for the admin dashboard. PRD §14, §15.
// Constant-time compare; reject early in production if no password configured.
const crypto = require('crypto');
const { config } = require('../config');

function basicAuth(req, res, next) {
  if (!config.ADMIN_PASSWORD) {
    if (config.NODE_ENV === 'production') {
      return res.status(503).send('admin auth not configured');
    }
    req.log.warn('ADMIN_PASSWORD missing — skipping basic auth (dev only)');
    return next();
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="bharat-resume admin"');
    return res.status(401).send('auth required');
  }

  let user = '';
  let pass = '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) throw new Error('malformed');
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch {
    return res.status(400).send('malformed auth header');
  }

  const userOk = safeEqual(user, config.ADMIN_USERNAME);
  const passOk = safeEqual(pass, config.ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    res.set('WWW-Authenticate', 'Basic realm="bharat-resume admin"');
    return res.status(401).send('invalid credentials');
  }
  next();
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { basicAuth };
