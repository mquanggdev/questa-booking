// On-sale (phase 7b): the moment a 10,000-ticket night opens. Every buyer
// arrives before the opening and joins the virtual waiting room; the worker
// admits WAITING_ROOM_ADMIT_PER_TICK per tick from the opening on; each
// admitted buyer holds 1-4 tickets (a block of neighbouring seats, or
// standing tickets), trying another block when seats are already taken.
//
// A few buyers (BYPASS_SHARE) never queue and try to hold right away: every
// one of them must be refused while the waiting room is on.
//
// With the waiting room off (run.mjs --queue off) the same buyers all hold
// at the opening instant: the comparison shows what the line protects.
//
//   pnpm loadtest on-sale                   (VUS=2000, ITERS=2 by default)
//   pnpm loadtest on-sale --queue off
//
// Buyers poll GET /queue/me every POLL seconds (--poll N, default 2). The
// web app listens on the /queue WebSocket instead; polling is the heavier,
// worst case for the API.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { API, authHeaders, summaryTo, userForIteration } from '../lib/common.js';

const VUS = Number(__ENV.VUS || 2000);
const ITERS = Number(__ENV.ITERS || 2);
const OPENS_AT = Number(__ENV.OPENS_AT || Date.now());
const POLL_S = Number(__ENV.POLL || 2);
const BYPASS_SHARE = Number(__ENV.BYPASS_SHARE || 0.05);

const night = JSON.parse(open('/load-tests/data/on-sale.json'));
const seatIds = new SharedArray('on-sale seats', () => night.seatIds);
const standing = night.zones.find((z) => z.type === 'STANDING');

const queueWait = new Trend('queue_wait', true);
const admitted = new Counter('queue_admitted');
const neverAdmitted = new Counter('queue_never_admitted');
const held = new Counter('reservations_held');
const ticketsHeld = new Counter('tickets_held');
const conflicts = new Counter('reservations_conflict');
const gaveUp = new Counter('buyers_gave_up');
const serverErrors = new Counter('reservations_5xx');
const passRefused = new Counter('admitted_but_refused');
const bypassRefused = new Counter('bypass_refused');
const bypassAccepted = new Counter('bypass_accepted');

export const options = {
  scenarios: {
    'on-sale': {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERS,
      maxDuration: '10m',
    },
  },
  // Sub-metrics, so the summary has the hold latency on its own (the
  // polling requests would otherwise dominate http_req_duration).
  thresholds: {
    'http_req_duration{name:POST /reservations}': ['max>=0'],
    'http_req_duration{name:GET /queue/me}': ['max>=0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const perf = night.performanceId;
const random = (n) => Math.floor(Math.random() * n);

function hold(token, body) {
  const res = http.post(
    `${API}/reservations`,
    JSON.stringify({ performanceId: perf, ...body }),
    { ...authHeaders(token), tags: { name: 'POST /reservations' } },
  );
  if (res.status >= 500) serverErrors.add(1);
  return res;
}

/** A block of `quantity` neighbouring seats starting at a random seat. */
function seatBlock(quantity) {
  const start = random(seatIds.length - quantity);
  const block = [];
  for (let i = 0; i < quantity; i++) block.push(seatIds[start + i]);
  return block;
}

function waitUntilOpen() {
  const ms = OPENS_AT - Date.now();
  if (ms > 0) sleep(ms / 1000);
}

/** Joins the line and polls until admitted. False if it never happens. */
function queue(token) {
  const joined = http.post(`${API}/performances/${perf}/queue`, null, {
    ...authHeaders(token),
    tags: { name: 'POST /queue' },
  });
  if (joined.status === 409 && joined.json('code') === 'WAITING_ROOM_DISABLED') {
    waitUntilOpen(); // --queue off: everyone rushes in at the opening
    return true;
  }
  if (joined.status !== 200) return false;
  const started = Date.now();
  let status = joined.json('status');
  while (status !== 'ADMITTED') {
    if (Date.now() - started > 8 * 60 * 1000) return false;
    sleep(POLL_S * (0.5 + Math.random())); // jitter: no synchronized waves
    const me = http.get(`${API}/performances/${perf}/queue/me`, {
      ...authHeaders(token),
      tags: { name: 'GET /queue/me' },
    });
    status = me.status === 200 ? me.json('status') : status;
  }
  // Waiting counted from the opening: queueing before it is free.
  queueWait.add(Date.now() - Math.max(started, OPENS_AT));
  return true;
}

function bypass(token) {
  waitUntilOpen();
  const res = hold(token, { seatIds: seatBlock(1) });
  if (res.status === 403 && res.json('code') === 'QUEUE_PASS_REQUIRED') bypassRefused.add(1);
  else if (res.status === 201) bypassAccepted.add(1);
}

export default function () {
  const user = userForIteration();
  // The second iteration of every VU arrives later, like latecomers.
  if (exec.vu.iterationInScenario === 0 && Math.random() < BYPASS_SHARE) {
    bypass(user.token);
    return;
  }
  if (!queue(user.token)) {
    neverAdmitted.add(1);
    return;
  }
  admitted.add(1);

  const quantity = 1 + random(4);
  if (Math.random() < 0.2) {
    const res = hold(user.token, { standing: [{ zoneId: standing.id, quantity }] });
    record(res, quantity);
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = hold(user.token, { seatIds: seatBlock(quantity) });
    if (record(res, quantity) !== 'retry') return;
    sleep(0.2 + Math.random() * 0.3); // a person picking other seats
  }
  gaveUp.add(1);
}

/** Counts one hold attempt; 'retry' when those seats were taken. */
function record(res, quantity) {
  if (res.status === 201) {
    held.add(1);
    ticketsHeld.add(quantity);
    return 'done';
  }
  if (res.status === 403 && res.json('code') === 'QUEUE_PASS_REQUIRED') {
    passRefused.add(1); // admitted, yet refused: must never happen
    return 'done';
  }
  check(res, { 'held (201) or taken (409)': (r) => r.status === 201 || r.status === 409 });
  if (res.status === 409) {
    conflicts.add(1);
    return res.json('code') === 'SEAT_UNAVAILABLE' ? 'retry' : 'done';
  }
  return 'done';
}

export const handleSummary = summaryTo('on-sale');
