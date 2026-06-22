// PII hashing. PRD §13.1 — never store raw phone numbers; use a keyed hash as
// the key. A phone number is low-entropy (~10 digits), so a *bare* sha256 is
// GPU-reversible: anyone who leaks a hash (DB, Razorpay notes) can brute-force
// the real number in seconds. We therefore HMAC with a server-side secret
// (PHONE_HASH_SECRET) so a hash leak alone never yields the number. If the
// secret is unset we fall back to plain sha256 and warn — acceptable only in
// dev; production MUST set it (config logs a loud warning otherwise).
const crypto = require('crypto');
const { config } = require('../config');

function hashPhone(phone) {
  if (!phone) return null;
  // Normalise to digits only before hashing. Twilio gives `whatsapp:+919999...`
  // while Meta's wa_id is `919999...` (no `+`); stripping ALL non-digits makes
  // the same student hash identically across both providers. See
  // docs/META_MIGRATION_PLAN.md §4 (phone format).
  const normalised = String(phone).replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
  if (config.PHONE_HASH_SECRET) {
    return crypto.createHmac('sha256', config.PHONE_HASH_SECRET).update(normalised).digest('hex');
  }
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

function shortHash(hash) {
  // First 12 hex chars — enough for log correlation, not enough to enable lookup.
  return hash ? String(hash).slice(0, 12) : null;
}

module.exports = { hashPhone, shortHash };
