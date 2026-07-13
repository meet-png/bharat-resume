// Health + admin routes. PRD §14, §15.
const express = require('express');
const path = require('path');
const { basicAuth } = require('../security/basicAuth');
const { fetchMetrics } = require('../store/postgres');
const logger = require('../logger');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

router.get('/payment-success', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'payment-success.html'));
});

// Public legal pages required for Meta Business Verification and DPDP Act
// compliance. Kept as static HTML in /public — no templating, no analytics,
// no dependencies. Long-cache headers so Meta's crawlers don't re-hit them.
const PUBLIC_LEGAL_PAGES = [
  { route: '/privacy', file: 'privacy.html' },
  { route: '/terms', file: 'terms.html' },
  { route: '/data-deletion', file: 'data-deletion.html' },
];
for (const { route, file } of PUBLIC_LEGAL_PAGES) {
  router.get(route, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, '..', '..', 'public', file));
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMetrics(m) {
  const f = m.funnel;
  const t = m.today || {};
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const row = (label, n, base) =>
    `<tr><td>${esc(label)}</td><td class="num">${n}</td><td class="bar"><span style="width:${pct(n, base)}%"></span></td><td class="num pct">${pct(n, base)}%</td></tr>`;

  const recent = m.recent.map((r) =>
    `<tr><td>${esc(r.event_name)}</td><td>${esc(r.state || '')}</td><td class="ts">${esc(new Date(r.at).toLocaleString('en-IN'))}</td></tr>`
  ).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bharat Resume — metrics</title>
<style>
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e8eb}
  .wrap{max-width:820px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#8b929c;margin:0 0 24px;font-size:13px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:28px}
  .card{flex:1 1 120px;background:#1a1d24;border:1px solid #262b34;border-radius:10px;padding:14px}
  .card .k{color:#8b929c;font-size:12px} .card .v{font-size:26px;font-weight:600;margin-top:4px}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#8b929c;margin:24px 0 8px}
  table{width:100%;border-collapse:collapse;background:#1a1d24;border:1px solid #262b34;border-radius:10px;overflow:hidden}
  td,th{padding:9px 12px;border-bottom:1px solid #262b34;text-align:left;font-size:14px}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums;width:64px} .pct{color:#8b929c;width:52px}
  .bar{width:40%} .bar span{display:block;height:8px;background:#3b82f6;border-radius:4px;min-width:1px}
  .ts{color:#8b929c;font-size:12px;white-space:nowrap}
</style></head><body><div class="wrap">
<h1>Bharat Resume — launch metrics</h1>
<p class="sub">${m.eventTotal} events tracked · refreshed ${esc(new Date().toLocaleString('en-IN'))}</p>

<div class="cards">
  <div class="card"><div class="k">Students</div><div class="v">${m.users}</div></div>
  <div class="card"><div class="k">Paid</div><div class="v">${m.paidUsers}</div></div>
  <div class="card"><div class="k">Conversion</div><div class="v">${m.conversionPct}%</div></div>
  <div class="card"><div class="k">Revenue</div><div class="v">₹${m.revenueInr}</div></div>
  <div class="card"><div class="k">Avg ATS</div><div class="v">${m.ats.avg == null ? '—' : m.ats.avg}</div></div>
</div>

<h2>Funnel (% of sessions started)</h2>
<table>
  ${row('Sessions started', f.session_started, f.session_started)}
  ${row('Resumes delivered', f.resume_delivered, f.session_started)}
  ${row('Payment links created', f.payment_link_created, f.session_started)}
  ${row('Payments succeeded', f.payment_succeeded, f.session_started)}
  ${row('Clean PDFs delivered', f.clean_pdf_delivered, f.session_started)}
</table>

<h2>Edits · Today</h2>
<table>
  <tr><td>Free edits applied</td><td class="num">${m.edits.free}</td></tr>
  <tr><td>Paid edits applied</td><td class="num">${m.edits.paid}</td></tr>
  <tr><td>Sessions started today</td><td class="num">${t.session_started || 0}</td></tr>
  <tr><td>Resumes delivered today</td><td class="num">${t.resume_delivered || 0}</td></tr>
  <tr><td>Payments today</td><td class="num">${t.payment_succeeded || 0}</td></tr>
</table>

<h2>Recent events</h2>
<table><tr><th>Event</th><th>State</th><th class="ts">When</th></tr>${recent || '<tr><td colspan="3">No events yet.</td></tr>'}</table>
</div></body></html>`;
}

router.get('/admin/metrics', basicAuth, async (_req, res) => {
  try {
    const metrics = await fetchMetrics();
    res.type('html').send(renderMetrics(metrics));
  } catch (e) {
    logger.error({ err: e.message }, 'metrics dashboard failed');
    res.status(500).send('metrics unavailable — check server logs');
  }
});

module.exports = router;
