// Shared pino logger. PRD §3 (logging row).
// Redact secrets defensively — even though we don't intend to log them,
// pino-http auto-captures req/res, and we never want a stray secret in stdout.
const pino = require('pino');
const { config } = require('./config');

const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  base: { svc: 'bharat-resume' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-twilio-signature"]',
      'req.headers["x-razorpay-signature"]',
      'req.body.AuthToken',
      'req.body.From',
      'req.body.To',
      'req.body.WaId',
      'req.body.ProfileName',
      // Session carries the raw WhatsApp address (phone_from) for outbound
      // post-payment delivery. We never log the session wholesale, but redact
      // defensively so a stray log line can never leak the number.
      '*.phone_from',
      '*.phoneFrom',
      'phone_from',
      '*.apiKey',
      '*.api_key',
      '*.secret',
      '*.password',
      '*.token',
      'config.OPENAI_API_KEY',
      'config.ANTHROPIC_API_KEY',
      'config.TWILIO_AUTH_TOKEN',
      'config.SUPABASE_SERVICE_ROLE_KEY',
      'config.RAZORPAY_KEY_SECRET',
      'config.RAZORPAY_WEBHOOK_SECRET',
      'config.ADMIN_PASSWORD',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
