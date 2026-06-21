// LLM wrapper: OpenAI only. PRD §3, §7.5 (Anthropic dropped per README Decisions log 2026-06-20).
// Strict JSON mode; one retry on JSON.parse failure with the same model.
const { config } = require('../config');

let openaiClient = null;

function getOpenAI() {
  if (openaiClient) return openaiClient;
  const OpenAI = require('openai');
  openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  return openaiClient;
}

async function complete({ system, user, model = config.LLM_PRIMARY, temperature = 0.2, maxTokens = 800 }) {
  const openai = getOpenAI();
  let lastErr;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await openai.chat.completions.create({
      model,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const raw = res.choices?.[0]?.message?.content || '{}';
    try {
      const data = JSON.parse(raw);
      return { data, usage: res.usage, model: res.model, attempts: attempt + 1 };
    } catch (e) {
      lastErr = new Error(`LLM returned invalid JSON (attempt ${attempt + 1}): ${raw.slice(0, 200)}`);
    }
  }
  throw lastErr;
}

module.exports = { complete, getOpenAI };
