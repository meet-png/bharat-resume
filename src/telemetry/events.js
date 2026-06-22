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

module.exports = { logEvent, EVENT_NAMES };
