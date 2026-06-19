// Main state machine. PRD §6, §18 Day 2.
// TODO Day 2: implement handle({ from, body }) — load session from Redis,
// route by state, call LLM extract for Phase 2, transition, persist, return reply text.

async function handle(_input) {
  throw new Error('state router not implemented (Day 2)');
}

module.exports = { handle };
