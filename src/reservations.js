const db = require('./db');
const { findShow, isUuid } = require('./shows');
const { HttpError, Decline } = require('./errors');

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

// ---------- input ----------

function parseReserveRequest(body, idempotencyKeyHeader) {
  const seats = body?.seats;
  const idempotencyKey = idempotencyKeyHeader || body?.idempotency_key;

  if (!Array.isArray(seats) || seats.length === 0) {
    throw new HttpError(400, 'invalid_seats', 'seats must be a non-empty list');
  }
  if (!seats.every((seat) => typeof seat === 'string' && seat !== '')) {
    throw new HttpError(400, 'invalid_seats', 'every seat id must be a non-empty string');
  }
  if (new Set(seats).size !== seats.length) {
    throw new HttpError(400, 'invalid_seats', 'the same seat is listed twice');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '' ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new HttpError(400, 'invalid_idempotency_key',
      'an idempotency key is required (Idempotency-Key header or idempotency_key in the body)');
  }

  // Sorted so ["A2","A1"] and ["A1","A2"] count as the same request.
  return { seats: [...seats].sort(), idempotencyKey };
}

// ---------- reserve ----------

// Reserves all requested seats for the user, or none of them (all-or-nothing).
// Returns { reservation, replayed }. Throws Decline (409) for a clean "no".
async function reserveSeats({ showId, userId, seats, idempotencyKey }) {
  const show = await findShow(showId);

  // A retry of a request we already completed: answer from what we stored.
  const previous = await findByIdempotencyKey(userId, idempotencyKey);
  if (previous) return replayPrevious(previous, show.id, seats);

  try {
    const reservation = await claimSeats(show, userId, seats, idempotencyKey);
    return { reservation, replayed: false };
  } catch (err) {
    // We may have lost a race against a retry of this very request (same key
    // sent twice in parallel). If that copy won, return its result instead of
    // a decline, so every retry sees the same answer.
    const lostToSameKey = err instanceof Decline || err.constraint === 'reservations_user_key_unique';
    if (lostToSameKey) {
      const winner = await findByIdempotencyKey(userId, idempotencyKey);
      if (winner) return replayPrevious(winner, show.id, seats);
    }
    throw err;
  }
}

async function claimSeats(show, userId, seats, idempotencyKey) {
  if (seats.length > show.per_user_limit) {
    throw new Decline('per_user_limit', `you can hold at most ${show.per_user_limit} seats for this show`);
  }

  // Cheap check without locks so a stampede on a sold seat is turned away
  // fast. It only ever says "no" — the real "yes" is decided in the
  // transaction below.
  await rejectIfAlreadyTaken(show.id, seats);

  return db.withTransaction(async (client) => {
    // Step 1 — idempotency. Insert the reservation row first. The unique
    // (user_id, idempotency_key) constraint makes a parallel request with the
    // same key wait here and then fail once we commit, so a key wins only once.
    // If anything below declines, the transaction rolls back and this row
    // disappears with it.
    const { rows: [reservation] } = await client.query(
      `INSERT INTO reservations (show_id, user_id, seats, amount_paise, status, idempotency_key)
       VALUES ($1, $2, $3, $4, 'confirmed', $5)
       RETURNING *`,
      [show.id, userId, seats, show.price_paise * seats.length, idempotencyKey],
    );

    // Step 2 — per-user limit, checked and applied in ONE statement.
    // The upsert locks this user's quota row, so 10 parallel requests from
    // the same user line up here one by one. The WHERE makes the increment
    // happen only if it stays within the limit; no row back = over limit.
    const quota = await client.query(
      `INSERT INTO user_show_quota (show_id, user_id, seats_held)
       VALUES ($1, $2, $3)
       ON CONFLICT (show_id, user_id) DO UPDATE
         SET seats_held = user_show_quota.seats_held + EXCLUDED.seats_held
         WHERE user_show_quota.seats_held + EXCLUDED.seats_held <= $4
       RETURNING seats_held`,
      [show.id, userId, seats.length, show.per_user_limit],
    );
    if (quota.rowCount === 0) {
      throw new Decline('per_user_limit', `you can hold at most ${show.per_user_limit} seats for this show`);
    }

    // Step 3 — lock the seat rows, always in seat_no order. Every request
    // locks in the same order, so two multi-seat requests can never end up
    // waiting on each other in a circle (no deadlock). Anyone else wanting
    // these seats now waits until we commit or roll back.
    const { rows: lockedSeats } = await client.query(
      `SELECT seat_no, status FROM seats
       WHERE show_id = $1 AND seat_no = ANY($2)
       ORDER BY seat_no
       FOR UPDATE`,
      [show.id, seats],
    );
    const unavailable = lockedSeats.filter((seat) => seat.status !== 'available').map((seat) => seat.seat_no);
    if (unavailable.length > 0) {
      throw new Decline('seat_taken', 'one or more seats are already taken', { unavailable_seats: unavailable });
    }

    // Step 4 — take the seats. We hold the locks and saw them available, so
    // this updates every row; the status guard is a second line of defence.
    const update = await client.query(
      `UPDATE seats
       SET status = 'confirmed', reservation_id = $3, user_id = $4, updated_at = now()
       WHERE show_id = $1 AND seat_no = ANY($2) AND status = 'available'`,
      [show.id, seats, reservation.id, userId],
    );
    if (update.rowCount !== seats.length) {
      throw new Decline('seat_taken', 'one or more seats are already taken');
    }

    return reservation;
  });
}

