const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const logger = require('./logger');

// bigint (count(*), amount_paise) comes back as a string by default.
// Our values are far below 2^53, so plain numbers are safe.
types.setTypeParser(20, Number);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/seats',
  max: Number(process.env.DB_POOL_MAX || 20),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => logger.error({ err }, 'idle db client error'));

let migrated = false;

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  migrated = true;
}

// On a cold start the DB may come up after us, so keep trying.
async function migrateWithRetry(attempts = 30, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await migrate();
      logger.info('database schema ready');
      return;
    } catch (err) {
      logger.warn({ err: err.message, attempt: i }, 'database not ready yet, retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('could not reach the database');
}

// Runs fn(client) inside BEGIN/COMMIT and always releases the client.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  migrateWithRetry,
  withTransaction,
  isMigrated: () => migrated,
};
