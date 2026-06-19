// LLM wrapper: OpenAI default, Anthropic fallback. PRD §3, §7.5.
// TODO Day 2: implement complete({ system, user, schema, model }) with strict JSON mode,
// retry-with-Sonnet on JSON parse failure (twice) or >3 iterations on same section.
const { config } = require('../config');

let openaiClient = null;
let anthropicClient = null;

function getOpenAI() {
  if (openaiClient) return openaiClient;
  const OpenAI = require('openai');
  openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  return openaiClient;
}

function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  const Anthropic = require('@anthropic-ai/sdk');
  anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return anthropicClient;
}

async function complete(_args) {
  throw new Error('llm.complete not implemented (Day 2)');
}

module.exports = { complete, getOpenAI, getAnthropic };
