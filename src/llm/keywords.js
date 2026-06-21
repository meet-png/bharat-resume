// JD keyword extractor. PRD §7.4.
// Three input modes:
//   1. jdText present → extract top 15 from the text
//   2. jdRole only → infer typical keywords for that role
//   3. jdGeneric → empty list; rewriter uses transferable-skill framing
const { complete } = require('./client');
const logger = require('../logger');

async function extractKeywords({ jdText, jdRole, jdGeneric }) {
  if (jdGeneric) {
    return { keywords: [], role_title: 'generic', experience_level: 'fresher' };
  }

  let source;
  if (jdText) {
    source = `JD TEXT:\n"""${jdText.slice(0, 3500)}"""`;
  } else if (jdRole) {
    source = `ROLE TITLE: "${jdRole}"\nNo JD text provided — infer the top 15 hard skills/tools/frameworks an ATS would look for in a typical "${jdRole}" role at fresher / junior level in the Indian market. Use real, named technologies and methodologies from this role's domain (don't bias toward software unless the role is software).`;
  } else {
    return { keywords: [], role_title: 'unknown', experience_level: 'fresher' };
  }

  const system = `Extract the top 15 keywords that an ATS would scan for in this job. Include:
- Hard skills (programming languages, software tools, methodologies, named technologies, certifications)
- Frameworks, libraries, platforms
- Industry-specific tools (e.g., AutoCAD for civil, SAP for finance, HubSpot for marketing)

EXCLUDE:
- Soft skills ("communication", "team player", "leadership", "problem-solving")
- Generic terms ("good fit", "passionate", "self-motivated")
- Years-of-experience phrases

${source}

Return JSON exactly:
{ "keywords": [string, max 15], "role_title": string, "experience_level": "fresher" | "junior" | "mid" }

If the role is non-software (marketing/finance/civil/medical/etc.), the keywords MUST reflect that domain's tools and frameworks — never default to software stack.`;

  try {
    const result = await complete({ system, user: 'extract keywords', maxTokens: 600 });
    const data = result.data;
    // Cap and sanitise.
    if (Array.isArray(data.keywords)) data.keywords = data.keywords.slice(0, 15).map(String);
    return data;
  } catch (e) {
    logger.warn({ err: e.message }, 'keyword extraction failed; returning empty');
    return { keywords: [], role_title: jdRole || 'unknown', experience_level: 'fresher' };
  }
}

module.exports = { extractKeywords };
