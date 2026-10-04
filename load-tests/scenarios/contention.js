// Contention: thousands of customers fight over 100 numbered seats.
// Each iteration is a different customer holding ONE random seat, all
// starting at the same instant. A correct system sells each seat at most
// once (invariant I1); the verify step counts seats sold more than once.
//
//   node load-tests/run.mjs contention          (VUS=1000, ITERS=5 by default)
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { API, authHeaders, fixtures, summaryTo, userForIteration } from '../lib/common.js';

const VUS = Number(__ENV.VUS || 1000);
const ITERS = Number(__ENV.ITERS || 5);

const held = new Counter('reservations_held');
const conflicts = new Counter('reservations_conflict');
const serverErrors = new Counter('reservations_5xx');

export const options = {
  scenarios: {
    contention: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERS,
      maxDuration: '5m',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const user = userForIteration();
  const seatId = fixtures.seatIds[Math.floor(Math.random() * fixtures.seatIds.length)];
  const res = http.post(
    `${API}/reservations`,
    JSON.stringify({ performanceId: fixtures.loadTestPerformanceId, seatIds: [seatId] }),
    { ...authHeaders(user.token), tags: { name: 'POST /reservations' } },
  );
  if (res.status === 201) held.add(1);
  else if (res.status === 409) conflicts.add(1);
  else if (res.status >= 500) serverErrors.add(1);
  check(res, { 'held (201) or taken (409)': (r) => r.status === 201 || r.status === 409 });
}

export const handleSummary = summaryTo('contention');
