// Full flow: thousands of customers each try to buy one standing ticket:
// hold -> pay at the fake gateway (which delivers the signed IPN) -> list
// my tickets. Checks that every paid order got its tickets (I2) and that the
// standing counters stay exact (I9).
//
//   pnpm loadtest full-flow            (VUS=1000, ITERS=5 by default)
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { API, authHeaders, summaryTo, userForIteration } from '../lib/common.js';
import { holdStanding, startPayment } from '../lib/payments.js';

const VUS = Number(__ENV.VUS || 1000);
const ITERS = Number(__ENV.ITERS || 5);

const held = new Counter('reservations_held');
const paid = new Counter('orders_paid');
const ticketsSeen = new Counter('tickets_seen');
const failures = new Counter('flow_failures');

// 4xx answers (sold out, already used, 04/97 are 200 anyway) are part of
// the scenario; only 5xx and network errors count as failed requests.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export const options = {
  scenarios: {
    'full-flow': {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERS,
      maxDuration: '10m',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const user = userForIteration();
  const order = holdStanding(user.token);
  if (!order) return; // counted in lib/payments.js
  held.add(1);

  const txnRef = startPayment(user.token, order.id);
  const done = txnRef
    ? http.post(
        `${API}/payments/fake/complete`,
        JSON.stringify({ txnRef, outcome: 'success' }),
        { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /payments/fake/complete' } },
      )
    : null;
  const confirmed = done !== null && done.status === 200 && done.json('ipn.RspCode') === '00';
  if (!confirmed) {
    failures.add(1);
    return;
  }
  paid.add(1);

  const tickets = http.get(`${API}/tickets`, {
    ...authHeaders(user.token),
    tags: { name: 'GET /tickets' },
  });
  const ok = check(tickets, {
    'one ticket for the order': (r) =>
      r.status === 200 && r.json().filter((t) => t.orderId === order.id).length === 1,
  });
  if (ok) ticketsSeen.add(1);
  else failures.add(1);
}

export const handleSummary = summaryTo('full-flow');
