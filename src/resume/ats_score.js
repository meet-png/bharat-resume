// ATS scorer. PRD §11. Runs server-side, no external API.
// total = 0.6 * keyword_match + 0.2 * structure_score + 0.2 * impact_score
// TODO Day 5: implement keyword_match (exact/fuzzy/synonym), structure_score, impact_score.

function scoreResume(_resumeJson, _jdKeywords) {
  throw new Error('scoreResume not implemented (Day 5)');
}

module.exports = { scoreResume };
