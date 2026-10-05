# Questa Booking

**English** | [Tiếng Việt](README.vi.md)

A concert ticketing backend built to sell exactly the seats that exist when thousands of people buy at the same moment, and to prove it with numbers.

> **Status:** Phase 3 done: PostgreSQL itself refuses to double-sell (conditional updates, a partial unique index, a CHECK constraint, advisory locks, Idempotency-Key). 0 seats sold twice in every run.

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

`docker compose up` starts PostgreSQL and Redis, applies migrations, then starts the API.

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
```

| Command | What it does |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Static checks |
| `pnpm test` | Unit tests |
| `pnpm test:e2e` | End-to-end tests on a separate `questa_test` database (needs PostgreSQL and Redis) |

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
| 3 | 3 seat-locking strategies compared | all correct; differences within run-to-run noise ([ADR-0008](docs/adr/0008-seat-and-standing-locking.md)) |

```bash
pnpm --filter @questa/api db:seed
pnpm loadtest contention      # or: standing, quota, browse
```

## Documentation

- [Specification](docs/spec.md) (Vietnamese)
- [Architecture decision records](docs/adr/) (Vietnamese)

## License

[MIT](LICENSE)
