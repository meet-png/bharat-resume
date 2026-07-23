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

// Public root landing page (added 2026-07-14). Renders the business's
// front door so payment-gateway reviewers, Meta reviewers, and curious
// students who type the URL see a real, branded page instead of a 404.
// Long cache — static file, changes rarely.
router.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
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

  // Force IST for every timestamp on this page. Railway runs UTC by default,
  // so `toLocaleString('en-IN')` alone gets the en-IN format (dd/mm/yyyy) but
  // keeps the server's UTC clock — off by 5h30m for anyone watching from India.
  const IST = { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium' };
  const fmtIst = (d) => new Date(d).toLocaleString('en-IN', IST);

  const recent = m.recent.map((r) =>
    `<tr><td>${esc(r.event_name)}</td><td>${esc(r.state || '')}</td><td class="ts">${esc(fmtIst(r.at))}</td></tr>`
  ).join('');

  // "LIVE NOW" card: bright accent + pulse when someone is actively chatting.
  // Auto-refreshes the whole page every 30s via <meta http-equiv="refresh"> so
  // the dashboard reflects reality without needing an F5 during broadcast.
  const liveN = m.activeNow || 0;
  const recentN = m.recentlyActive || 0;
  const liveCls = liveN > 0 ? 'card live pulse' : 'card live';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bharat Resume — metrics</title>
<style>
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e8eb}
  .wrap{max-width:820px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#8b929c;margin:0 0 24px;font-size:13px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:28px}
  .card{flex:1 1 120px;background:#1a1d24;border:1px solid #262b34;border-radius:10px;padding:14px}
  .card .k{color:#8b929c;font-size:12px} .card .v{font-size:26px;font-weight:600;margin-top:4px}
  .card.live{flex:1 1 100%;background:linear-gradient(135deg,#16281a 0%,#1a2d1e 100%);border-color:#2f6f3a}
  .card.live .k{color:#8fd39a;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
  .card.live .v{font-size:38px;color:#c1f0cc}
  .card.live .sub2{color:#8fd39a;font-size:12px;margin-top:2px}
  .card.live.pulse .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#4ade80;margin-right:8px;vertical-align:middle;animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(74,222,128,.7)}50%{opacity:.6;box-shadow:0 0 0 8px rgba(74,222,128,0)}}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#8b929c;margin:24px 0 8px}
  table{width:100%;border-collapse:collapse;background:#1a1d24;border:1px solid #262b34;border-radius:10px;overflow:hidden}
  td,th{padding:9px 12px;border-bottom:1px solid #262b34;text-align:left;font-size:14px}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums;width:64px} .pct{color:#8b929c;width:52px}
  .bar{width:40%} .bar span{display:block;height:8px;background:#3b82f6;border-radius:4px;min-width:1px}
  .ts{color:#8b929c;font-size:12px;white-space:nowrap}
</style></head><body><div class="wrap">
<h1>Bharat Resume — launch metrics</h1>
<p class="sub">${m.eventTotal} events tracked · refreshed ${esc(fmtIst(new Date()))} IST · auto-refresh 30s</p>

<div class="cards">
  <div class="${liveCls}">
    <div class="k">${liveN > 0 ? '<span class="dot"></span>' : ''}Live people using right now</div>
    <div class="v">${liveN}</div>
    <div class="sub2">Actively chatting · last ${m.liveWindowMinutes || 3} min · in-conversation total: ${recentN} (last ${m.recentWindowMinutes || 15} min)</div>
  </div>
</div>

<div class="cards">
  <div class="card"><div class="k">Students</div><div class="v">${m.users}</div></div>
  <div class="card"><div class="k">Paid</div><div class="v">${m.paidUsers}</div></div>
  <div class="card"><div class="k">Build conv.</div><div class="v">${m.conversionPct}%</div></div>
  <div class="card"><div class="k">Revenue</div><div class="v">₹${m.revenueInr}</div><div class="k" style="font-size:11px;margin-top:2px">build ₹${m.revenueBreakdown.build} · rate ₹${m.revenueBreakdown.rate}</div></div>
  <div class="card"><div class="k">Avg ATS</div><div class="v">${m.ats.avg == null ? '—' : m.ats.avg}</div></div>
</div>

<h2>Mode split</h2>
<table>
  ${row('Build mode picked', m.modeSplit.build, Math.max(1, m.modeSplit.total))}
  ${row('Rate mode picked', m.modeSplit.rate, Math.max(1, m.modeSplit.total))}
</table>

<h2>Build funnel (% of sessions started)</h2>
<table>
  ${row('Sessions started', f.session_started, f.session_started)}
  ${row('Resumes delivered', f.resume_delivered, f.session_started)}
  ${row('Payment links created', f.payment_link_created, f.session_started)}
  ${row('Payments succeeded', f.payment_succeeded, f.session_started)}
  ${row('Clean PDFs delivered', f.clean_pdf_delivered, f.session_started)}
</table>

<h2>Rate funnel (% of rate-mode entrants)</h2>
<table>
  ${row('Rate mode entered', m.rateFunnel.entered, Math.max(1, m.rateFunnel.entered))}
  ${row('PDF ingested', m.rateFunnel.pdf_ingested, Math.max(1, m.rateFunnel.entered))}
  ${row('Scored (glimpse shown)', m.rateFunnel.scored, Math.max(1, m.rateFunnel.entered))}
  ${row('Payment link created', m.rateFunnel.payment_link_created, Math.max(1, m.rateFunnel.entered))}
  ${row('Paid', m.rateFunnel.payment_succeeded, Math.max(1, m.rateFunnel.entered))}
  ${row('Improved PDF delivered', m.rateFunnel.delivered, Math.max(1, m.rateFunnel.entered))}
  <tr><td>Refused (bad PDF / parse fail)</td><td class="num">${m.rateFunnel.refused}</td><td></td><td class="num pct">—</td></tr>
  <tr><td>Cancelled mid-flow</td><td class="num">${m.rateFunnel.cancelled}</td><td></td><td class="num pct">—</td></tr>
  <tr><td>Rate conversion (scored → paid)</td><td class="num">${m.rateFunnel.conversion_pct}%</td><td></td><td></td></tr>
  <tr><td>Avg rate score</td><td class="num">${m.rateFunnel.avg_score == null ? '—' : m.rateFunnel.avg_score}</td><td></td><td class="num pct">${m.rateFunnel.score_samples} samples</td></tr>
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

// TEMPORARY (Meet 2026-07-23): demo-mode payload for pilot-marketing screenshots.
// Gated behind DASHBOARD_DEMO_MODE env var — flip on Railway to swap, flip off
// to restore live numbers. NEVER default this to on. Remove this whole block
// once the screenshot cycle is done.
function demoMetrics() {
  const now = Date.now();
  const minAgo = (m) => new Date(now - m * 60 * 1000).toISOString();
  return {
    eventTotal: 512,
    activeNow: 4,
    recentlyActive: 8,
    liveWindowMinutes: 3,
    recentWindowMinutes: 15,
    users: 64,
    paidUsers: 38,
    conversionPct: 64,
    revenueInr: 1862,
    revenueBreakdown: { build: 1323, rate: 539 },
    ats: { avg: 87 },
    modeSplit: { build: 42, rate: 22, total: 64 },
    funnel: {
      session_started: 42,
      resume_delivered: 38,
      payment_link_created: 32,
      payment_succeeded: 27,
      clean_pdf_delivered: 27,
    },
    rateFunnel: {
      entered: 22,
      pdf_ingested: 20,
      scored: 20,
      payment_link_created: 15,
      payment_succeeded: 11,
      delivered: 11,
      refused: 2,
      cancelled: 0,
      conversion_pct: 55,
      avg_score: 6.8,
      score_samples: 20,
    },
    edits: { free: 47, paid: 22 },
    today: {
      session_started: 12,
      resume_delivered: 10,
      payment_succeeded: 7,
    },
    recent: [
      { event_name: 'rate_pdf_ingested', state: 'RATE_ASKING_LINKS', at: minAgo(2) },
      { event_name: 'rate_payment_succeeded', state: 'RATE_IMPROVING', at: minAgo(5) },
      { event_name: 'rate_delivered', state: 'RATE_DELIVERED', at: minAgo(8) },
      { event_name: 'session_started', state: 'AWAITING_CONFIRM_START', at: minAgo(11) },
      { event_name: 'resume_delivered', state: 'DELIVERED', at: minAgo(15) },
      { event_name: 'payment_succeeded', state: 'PAID_COMPLETE', at: minAgo(18) },
      { event_name: 'rating_submitted', state: 'RATE_DELIVERED', at: minAgo(24) },
      { event_name: 'mode_selected', state: 'AWAITING_MODE_SELECT', at: minAgo(32) },
      { event_name: 'session_started', state: 'AWAITING_CONFIRM_START', at: minAgo(45) },
      { event_name: 'clean_pdf_delivered', state: 'PAID_COMPLETE', at: minAgo(60) },
      { event_name: 'edit_requested', state: 'AWAITING_EDIT_OR_DONE', at: minAgo(75) },
      { event_name: 'rate_score_computed', state: 'RATE_SHOWING_SCORE', at: minAgo(100) },
      { event_name: 'resume_delivered', state: 'DELIVERED', at: minAgo(120) },
      { event_name: 'session_started', state: 'AWAITING_CONFIRM_START', at: minAgo(150) },
      { event_name: 'payment_succeeded', state: 'PAID_COMPLETE', at: minAgo(180) },
    ],
  };
}

router.get('/admin/metrics', basicAuth, async (_req, res) => {
  try {
    const metrics = process.env.DASHBOARD_DEMO_MODE === '1'
      ? demoMetrics()
      : await fetchMetrics();
    res.type('html').send(renderMetrics(metrics));
  } catch (e) {
    logger.error({ err: e.message }, 'metrics dashboard failed');
    res.status(500).send('metrics unavailable — check server logs');
  }
});

module.exports = router;
