// Event logger → Postgres `events` table. PRD §13.2 taxonomy.
//
// Fire-and-forget by contract: logEvent NEVER throws into its caller and NEVER
// blocks a reply — call it without awaiting from the hot path. Any DB failure is
// logged and swallowed so telemetry can never break a student's flow.
//
// Disabled under NODE_ENV=test so the regression suite doesn't pollute the real
// users/events tables (and the live admin dashboard).
const { config } = require('../config');
const logger = require('../logger');
const { upsertUser, insertEvent } = require('../store/postgres');

const EVENT_NAMES = Object.freeze([
  'session_started',
  'section_completed',
  'section_skipped',
  'jd_scrape_attempted',
  'jd_paste_used',
  'resume_generated',
  'resume_delivered',
  'edit_requested',
  'payment_link_created',
  'payment_link_opened',
  'payment_succeeded',
  'clean_pdf_delivered',
  'session_ended',
  'feedback_apply',
]);
const EVENT_SET = new Set(EVENT_NAMES);

async function logEvent({ phoneHash, eventName, state = null, payload = null, userFields = {} } = {}) {
  if (config.NODE_ENV === 'test') return;
  if (!phoneHash || !EVENT_SET.has(eventName)) {
    logger.warn({ eventName, hasHash: !!phoneHash }, 'logEvent: missing phoneHash or unknown event — skipped');
    return;
  }
  try {
    const userId = await upsertUser(phoneHash, userFields);
    await insertEvent({ userId, eventName, state, payload });
  } catch (e) {
    // Non-fatal: telemetry must never break the conversation.
    logger.error({ err: e.message, eventName }, 'logEvent failed (non-fatal)');
  }
}

// Bump users.last_active_at on every inbound message — WITHOUT writing an
// event row. logEvent above only fires for milestone events (session_started,
// resume_delivered, edit_requested, payment_*), so a student in the middle of
// Phase 2 Q&A (name/email/education/skills/etc.) has NO event during that
// stretch and the LIVE-now dashboard drops them off after 5 min even though
// they're actively chatting. This helper is the accurate signal: it bumps
// activity time without polluting the events table with "message_received"
// noise. Fire-and-forget; never blocks the reply, never throws.
async function bumpUserActivity(phoneHash) {
  if (config.NODE_ENV === 'test') return;
  if (!phoneHash) return;
  try {
    await upsertUser(phoneHash, {});
  } catch (e) {
    logger.warn({ err: e.message }, 'bumpUserActivity failed (non-fatal)');
  }
}

module.exports = { logEvent, bumpUserActivity, EVENT_NAMES };