async function rejectIfAlreadyTaken(showId, seats) {
  const { rows } = await db.pool.query(
    'SELECT seat_no, status FROM seats WHERE show_id = $1 AND seat_no = ANY($2)',
    [showId, seats],
  );

  if (rows.length !== seats.length) {
    const known = new Set(rows.map((row) => row.seat_no));
    throw new HttpError(400, 'unknown_seats', 'some seats do not exist in this show', {
      unknown_seats: seats.filter((seat) => !known.has(seat)),
    });
  }

  const taken = rows.filter((row) => row.status !== 'available').map((row) => row.seat_no);
  if (taken.length > 0) {
    throw new Decline('seat_taken', 'one or more seats are already taken', { unavailable_seats: taken });
  }
}

async function findByIdempotencyKey(userId, idempotencyKey) {
  const { rows } = await db.pool.query(
    'SELECT * FROM reservations WHERE user_id = $1 AND idempotency_key = $2',
    [userId, idempotencyKey],
  );
  return rows[0] || null;
}

// Same key + same request  -> return the original reservation.
// Same key + different one -> 409, never a second reservation.
function replayPrevious(previous, showId, seats) {
  const sameRequest = previous.show_id === showId && previous.seats.join(',') === seats.join(',');
  if (!sameRequest) {
    throw new Decline('idempotency_key_reused',
      'this idempotency key was already used for a different request',
      { reservation_id: previous.id });
  }
  return { reservation: previous, replayed: true };
}

// ---------- cancel ----------

// Only the owner can cancel. Cancelling twice is a harmless no-op.
// Returns { reservation, alreadyCancelled }.
async function cancelReservation({ reservationId, userId }) {
  if (!isUuid(reservationId)) {
    throw new HttpError(404, 'reservation_not_found', 'reservation not found');
  }

  return db.withTransaction(async (client) => {
    const { rows: [reservation] } = await client.query(
      'SELECT * FROM reservations WHERE id = $1 FOR UPDATE',
      [reservationId],
    );
    if (!reservation) {
      throw new HttpError(404, 'reservation_not_found', 'reservation not found');
    }
    if (reservation.user_id !== userId) {
      throw new HttpError(403, 'forbidden', 'you can only cancel your own reservations');
    }
    if (reservation.status === 'cancelled') {
      return { reservation, alreadyCancelled: true };
    }

    // Same lock order as reserve (quota, then seats by seat_no) so a cancel
    // and a reserve can't deadlock each other.
    await client.query(
      `UPDATE user_show_quota SET seats_held = seats_held - $3
       WHERE show_id = $1 AND user_id = $2`,
      [reservation.show_id, reservation.user_id, reservation.seats.length],
    );
    await client.query(
      'SELECT seat_no FROM seats WHERE reservation_id = $1 ORDER BY seat_no FOR UPDATE',
      [reservation.id],
    );

    // Only seats still pointing at THIS reservation are released, so a cancel
    // can never free a seat that now belongs to someone else.
    await client.query(
      `UPDATE seats
       SET status = 'available', reservation_id = NULL, user_id = NULL, updated_at = now()
       WHERE reservation_id = $1`,
      [reservation.id],
    );

    const { rows: [cancelled] } = await client.query(
      `UPDATE reservations SET status = 'cancelled', cancelled_at = now()
       WHERE id = $1
       RETURNING *`,
      [reservation.id],
    );
    return { reservation: cancelled, alreadyCancelled: false };
  });
}

// ---------- output ----------

function toResponse(reservation) {
  return {
    reservation_id: reservation.id,
    show_id: reservation.show_id,
    user_id: reservation.user_id,
    seats: reservation.seats,
    amount_paise: reservation.amount_paise,
    status: reservation.status,
  };
}

module.exports = { parseReserveRequest, reserveSeats, cancelReservation, toResponse };
