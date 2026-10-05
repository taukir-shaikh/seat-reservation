const app = require('./app');
const db = require('./db');
const logger = require('./logger');

const port = Number(process.env.PORT || 3000);

// Start listening right away so liveness answers during a cold start;
// readiness stays 503 until the schema is in place.
const server = app.listen(port, () => logger.info({ port }, 'server listening'));

db.migrateWithRetry().catch((err) => {
  logger.fatal({ err }, 'giving up on database, exiting');
  process.exit(1);
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    db.pool.end().finally(() => process.exit(0));
  });
  // don't hang forever on open keep-alive connections
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
