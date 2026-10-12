#!/usr/bin/env node
// Runs one load-test scenario end to end and reports the result.
//
//   pnpm loadtest contention
//   pnpm loadtest standing --vus 1000 --iters 5
//   pnpm loadtest browse --rate 300 --duration 30s
//   pnpm loadtest webhook-chaos | full-flow | check-in   (phase 5, fake gateway)
//   pnpm loadtest contention --record "phase 2 naive"   (appends to docs/benchmarks.md)
//   pnpm loadtest contention --kill-after 5               (kills one API replica 5 s in)
//   pnpm loadtest on-sale [--queue off] [--lead 20]      (phase 7b, waiting room)
//
// Steps: reset the target performance (write scenarios) -> k6 in Docker ->
// invariant SQL -> printed report (+ optional benchmark row).
// Needs: docker compose up, and `pnpm --filter @questa/api db:seed` once.
import { spawn, spawnSync } from 'node:child_process';
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
const WRITE_SCENARIOS = new Set(['contention', 'standing', 'quota', 'on-sale', ...PAYMENT_SCENARIOS]);
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

function psql(file, perf, vars = {}) {
  const user = process.env.POSTGRES_USER ?? 'questa';
  const db = process.env.POSTGRES_DB ?? 'questa';
  const extra = Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]);
  return sh(
    ['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', user, '-d', db,
      '-v', 'ON_ERROR_STOP=1', '-At', '-v', `perf=${perf}`, ...extra, '-f', '-'],
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
  if (scenario === 'on-sale') {
    const holdLatency = m['http_req_duration{name:POST /reservations}']?.values ?? {};
    const wait = m.queue_wait?.values ?? {};
    row.hold = { p50: holdLatency.med, p95: holdLatency['p(95)'], p99: holdLatency['p(99)'] };
    row.queueWait = { p50: wait.med, p95: wait['p(95)'], max: wait.max };
    row.counters = Object.fromEntries(
      ['queue_admitted', 'queue_never_admitted', 'reservations_held', 'tickets_held',
        'reservations_conflict', 'buyers_gave_up', 'admitted_but_refused',
        'bypass_refused', 'bypass_accepted', 'reservations_5xx'].map((n) => [n, count(n)]),
    );
    console.log(`holds           p50 ${ms(row.hold.p50)} · p95 ${ms(row.hold.p95)} · p99 ${ms(row.hold.p99)}`);
    console.log(`queue wait      p50 ${ms(wait.med)} · p95 ${ms(wait['p(95)'])} · max ${ms(wait.max)}`);
    console.log(`counters        ${JSON.stringify(row.counters)}`);
  } else if (PAYMENT_SCENARIOS.has(scenario)) {
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
  const replicas = row.apiReplicas ?? 1;
  const machine = `R5 4600H, 16 GB; Docker 7.7 GB; ${replicas} API (512 MB)${replicas > 1 ? ' sau Nginx' : ''}${row.killed ? `, giết ${row.killed} giữa chừng` : ''}`;
  const load = row.scenario === 'on-sale'
    ? `${Number(opts.vus ?? 2000) * Number(opts.iters ?? 2)} khách (${opts.vus ?? 2000} VU) trên 10.000 vé, hàng chờ ${opts.queue === 'off' ? 'tắt' : `bật (${row.apiConfig.WAITING_ROOM_ADMIT_PER_TICK} người / ${row.apiConfig.WAITING_ROOM_TICK_MS} ms)`}`
    : row.scenario === 'browse'
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
  } else if (row.scenario === 'on-sale') {
    const v = row.verify;
    const z = v.standing[0];
    const total = v.i1DoubleSoldSeats + v.i9Violations + v.i10Violations + row.counters.bypass_accepted + row.counters.admitted_but_refused;
    doubleSold = `**${total}** vi phạm I1/I9/I10 và hàng chờ (${v.seatsSold + z.ticketsIssued}/10.000 vé được giữ, ${row.counters.bypass_refused} lượt lách hàng bị chặn)`;
  } else if (row.scenario === 'quota') {
    doubleSold = `**${row.verify.i10Violations}** tài khoản vượt giới hạn (tối đa ${row.verify.maxTicketsOfOneBuyer} vé/người)`;
  }
  const errors = row.scenario === 'browse'
    ? `${(row.nonExpectedRate * 100).toFixed(2)} %`
    : `${(row.errorRate5xx * 100).toFixed(2)} %`;
  const c = row.apiConfig;
  const machine2 = `${machine}; khóa ${c.SEAT_HOLD_STRATEGY}, gate ${c.RESERVATION_GATE_ENABLED === 'false' ? 'tắt' : 'bật'}, pool ${c.DB_POOL_MAX}${row.scenario === 'browse' ? `, cache ${c.CATALOG_CACHE_TTL_SECONDS === '0' ? 'tắt' : `${c.CATALOG_CACHE_TTL_SECONDS} s`}` : ''}`;
  // on-sale: the latency columns are the holds' (polling GET /queue/me
  // would dominate the overall numbers); the queue wait goes in the note.
  const lat = row.scenario === 'on-sale' ? row.hold : row;
  const note = row.scenario === 'on-sale' && opts.queue !== 'off'
    ? `${opts.record}. Chờ trong hàng sau giờ mở bán: p50 ${ms(row.queueWait.p50)}, p95 ${ms(row.queueWait.p95)}`
    : opts.record;
  const line = `| ${opts.phase ?? '?'} | \`${tag}\` | ${machine2} | ${row.scenario}: ${load} | ${doubleSold} | ${row.rps.toFixed(0)} | ${ms(lat.p50)} | ${ms(lat.p95)} | ${ms(lat.p99)} | ${errors} | ${note} |\n`;
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
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));
const { tokenExpiresAt } = fixtures;
const perf = opts.scenario === 'on-sale' ? fixtures.onSalePerformanceId : fixtures.loadTestPerformanceId;
if (!perf) {
  console.error('fixtures.json predates this scenario. Re-run: pnpm --filter @questa/api db:seed');
  process.exit(1);
}
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
if (opts.scenario === 'on-sale') {
  // The sale opens `lead` seconds from now, by the database's clock (the
  // same clock as the k6 container's; the host's may differ). The line,
  // the cached performance and the passes start empty.
  const lead = Number(opts.lead ?? 20);
  psql('sql/prepare-on-sale.sql', perf, { lead, queue: opts.queue === 'off' ? 'false' : 'true' });
  const opensAt = psql('sql/on-sale-opens-at.sql', perf);
  sh(
    ['docker', 'compose', 'exec', '-T', 'redis', 'redis-cli', 'EVAL',
      readFileSync(resolve(here, 'sql/reset-gate.lua'), 'utf8'), '0',
      `wr:${perf}:*`, `cache:performance:${perf}`],
    { quiet: true },
  );
  sh(['docker', 'compose', 'exec', '-T', 'redis', 'redis-cli', 'SREM', 'wr:active', perf], { quiet: true });
  env.push('-e', `OPENS_AT=${opensAt}`);
  // Without a line there is nothing to bypass.
  if (opts.queue === 'off') env.push('-e', 'BYPASS_SHARE=0');
  console.log(`Sale opens in ${lead} s; waiting room ${opts.queue === 'off' ? 'off' : 'on'}`);
}
for (const key of ['vus', 'iters', 'rate', 'duration', 'accounts', 'tickets', 'poll']) {
  if (opts[key]) env.push('-e', `${key.toUpperCase()}=${opts[key]}`);
}
// The fake gateway's local dummy secret, so k6 can sign IPNs like it does.
if (PAYMENT_SCENARIOS.has(opts.scenario)) {
  env.push('-e', `FAKE_PAYMENT_SECRET=${process.env.FAKE_PAYMENT_SECRET ?? 'local-fake-gateway-secret'}`);
}
// The API's effective configuration, read from the running container. It is
// printed and recorded with every result, and the container must be the same
// one before and after the run.
const CONFIG_KEYS = ['SEAT_HOLD_STRATEGY', 'RESERVATION_GATE_ENABLED', 'DB_POOL_MAX', 'DB_TX_MAX_WAIT_MS', 'PAYMENT_PROVIDER', 'RATE_LIMIT_ENABLED', 'CATALOG_CACHE_TTL_SECONDS', 'WAITING_ROOM_TICK_MS', 'WAITING_ROOM_ADMIT_PER_TICK'];
function apiState() {
  // Every API replica: the set must not change during a run (except the one
  // replica that --kill-after stops on purpose).
  const ids = sh(['docker', 'compose', 'ps', '-q', 'api'], { quiet: true })
    .split(String.fromCharCode(10))
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();
  const id = ids.join(',');
  const values = sh(['docker', 'compose', 'exec', '-T', 'api', 'printenv', ...CONFIG_KEYS], { quiet: true })
    .trim()
    .split(String.fromCharCode(10)) // newline; trim() drops a trailing CR
    .map((v) => v.trim());
  return { id, replicas: ids.length, config: Object.fromEntries(CONFIG_KEYS.map((k, i) => [k, values[i]])) };
}
const before = apiState();
console.log(`API config: ${JSON.stringify(before.config)}, replicas: ${before.replicas}`);
// Every k6 VU comes from the same IP (the k6 container): with rate limiting
// on, most requests would be 429 and the numbers would measure the limiter.
if (before.config.RATE_LIMIT_ENABLED !== 'false') {
  console.error('Rate limiting is on. Restart the API without it, then run again:');
  console.error('  RATE_LIMIT_ENABLED=false docker compose up -d api');
  process.exit(1);
}

