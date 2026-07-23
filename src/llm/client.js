// LLM wrapper: OpenAI only. PRD §3, §7.5 (Anthropic dropped per README Decisions log 2026-06-20).
// Strict JSON mode; one retry on JSON.parse failure with the same model.
const crypto = require('crypto');
const { config } = require('../config');
const logger = require('../logger');

let openaiClient = null;

// Safe key fingerprint for cross-env comparison. SHA-256 first 12 hex (48 bits)
// — doesn't reveal the key, but lets us confirm that what we expect is what
// Railway actually loaded (mismatched envs are the #1 prod-vs-local divergence).
function keyFingerprint(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex').slice(0, 12);
}

function getOpenAI() {
  if (openaiClient) return openaiClient;
  const OpenAI = require('openai');
  // Trim the key. Pasting into a hosting panel (Railway) very often appends a
  // trailing newline/space; a stray char in the Authorization header value
  // makes undici throw a header-validation error that surfaces as an opaque
  // "Connection error." (no errno) — and echoes the key into the error message.
  // Trimming kills the most common, hardest-to-diagnose prod failure here.
  const raw = String(config.OPENAI_API_KEY || '');
  const apiKey = raw.trim();
  // One-shot boot log: safe fingerprint + length + trailing-whitespace check.
  // Same fingerprint on local + Railway = same key. Different = paste mismatch.
  logger.info({
    keyFp: keyFingerprint(apiKey),
    keyLen: apiKey.length,
    keyHadTrailingWs: raw !== apiKey,
    keyPrefix: apiKey.slice(0, 8), // sk-proj- or sk- — non-secret
  }, 'openai client init');
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

// Walk e.cause chain (undici nests root causes 2-3 levels deep on stream
// failures). NEVER include the messages — undici occasionally embeds the
// outgoing Authorization header value in cause messages, leaking the secret.
// Names + codes only.
function causeChain(e, depth = 5) {
  const out = [];
  let cur = e;
  for (let i = 0; i < depth && cur; i++) {
    out.push({ name: cur.name || null, code: cur.code || null });
    cur = cur.cause;
  }
  return out;
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
        {
          status: e.status,
          code: e.code,
          type: e.type,
          causeCode: cause.code,
          causeChain: causeChain(e), // chain of {name, code} — NO messages (header-leak risk)
          attempt,
          transient,
          err: e.message,
          model,
        },
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
    const finishReason = res.choices?.[0]?.finish_reason;
    try {
      const data = JSON.parse(raw);
      return { data, usage: res.usage, model: res.model, attempts: attempt };
    } catch {
      lastErr = new Error(`LLM returned invalid JSON (attempt ${attempt}): ${raw.slice(0, 200)}`);
      // finish_reason distinguishes 'length' (truncated at max_tokens) from
      // 'stop' (model finished but produced malformed JSON — usually recoverable
      // via retry) and 'content_filter' (blocked, retry won't help).
      logger.warn({
        attempt, model,
        finish_reason: finishReason,
        completion_tokens: res.usage?.completion_tokens,
        rawTail: raw.slice(-120),
      }, 'llm json parse failed');
    }
  }
  throw lastErr;
}

module.exports = { complete, getOpenAI };
