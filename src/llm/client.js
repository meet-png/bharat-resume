// LLM wrapper: OpenAI only. PRD §3, §7.5 (Anthropic dropped per README Decisions log 2026-06-20).
// Strict JSON mode; one retry on JSON.parse failure with the same model.
const { config } = require('../config');
const logger = require('../logger');

let openaiClient = null;

function getOpenAI() {
  if (openaiClient) return openaiClient;
  const OpenAI = require('openai');
  // Trim the key. Pasting into a hosting panel (Railway) very often appends a
  // trailing newline/space; a stray char in the Authorization header value
  // makes undici throw a header-validation error that surfaces as an opaque
  // "Connection error." (no errno) — and echoes the key into the error message.
  // Trimming kills the most common, hardest-to-diagnose prod failure here.
  const apiKey = String(config.OPENAI_API_KEY || '').trim();
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

async function complete({ system, user, model = config.LLM_PRIMARY, temperature = 0.2, maxTokens = 800 }) {
  const openai = getOpenAI();
  let lastErr;

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await openai.chat.completions.create({
        model,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
    } catch (e) {
      // OpenAI SDK error (auth, quota, model-access, network). status/code/type
      // are what distinguish a misconfigured prod key (401) or exhausted quota
      // (429) or missing model access (404) from a transient blip. Log them and
      // abort — retrying a 401/429/404 just burns another call on the same failure.
      // "Connection error." (no status/code) means the request never reached
      // OpenAI — a network/DNS/egress failure. The real errno (ETIMEDOUT /
      // EAI_AGAIN / ECONNREFUSED) lives in e.cause.code. NEVER log e.cause.message
      // here: on some undici failures it embeds the outgoing request's
      // Authorization header (the API key) — logging it leaks the secret.
      const cause = e.cause || {};
      logger.error(
        { status: e.status, code: e.code, type: e.type, causeCode: cause.code, err: e.message, model },
        'openai request failed',
      );
      throw e;
    }

    const raw = res.choices?.[0]?.message?.content || '{}';
    try {
      const data = JSON.parse(raw);
      return { data, usage: res.usage, model: res.model, attempts: attempt + 1 };
    } catch {
      lastErr = new Error(`LLM returned invalid JSON (attempt ${attempt + 1}): ${raw.slice(0, 200)}`);
      logger.warn({ attempt: attempt + 1, model, rawHead: raw.slice(0, 120) }, 'llm json parse failed');
    }
  }
  throw lastErr;
}

module.exports = { complete, getOpenAI };
