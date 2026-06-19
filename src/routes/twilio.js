// Twilio Sandbox webhook. PRD §14, §18 Day 1 milestone.
// Day 1: echo back inbound Body. Day 2+: delegate to state machine.
// Signature validation runs first — any unsigned/invalid request gets 403.
const express = require('express');
const { validateTwilioRequest } = require('../security/twilioSignature');
const { hashPhone, shortHash } = require('../security/hash');

const router = express.Router();

router.post('/', validateTwilioRequest, async (req, res) => {
  const body = (req.body && req.body.Body) || '';
  const phoneHash = hashPhone(req.body && req.body.From);
  req.log.info({ from: shortHash(phoneHash), bodyLen: body.length }, 'inbound whatsapp');

  // TODO Day 2: route to state machine.
  // const reply = await require('../state/router').handle({ phoneHash, body });

  const reply = body || '(empty message)';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`;
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
