// Shared helpers for k6 scenarios. Runs inside the grafana/k6 container,
// where this folder is mounted at /load-tests.
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

export const BASE_URL = __ENV.BASE_URL || 'http://api:3000';
export const API = `${BASE_URL}/api/v1`;

// Written by `pnpm --filter @questa/api db:seed`. SharedArray keeps one copy
// in memory for all VUs instead of one per VU.
export const users = new SharedArray('users', () =>
  JSON.parse(open('/load-tests/data/users.json')),
);
export const fixtures = JSON.parse(open('/load-tests/data/fixtures.json'));

/** A distinct seeded customer for every iteration across all VUs. */
export function userForIteration() {
  const index = exec.scenario.iterationInTest;
  if (index >= users.length) {
    exec.test.abort(`Only ${users.length} seeded users; lower VUS x ITERS`);
  }
  return users[index];
}

export function authHeaders(token) {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };
}

/** Writes the raw k6 summary so load-tests/run.mjs can build the report. */
export function summaryTo(name) {
  return (data) => ({
    [`/load-tests/results/${name}.json`]: JSON.stringify(data, null, 2),
    stdout: `\n${name}: summary written to load-tests/results/${name}.json\n`,
  });
}
