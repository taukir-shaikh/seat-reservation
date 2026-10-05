const db = require('./db');
const { HttpError } = require('./errors');

const DEFAULT_PER_USER_LIMIT = 4;
const MAX_SEATS_PER_SHOW = 20000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validateNewShow(body) {
  const { name, seats, price_paise, per_user_limit = DEFAULT_PER_USER_LIMIT } = body || {};

  if (typeof name !== 'string' || name.trim() === '') {
    throw new HttpError(400, 'invalid_name', 'name is required');
  }
  if (!Array.isArray(seats) || seats.length === 0 || seats.length > MAX_SEATS_PER_SHOW) {
    throw new HttpError(400, 'invalid_seats', `seats must be a list of 1-${MAX_SEATS_PER_SHOW} seat ids`);
  }
  if (!seats.every((seat) => typeof seat === 'string' && seat.trim() !== '' && seat.length <= 20)) {
    throw new HttpError(400, 'invalid_seats', 'every seat id must be a non-empty string (max 20 chars)');
  }
  if (new Set(seats).size !== seats.length) {
    throw new HttpError(400, 'invalid_seats', 'seat ids must be unique');
  }
  // money is integer paise, never a float
  if (!Number.isSafeInteger(price_paise) || price_paise < 0) {
    throw new HttpError(400, 'invalid_price', 'price_paise must be a non-negative integer');
  }
  if (!Number.isInteger(per_user_limit) || per_user_limit < 1 || per_user_limit > 100) {
    throw new HttpError(400, 'invalid_limit', 'per_user_limit must be an integer between 1 and 100');
  }

  return { name: name.trim(), seats, pricePaise: price_paise, perUserLimit: per_user_limit };
}

async function createShow(body) {
  const show = validateNewShow(body);

  const showId = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO shows (name, price_paise, per_user_limit, total_seats)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [show.name, show.pricePaise, show.perUserLimit, show.seats.length],
    );
    const id = rows[0].id;

    // insert every seat in one statement; position keeps the admin's order
    await client.query(
      `INSERT INTO seats (show_id, seat_no, position)
       SELECT $1, seat_no, position
       FROM unnest($2::text[]) WITH ORDINALITY AS t(seat_no, position)`,
      [id, show.seats],
    );
    return id;
  });

  return getShowState(showId);
}

// A show's name, price and limit never change after creation, so we keep
// them in memory and save one query on every reserve call.
const showCache = new Map();

// The show row without its seats. Throws 404 if it doesn't exist.
async function findShow(showId) {
  if (!isUuid(showId)) {
    throw new HttpError(404, 'show_not_found', 'show not found');
  }
  if (showCache.has(showId)) return showCache.get(showId);

  const { rows } = await db.pool.query('SELECT * FROM shows WHERE id = $1', [showId]);
  if (rows.length === 0) {
    throw new HttpError(404, 'show_not_found', 'show not found');
  }
  showCache.set(showId, rows[0]);
  return rows[0];
}

// Per-seat status plus counts. The counts are computed from the same single
// query as the seat list, so they are one consistent snapshot.
async function getShowState(showId) {
  const show = await findShow(showId);
  const { rows: seats } = await db.pool.query(
    'SELECT seat_no, status FROM seats WHERE show_id = $1 ORDER BY position',
    [showId],
  );

  // "held" is part of the API contract; in this design a reservation is
  // confirmed immediately, so nothing ever sits in "held".
  const counts = { available: 0, held: 0, confirmed: 0 };
  for (const seat of seats) counts[seat.status] += 1;

  return {
    id: show.id,
    name: show.name,
    price_paise: show.price_paise,
    per_user_limit: show.per_user_limit,
    total_seats: show.total_seats,
    counts,
    invariant_ok: counts.available + counts.held + counts.confirmed === show.total_seats,
    seats: seats.map((seat) => ({ seat: seat.seat_no, status: seat.status })),
  };
}

module.exports = { createShow, findShow, getShowState, isUuid };
