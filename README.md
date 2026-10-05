# Seat Reservation at Scale

A small JSON API that sells assigned seats for a show and stays correct when thousands of buyers hit "book" in the same second: no seat sold twice, no user over their limit, no retry booked twice.

Node.js 22 · Express 5 · PostgreSQL 16 · prom-client · pino

- **Live URL:** `<add after deploy>`
- **Metrics:** `<live URL>/metrics`
- **Design write-up:** [WRITEUP.md](WRITEUP.md)

## Run it locally

```bash
docker compose up --build
# API on http://localhost:3000, admin key: dev-admin-key
```

Without Docker for the app (still needs a Postgres). The defaults already point to `postgres://postgres:postgres@localhost:5432/seats`, so with a local Postgres like the one below no config is needed:

```bash
docker run -d --name seats-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=seats -p 5432:5432 postgres:16-alpine
npm install
npm start
```

To point at another database, set the env vars from [.env.example](.env.example) (e.g. `DATABASE_URL`) in your shell before `npm start`.

## Burst test (one command)

```bash
./burst.sh <BASE_URL>                 # or: npm run burst -- <BASE_URL>

# against the deployed service
ADMIN_KEY=<admin key> ./burst.sh https://<your-service>.onrender.com
```

It creates a fresh 500-seat show and fires ~20,000 reserve calls (500 in flight at a time). The calls include:

- a **hot-seat storm**: 500 different buyers on each of 5 seats (A1–A5)
- one **greedy user** firing 10 parallel reserves on a limit-4 show
- **retries** with the same idempotency key and same body
- **key reuse**: the same key with different seats
- **spoofed** `user_id` in the body
- normal 1- and 2-seat bookings across the hall

It polls `GET /shows/{id}` the whole time and then prints:

- the outcome distribution (confirmed / declined by reason / 5xx)
- PASS/FAIL for every correctness rule
- the final reconciliation of API state against the responses and against `/metrics`
- a cancel round-trip: a stranger gets 403, the owner can cancel, and the seat can be booked again

The exit code is non-zero if any check fails. You can tune it with env vars: `REQUESTS`, `USERS`, `SEATS`, `HOT_SEATS`, `STORM`, `CONCURRENCY` (see the top of [scripts/burst.js](scripts/burst.js)).

Sample run against `docker compose` on a laptop:

```
Done in 22.2s (900 req/s)

Outcomes:
    19498  409 seat_taken
      429  201 confirmed
       63  409 idempotency_key_reused
        6  409 per_user_limit
        4  200 idempotent replay

Checks:
  PASS  zero 5xx  (0 x 5xx)
  PASS  hot seat A1: exactly one winner  (1 x 201)
  ...
  PASS  per-user limit (4) holds  (greedy user got 4 of 10)
  PASS  identity comes from the token, not the body  (0 spoofed)
  PASS  invariant held during the burst  (54 polls, 0 broken)
  PASS  confirmed seats == seats in the reservations we got back  (494 vs 494)
  PASS  reservations_confirmed_total matches responses  (metric +429, observed 429)
  ...
ALL CHECKS PASSED
```

## API

All bodies are JSON. Money is always integer paise.

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/auth/token` | — | `{ "user_id": "alice" }` → `{ token }` (demo login, see below) |
| POST | `/shows` | `x-admin-key` header | create a show |
| GET | `/shows/{id}` | — | per-seat status + counts |
| POST | `/shows/{id}/reserve` | Bearer token | reserve seats |
| POST | `/reservations/{id}/cancel` | Bearer token | cancel your own reservation |
| GET | `/health/live` | — | process is up |
| GET | `/health/ready` | — | DB reachable (503 if not) |
| GET | `/metrics` | — | Prometheus metrics |

### Create a show

```bash
curl -X POST $URL/shows -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"name":"friday-night","seats":["A1","A2","A3"],"price_paise":25000,"per_user_limit":4}'
```

`per_user_limit` is optional (default 4). The response is the same shape as `GET /shows/{id}`.

### Reserve

```bash
TOKEN=$(curl -s -X POST $URL/auth/token -H "content-type: application/json" -d '{"user_id":"alice"}' | jq -r .token)

