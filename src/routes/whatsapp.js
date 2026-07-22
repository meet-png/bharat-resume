// Meta WhatsApp Cloud API webhook. See docs/META_MIGRATION_PLAN.md §3, §4.
//
// GET  — Meta's verification handshake. On webhook setup Meta sends a GET with
//        ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... ; we echo the
//        challenge back ONLY if the token matches META_VERIFY_TOKEN.
// POST — inbound message events. ASYNC, ack-first model (Meta is not synchronous
//        like Twilio's TwiML): verify HMAC-SHA256 signature → 200 OK immediately
//        → then dedupe, route through handle(), and push the reply via the
//        outbound provider. The state machine (handle) is provider-agnostic and
//        untouched.
const express = require('express');
const { config } = require('../config');
const { verifyMetaSignature } = require('../security/metaSignature');
const { hashPhone, shortHash } = require('../security/hash');
const { markMessageProcessed, getSession } = require('../store/redis');
const { sendWhatsApp } = require('../messaging');
const { downloadMedia } = require('../messaging/meta');
const { handle } = require('../state/router');
const { RATE_STATES, STATES } = require('../state/states');
const logger = require('../logger');

// Attachment types we accept in rate mode. Everything else is refused at the
// transport boundary — matches the mimes rate-mode's parser (pdfjs + mammoth)
// can handle.
const ACCEPTED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // legacy .doc — mammoth handles most
]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

// Does the session's current state accept a PDF/DOCX upload right now?
// True in RATE_AWAITING_PDF (the natural entry) OR when session has no mode
// yet AND is at AWAITING_MODE_SELECT (auto-switch on unprompted upload).
function stateAcceptsAttachment(session) {
  if (!session) return true; // brand-new phone — auto-treat as rate entry
  if (session.state === STATES.RATE_AWAITING_PDF) return true;
  if (session.state === STATES.AWAITING_MODE_SELECT) return true;
  return false;
}

const router = express.Router();

// GET verify-challenge. Meta calls this once when you save the callback URL.
// Tokens are trimmed before comparison: pasting a value into a hosting panel
// (Railway etc.) very often appends a stray space/newline, and "x" !== "x\n"
// would 403 a token that is otherwise correct.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] || '').trim();
  const challenge = req.query['hub.challenge'];
  const expected = String(config.META_VERIFY_TOKEN || '').trim();

  if (mode === 'subscribe' && token && expected && token === expected) {
    req.log.info('meta webhook verified');
    return res.status(200).send(challenge);
  }
  // Log lengths (never the secret values) so a stray-whitespace or unset-var
  // mismatch is diagnosable from the logs alone.
  req.log.warn(
    { mode, expectedSet: !!expected, expectedLen: expected.length, reqLen: token.length },
    'meta webhook verify failed',
  );
  return res.sendStatus(403);
});

// POST events. Raw body (for HMAC) → signature gate → ack 200 → async process.
router.post('/', express.raw({ type: '*/*' }), verifyMetaSignature, (req, res) => {
  // Ack FIRST. Meta retries on a slow/failed 200, so we never do work in the
  // response cycle. Dedupe (below) makes those retries harmless.
  res.sendStatus(200);

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''));
  } catch {
    req.log.warn('meta webhook: bad JSON');
    return;
  }

  for (const msg of extractMessages(payload)) {
    // Detached from the response — never throw back into Express.
    processInbound(msg).catch((e) => logger.error({ err: e.message }, 'meta inbound processing failed'));
  }
});

// Walk the Meta envelope to the message objects. Status callbacks (sent/
// delivered/read) arrive as `value.statuses` with no `messages` key — skipped.
function extractMessages(payload) {
  const out = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return out;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const m of value.messages || []) out.push(m);
    }
  }
  return out;
}

