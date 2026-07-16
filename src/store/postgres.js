// Supabase Postgres client + query helpers. PRD §13.1.
const { createClient } = require('@supabase/supabase-js');
const { config } = require('../config');

let client = null;

function getClient() {
  if (client) return client;
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return client;
}

// Upsert by phone *hash* (never the raw number) and return the user id. Bumps
// last_active_at on every call; `fields` can carry e.g. { paid: true } — columns
// not included are left untouched on conflict.
async function upsertUser(phoneHash, fields = {}) {
  const row = { phone_hash: phoneHash, last_active_at: new Date().toISOString(), ...fields };
  const { data, error } = await getClient()
    .from('users')
    .upsert(row, { onConflict: 'phone_hash' })
    .select('id')
    .single();
  if (error) throw new Error(`upsertUser: ${error.message}`);
  return data.id;
}

async function insertEvent({ userId, eventName, state, payload }) {
  const { error } = await getClient().from('events').insert({
    user_id: userId,
    event_name: eventName,
    state_at_event: state || null,
    payload: payload || null,
  });
  if (error) throw new Error(`insertEvent: ${error.message}`);
}

// Aggregates the launch funnel for the admin dashboard. At 100-student scale the
// events table is tiny, so we pull a bounded window and fold it in JS rather than
// maintaining SQL views.
async function fetchMetrics() {
  const db = getClient();

  // "Live now" = students whose last_active_at is within the last 5 min. Uses
  // the users table's last_active_at (bumped on every upsertUser call, i.e. every
  // inbound message that touches the state machine) so an idle 24h-TTL session
  // that hasn't had a new message isn't counted as "live".
  const liveWindowMs = 5 * 60 * 1000;
  const liveCutoff = new Date(Date.now() - liveWindowMs).toISOString();

  const [{ count: users }, { count: paidUsers }, { count: activeNow }] = await Promise.all([
    db.from('users').select('*', { count: 'exact', head: true }),
    db.from('users').select('*', { count: 'exact', head: true }).eq('paid', true),
    db.from('users').select('*', { count: 'exact', head: true }).gt('last_active_at', liveCutoff),
  ]);

  const { data: events, error } = await db
    .from('events')
    .select('event_name, state_at_event, payload, created_at')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error(`fetchMetrics: ${error.message}`);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const counts = {};
  const todayCounts = {};
  const atsScores = [];
  let freeEdits = 0;
  let paidEdits = 0;

  for (const e of events) {
    counts[e.event_name] = (counts[e.event_name] || 0) + 1;
    if (new Date(e.created_at) >= startOfToday) {
      todayCounts[e.event_name] = (todayCounts[e.event_name] || 0) + 1;
    }
    if (e.event_name === 'resume_delivered' && e.payload && typeof e.payload.ats_score === 'number') {
      atsScores.push(e.payload.ats_score);
    }
    if (e.event_name === 'edit_requested' && e.payload) {
      if (e.payload.phase === 'paid') paidEdits++;
      else freeEdits++;
    }
  }

  const delivered = counts.resume_delivered || 0;
  const paid = counts.payment_succeeded || 0;
  const avgAts = atsScores.length
    ? Math.round(atsScores.reduce((a, b) => a + b, 0) / atsScores.length)
    : null;

  return {
    users: users || 0,
    paidUsers: paidUsers || 0,
    activeNow: activeNow || 0,
    liveWindowMinutes: 5,
    funnel: {
      session_started: counts.session_started || 0,
      resume_delivered: delivered,
      payment_link_created: counts.payment_link_created || 0,
      payment_succeeded: paid,
      clean_pdf_delivered: counts.clean_pdf_delivered || 0,
    },
    today: todayCounts,
    conversionPct: delivered ? Math.round((paid / delivered) * 100) : 0,
    edits: { free: freeEdits, paid: paidEdits },
    ats: { avg: avgAts, samples: atsScores.length },
    revenueInr: paid * 49,
    recent: events.slice(0, 15).map((e) => ({
      event_name: e.event_name,
      state: e.state_at_event,
      at: e.created_at,
    })),
    eventTotal: events.length,
  };
}

module.exports = { getClient, upsertUser, insertEvent, fetchMetrics };
