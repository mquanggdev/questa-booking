#!/usr/bin/env node
// Runs one load-test scenario end to end and reports the result.
//
//   pnpm loadtest contention
//   pnpm loadtest standing --vus 1000 --iters 5
//   pnpm loadtest browse --rate 300 --duration 30s
//   pnpm loadtest webhook-chaos | full-flow | check-in   (phase 5, fake gateway)
//   pnpm loadtest contention --record "phase 2 naive"   (appends to docs/benchmarks.md)
//
// Steps: reset the target performance (write scenarios) -> k6 in Docker ->
// invariant SQL -> printed report (+ optional benchmark row).
// Needs: docker compose up, and `pnpm --filter @questa/api db:seed` once.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..');
try {
  process.loadEnvFile(resolve(repo, '.env'));
} catch {
  // defaults below
}

const PAYMENT_SCENARIOS = new Set(['full-flow', 'webhook-chaos', 'check-in']);
const WRITE_SCENARIOS = new Set(['contention', 'standing', 'quota', ...PAYMENT_SCENARIOS]);
const SCENARIOS = new Set([...WRITE_SCENARIOS, 'browse']);

function parseArgs(argv) {
  const [scenario, ...rest] = argv;
  const opts = { scenario };
  for (let i = 0; i < rest.length; i += 2) {
    opts[rest[i].replace(/^--/, '')] = rest[i + 1];
  }
  return opts;
}

function sh(args, { input, quiet = false } = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: repo,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', quiet ? 'pipe' : 'inherit', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout ?? '';
}

function psql(file, perf) {
  const user = process.env.POSTGRES_USER ?? 'questa';
  const db = process.env.POSTGRES_DB ?? 'questa';
  return sh(
    ['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', user, '-d', db,
      '-v', 'ON_ERROR_STOP=1', '-At', '-v', `perf=${perf}`, '-f', '-'],
    { input: readFileSync(resolve(here, file), 'utf8'), quiet: true },
  ).trim();
}

const ms = (v) => (v === undefined ? '–' : `${Math.round(v)} ms`);

function report(scenario, summary, verify) {
  const m = summary.metrics;
  const duration = m.http_req_duration?.values ?? {};
  const reqs = m.http_reqs?.values ?? {};
  const failed = m.http_req_failed?.values?.rate ?? 0;
  const count = (name) => m[name]?.values?.count ?? 0;
  const totalReqs = reqs.count ?? 0;
  // Payment scenarios mark every 4xx as expected (setResponseCallback), so
  // http_req_failed counts exactly the 5xx and network errors there.
  const status5xx = PAYMENT_SCENARIOS.has(scenario)
    ? Math.round(failed * totalReqs)
    : count('reservations_5xx');
  const row = {
    scenario,
    requests: totalReqs,
    rps: reqs.rate ?? 0,
    p50: duration.med,
    p95: duration['p(95)'],
    p99: duration['p(99)'],
    max: duration.max,
    errorRate5xx: totalReqs ? status5xx / totalReqs : 0,
    nonExpectedRate: failed,
    held: count('reservations_held'),
    conflicts: count('reservations_conflict'),
    verify,
  };
  console.log(`\n=== ${scenario} ===`);
  console.log(`requests        ${totalReqs}  (${row.rps.toFixed(1)} req/s)`);
  console.log(`latency         p50 ${ms(row.p50)} · p95 ${ms(row.p95)} · p99 ${ms(row.p99)} · max ${ms(row.max)}`);
  if (PAYMENT_SCENARIOS.has(scenario)) {
    row.counters = Object.fromEntries(
      Object.entries(m)
        .filter(([name, metric]) => metric.type === 'counter' && !name.startsWith('http_') && !name.startsWith('data_') && name !== 'iterations')
        .map(([name, metric]) => [name, metric.values.count]),
    );
    console.log(`5xx             ${status5xx}`);
    console.log(`counters        ${JSON.stringify(row.counters)}`);
  } else if (WRITE_SCENARIOS.has(scenario)) {
    console.log(`held / taken    ${row.held} / ${row.conflicts}   5xx: ${status5xx}`);
  } else {
    console.log(`non-2xx rate    ${(failed * 100).toFixed(2)} %`);
  }
  if (verify) console.log(`invariants      ${JSON.stringify(verify, null, 2)}`);
  return row;
}

