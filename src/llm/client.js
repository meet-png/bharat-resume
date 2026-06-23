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

// Transient transport / server errors worth retrying. Auth (401), forbidden
// (403), model-access (404), and validation (400) are NEVER retried — same
// call will fail the same way and burn quota. ERR_STREAM_PREMATURE_CLOSE was
// the live-prod failure on 2026-06-23 (OpenAI dropped the rewrite body at
// ~27s); ECONNRESET / ETIMEDOUT / 429 / 5xx are the other usual suspects.
function isTransientLlmError(e) {
  const cause = e && e.cause ? e.cause : {};
  const code = (e && e.code) || cause.code || '';
  const status = (e && e.status) || 0;
  const TRANSPORT = new Set([
    'ERR_STREAM_PREMATURE_CLOSE',
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ]);
  if (TRANSPORT.has(code)) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

async function complete({ system, user, model = config.LLM_PRIMARY, temperature = 0.2, maxTokens = 800 }) {
  const openai = getOpenAI();
  const MAX_ATTEMPTS = 2; // 1 retry. Outer caller (generator.withTimeout) caps total wall-time.
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      // distinguish a misconfigured prod key (401) or missing model access (404)
      // from a transient blip — retry the transient class only.
      // "Connection error." (no status/code) means the request never reached
      // OpenAI — a network/DNS/egress failure. The real errno (ETIMEDOUT /
      // EAI_AGAIN / ECONNREFUSED) lives in e.cause.code. NEVER log e.cause.message
      // here: on some undici failures it embeds the outgoing request's
      // Authorization header (the API key) — logging it leaks the secret.
      const cause = e.cause || {};
      const transient = isTransientLlmError(e);
      logger.error(
        { status: e.status, code: e.code, type: e.type, causeCode: cause.code, attempt, transient, err: e.message, model },
        'openai request failed',
      );
      lastErr = e;
      if (transient && attempt < MAX_ATTEMPTS) {
        // Small backoff; OpenAI rarely needs more. Outer timeout in generator.js
        // protects against runaway total wall-time.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }

    const raw = res.choices?.[0]?.message?.content || '{}';
    try {
      const data = JSON.parse(raw);
      return { data, usage: res.usage, model: res.model, attempts: attempt };
    } catch {
      lastErr = new Error(`LLM returned invalid JSON (attempt ${attempt}): ${raw.slice(0, 200)}`);
      logger.warn({ attempt, model, rawHead: raw.slice(0, 120) }, 'llm json parse failed');
      // JSON-parse retry has no delay — it's model variance, not network.
    }
  }
  throw lastErr;
}

module.exports = { complete, getOpenAI };
