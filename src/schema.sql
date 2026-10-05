-- Runs on every boot; everything is IF NOT EXISTS so it is safe to re-run.

CREATE TABLE IF NOT EXISTS shows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text    NOT NULL,
  price_paise    integer NOT NULL CHECK (price_paise >= 0),
  per_user_limit integer NOT NULL CHECK (per_user_limit > 0),
  total_seats    integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per physical seat. The row's status is the single source of truth,
-- so available + held + confirmed == total_seats holds by construction.
CREATE TABLE IF NOT EXISTS seats (
  show_id        uuid    NOT NULL REFERENCES shows(id),
  seat_no        text    NOT NULL,
  position       integer NOT NULL,
  status         text    NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available', 'confirmed')),
  reservation_id uuid,
  user_id        text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (show_id, seat_no),
  -- a confirmed seat always points at its owner, an available one never does
  CHECK ((status = 'available') = (reservation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS seats_reservation_idx ON seats (reservation_id);

CREATE TABLE IF NOT EXISTS reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id         uuid    NOT NULL REFERENCES shows(id),
  user_id         text    NOT NULL,
  seats           text[]  NOT NULL,          -- stored sorted
  amount_paise    bigint  NOT NULL,
  status          text    NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  idempotency_key text    NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz,
  -- exactly-once: a user can only ever create one reservation per key
  CONSTRAINT reservations_user_key_unique UNIQUE (user_id, idempotency_key)
);

-- How many seats each user currently holds for a show. Updated with a
-- guarded upsert so the per-user limit is checked and applied in one step.
CREATE TABLE IF NOT EXISTS user_show_quota (
  show_id    uuid    NOT NULL REFERENCES shows(id),
  user_id    text    NOT NULL,
  seats_held integer NOT NULL CHECK (seats_held >= 0),
  PRIMARY KEY (show_id, user_id)
);
