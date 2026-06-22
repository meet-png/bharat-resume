// Env var validation. PRD §17.
const { z } = require('zod');
require('dotenv').config();

// Treat empty .env values as "not set" so optional URL fields don't blow up
// when Meet has only filled in some sections of the .env file.
const emptyAsUndefined = (v) => (v === '' || v == null ? undefined : v);

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BASE_URL: z.preprocess(emptyAsUndefined, z.string().url().default('http://localhost:3000')),

  TWILIO_ACCOUNT_SID: z.preprocess(emptyAsUndefined, z.string().optional()),
  TWILIO_AUTH_TOKEN: z.preprocess(emptyAsUndefined, z.string().optional()),
  TWILIO_WHATSAPP_FROM: z.string().default('whatsapp:+14155238886'),

  // Meta WhatsApp Cloud API (migration target — see docs/META_MIGRATION_PLAN.md).
  // All optional so the bot still boots on Twilio while these are being filled in.
  WHATSAPP_PROVIDER: z.enum(['twilio', 'meta']).default('twilio'),
  META_PHONE_NUMBER_ID: z.preprocess(emptyAsUndefined, z.string().optional()),
  META_WABA_ID: z.preprocess(emptyAsUndefined, z.string().optional()),
  META_APP_SECRET: z.preprocess(emptyAsUndefined, z.string().optional()),
  META_VERIFY_TOKEN: z.preprocess(emptyAsUndefined, z.string().optional()),
  META_WHATSAPP_TOKEN: z.preprocess(emptyAsUndefined, z.string().optional()),

  SUPABASE_URL: z.preprocess(emptyAsUndefined, z.string().url().optional()),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(emptyAsUndefined, z.string().optional()),
  SUPABASE_STORAGE_BUCKET: z.string().default('resumes'),

  REDIS_URL: z.preprocess(emptyAsUndefined, z.string().optional()),

  OPENAI_API_KEY: z.preprocess(emptyAsUndefined, z.string().optional()),
  ANTHROPIC_API_KEY: z.preprocess(emptyAsUndefined, z.string().optional()),
  LLM_PRIMARY: z.string().default('gpt-4o-mini'),
  LLM_FALLBACK: z.string().default('claude-sonnet-4-6'),

  RAZORPAY_KEY_ID: z.preprocess(emptyAsUndefined, z.string().optional()),
  RAZORPAY_KEY_SECRET: z.preprocess(emptyAsUndefined, z.string().optional()),
  RAZORPAY_WEBHOOK_SECRET: z.preprocess(emptyAsUndefined, z.string().optional()),

  // Optional: GitHub PAT raises unauthenticated rate-limit (60/hr) to 5000/hr.
  // Used by src/enrichment/github.js for project repo enrichment.
  GITHUB_TOKEN: z.preprocess(emptyAsUndefined, z.string().optional()),

  ADMIN_USERNAME: z.string().default('meet'),
  ADMIN_PASSWORD: z.preprocess(emptyAsUndefined, z.string().optional()),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid env vars:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = { config: parsed.data };
