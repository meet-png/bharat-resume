// Resume rewriter — Hinglish/Hindi → impact-oriented English. PRD §7.2.
// Critical rule: NEVER invent facts. Maintain exact JSON schema.
// TODO Day 3: build system prompt from PRD §7.2, call llm.complete, return resume_json_rewritten.

async function rewriteResume(_args) {
  throw new Error('llm.rewriteResume not implemented (Day 3)');
}

module.exports = { rewriteResume };
