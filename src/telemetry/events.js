// Event logger → Postgres `events` table. PRD §13.2 taxonomy.
// TODO Day 6: insert { user_id, event_name, state_at_event, payload, created_at }.

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

async function logEvent(_args) {
  throw new Error('logEvent not implemented (Day 6)');
}

module.exports = { logEvent, EVENT_NAMES };