// --no-deps: without it, `docker compose run` re-evaluates the api service
// from .env and RECREATES it, silently discarding any configuration the API
// was started with (this invalidated earlier comparisons; see ADR-0011).
const k6Args = ['compose', '--profile', 'loadtest', 'run', '--rm', '--no-deps', ...env, 'k6', 'run', '--quiet',
  `/load-tests/scenarios/${opts.scenario}.js`];
let killed = null;
if (opts['kill-after'] === undefined) {
  sh(['docker', ...k6Args]);
} else {
  // Phase 7a: a replica dies mid-run, like a crash (SIGKILL, no graceful
  // shutdown). Nginx must route around it and no invariant may break.
  const victim = sh(['docker', 'compose', 'ps', '-q', 'api'], { quiet: true }).trim().split(String.fromCharCode(10)).pop().trim();
  const k6 = spawn('docker', k6Args, { cwd: repo, stdio: 'inherit' });
  const timer = setTimeout(() => {
    killed = sh(['docker', 'inspect', '-f', '{{.Name}}', victim], { quiet: true }).trim().replace(/^\//, '');
    sh(['docker', 'kill', victim], { quiet: true });
    console.log(`
>>> killed ${killed} after ${opts['kill-after']} s`);
  }, Number(opts['kill-after']) * 1000);
  const code = await new Promise((done) => k6.on('exit', done));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`k6 exited with ${code}`);
  if (killed) sh(['docker', 'start', victim], { quiet: true });
}

const after = apiState();
// A killed replica is restarted above (same container id), so the set of
// replicas must still be exactly the one measured.
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
const row = { ...report(opts.scenario, summary, verify), apiConfig: before.config, apiReplicas: before.replicas, killed };
if (opts.record) record(row, opts);
