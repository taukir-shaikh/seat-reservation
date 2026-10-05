const client = require('prom-client');
const db = require('./db');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const reservationsConfirmed = new client.Counter({
  name: 'reservations_confirmed_total',
  help: 'Reservations that were newly confirmed (201)',
  registers: [registry],
});

const reservationsDeclined = new client.Counter({
  name: 'reservations_declined_total',
  help: 'Reserve requests that did not create a new reservation, by reason',
  labelNames: ['reason'],
  registers: [registry],
});

const reservationsCancelled = new client.Counter({
  name: 'reservations_cancelled_total',
  help: 'Reservations cancelled by their owner',
  registers: [registry],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency; the _count series gives requests per status',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Show every reason from the start (as 0) so dashboards don't have gaps.
for (const reason of ['seat_taken', 'per_user_limit', 'idempotent_replay', 'idempotency_key_reused']) {
  reservationsDeclined.inc({ reason }, 0);
}

// Seat gauges are read straight from the database on every scrape, so they
// always match what GET /shows/{id} returns — no in-memory copy to drift.
async function countSeatsByShow() {
  const { rows } = await db.pool.query(
    `SELECT show_id,
            count(*) FILTER (WHERE status = 'available') AS available,
            count(*) FILTER (WHERE status = 'confirmed') AS confirmed
     FROM seats
     GROUP BY show_id`,
  );
  return rows;
}

new client.Gauge({
  name: 'seats_available',
  help: 'Seats currently available, per show',
  labelNames: ['show_id'],
  registers: [registry],
  async collect() {
    this.reset();
    if (!db.isMigrated()) return;
    for (const row of await countSeatsByShow()) this.set({ show_id: row.show_id }, row.available);
  },
});

new client.Gauge({
  name: 'seats_confirmed',
  help: 'Seats currently confirmed, per show',
  labelNames: ['show_id'],
  registers: [registry],
  async collect() {
    this.reset();
    if (!db.isMigrated()) return;
    for (const row of await countSeatsByShow()) this.set({ show_id: row.show_id }, row.confirmed);
  },
});

// Express middleware: time every request. Uses the route pattern
// (/shows/:id) rather than the raw URL to keep label values few.
function trackHttpRequests(req, res, next) {
  const stopTimer = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
    stopTimer({ method: req.method, route, status: res.statusCode });
  });
  next();
}

module.exports = {
  registry,
  reservationsConfirmed,
  reservationsDeclined,
  reservationsCancelled,
  trackHttpRequests,
};
