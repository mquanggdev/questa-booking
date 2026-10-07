// Payment helpers for k6: hold a standing ticket, start a payment, and sign
// IPNs exactly like the API's fake gateway does (VNPay 2.1.0 protocol:
// sorted parameters, encodeURIComponent with spaces as "+", HMAC-SHA512).
import crypto from 'k6/crypto';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { API, authHeaders, fixtures } from './common.js';

// Local dummy secret of the fake gateway (FAKE_PAYMENT_SECRET in .env),
// passed by load-tests/run.mjs. Never a real gateway secret.
const SECRET = __ENV.FAKE_PAYMENT_SECRET || 'local-fake-gateway-secret';

const conflicts = new Counter('reservations_conflict');
const busy = new Counter('reservations_5xx');

export const standingZone = fixtures.zones.find((z) => z.type === 'STANDING');

const encode = (v) => encodeURIComponent(v).replace(/%20/g, '+');

function canonical(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k])}`)
    .join('&');
}

function vnpDate(date) {
  const d = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** A signed IPN query string, as the gateway would send it. */
export function signedIpn(txnRef, amountVnd, transactionNo, { success = true } = {}) {
  const params = {
    vnp_TmnCode: 'FAKE0001',
    vnp_TxnRef: txnRef,
    vnp_Amount: String(amountVnd * 100),
    vnp_BankCode: 'NCB',
    vnp_PayDate: vnpDate(new Date()),
    vnp_ResponseCode: success ? '00' : '24',
    vnp_TransactionStatus: success ? '00' : '02',
    vnp_TransactionNo: transactionNo,
    vnp_OrderInfo: `Thanh toan ${txnRef}`,
  };
  const query = canonical(params);
  return `${query}&vnp_SecureHash=${crypto.hmac('sha512', SECRET, query, 'hex')}`;
}

const IPN_TAGS = { tags: { name: 'GET /payments/ipn' } };

/** For http.batch: one IPN delivery. */
export function ipnRequest(query) {
  return ['GET', `${API}/payments/ipn/fake?${query}`, null, IPN_TAGS];
}

/** Delivers one IPN and waits for the answer. */
export function sendIpn(query) {
  return http.get(`${API}/payments/ipn/fake?${query}`, IPN_TAGS);
}

/**
 * Holds `quantity` standing tickets. Returns the order, or null: sold out
 * (409) or the API shedding load (503 with Retry-After), told apart by the
 * reservations_conflict and reservations_5xx counters.
 */
export function holdStanding(token, quantity = 1) {
  const res = http.post(
    `${API}/reservations`,
    JSON.stringify({
      performanceId: fixtures.loadTestPerformanceId,
      standing: [{ zoneId: standingZone.id, quantity }],
    }),
    { ...authHeaders(token), tags: { name: 'POST /reservations' } },
  );
  if (res.status === 201) return res.json();
  if (res.status >= 500) busy.add(1);
  else conflicts.add(1);
  return null;
}

/** Starts a fake-gateway payment; returns its txnRef or null. */
export function startPayment(token, orderId) {
  const res = http.post(
    `${API}/orders/${orderId}/pay`,
    JSON.stringify({ provider: 'fake' }),
    { ...authHeaders(token), tags: { name: 'POST /orders/:id/pay' } },
  );
  if (res.status !== 201) return null;
  return res.json('checkoutUrl').split('txnRef=')[1];
}
