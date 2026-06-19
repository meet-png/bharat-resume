// Saathi's outbound messages, keyed by state. PRD §5, §6.
// TODO Day 2: populate per PRD §5 (full Phase 1-7 wording). Use आप, not तू/तुम.
// Each prompt ≤2 lines on mobile.
const { STATES } = require('./states');

const PROMPTS = {
  [STATES.NEW]:
    'नमस्ते! मैं Saathi, BHARAT RESUME का AI bot. आपका professional resume सिर्फ 10 मिनट में बना दूंगा — हिंदी या English में बात करें, जैसा comfortable हो. Ready हैं?',
  [STATES.AWAITING_NAME]: 'सबसे पहले, आपका पूरा नाम क्या है?',
  [STATES.AWAITING_EMAIL]: 'आपकी email ID?',
  // TODO Day 2: fill in the rest from PRD §5 Phase 2 table.
};

module.exports = { PROMPTS };
