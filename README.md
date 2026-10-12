# Questa Booking

**English** | [Tiếng Việt](README.vi.md) &nbsp; [![CI](https://github.com/mquanggdev/questa-booking/actions/workflows/ci.yml/badge.svg)](https://github.com/mquanggdev/questa-booking/actions/workflows/ci.yml)

A concert ticketing backend built to sell exactly the seats that exist when thousands of people buy at the same moment, and to prove it with numbers.

> **Status:** Phase 7b done: presale codes (single use, one per account per presale, enforced by the database) and a virtual waiting room that admits buyers at a measured pace, with live position over WebSocket. Earlier phases: database guards against double-selling, a Redis filter, expiring holds, payments through a signed IPN with refunds, a Next.js web app, two API replicas behind Nginx with a realtime seat map, a catalog cache and rate limiting. An online demo comes with phase 9.

![Buying tickets: sign up, pick seats and standing tickets, hold, pay at the fake gateway, get QR tickets](docs/assets/buying-flow.gif)

## The problem

Ticket on-sales are short, violent bursts of traffic where many buyers want the same few seats. A naive "read the seat, see it is free, then write" sells one seat to two people under load. This project starts from exactly that broken version, measures the double-sells, and then removes them step by step: database locking, time-limited holds in Redis, idempotent payments, multiple instances, a virtual waiting room, and event streaming with Kafka. Every step is benchmarked.

## Stack

NestJS 12 (TypeScript, ESM) · PostgreSQL 18 · Prisma 7 · Redis 8 · BullMQ · Kafka · Socket.IO · Next.js · k6 · Docker Compose · GitHub Actions · Prometheus and Grafana

Why each one is here: [`docs/adr/`](docs/adr/).

## Run it

Requirements: Docker, Node.js 24, pnpm.

```bash
cp .env.example .env
docker compose up -d --build
curl localhost:3000/api/v1/health/ready
```

`docker compose up` starts PostgreSQL and Redis, applies migrations, then starts two API replicas, the background worker and the web app, all behind Nginx, the single entry point (`/` to the web app, `/api` and `/socket.io` to the API replicas).

- Web app: <http://localhost:3200>. Pick a performance, select seats on the map, hold them, pay at the fake gateway, get QR tickets. Seats held or sold by other buyers change color live. Every response names the replica that served it in an `X-Instance` header.
- After seeding: "Questa Arena Live" (10,000 tickets) sells through the virtual waiting room, and "Questa Fan Club Night" is in its presale; its 50 presale codes are written to `load-tests/data/fixtures.json`.

Payments use the local fake gateway by default (`PAYMENT_PROVIDER=fake`), so no account is needed. To pay on the real VNPay sandbox, follow [`docs/vnpay-sandbox.md`](docs/vnpay-sandbox.md) (Vietnamese).

- API docs (Swagger): <http://localhost:3000/api/docs>
- Load sample data (wipes the development database):

  ```bash
  pnpm install
  pnpm --filter @questa/api db:seed
  ```

  Accounts: `organizer@questa.test`, `staff@questa.test`, `customer0001@questa.test` … `customer5000@questa.test`, all with the password in `SEED_PASSWORD` (`.env.example`).

### Develop on the host

```bash
pnpm install
docker compose up -d postgres redis
pnpm --filter @questa/api start:dev
pnpm --filter @questa/web dev        # http://localhost:3200
```

| Command | What it does |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Static checks |
| `pnpm test` | Unit tests |
| `pnpm test:e2e` | End-to-end tests on a separate `questa_test` database (needs PostgreSQL and Redis) |
| `pnpm test:browser` | Playwright tests of the buying flow in a real browser (needs the stack running and seeded, with `RATE_LIMIT_ENABLED=false`) |

## Benchmarks

Every number comes from `pnpm loadtest <scenario>`: k6 inside the compose network, then SQL checks straight against PostgreSQL. Full table: [`docs/benchmarks.md`](docs/benchmarks.md).

| Phase | Scenario | Result |
| --- | --- | --- |
| 2: naive "read, check, write" | 5,000 buyers, 100 seats | **4–11 seats sold twice** in every run |
| 2: naive | 5,000 buyers, 500 standing tickets | **925 tickets issued** for 500 places; the counter recorded 94 (831 lost updates) |
| 2: naive | catalog reads, one API process | 100 req/s at p95 41 ms; saturates (CPU-bound) before 200 req/s |
| **3: database guards** | 5,000 buyers, 100 seats | **0 seats sold twice in 5 runs in a row**, exactly 100 tickets |
| 3 | 5,000 buyers, 500 standing tickets | exactly **500** tickets, counter matches |
| 3 | 20 accounts × 50 parallel requests, limit 6 | exactly **6 per account** (120 total) |
| 3 | 3 seat-locking strategies compared | all correct, within ~10% of each other (re-measured, see below) ([ADR-0008](docs/adr/0008-seat-and-standing-locking.md)) |
| **4: Redis gate off → on** | 5,000 buyers, 100 seats | 159–211 → **701–815 req/s**, p50 ~5 s → **11–456 ms**, 503s → **0**; still 0 double-sells |
| 4 | 5,000 buyers, 500 standing tickets | ~200 → **~510 req/s**, p50 ~4.5 s → **~25 ms** |
| **5: payments** | webhook chaos: every IPN 5× in parallel, wrong amounts, forged signatures, money after the order was cancelled, cancel racing the IPN | **0 violations** of I2/I4/I8/I9/I12; 500 payments confirmed exactly once, 250 refunded |
| 5 | 5,000 buyers: hold → pay → get tickets | all 500 held tickets paid and issued, 0 violations; ~6% of holds shed with 503 under load |
| 5 | 5,000 concurrent scans of 100 tickets | exactly **100 accepted**; 267 → **365 req/s** after making an accepted scan one statement |
| **7a: 1 → 2 API replicas behind Nginx** | 5,000 buyers, 100 seats | 525 → **790 req/s**, p95 7.3 s → 4.8 s; still 0 double-sells |
| 7a | 5,000 buyers, 500 standing tickets | 436 → **614 req/s**; exactly 500 tickets |
| 7a | one replica killed (`docker kill`) 5 s into the run | **0 invariant violations** in both scenarios; only the requests in flight on the dead replica fail |
| 7a: catalog cache off → on | 400 req/s of catalog reads | could only sustain 362 req/s at p95 4.9 s → **400 req/s at p95 7 ms** |
| **7b: on-sale, 10,000 tickets** | 4,000 buyers queue before the opening; 5% try to skip the line | waiting room admitting **50/s**: holds p50 **20 ms**, p95 **99 ms**, 0 errors, **0 of 114** line-skippers got through |
| 7b | same rush, admitting 100/s | over capacity on this machine: holds p50 3.7 s, 503s (the pool is exhausted). The admission rate is set from measurements |
| 7b | same rush, **no waiting room** | holds p95 **10.7 s**, 16% of requests fail with 503; still 0 invariant violations |
| 7b | first on-sale run, before fixing the stack | 28,457 × 502: Node's listen queue overflowed and a keep-alive race made Nginx mark both healthy replicas dead ([ADR-0016](docs/adr/0016-presale-codes-and-waiting-room.md)) |

> A measurement bug (`docker compose run` silently recreated the API with default settings) invalidated three earlier comparisons. The load-test script now records the API's real configuration with every result; affected rows are marked and re-measured ([ADR-0011](docs/adr/0011-benchmark-config-integrity.md)).

```bash
pnpm --filter @questa/api db:seed
pnpm loadtest contention      # or: standing, quota, browse, full-flow, webhook-chaos, check-in, on-sale
```

## Documentation

- [Specification](docs/spec.md) (Vietnamese)
- [Architecture decision records](docs/adr/) (Vietnamese)
- [Paying on the VNPay sandbox](docs/vnpay-sandbox.md) (Vietnamese)

## License

[MIT](LICENSE)
