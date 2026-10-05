// Quota: a few accounts each fire many purchases in parallel, one standing
// ticket per request. However the requests interleave, no account may end up
// with more active tickets than the performance allows (invariant I10).
//
//   node load-tests/run.mjs quota               (500 VU x 2 iterations, 20 accounts)
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { API, authHeaders, fixtures, summaryTo, users } from '../lib/common.js';

const VUS = Number(__ENV.VUS || 500);
const ITERS = Number(__ENV.ITERS || 2);
const ACCOUNTS = Number(__ENV.ACCOUNTS || 20);
const zone = fixtures.zones.find((z) => z.type === 'STANDING');

const held = new Counter('reservations_held');
const conflicts = new Counter('reservations_conflict');
const serverErrors = new Counter('reservations_5xx');

export const options = {
  scenarios: {
    quota: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERS,
      maxDuration: '5m',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  // Requests are spread round-robin over a handful of accounts, so each
  // account sends dozens of requests at the same moment.
  const user = users[exec.scenario.iterationInTest % ACCOUNTS];
  const res = http.post(
    `${API}/reservations`,
    JSON.stringify({
      performanceId: fixtures.loadTestPerformanceId,
      standing: [{ zoneId: zone.id, quantity: 1 }],
    }),
    { ...authHeaders(user.token), tags: { name: 'POST /reservations' } },
  );
  if (res.status === 201) held.add(1);
  else if (res.status === 409) conflicts.add(1);
  else if (res.status >= 500) serverErrors.add(1);
  check(res, { 'held (201) or limit reached (409)': (r) => r.status === 201 || r.status === 409 });
}

export const handleSummary = summaryTo('quota');
