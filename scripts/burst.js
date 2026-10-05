// On-sale stampede against a running service.
//
//   node scripts/burst.js <BASE_URL>
//
// Env knobs (all optional):
//   ADMIN_KEY     admin key for POST /shows            (default dev-admin-key)
//   REQUESTS      roughly how many reserve calls        (default 20000)
//   USERS         distinct buyers                       (default 3000)
//   SEATS         seats in the hall                     (default 500)
//   HOT_SEATS     seats everyone fights over            (default 5)
//   STORM         buyers per hot seat                   (default 500)
//   CONCURRENCY   requests in flight at once            (default 500)

const BASE_URL = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const REQUESTS = Number(process.env.REQUESTS || 20000);
const USERS = Number(process.env.USERS || 3000);
const SEATS = Number(process.env.SEATS || 500);
const HOT_SEATS = Number(process.env.HOT_SEATS || 5);
const STORM = Number(process.env.STORM || 500);
const CONCURRENCY = Number(process.env.CONCURRENCY || 500);
const PER_USER_LIMIT = 4;

// ---------- small helpers ----------

async function call(method, path, { token, body, headers = {} } = {}) {
  try {
    const res = await fetch(BASE_URL + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token && { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* metrics endpoint is plain text */ }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

// Runs async tasks with at most `limit` running at the same time.
async function runAll(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randomKey = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

async function readCounters() {
  const res = await call('GET', '/metrics');
  const counters = {};
  for (const line of (res.text || '').split('\n')) {
    const match = line.match(/^(reservations_\w+?)(?:\{reason="(\w+)"\})? (\d+)/);
    if (match) counters[match[2] ? `${match[1]}:${match[2]}` : match[1]] = Number(match[3]);
  }
  return counters;
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// ---------- the burst ----------

async function main() {
  console.log(`Target: ${BASE_URL}`);

  const ready = await call('GET', '/health/ready');
  if (ready.status !== 200) {
    console.error('Service is not ready:', ready.status, ready.json || ready.error);
    process.exit(1);
  }

  // 1. A fresh show: rows A, B, C, ... with 25 seats each.
  const seatIds = Array.from({ length: SEATS }, (_, i) => String.fromCharCode(65 + Math.floor(i / 25)) + ((i % 25) + 1));
  const created = await call('POST', '/shows', {
    headers: { 'x-admin-key': ADMIN_KEY },
    body: { name: `burst-${Date.now()}`, seats: seatIds, price_paise: 25000, per_user_limit: PER_USER_LIMIT },
  });
  if (created.status !== 201) {
    console.error('Could not create show:', created.status, created.json);
    process.exit(1);
  }
  const showId = created.json.id;
  console.log(`Show ${showId} with ${SEATS} seats, per-user limit ${PER_USER_LIMIT}`);

  // 2. Tokens for every buyer.
  const userIds = Array.from({ length: USERS }, (_, i) => `buyer-${i}`);
  const tokens = {};
  await runAll(userIds.map((id) => async () => {
    const res = await call('POST', '/auth/token', { body: { user_id: id } });
    tokens[id] = res.json?.token;
  }), 100);
  const greedyUser = 'greedy-user';
  tokens[greedyUser] = (await call('POST', '/auth/token', { body: { user_id: greedyUser } })).json.token;

  // 3. Build the list of requests. Each one remembers what kind it is.
  const hotSeats = seatIds.slice(0, HOT_SEATS);
  const normalSeats = seatIds.slice(HOT_SEATS + 10); // the 10 after the hot ones are for the greedy user
  const requests = [];
  const reserve = (kind, user, seats, key, extraBody = {}) =>
    requests.push({ kind, user, seats, key, body: { seats, idempotency_key: key, ...extraBody } });

  // a) hot-seat storm: STORM different buyers per hot seat
  for (const seat of hotSeats) {
    for (const user of shuffle([...userIds]).slice(0, STORM)) reserve('hot', user, [seat], randomKey());
  }
  // b) one user fires 10 parallel reserves for 10 different free seats
  for (const seat of seatIds.slice(HOT_SEATS, HOT_SEATS + 10)) reserve('greedy', greedyUser, [seat], randomKey());

  // c) everyone else: 1 or 2 random seats. Some carry a spoofed user_id.
  while (requests.length < REQUESTS * 0.85) {
    const seats = Math.random() < 0.3 ? [pick(normalSeats), pick(normalSeats)] : [pick(normalSeats)];
    if (seats[0] === seats[1]) seats.pop();
    const spoof = Math.random() < 0.05 ? { user_id: 'victim' } : {};
    reserve(spoof.user_id ? 'spoof' : 'normal', pick(userIds), seats, randomKey(), spoof);
  }

  // d) retries: resend ~10% of requests with the same key and same body
  for (const original of requests.slice(0, Math.floor(REQUESTS * 0.1))) {
    requests.push({ ...original, kind: 'retry' });
  }
  // e) key reuse: same key, different seats -> must never make a 2nd reservation
  for (const original of requests.slice(0, Math.floor(REQUESTS * 0.05))) {
    const otherSeat = pick(normalSeats.filter((s) => !original.seats.includes(s)));
    requests.push({ ...original, kind: 'key-reuse', seats: [otherSeat], body: { ...original.body, seats: [otherSeat] } });
  }
  shuffle(requests);

  // 4. Fire. Watch the invariant while it runs.
  const before = await readCounters();
  let invariantBroken = 0;
  let polls = 0;
  let firing = true;
  const watcher = (async () => {
    while (firing) {
      const state = await call('GET', `/shows/${showId}`);
      if (state.json) {
        polls++;
        const { available, held, confirmed } = state.json.counts;
        if (available + held + confirmed !== state.json.total_seats) invariantBroken++;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  console.log(`Firing ${requests.length} reserve requests, ${CONCURRENCY} at a time...`);
  const startedAt = Date.now();
  const responses = await runAll(requests.map((req) => () =>
    call('POST', `/shows/${showId}/reserve`, { token: tokens[req.user], body: req.body })), CONCURRENCY);
  const seconds = (Date.now() - startedAt) / 1000;
  firing = false;
  await watcher;

  // 5. Outcome distribution
  const outcomes = {};
  responses.forEach((res) => {
    const label = res.status === 0 ? 'network error'
      : `${res.status} ${res.json?.error || (res.status === 201 ? 'confirmed' : res.status === 200 ? 'idempotent replay' : '')}`;
    outcomes[label] = (outcomes[label] || 0) + 1;
  });
  console.log(`\nDone in ${seconds.toFixed(1)}s (${Math.round(requests.length / seconds)} req/s)\n\nOutcomes:`);
  for (const [label, count] of Object.entries(outcomes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(7)}  ${label}`);
  }

  // 6. Check every rule.
  console.log('\nChecks:');
  const errors5xx = responses.filter((r) => r.status >= 500).length;
  const networkErrors = responses.filter((r) => r.status === 0).length;
  check('zero 5xx', errors5xx === 0, `${errors5xx} x 5xx`);
  check('zero network errors / timeouts', networkErrors === 0, `${networkErrors}`);

  // all distinct reservations we were told about (201 or 200 replay)
  const reservations = new Map();
  responses.forEach((res, i) => {
    if (res.status === 201 || res.status === 200) reservations.set(res.json.reservation_id, { ...res.json, req: requests[i] });
  });

  const new201s = responses.filter((r) => r.status === 201);
  check('every 201 is a different reservation', new201s.length === new Set(new201s.map((r) => r.json.reservation_id)).size);

  // a retry of the winner gets 200 (replay), so counting 201s is exact
  for (const seat of hotSeats) {
    const winners = responses.filter((r) => r.status === 201 && r.json.seats.includes(seat));
    check(`hot seat ${seat}: exactly one winner`, winners.length === 1, `${winners.length} x 201`);
  }

  const seatOwners = new Map();
  for (const r of reservations.values()) {
    for (const seat of r.seats) seatOwners.set(seat, (seatOwners.get(seat) || 0) + 1);
  }
  const doubleSold = [...seatOwners].filter(([, n]) => n > 1);
  check('no seat sold twice', doubleSold.length === 0, doubleSold.map(([s]) => s).join(',') || 'none');

  const reservationsPerKey = new Map();
  for (const r of reservations.values()) {
    const key = `${r.req.user}|${r.req.key}`;
    reservationsPerKey.set(key, (reservationsPerKey.get(key) || 0) + 1);
  }
  // covers retries (same body) and key reuse (different seats) alike
  check('at most one reservation per idempotency key', [...reservationsPerKey.values()].every((n) => n === 1));

  const seatsPerUser = new Map();
  for (const r of reservations.values()) seatsPerUser.set(r.user_id, (seatsPerUser.get(r.user_id) || 0) + r.seats.length);
  const overLimit = [...seatsPerUser].filter(([, n]) => n > PER_USER_LIMIT);
  check(`per-user limit (${PER_USER_LIMIT}) holds`, overLimit.length === 0, `greedy user got ${seatsPerUser.get(greedyUser) || 0} of 10`);

  const spoofed = [...reservations.values()].filter((r) => r.user_id !== r.req.user);
  check('identity comes from the token, not the body', spoofed.length === 0, `${spoofed.length} spoofed`);

  check('invariant held during the burst', invariantBroken === 0, `${polls} polls, ${invariantBroken} broken`);

  // 7. Final reconciliation: API state vs what we observed vs metrics
  const state = (await call('GET', `/shows/${showId}`)).json;
  const soldSeats = [...reservations.values()].reduce((sum, r) => sum + r.seats.length, 0);
  const { available, held, confirmed } = state.counts;
  console.log(`\nFinal state: available=${available} held=${held} confirmed=${confirmed} total=${state.total_seats}`);
  check('available + held + confirmed == total_seats', available + held + confirmed === state.total_seats);
  check('confirmed seats == seats in the reservations we got back', confirmed === soldSeats, `${confirmed} vs ${soldSeats}`);

  const after = await readCounters();
  const delta = (name) => (after[name] || 0) - (before[name] || 0);
  const count = (fn) => responses.filter(fn).length;
  console.log('\nMetrics delta (only exact if nobody else is hitting the service):');
  const metricChecks = [
    ['reservations_confirmed_total', count((r) => r.status === 201)],
    ['reservations_declined_total:seat_taken', count((r) => r.json?.error === 'seat_taken')],
    ['reservations_declined_total:per_user_limit', count((r) => r.json?.error === 'per_user_limit')],
    ['reservations_declined_total:idempotent_replay', count((r) => r.status === 200)],
    ['reservations_declined_total:idempotency_key_reused', count((r) => r.json?.error === 'idempotency_key_reused')],
  ];
  for (const [name, observed] of metricChecks) {
    check(`${name} matches responses`, delta(name) === observed, `metric +${delta(name)}, observed ${observed}`);
  }

  // 8. Cancel: only the owner may cancel, and the seat becomes bookable again.
  console.log('\nCancel:');
  const someReservation = new201s[0].json;
  const owner = someReservation.user_id;
  const stranger = userIds.find((u) => u !== owner);
  const byStranger = await call('POST', `/reservations/${someReservation.reservation_id}/cancel`, { token: tokens[stranger] });
  check("a stranger can't cancel someone else's reservation", byStranger.status === 403, `${byStranger.status}`);
  const byOwner = await call('POST', `/reservations/${someReservation.reservation_id}/cancel`, { token: tokens[owner] });
  check('the owner can cancel', byOwner.status === 200 && byOwner.json.status === 'cancelled');
  const newcomer = (await call('POST', '/auth/token', { body: { user_id: 'newcomer' } })).json.token;
  const rebook = await call('POST', `/shows/${showId}/reserve`, {
    token: newcomer,
    body: { seats: someReservation.seats, idempotency_key: randomKey() },
  });
  check('a released seat can be booked again', rebook.status === 201, `${rebook.status}`);
  const finalState = (await call('GET', `/shows/${showId}`)).json;
  check('invariant still holds after cancel', finalState.invariant_ok);

  const failed = checks.filter((ok) => !ok).length;
  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}  —  show ${showId}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
