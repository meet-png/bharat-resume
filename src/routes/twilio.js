// Twilio Sandbox webhook. PRD §14.
// Signature-validated, hashes phone before logging, routes to state machine.
// Reply may be a plain string or { text, media } object for messages with PDF attachment.
const express = require('express');
const { validateTwilioRequest } = require('../security/twilioSignature');
const { hashPhone, shortHash } = require('../security/hash');
const { handle } = require('../state/router');

const router = express.Router();

router.post('/', validateTwilioRequest, async (req, res) => {
  const body = (req.body && req.body.Body) || '';
  const phoneFrom = (req.body && req.body.From) || '';
  const phoneHash = hashPhone(phoneFrom);
  req.log.info({ from: shortHash(phoneHash), bodyLen: body.length }, 'inbound whatsapp');

  let reply;
  try {
    reply = await handle({ phoneHash, body, phoneFrom });
  } catch (e) {
    req.log.error({ err: e.message }, 'router handle failed');
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

  const mediaTag = media ? `<Media>${escapeXml(media)}</Media>` : '';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${mediaTag}${escapeXml(text)}</Message></Response>`;
  res.type('text/xml').send(twiml);
});

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = router;
