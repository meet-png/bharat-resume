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
const { markMessageProcessed } = require('../store/redis');
const { sendWhatsApp } = require('../messaging');
const { handle } = require('../state/router');
const logger = require('../logger');

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

  // Non-text messages (document / image / audio / video / sticker / etc.):
  // students frequently send their existing resume PDF/DOCX/photo hoping we'll
  // rate or modify it. We don't do that — only NEW resume generation. Refuse
  // formally and point them at the chat flow. Do NOT run the state machine
  // for these; an empty text body would either short-circuit or produce a
  // confusing generic response. Handle here at the transport boundary.
  if (msg.type !== 'text') {
    logger.info({ from: shortHash(phoneHash), type: msg.type }, 'non-text message refused (attachment)');
    await sendWhatsApp({
      to: phoneFrom,
      body:
        'Namaste 🙏 File / photo / voice note nahi le sakta abhi.\n\n' +
        'Ye bot sirf *naya resume BANATA* hai — existing resume ko rate, score, ya modify karne ka option nahi hai.\n\n' +
        'Naya banane ke liye, chat me apne details type kariye. Type "reset" if you want to start fresh.',
    });
    return;
  }

  let reply;
  try {
    reply = await handle({ phoneHash, body, phoneFrom });
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
