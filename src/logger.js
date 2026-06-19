// Shared pino logger. PRD §3 (logging row).
const pino = require('pino');
const { config } = require('./config');

const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  base: { svc: 'bharat-resume' },
});

module.exports = logger;
