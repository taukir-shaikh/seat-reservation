# Write-up

## 1. The atomic decision

All of it lives in one Postgres transaction in [src/reservations.js](src/reservations.js) (`claimSeats`). Every reserve request goes through four steps, always in this order:

| Step | Statement | What it guarantees |
|---|---|---|
| 1 | `INSERT INTO reservations (..., idempotency_key)` | `UNIQUE (user_id, idempotency_key)`: a key can win only once |
| 2 | `INSERT INTO user_show_quota ... ON CONFLICT DO UPDATE SET seats_held = seats_held + n WHERE seats_held + n <= limit` | per-user limit, checked and applied in one statement |
| 3 | `SELECT ... FROM seats WHERE seat_no = ANY($seats) ORDER BY seat_no FOR UPDATE` | the seat rows are locked, in a fixed order |
| 4 | `UPDATE seats SET status='confirmed' ... WHERE ... AND status='available'` | take the seats |

If any step says no, the whole transaction rolls back, so nothing is half-done: no stray reservation row, no quota bump, no seat change.

**Why there is no double-sell (step 3).** `SELECT ... FOR UPDATE` takes a row lock on each seat. When 500 requests want A12, one of them gets the lock and the other 499 wait on that row. Under Postgres's default READ COMMITTED isolation, a waiter that finally gets the lock re-reads the latest committed version of the row, not the stale one it started with. So each loser sees `status = 'confirmed'` and gets a clean `409 seat_taken`. There is no window between "is it free?" and "take it", because the check happens while we hold the lock.

The extra `AND status = 'available'` on the update in step 4, plus a `CHECK` that a confirmed seat always has a `reservation_id`, are a second line of defence. They are not the mechanism.

**Why there is no deadlock on multi-seat requests.**

- **Seats are locked in `seat_no` order.** If two requests both want A12 and A13, both lock A12 first. One waits for the other; neither holds A13 while waiting for A12.
- **Every transaction takes locks in the same order: reservation row → quota row → seat rows (sorted).** Cancel uses this order too, so a cancel and a reserve can't form a cycle.

The burst runs 30% two-seat requests and shows zero deadlocks / 5xx.

**Why the per-user limit holds under concurrency (step 2).** The upsert locks that user's quota row. So 10 parallel requests from one user queue up on it one at a time. Each one checks `seats_held + n <= limit` and increments in the same statement, and if the check fails no row comes back. The burst's greedy user fires 10 parallel single-seat reserves on a limit-4 show and ends with exactly 4.

**The lock-free pre-check.** Before the transaction there is a plain `SELECT` that rejects requests whose seats are already taken. Its job is to keep the 499 losers of a hot-seat storm from queueing on the row lock, which keeps latency flat. It can only ever say **no**; every **yes** goes through the locked path. A stale "no" can only happen if a seat was released a millisecond earlier, and that is a harmless decline.

**Partial requests are all-or-nothing.** If you ask for A12 and A13 and A13 is taken, you get `409 seat_taken` with `unavailable_seats: ["A13"]`, and A12 stays free. This holds under concurrency because both seats are locked together in step 3 and taken in one update.

## 2. Idempotency

**Where the key is stored.** The key lives on the reservation row itself, with `UNIQUE (user_id, idempotency_key)`. Keys are scoped per user, so one user can't collide with or probe another user's keys.

**How exactly-once is enforced.** The key is inserted in step 1 of the same transaction that takes the seats. The reservation, the key and the seat changes therefore commit together or not at all.

**Retry after success.** We look the key up first and return the stored reservation with **200** and `Idempotent-Replayed: true`. The retry gets 200, not 201, so it can't be mistaken for a second sale: each hot seat still shows exactly one 201.

**Two copies of the same request in parallel.**

1. The second copy's `INSERT` waits on the unique index until the first copy commits.
2. Then it fails with a unique violation.
3. We catch that, read the winner's row, and return it as a replay.

If the second copy instead lost a seat or limit race against its own twin, we check the key again before answering, so it still gets the replay rather than a decline.

**Same key, different body.** The stored `show_id` and sorted `seats` are compared with the new request. If they differ, the answer is `409 idempotency_key_reused`, and no second reservation is ever made.

**Declines are not stored.** A request that got `409 seat_taken` and is retried with the same key is evaluated again. I think this is the more useful behaviour: the seat may have been released since. It still can't create more than one reservation per key.

## 3. Holds & expiry

I chose the **explicit cancel** model: `POST /reservations/{id}/cancel`.

- **Reserve confirms immediately.** The task's success response is `status: "confirmed"` and there is no payment step. So `held` exists in the API counts but is always 0.
- **Only the owner can cancel.** The owner check uses the token's user; anyone else gets 403. Cancelling twice is a no-op.
- **A cancel can't resurrect someone else's seat.** It releases only the seat rows whose `reservation_id` is this reservation:

  ```sql
  UPDATE seats SET status = 'available' ... WHERE reservation_id = $1
  ```

  If a seat had somehow moved to another reservation, it simply wouldn't match. The cancel also gives the user's quota back, and the seat is immediately re-bookable. The burst script checks this end to end.

If I added a real payment step, I would make reserve create `held` seats with a `held_until`. Then:

- Confirm would be a guarded update: `WHERE status = 'held' AND reservation_id = $1 AND held_until > now()`.
- Expiry would be a periodic `UPDATE ... SET status = 'available' WHERE status = 'held' AND held_until < now()`.

Because both are guarded on current state, a late confirm and the expiry job can't both win.

## 4. Consistency vs availability under a partition

This service chooses **consistency**. There is one Postgres primary and it is the only source of truth: no cache or replica is ever used to decide a sale.

**If the app can't reach the database:**

- `/health/ready` returns 503 within 2 seconds.
- The platform stops routing traffic to the instance.
- Reserve calls fail instead of guessing.

Turning buyers away for a few seconds is much cheaper than selling A12 twice and having to un-sell it.

**If a commit succeeds but the response is lost** (e.g. the client's connection drops), the client doesn't know whether it got the seat. That is exactly what the idempotency key is for: retrying with the same key returns the original reservation instead of booking again.

## 5. Observability — what would page me at 2am

**Page:**

- **Any sustained 5xx on `/shows/:id/reserve`**, from `http_request_duration_seconds_count{status=~"5.."}`. Declines are 409s by design, so a 5xx always means something is actually broken.
- **Readiness failing / no healthy instance.** Nobody can buy.
- **Reconciliation drift.** `seats_available + seats_confirmed` for a show differs from its seat count, or `seats_confirmed` drops without a matching rise in `reservations_cancelled_total`. Either would mean seats are disappearing or being resurrected, which should be impossible. This would be the scariest page.
- **p99 latency on reserve above a few seconds during an on-sale.** Usually DB lock queueing or pool exhaustion.

**Don't page (dashboard only):**

- spikes in `reservations_declined_total{reason="seat_taken"}`: that is the system working during a popular on-sale
- `idempotent_replay` / `per_user_limit` rates: good for spotting a misbehaving client or a bot

Every log line has a `reqId`, so a buyer's complaint ("I got an error at 10:00:03") can be traced to the exact request and its `reservation_declined` / `reservation_confirmed` event.

## 6. AI usage

I used Claude Code (Claude Opus, inside VS Code) for most of this. To be specific about who did what:

**What I directed / decided:**

- **The constraints.** I gave it the brief and set three rules:
  - keep the code plain and readable, so I can explain and extend it myself in the interview (no ORM, no Redis, no extra layers)
  - don't over-engineer
  - the tool never pushes to GitHub; I handle the repo and the deploy
- **The database.** My default would have been MySQL, since that's what I use every day with Laravel. I asked for a comparison before any code was written, and accepted Postgres for three reasons:
  - better free hosting for a round that grades the deploy
  - `INSERT ... ON CONFLICT DO UPDATE ... WHERE` makes the per-user limit a single atomic statement
  - MySQL's REPEATABLE READ gap locks would make deadlocks (and so 5xx) more likely under a burst
- **The deploy.** I chose not to link my GitHub account to Render. So instead of the blueprint I created the Postgres and the web service by hand from the public repo URL.
- **What I did myself:**
  - created the GitHub repo and pushed the commits
  - set up Render and set the env vars
  - ran the burst locally, in `docker compose` and against the live URL
  - recorded the live logs

**What the AI did:**

- **Wrote the code, the burst script, the README and this write-up.**
- **Proposed the core design**, which I reviewed and kept:
  - the four-step transaction and its lock order (reservation → quota → seats sorted by `seat_no`)
  - the per-user limit as one guarded upsert
  - the lock-free pre-check that can only say "no"
  - returning 200 rather than 201 for idempotent replays
  - the explicit-cancel model instead of expiring holds
- **Walked me through the Render setup** step by step. It also caught that I had picked a paid database plan by mistake.
- **Explained the design back to me.** After the build I had it walk through the request flow and the burst output with me, so the reasoning in this document is something I can defend, not just something I was handed.

**How it was verified:**

- The burst script checks every rule in the brief. It was run with 20,000 requests against a local process and against the `docker compose` stack, and with 2,000 requests against the live Render service. All checks passed with zero 5xx each time.
- Readiness was tested by stopping and by freezing the database container.

**Things that changed because of that testing:**

- The decline-reason metrics didn't appear until first used, so they are now pre-initialised to 0.
- Request logs were dumping every header, so they are now slimmed down and tokens are never logged.
- A frozen DB made readiness hang, so it now times out after 2 s.
- Opening the bare live URL returned a 404, so `/` now lists the endpoints.

## 7. What I'd do next

- **Holds with expiry + a confirm/payment step**, as described in section 3.
- **Automated tests in CI:**
  - a concurrency test that runs the burst against a throwaway Postgres on every push
  - unit tests for input validation
- **Clean overload handling.** Put a bounded wait on the DB pool and return `503 + Retry-After` when it's exceeded, instead of letting requests queue without limit.
- **Multiple instances.** Metric counters are per process today. With more than one instance I'd sum them in Prometheus, and add PgBouncer in front of Postgres.
- **Per-user rate limiting** on reserve, to blunt bots during an on-sale.
- **Real auth (OIDC) and real admin roles** instead of the demo token endpoint and shared admin key.
