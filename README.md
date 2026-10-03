# Questa Booking

**English** | [Tiếng Việt](README.vi.md)

A concert ticketing backend built to sell exactly the seats that exist when thousands of people buy at the same moment, and to prove it with numbers.

> **Status:** Phase 1 done: data model, authentication with rotating refresh tokens, roles, concert and performance catalog, seed data. Booking starts in phase 2. See [the roadmap](docs/spec.md#10-lộ-trình-triển-khai).

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

Starts at phase 2 with the naive, double-selling version. See [`docs/benchmarks.md`](docs/benchmarks.md).

## Documentation

- [Specification](docs/spec.md) (Vietnamese)
- [Architecture decision records](docs/adr/) (Vietnamese)

## License

[MIT](LICENSE)
