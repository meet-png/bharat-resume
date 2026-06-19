// PII hashing. PRD §13.1 — never store raw phone numbers; use sha256 hash as the key.
const crypto = require('crypto');

function hashPhone(phone) {
  if (!phone) return null;
  // Normalise: strip 'whatsapp:' prefix and any non-digits before hashing,
  // so the same student always produces the same hash regardless of channel quirks.
  const normalised = String(phone).replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

function shortHash(hash) {
  // First 12 hex chars — enough for log correlation, not enough to enable lookup.
  return hash ? String(hash).slice(0, 12) : null;
}

module.exports = { hashPhone, shortHash };
