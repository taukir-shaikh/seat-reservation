const pino = require('pino');

// JSON logs to stdout — the platform (Render/Fly/docker) collects them.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'seat-reservation' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
