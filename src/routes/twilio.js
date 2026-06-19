// Twilio Sandbox webhook. PRD §14, §18 Day 1 milestone.
// Day 1: echo back whatever the student sends.
// Day 2+: delegate to state machine in src/state/router.js.
const express = require('express');

const router = express.Router();

router.post('/', async (req, res) => {
  const body = (req.body && req.body.Body) || '';
  const from = (req.body && req.body.From) || 'unknown';
  req.log.info({ from, body }, 'inbound whatsapp');

  // TODO Day 2: route to state machine instead of echoing.
  // const reply = await require('../state/router').handle({ from, body });

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
