// Express bootstrap. PRD §4 (architecture), §14 (endpoints), §18 Day 1.
const express = require('express');
const pinoHttp = require('pino-http');
const { config } = require('./config');
const logger = require('./logger');

const twilioRouter = require('./routes/twilio');
const razorpayRouter = require('./routes/razorpay');
const adminRouter = require('./routes/admin');

const app = express();

app.use(pinoHttp({ logger }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/webhook/twilio', twilioRouter);
app.use('/webhook/razorpay', razorpayRouter);
app.use('/', adminRouter);

app.use((err, req, res, _next) => {
  req.log.error({ err }, 'unhandled error');
  res.status(500).send('internal error');
});

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'bharat-resume up');
});