async function processInbound(msg) {
  // Idempotency first: mark BEFORE routing so a Meta retry can never double-
  // advance the state machine. Trade-off: if the send below fails, the student
  // re-sends rather than us risking a duplicate state transition — the safer
  // failure for a stateful conversation.
  const fresh = await markMessageProcessed(msg.id);
  if (!fresh) {
    logger.info({ id: msg.id }, 'duplicate meta message ignored');
    return;
  }

  const phoneFrom = msg.from; // wa_id — digits only, no '+'
  const phoneHash = hashPhone(phoneFrom);
  const body = (msg.type === 'text' && msg.text && msg.text.body) || '';
  logger.info({ from: shortHash(phoneHash), bodyLen: body.length, type: msg.type }, 'inbound whatsapp (meta)');

  // Non-text messages: two paths now.
  // (a) Rate mode expects PDF/DOCX uploads at RATE_AWAITING_PDF — accept and
  //     download from Meta CDN, hand off to the state machine as `attachment`.
  //     A brand-new phone auto-enters rate mode on unprompted upload.
  // (b) All other non-text messages (photos, voice, video, sticker, wrong
  //     format at wrong time) are refused at this transport boundary with a
  //     mode-aware nudge.
  let attachment = null;
  if (msg.type !== 'text') {
    const session = await getSession(phoneHash).catch(() => null);
    const inRateOrEntry = stateAcceptsAttachment(session);

    // Only documents (PDF / DOCX) are ever accepted. Photo/audio/video/sticker
    // never carry a legitimate rate-mode payload, so refuse those unconditionally.
    const doc = (msg.type === 'document') ? msg.document : null;
    const mime = doc && doc.mime_type;
    if (!doc || !ACCEPTED_MIMES.has(mime) || !inRateOrEntry) {
      logger.info({
        from: shortHash(phoneHash), type: msg.type, mime,
        state: session?.state, mode: session?.mode,
      }, 'attachment refused');
      const refuseText = (session && session.mode === 'build')
        ? 'Namaste 🙏 Build mode me file/photo nahi le sakta. Naya resume banane ke liye details type karo. Type "rate" if you want to switch to rate mode instead.'
        : (msg.type !== 'document')
        ? 'Rate mode me PDF ya Word (.docx) file chahiye — photo/audio/video kaam nahi karega.'
        : `File format supported nahi hai (${mime || 'unknown'}). PDF ya .docx bhejo.`;
      await sendWhatsApp({ to: phoneFrom, body: refuseText });
      return;
    }

    // Download the attachment. Failure at this stage is a Meta-CDN issue;
    // tell the student to try again rather than silently hanging.
    try {
      const dl = await downloadMedia(doc.id, { maxBytes: MAX_ATTACHMENT_BYTES });
      attachment = {
        buffer: dl.buffer,
        filename: doc.filename || 'resume.pdf',
        mimeType: dl.mimeType || mime,
        bytes: dl.fileSize,
      };
      logger.info({ from: shortHash(phoneHash), bytes: attachment.bytes, mime: attachment.mimeType }, 'attachment downloaded');
    } catch (e) {
      logger.error({ err: e.message, from: shortHash(phoneHash) }, 'attachment download failed');
      await sendWhatsApp({
        to: phoneFrom,
        body: '⛔ File download nahi ho paayi (Meta CDN issue). 30 seconds baad file dobara bhejo, ya "cancel" karo.',
      });
      return;
    }
  }

  let reply;
  try {
    reply = await handle({ phoneHash, body, phoneFrom, attachment });
  } catch (e) {
    logger.error({ err: e.message }, 'router handle failed');
    reply = 'Server pe kuch issue hai. 30s baad try kariye.';
  }

  let text, media;
  if (reply && typeof reply === 'object') {
    text = reply.text || '';
    media = reply.media || null;
  } else {
    text = String(reply || '');
    media = null;
  }
  if (!text && !media) return;

  await sendWhatsApp({ to: phoneFrom, body: text, mediaUrl: media });
}

module.exports = router;
