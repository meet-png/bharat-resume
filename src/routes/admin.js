// Health + admin routes. PRD §14, §15.
const express = require('express');
const path = require('path');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

router.get('/payment-success', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'payment-success.html'));
});

// TODO Day 6: basic auth + metrics dashboard per PRD §15.
router.get('/admin/metrics', (_req, res) => {
  res.status(501).send('metrics dashboard not implemented (Day 6)');
});

module.exports = router;
