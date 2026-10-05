const express = require('express');
const db = require('./db');
const auth = require('./auth');
const shows = require('./shows');
const logger = require('./logger');
const { HttpError } = require('./errors');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- health ----------

// Liveness: the process is up. Never touches the DB.
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: can we actually serve traffic? Fails closed if the DB is down.
app.get('/health/ready', async (req, res) => {
  try {
    if (!db.isMigrated()) throw new Error('schema not ready');
    await db.pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

// ---------- auth ----------

app.post('/auth/token', (req, res) => {
  const token = auth.issueToken(req.body?.user_id);
  res.status(201).json({ token, user_id: req.body.user_id });
});

// ---------- shows ----------

app.post('/shows', auth.requireAdmin, async (req, res) => {
  const show = await shows.createShow(req.body);
  res.status(201).json(show);
});

app.get('/shows/:id', async (req, res) => {
  res.json(await shows.getShowState(req.params.id));
});

// ---------- errors ----------

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: 'route not found' });
});

// Express 5 forwards errors from async handlers here automatically.
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }
  // body-parser: malformed JSON, body too large, ...
  if (err.type && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'bad_request', message: err.message });
  }
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});

module.exports = app;
