// Supabase Postgres client + query helpers. PRD §13.1.
// TODO Day 1-2: implement upsertUser, insertResume, insertPayment, etc.
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

module.exports = { getClient };
