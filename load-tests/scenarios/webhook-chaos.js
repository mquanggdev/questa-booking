// Webhook chaos: the gateway misbehaves in every way the spec lists, while
// hundreds of customers pay at once. Each iteration holds one standing
// ticket, starts a payment, sends a forged IPN (must be 97), then one of:
//   0 duplicate   - the same success IPN 5 times in parallel (one 00, I4)
//   1 bad amount  - a wrong amount first (04, I12), then the right one
//   2 late        - the order is cancelled first, then the money arrives:
//                   refunded, seat never taken back (I8)
//   3 race        - cancel and IPN at the same moment: PAID or refunded
// Afterwards load-tests/verify/payments.sql checks I2, I4, I8, I12 in the DB.
//
//   pnpm loadtest webhook-chaos        (VUS=250, ITERS=2 by default: 500 tickets)
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { API, authHeaders, summaryTo, userForIteration } from '../lib/common.js';
import { holdStanding, ipnRequest, sendIpn, signedIpn, startPayment } from '../lib/payments.js';

const VUS = Number(__ENV.VUS || 250);
const ITERS = Number(__ENV.ITERS || 2);

const held = new Counter('reservations_held');
const replies = {
  '00': new Counter('ipn_00_confirmed'),
  '01': new Counter('ipn_01_not_found'),
  '02': new Counter('ipn_02_already_confirmed'),
  '04': new Counter('ipn_04_bad_amount'),
  '97': new Counter('ipn_97_bad_signature'),
  '99': new Counter('ipn_99_error'),
};
const appliedTwice = new Counter('payments_confirmed_twice');
const unexpected = new Counter('unexpected_replies');

// 4xx answers (sold out, already used, 04/97 are 200 anyway) are part of
// the scenario; only 5xx and network errors count as failed requests.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export const options = {
  scenarios: {
    'webhook-chaos': {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERS,
      maxDuration: '10m',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function codeOf(res) {
  const code = res.status === 200 ? res.json('RspCode') : `http-${res.status}`;
  if (replies[code]) replies[code].add(1);
  return code;
}

function expect(code, wanted, label) {
  if (!check(code, { [label]: (c) => wanted.includes(c) })) unexpected.add(1);
}

export default function () {
  const user = userForIteration();
  const order = holdStanding(user.token);
  if (!order) return; // counted in lib/payments.js
  held.add(1);
  const txnRef = startPayment(user.token, order.id);
  if (!txnRef) {
    unexpected.add(1);
    return;
  }
  const amount = order.totalAmount;
  const txnNo = `${Date.now()}${exec.vu.idInTest}${exec.vu.iterationInScenario}`;
  const good = signedIpn(txnRef, amount, txnNo);

  // A forged notification: right fields, signature over different data.
  const forged = good.replace(`vnp_Amount=${amount * 100}`, `vnp_Amount=${amount * 100 - 100}`);
  expect(codeOf(sendIpn(forged)), ['97'], 'forged IPN is 97');

  const cancel = () =>
    ['POST', `${API}/orders/${order.id}/cancel`, null, { ...authHeaders(user.token), tags: { name: 'POST /orders/:id/cancel' } }];

  switch (exec.scenario.iterationInTest % 4) {
    case 0: {
      const codes = http.batch(Array.from({ length: 5 }, () => ipnRequest(good))).map(codeOf);
      const confirmed = codes.filter((c) => c === '00').length;
      if (confirmed > 1) appliedTwice.add(1);
      expect(confirmed === 1 && codes.every((c) => c === '00' || c === '02') ? 'ok' : codes.join(','), ['ok'], 'duplicates: one 00, rest 02');
      break;
    }
    case 1: {
      const wrong = signedIpn(txnRef, amount + 1000, txnNo);
      expect(codeOf(sendIpn(wrong)), ['04'], 'wrong amount is 04');
      expect(codeOf(sendIpn(good)), ['00'], 'then the right IPN is 00');
      break;
    }
    case 2: {
      const [, url, body, params] = cancel();
      const res = http.post(url, body, params);
      check(res, { 'cancelled (204)': (r) => r.status === 204 });
      expect(codeOf(sendIpn(good)), ['00'], 'late IPN accepted for refund');
      expect(codeOf(sendIpn(good)), ['02'], 'repeat is 02');
      break;
    }
    default: {
      const [cancelRes, ipnRes] = http.batch([cancel(), ipnRequest(good)]);
      check(cancelRes, { 'cancel is 204 or 409': (r) => r.status === 204 || r.status === 409 });
      expect(codeOf(ipnRes), ['00'], 'racing IPN is 00');
    }
  }
}

export const handleSummary = summaryTo('webhook-chaos');
