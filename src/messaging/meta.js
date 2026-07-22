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

// Download an inbound media attachment (document / image / etc.) from Meta.
// Meta's media pipeline is 2-step:
//   1. GET /{media-id} → returns a JSON { url, mime_type, sha256, file_size, id }
//   2. GET that url (with Authorization header) → returns raw bytes
// Both steps require the same bearer token as sendWhatsApp. Returns a Node
// Buffer + the mime_type / file size / sha256 so the caller can decide
// what to do with it. Throws on failure.
//
// Cap the download size defensively (default 10MB — WhatsApp allows up to
// 100MB but rate mode has no legit reason for that). Preventing an OOM on
// a hostile PDF is a security concern, not just a UX one.
const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;

async function downloadMedia(mediaId, { maxBytes = DEFAULT_MAX_MEDIA_BYTES } = {}) {
  if (!mediaId) throw new Error('downloadMedia: mediaId required');
  if (!config.META_WHATSAPP_TOKEN) throw new Error('META_WHATSAPP_TOKEN not set');

  const metaUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${String(config.META_WHATSAPP_TOKEN).trim()}` },
  });
  if (!metaRes.ok) {
    const detail = await metaRes.text().catch(() => '');
    logger.error({ status: metaRes.status, detail: detail.slice(0, 200) }, 'meta media lookup failed');
    throw new Error(`meta media lookup failed: ${metaRes.status}`);
  }
  const meta = await metaRes.json();
  const url = meta && meta.url;
  const mimeType = meta && meta.mime_type;
  const fileSize = meta && Number(meta.file_size);
  if (!url) throw new Error('meta media lookup: no url in response');
  if (fileSize && fileSize > maxBytes) {
    throw new Error(`media too large: ${fileSize} > ${maxBytes} bytes`);
  }

  const binRes = await fetch(url, {
    headers: { Authorization: `Bearer ${String(config.META_WHATSAPP_TOKEN).trim()}` },
  });
  if (!binRes.ok) {
    logger.error({ status: binRes.status }, 'meta media download failed');
    throw new Error(`meta media download failed: ${binRes.status}`);
  }
  const ab = await binRes.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    throw new Error(`media exceeds cap after download: ${ab.byteLength} > ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(ab);
  logger.info({ mediaId: String(mediaId).slice(0, 8), bytes: buffer.length, mimeType }, 'meta media downloaded');
  return { buffer, mimeType, fileSize: buffer.length, sha256: meta.sha256 || null };
}

module.exports = { sendWhatsApp, toWaId, downloadMedia };