function record(row, opts) {
  const tag = sh(['git', 'describe', '--tags', '--always', '--dirty'], { quiet: true }).trim();
  const machine = 'R5 4600H, 16 GB; Docker 7.7 GB; 1 API (512 MB)';
  const load = row.scenario === 'browse'
    ? `${opts.rate ?? 200} req/s × ${opts.duration ?? '30s'}`
    : row.scenario === 'quota'
      ? `${Number(opts.vus ?? 500) * Number(opts.iters ?? 2)} lượt từ ${opts.accounts ?? 20} tài khoản`
      : row.scenario === 'webhook-chaos'
        ? `${Number(opts.vus ?? 250) * Number(opts.iters ?? 2)} lượt (${opts.vus ?? 250} VU)`
        : row.scenario === 'check-in'
          ? `${Number(opts.vus ?? 1000) * Number(opts.iters ?? 5)} lượt quét ${opts.tickets ?? 100} vé`
          : `${Number(opts.vus ?? 1000) * Number(opts.iters ?? 5)} lượt (${opts.vus ?? 1000} VU)`;
  let doubleSold = '–';
  if (row.scenario === 'contention') {
    doubleSold = `**${row.verify.i1DoubleSoldSeats}** ghế (+${row.verify.i1ExtraTickets} vé thừa)`;
  } else if (row.scenario === 'standing') {
    const z = row.verify.standing[0];
    doubleSold = `**${z.oversold}** vé vượt sức chứa (${z.ticketsIssued}/${z.capacity}), lệch bộ đếm ${z.lostUpdates}`;
  } else if (PAYMENT_SCENARIOS.has(row.scenario)) {
    const v = row.verify;
    const total = v.i2Violations + v.i4Violations + v.i8Violations + v.i12Violations + v.i9Violations + (v.i6Violations ?? 0);
    doubleSold = row.scenario === 'check-in'
      ? `**${v.i6Violations}** vé check-in quá 1 lần (${v.ticketsCheckedIn} vé, ${row.counters.checkins_accepted} lượt nhận)`
      : `**${total}** vi phạm I2/I4/I8/I9/I12 (${v.orders.PAID ?? 0} đơn PAID, ${(v.orders.REFUND_PENDING ?? 0) + (v.orders.REFUNDED ?? 0)} đơn hoàn tiền)`;
  } else if (row.scenario === 'quota') {
    doubleSold = `**${row.verify.i10Violations}** tài khoản vượt giới hạn (tối đa ${row.verify.maxTicketsOfOneBuyer} vé/người)`;
  }
  const errors = row.scenario === 'browse'
    ? `${(row.nonExpectedRate * 100).toFixed(2)} %`
    : `${(row.errorRate5xx * 100).toFixed(2)} %`;
  const c = row.apiConfig;
  const machine2 = `${machine}; khóa ${c.SEAT_HOLD_STRATEGY}, gate ${c.RESERVATION_GATE_ENABLED === 'false' ? 'tắt' : 'bật'}, pool ${c.DB_POOL_MAX}`;
  const line = `| ${opts.phase ?? '?'} | \`${tag}\` | ${machine2} | ${row.scenario}: ${load} | ${doubleSold} | ${row.rps.toFixed(0)} | ${ms(row.p50)} | ${ms(row.p95)} | ${ms(row.p99)} | ${errors} | ${opts.record} |\n`;
  appendFileSync(resolve(repo, 'docs/benchmarks.md'), line);
  console.log('\nRecorded in docs/benchmarks.md');
}

const opts = parseArgs(process.argv.slice(2));
if (!SCENARIOS.has(opts.scenario)) {
  console.error(`Usage: pnpm loadtest <${[...SCENARIOS].join('|')}> [--vus N --iters N | --rate N --duration 30s] [--record "note" --phase N]`);
  process.exit(1);
}
const fixturesPath = resolve(here, 'data/fixtures.json');
if (!existsSync(fixturesPath)) {
  console.error('load-tests/data/fixtures.json is missing. Run: pnpm --filter @questa/api db:seed');
  process.exit(1);
}
const { loadTestPerformanceId: perf, tokenExpiresAt } = JSON.parse(readFileSync(fixturesPath, 'utf8'));
if (new Date(tokenExpiresAt) < new Date(Date.now() + 10 * 60 * 1000)) {
  console.error('Seeded tokens expire soon. Re-run: pnpm --filter @questa/api db:seed');
  process.exit(1);
}
mkdirSync(resolve(here, 'results'), { recursive: true });

