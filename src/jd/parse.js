// URL detection + paste fallback. PRD §8.2, §8.3.
const NAUKRI_RE = /^https?:\/\/(www\.)?naukri\.com\/job-listings/i;

function isNaukriUrl(text) {
  return NAUKRI_RE.test(String(text || '').trim());
}

function isUrl(text) {
  try {
    new URL(String(text || '').trim());
    return true;
  } catch {
    return false;
  }
}

module.exports = { isNaukriUrl, isUrl };