curl -X POST $URL/shows/$SHOW_ID/reserve -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -H "Idempotency-Key: 7f3c..." \
  -d '{"seats":["A12","A13"]}'
```

The idempotency key can go in the `Idempotency-Key` header or as `idempotency_key` in the body.

| Status | When |
|---|---|
| 201 | new reservation, `status: "confirmed"` |
| 200 | replay of an earlier request with the same key and body (header `Idempotent-Replayed: true`) |
| 409 `seat_taken` | at least one seat is already taken (`unavailable_seats` lists them) |
| 409 `per_user_limit` | this would put you over the show's limit |
| 409 `idempotency_key_reused` | same key, different seats or show |
| 400 | bad input, unknown seats (`unknown_seats`), missing key |
| 401 / 404 | no or invalid token / unknown show |

**Multi-seat requests are all-or-nothing:** you get every seat you asked for, or none of them.

### Show state

```json
{
  "id": "…", "name": "friday-night", "price_paise": 25000, "per_user_limit": 4,
  "total_seats": 3,
  "counts": { "available": 2, "held": 0, "confirmed": 1 },
  "invariant_ok": true,
  "seats": [{ "seat": "A1", "status": "confirmed" }, …]
}
```

A reservation is confirmed straight away (no separate payment step), so `held` is always 0 in this design. See [WRITEUP.md](WRITEUP.md#holds--expiry).

### Auth

`POST /auth/token` is a stand-in for a real login: there is no user store, so it hands out a signed JWT for any `user_id`. The part that matters is what happens after that. Every request takes the user **only** from the token. A `user_id` in the request body is never read, and only the owner can cancel a reservation.

## Observability

**Metrics** (`/metrics`):

| Metric | Type | Meaning |
|---|---|---|
| `reservations_confirmed_total` | counter | new reservations (201s) |
| `reservations_declined_total{reason}` | counter | `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_key_reused` |
| `reservations_cancelled_total` | counter | owner cancellations |
| `seats_available{show_id}` | gauge | read live from the DB on each scrape |
| `seats_confirmed{show_id}` | gauge | read live from the DB on each scrape |
| `http_request_duration_seconds{method,route,status}` | histogram | latency; `_count` gives requests per status, so 5xx is visible |

The seat gauges are queried from the database at scrape time, so they always match `GET /shows/{id}`. The counters live in process memory. They are exact for the single instance we run, and they reset on restart.

**Logs:** JSON lines on stdout (pino).

- Every request gets an `x-request-id`. The caller's value is reused if they send one, and it is always returned in the response header.
- Every log line for that request carries the id as `reqId`.
- Domain events are logged with an `event` field: `reservation_confirmed`, `reservation_declined` (with `reason`), `reservation_replayed`, `reservation_cancelled`, `show_created`.
- Tokens and the admin key are never logged.

On Render, logs are under the service's **Logs** tab.

## Deploy (Render, free tier)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → pick the repo. [render.yaml](render.yaml) creates the web service (built from the Dockerfile) and a Postgres database, and generates `JWT_SECRET` and `ADMIN_KEY`.
3. Render uses `/health/ready` as its health check, so a deploy only goes live once the DB is reachable.

On boot the service starts listening right away (liveness OK), creates the schema (retrying until the DB is up), and only then reports ready.

Notes:

- The free web service sleeps when idle. The first request after a sleep takes about a minute while it cold-starts.
- The free Postgres expires after 30 days.

### Environment

| Var | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/seats` | |
| `DB_SSL` | `false` | `true` for hosted Postgres that needs TLS |
| `DB_POOL_MAX` | `20` | |
| `JWT_SECRET` | `dev-secret` | **set in production** |
| `ADMIN_KEY` | `dev-admin-key` | **set in production** |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | |

## Project layout

```
src/
  server.js        boot, schema migration with retry, graceful shutdown
  app.js           routes, request logging, error handling
  reservations.js  reserve + cancel — the atomic decision lives here
  shows.js         create show, show state
  auth.js          JWT tokens, admin key
  metrics.js       Prometheus counters/gauges
  db.js            pg pool, transaction helper
  schema.sql       tables and constraints
scripts/burst.js   the stampede + correctness checks
```
