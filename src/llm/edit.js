// Targeted edit pass. PRD §7.3 / §5 Phase 4 (edit loop, Day 5.3).
// Takes the ALREADY-rewritten resume JSON + one free-text change request and
// returns the SAME schema with ONLY that change applied. Never invents facts,
// never touches unrelated sections. On ambiguity or a request that would require
// fabricating data, returns the resume unchanged + a short clarification.
const { complete } = require('./client');

function jdLine({ jdRole, jdText, jdGeneric }) {
  if (jdGeneric) return 'TARGET: generic resume (no specific role).';
  if (jdRole) return `TARGET ROLE: "${jdRole}". Keep edits consistent with this role.`;
  if (jdText) return `TARGET JD (excerpt): """${String(jdText).slice(0, 600)}"""`;
  return 'TARGET: generic resume.';
}

// Returns { data: <full resume schema> | null, clarification_needed: string | null, usage }.
async function applyEdit({ rewritten, instruction, jdRole, jdText, jdGeneric }) {
  if (!rewritten) throw new Error('applyEdit: rewritten resume required');
  if (!instruction || !String(instruction).trim()) {
    return { data: null, clarification_needed: 'Kya change karna hai? Ek line mein batao.', usage: null };
  }

  const system = `You edit an already-finalized resume JSON for an Indian student. You are given the CURRENT resume JSON and ONE change request. Apply ONLY that change and return the COMPLETE resume JSON in the exact same schema.

${jdLine({ jdRole, jdText, jdGeneric })}

ABSOLUTE RULES:
1. NEVER invent facts, metrics, companies, skills, or achievements. If the change asks to ADD something the student gives no real detail for (e.g. "add a Google internship" with no specifics), do NOT fabricate — set clarification_needed asking for the concrete detail and return the resume UNCHANGED.
2. Touch ONLY what the request asks for. Every other field must come back byte-for-byte identical. Do not re-write, re-order, or "improve" unrelated bullets/sections.
3. Preserve formatting: bullets are plain strings that keep their \`**bold**\` markdown markers around metrics. Keep that convention on any bullet you add or modify.
4. If the request is a genuine edit you can apply from given information (rephrase a bullet, fix a typo, change CGPA the student now states, remove a project, reorder skills, shorten the summary), apply it and set clarification_needed = null.
5. If the request is ambiguous or you cannot tell what to change, return the resume unchanged + a one-line clarification.

CURRENT resume JSON:
${JSON.stringify(rewritten)}

Return ONLY valid JSON in this shape (no prose, no markdown fences):
{ "resume": <the FULL resume JSON in the same schema as above>, "clarification_needed": string | null }

VOICE for clarification_needed: Hinglish or English, Latin script only, one short warm sentence (goes straight to WhatsApp).`;

  const result = await complete({ system, user: String(instruction), maxTokens: 2400, temperature: 0.2 });
  const out = result.data || {};
  const clarification = out.clarification_needed || null;
  const resume = clarification ? null : (out.resume || null);

  // Defensive: preserve the contact phone from the prior version — an edit must
  // never drop or alter it unless explicitly asked (and the student can't change
  // their WhatsApp-derived number via chat anyway).
  if (resume && rewritten.phone && !resume.phone) resume.phone = rewritten.phone;

  return { data: resume, clarification_needed: clarification, usage: result.usage };
}

module.exports = { applyEdit };