function resetGate() {
  sh(
    ['docker', 'compose', 'exec', '-T', 'redis', 'redis-cli', 'EVAL',
      readFileSync(resolve(here, 'sql/reset-gate.lua'), 'utf8'), '0',
      'seat:hold:*', 'zone:*', 'hold:req:*'],
    { quiet: true },
  );
}

if (WRITE_SCENARIOS.has(opts.scenario)) {
  console.log(`Resetting performance ${perf} (PostgreSQL and Redis gate)…`);
  psql('sql/reset-performance.sql', perf);
  resetGate();
}

const env = [];
for (const key of ['vus', 'iters', 'rate', 'duration', 'accounts', 'tickets']) {
  if (opts[key]) env.push('-e', `${key.toUpperCase()}=${opts[key]}`);
}
// The fake gateway's local dummy secret, so k6 can sign IPNs like it does.
if (PAYMENT_SCENARIOS.has(opts.scenario)) {
  env.push('-e', `FAKE_PAYMENT_SECRET=${process.env.FAKE_PAYMENT_SECRET ?? 'local-fake-gateway-secret'}`);
}
// The API's effective configuration, read from the running container. It is
// printed and recorded with every result, and the container must be the same
// one before and after the run.
const CONFIG_KEYS = ['SEAT_HOLD_STRATEGY', 'RESERVATION_GATE_ENABLED', 'DB_POOL_MAX', 'DB_TX_MAX_WAIT_MS', 'PAYMENT_PROVIDER'];
function apiState() {
  const id = sh(['docker', 'inspect', '-f', '{{.Id}}', 'questa-api-1'], { quiet: true }).trim();
  const values = sh(['docker', 'compose', 'exec', '-T', 'api', 'printenv', ...CONFIG_KEYS], { quiet: true })
    .trim()
    .split(String.fromCharCode(10)) // newline; trim() drops a trailing CR
    .map((v) => v.trim());
  return { id, config: Object.fromEntries(CONFIG_KEYS.map((k, i) => [k, values[i]])) };
}
const before = apiState();
console.log(`API config: ${JSON.stringify(before.config)}`);

// --no-deps: without it, `docker compose run` re-evaluates the api service
// from .env and RECREATES it, silently discarding any configuration the API
// was started with (this invalidated earlier comparisons; see ADR-0011).
sh(['docker', 'compose', '--profile', 'loadtest', 'run', '--rm', '--no-deps', ...env, 'k6', 'run', '--quiet',
  `/load-tests/scenarios/${opts.scenario}.js`]);

const after = apiState();
if (after.id !== before.id || JSON.stringify(after.config) !== JSON.stringify(before.config)) {
  console.error(`The API container changed during the run (${JSON.stringify(before)} -> ${JSON.stringify(after)}). Result discarded.`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(resolve(here, `results/${opts.scenario}.json`), 'utf8'));
let verify = WRITE_SCENARIOS.has(opts.scenario)
  ? JSON.parse(psql('verify/invariants.sql', perf))
  : null;
if (PAYMENT_SCENARIOS.has(opts.scenario)) {
  verify = { ...verify, ...JSON.parse(psql('verify/payments.sql', perf)) };
  if (opts.scenario === 'check-in') {
    // I6: every accepted scan is one checked-in ticket, and no ticket twice.
    const accepted = summary.metrics.checkins_accepted?.values?.count ?? 0;
    const tickets = Number(opts.tickets ?? 100);
    verify.i6Violations = Math.abs(accepted - verify.ticketsCheckedIn) + Math.max(accepted - tickets, 0);
  }
}
const row = { ...report(opts.scenario, summary, verify), apiConfig: before.config };
if (opts.record) record(row, opts);
