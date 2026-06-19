// Section-by-section info extraction from a single WhatsApp message. PRD §7.1.
// TODO Day 2: build system prompt with state + current resume_json, call llm.complete,
// merge fields into resume_json, surface clarification_needed when present.

async function extractSection(_args) {
  throw new Error('llm.extractSection not implemented (Day 2)');
}

module.exports = { extractSection };
