// Outbound WhatsApp via Meta Cloud API (Graph API). See docs/META_MIGRATION_PLAN.md.
// Mirrors the twilio.js sendWhatsApp({ to, body, mediaUrl }) contract so the
// messaging router can swap providers transparently.
const { config } = require('../config');
const logger = require('../logger');

const GRAPH_VERSION = 'v21.0';

// Meta wants the recipient as a bare digits-only MSISDN (country code + number,
// no `+`, no `whatsapp:` prefix). Twilio-style addresses are normalised here so
// callers can pass whatever the session stored.
function toWaId(to) {
  return String(to || '').replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
}

// Sends a WhatsApp message (optionally with one PDF document attachment) to `to`.
// When mediaUrl is present we send a `document` message (Meta fetches the link
// server-side, so the signed URL must outlive the fetch — see media TTL bump).
// `body` rides as the document caption. Throws on failure — callers decide how
// to degrade (matches twilio.js).
async function sendWhatsApp({ to, body, mediaUrl }) {
  const waId = toWaId(to);
  if (!waId) throw new Error('sendWhatsApp(meta): `to` required');
  if (!config.META_PHONE_NUMBER_ID || !config.META_WHATSAPP_TOKEN) {
    throw new Error('META_PHONE_NUMBER_ID / META_WHATSAPP_TOKEN not set');
  }

  let payload;
  if (mediaUrl) {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'document',
      document: { link: mediaUrl, filename: 'resume.pdf', caption: body || '' },
    };
  } else {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'text',
      text: { body: body || '', preview_url: false },
    };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${config.META_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.META_WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // Read the error body for diagnostics but never log the token or raw number.
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    logger.error({ status: res.status, detail }, 'meta outbound failed');
    throw new Error(`meta send failed: ${res.status}`);
  }

  const data = await res.json().catch(() => ({}));
  const id = data && data.messages && data.messages[0] && data.messages[0].id;
  logger.info({ id, hasMedia: !!mediaUrl }, 'whatsapp outbound sent (meta)');
  return data;
}

module.exports = { sendWhatsApp, toWaId };
