---
name: benchmark
description: Runs a Questa Booking k6 load-test scenario end to end (reset, k6 in Docker, invariant SQL) and optionally records a row in docs/benchmarks.md. Use when measuring a phase, comparing before and after a change, or checking that no seat is double-sold under load.
---

# Benchmark

All load tests go through one command, so every number in `docs/benchmarks.md` is produced the same way.

## Before

1. Stack running: `docker compose up -d --build` (rebuild after code changes), API `healthy`.
2. Seed data exists and tokens are fresh: `pnpm --filter @questa/api db:seed`. The script refuses to run if tokens expire within 10 minutes.
3. Nothing else heavy is running on the machine. Note anything unusual in the row.

## Run

```bash
pnpm loadtest contention            # 1000 VU x 5 iterations, 1 random seat each, 100 seats
pnpm loadtest standing              # same load, 1 ticket each, 500-ticket standing zone
pnpm loadtest browse --rate 100     # constant read rate, 30 s by default
```

Options: `--vus N --iters N` for the write scenarios, `--rate N --duration 30s` for browse.

The script resets the load-test performance, runs k6 inside the compose network (`http://api:3000`), then runs `load-tests/verify/invariants.sql` against PostgreSQL and prints the report.

## Judge the result

- `i1DoubleSoldSeats` and the standing `oversold` / `lostUpdates` values must be **0** from phase 3 on. A non-zero value is a correctness bug: stop and investigate before anything else.
- 5xx should be 503 (load shedding), never 500. Check `docker compose logs api` for `"level":50` lines.
- Run a write scenario several times before drawing conclusions: results vary on a laptop.

## Record

When the numbers are the ones to keep for the phase:

```bash
pnpm loadtest contention --phase 3 --record "what changed and why it matters"
```

This appends one row to `docs/benchmarks.md`. Never edit old rows; add new ones. If a row was recorded on an uncommitted tree, fix its tag column to the phase tag once that tag exists.
