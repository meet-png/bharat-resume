// Express bootstrap. PRD §4 (architecture), §14 (endpoints), §18 Day 1.
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { config } = require('./config');
const logger = require('./logger');

const twilioRouter = require('./routes/twilio');
const whatsappRouter = require('./routes/whatsapp');
const razorpayRouter = require('./routes/razorpay');
const cashfreeRouter = require('./routes/cashfree');
const adminRouter = require('./routes/admin');

const app = express();

// Behind Railway / ngrok we need to trust the proxy so req.protocol / req.host
// reflect the original request — required for Twilio signature validation.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false })); // CSP off for now; payment-success.html is the only HTML.
app.use(pinoHttp({ logger }));

// Payment + WhatsApp webhooks need raw body for HMAC, so they mount their own
// body parsers inside the router BEFORE these global parsers run. Both payment
// routes stay wired — active provider is selected by config.PAYMENT_PROVIDER,
// the inactive route just never receives traffic.
app.use('/webhook/razorpay', razorpayRouter);
app.use('/webhook/cashfree', cashfreeRouter);
app.use('/webhook/whatsapp', whatsappRouter);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

app.use('/webhook/twilio', twilioRouter);
app.use('/', adminRouter);

app.use((err, req, res, _next) => {
  req.log.error({ err }, 'unhandled error');
  res.status(500).send('internal error');
});

app.listen(config.PORT, () => {
  // Include router.js mtime in the boot banner so server.log makes it obvious
  // which version of the state machine is live (catches "old code still running" bugs).
  const fs = require('fs');
  const crypto = require('crypto');
  const routerStat = fs.statSync(require.resolve('./state/router'));
  // Eager OpenAI key fingerprint — SHA-256 first 12 hex of the trimmed key.
  // Lets us confirm at a glance whether prod & local loaded the same key,
  // without revealing the key itself. Computed here so it appears in the
  // boot banner (not lazy-init'd inside client.js). Safe: hash only.
  const rawKey = String(config.OPENAI_API_KEY || '');
  const trimmedKey = rawKey.trim();
  const openaiKeyFp = trimmedKey
    ? crypto.createHash('sha256').update(trimmedKey).digest('hex').slice(0, 12)
    : null;
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      routerMtime: routerStat.mtime.toISOString(),
      openaiKeyFp,
      openaiKeyLen: trimmedKey.length,
      openaiKeyHadTrailingWs: rawKey !== trimmedKey,
      openaiKeyPrefix: trimmedKey.slice(0, 8), // sk-proj- or sk- — non-secret
      gitCommitSha: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '').slice(0, 12) || null,
    },
    'bharat-resume up'
  );
});
