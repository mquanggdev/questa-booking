// Browse: anonymous visitors reading the catalog at a steady request rate.
// No writes. This is the baseline that caching (phase 7a) must beat.
//
//   node load-tests/run.mjs browse              (RATE=200 req/s for 30s by default)
import http from 'k6/http';
import { check } from 'k6';
import { API, fixtures, summaryTo } from '../lib/common.js';

const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const id = fixtures.loadTestPerformanceId;
const pages = [
  ['GET /concerts', `${API}/concerts`],
  ['GET /performances/:id', `${API}/performances/${id}`],
  ['GET /performances/:id/seats', `${API}/performances/${id}/seats`],
];

export default function () {
  const [name, url] = pages[Math.floor(Math.random() * pages.length)];
  const res = http.get(url, { tags: { name } });
  check(res, { 'status 200': (r) => r.status === 200 });
}

export const handleSummary = summaryTo('browse');
