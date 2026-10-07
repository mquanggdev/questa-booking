// Check-in: the same tickets scanned at many gates at once. setup() buys
// TICKETS tickets through the real flow; then every VU iteration scans one of
// them, so each code is scanned VUS x ITERS / TICKETS times concurrently.
// A correct system accepts each ticket exactly once (I6).
//
//   pnpm loadtest check-in             (VUS=1000, ITERS=5, TICKETS=100)
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { API, authHeaders, fixtures, summaryTo, users } from '../lib/common.js';
import { standingZone } from '../lib/payments.js';

const VUS = Number(__ENV.VUS || 1000);
const ITERS = Number(__ENV.ITERS || 5);
const TICKETS = Number(__ENV.TICKETS || 100);

const accepted = new Counter('checkins_accepted');
const rejected = new Counter('checkins_already_used');
const other = new Counter('checkins_unexpected');

// 4xx answers (sold out, already used, 04/97 are 200 anyway) are part of
// the scenario; only 5xx and network errors count as failed requests.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export const options = {
  setupTimeout: '5m',
  scenarios: {
    'check-in': {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERS,
      maxDuration: '5m',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

/**
 * Buys TICKETS tickets through the real flow, each step for all buyers at
 * once (http.batch), so setup takes a second or two and barely dilutes the
 * request rate of the scan phase.
 */
export function setup() {
  // Buyers from the end of the list; the scan phase uses only the staff token.
  const buyers = Array.from({ length: TICKETS }, (_, i) => users[users.length - 1 - i]);
  const batch = (make) => http.batch(buyers.map(make));
  const json = { 'Content-Type': 'application/json' };

  const holds = batch((b) => [
    'POST',
    `${API}/reservations`,
    JSON.stringify({
      performanceId: fixtures.loadTestPerformanceId,
      standing: [{ zoneId: standingZone.id, quantity: 1 }],
    }),
    authHeaders(b.token),
  ]);
  const orderIds = holds.map((r, i) => {
    if (r.status !== 201) exec.test.abort(`setup: hold ${i} answered ${r.status}`);
    return r.json('id');
  });
  const pays = batch((b, i) => [
    'POST',
    `${API}/orders/${orderIds[i]}/pay`,
    JSON.stringify({ provider: 'fake' }),
    authHeaders(b.token),
  ]);
  const completes = http.batch(
    pays.map((r) => [
      'POST',
      `${API}/payments/fake/complete`,
      JSON.stringify({ txnRef: r.json('checkoutUrl').split('txnRef=')[1], outcome: 'success' }),
      { headers: json },
    ]),
  );
  completes.forEach((r, i) => {
    if (r.json('ipn.RspCode') !== '00') exec.test.abort(`setup: payment ${i} not confirmed`);
  });
  const lists = batch((b) => ['GET', `${API}/tickets`, null, authHeaders(b.token)]);
  return { codes: lists.map((r) => r.json()[0].code) };
}

export default function ({ codes }) {
  const code = codes[exec.scenario.iterationInTest % codes.length];
  const res = http.post(`${API}/tickets/check-in`, JSON.stringify({ code }), {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${fixtures.staffToken}`,
    },
    tags: { name: 'POST /tickets/check-in' },
  });
  if (res.status === 200) accepted.add(1);
  else if (res.status === 409 && res.json('code') === 'TICKET_ALREADY_CHECKED_IN') rejected.add(1);
  else other.add(1);
  check(res, { 'accepted (200) or already used (409)': (r) => r.status === 200 || r.status === 409 });
}

export const handleSummary = summaryTo('check-in');
