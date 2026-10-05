const crypto = require('crypto');
const express = require('express');
const pinoHttp = require('pino-http');
const db = require('./db');
const auth = require('./auth');
const shows = require('./shows');
const reservations = require('./reservations');
const metrics = require('./metrics');
const logger = require('./logger');
const { HttpError, Decline } = require('./errors');

const app = express();
app.use(express.json({ limit: '1mb' }));

// One log line per request, tagged with a request id. We reuse the caller's
// X-Request-Id if they sent one and always echo it back in the response.
app.use(pinoHttp({
  logger,
  genReqId(req, res) {
    const requestId = req.get('x-request-id') || crypto.randomUUID();
    res.setHeader('x-request-id', requestId);
    return requestId;
  },
  // req.log lines carry just the request id; the "request completed" line
  // carries method, url, status and timing. No headers, so no tokens in logs.
  quietReqLogger: true,
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
}));
app.use(metrics.trackHttpRequests);

// ---------- index ----------

// What a reviewer sees when they open the bare URL.
app.get('/', (req, res) => {
  res.json({
    service: 'seat-reservation',
    endpoints: [
      'POST /auth/token',
      'POST /shows  (x-admin-key)',
      'GET  /shows/:id',
      'POST /shows/:id/reserve  (Bearer token)',
      'POST /reservations/:id/cancel  (Bearer token)',
      'GET  /health/live',
      'GET  /health/ready',
      'GET  /metrics',
    ],
  });
});

// ---------- health & metrics ----------

// Liveness: the process is up. Never touches the DB.
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: can we actually serve traffic? Fails closed if the DB is down
// or doesn't answer within 2 seconds.
app.get('/health/ready', async (req, res) => {
  try {
    if (!db.isMigrated()) throw new Error('schema not ready');
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('database timeout')), 2000));
    await Promise.race([db.pool.query('SELECT 1'), timeout]);
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

app.get('/metrics', async (req, res) => {
  res.set('content-type', metrics.registry.contentType);
  res.send(await metrics.registry.metrics());
});

// ---------- auth ----------

app.post('/auth/token', (req, res) => {
  const token = auth.issueToken(req.body?.user_id);
  res.status(201).json({ token, user_id: req.body.user_id });
});

// ---------- shows ----------

app.post('/shows', auth.requireAdmin, async (req, res) => {
  const show = await shows.createShow(req.body);
  req.log.info({ event: 'show_created', show_id: show.id, total_seats: show.total_seats }, 'show created');
  res.status(201).json(show);
});

app.get('/shows/:id', async (req, res) => {
  res.json(await shows.getShowState(req.params.id));
});

// ---------- reservations ----------

// The user always comes from the token (req.userId). Any user_id in the body
// is simply never read.
app.post('/shows/:id/reserve', auth.requireUser, async (req, res) => {
  const { seats, idempotencyKey } = reservations.parseReserveRequest(req.body, req.get('idempotency-key'));

  let result;
  try {
    result = await reservations.reserveSeats({
      showId: req.params.id,
      userId: req.userId,
      seats,
      idempotencyKey,
    });
  } catch (err) {
    if (err instanceof Decline) {
      metrics.reservationsDeclined.labels(err.reason).inc();
      req.log.info({ event: 'reservation_declined', reason: err.reason, user_id: req.userId, seats }, 'declined');
    }
    throw err;
  }

  const { reservation, replayed } = result;
  if (replayed) {
    metrics.reservationsDeclined.labels('idempotent_replay').inc();
    req.log.info({ event: 'reservation_replayed', reservation_id: reservation.id, user_id: req.userId }, 'replayed');
  } else {
    metrics.reservationsConfirmed.inc();
    req.log.info({ event: 'reservation_confirmed', reservation_id: reservation.id, user_id: req.userId, seats }, 'confirmed');
  }

  // 201 the first time; a replay returns the same body with 200 so it is
  // never mistaken for a second sale.
  res.set('Idempotent-Replayed', String(replayed));
  res.status(replayed ? 200 : 201).json(reservations.toResponse(reservation));
});

app.post('/reservations/:id/cancel', auth.requireUser, async (req, res) => {
  const { reservation, alreadyCancelled } = await reservations.cancelReservation({
    reservationId: req.params.id,
    userId: req.userId,
  });
  if (!alreadyCancelled) {
    metrics.reservationsCancelled.inc();
    req.log.info({ event: 'reservation_cancelled', reservation_id: reservation.id, user_id: req.userId }, 'cancelled');
  }
  res.json(reservations.toResponse(reservation));
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
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});

module.exports = app;
