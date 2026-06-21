// Express bootstrap. PRD §4 (architecture), §14 (endpoints), §18 Day 1.
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { config } = require('./config');
const logger = require('./logger');

const twilioRouter = require('./routes/twilio');
const razorpayRouter = require('./routes/razorpay');
const adminRouter = require('./routes/admin');

const app = express();

// Behind Railway / ngrok we need to trust the proxy so req.protocol / req.host
// reflect the original request — required for Twilio signature validation.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false })); // CSP off for now; payment-success.html is the only HTML.
app.use(pinoHttp({ logger }));

// /webhook/razorpay needs the raw body for HMAC, so it mounts its own express.raw
// inside the router BEFORE these global parsers run.
app.use('/webhook/razorpay', razorpayRouter);

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
  const routerStat = fs.statSync(require.resolve('./state/router'));
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, routerMtime: routerStat.mtime.toISOString() },
    'bharat-resume up'
  );
});
