// PII hashing. PRD §13.1 — never store raw phone numbers; use sha256 hash as the key.
const crypto = require('crypto');

function hashPhone(phone) {
  if (!phone) return null;
  // Normalise to digits only before hashing. Twilio gives `whatsapp:+919999...`
  // while Meta's wa_id is `919999...` (no `+`); stripping ALL non-digits makes
  // the same student hash identically across both providers. See
  // docs/META_MIGRATION_PLAN.md §4 (phone format).
  const normalised = String(phone).replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

function shortHash(hash) {
  // First 12 hex chars — enough for log correlation, not enough to enable lookup.
  return hash ? String(hash).slice(0, 12) : null;
}

module.exports = { hashPhone, shortHash };
