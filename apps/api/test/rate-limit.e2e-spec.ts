import { randomUUID } from 'node:crypto';
import { Role } from '../src/generated/prisma/client.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  type TestApp,
} from './support/app.js';

/**
 * Phase 7a: rate limiting per IP and per user, with counters in Redis so
 * every API replica shares them. Two Nest apps in this process stand in for
 * two replicas behind Nginx.
 */
describe('Rate limiting (e2e)', () => {
  // Each pair stands for two replicas; the shared Redis test connection is
  // closed once, at the very end.
  let a: TestApp;
  let b: TestApp;
  let userA: TestApp;
  let userB: TestApp;

  beforeAll(async () => {
    const strictIp = {
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_IP_PER_MINUTE: 6,
      RATE_LIMIT_USER_PER_MINUTE: 1000,
    };
    const looseIp = { ...strictIp, RATE_LIMIT_IP_PER_MINUTE: 1000 };
    [a, b, userA, userB] = await Promise.all([
      createTestApp({ config: strictIp }),
      createTestApp({ config: strictIp }),
      createTestApp({ config: looseIp }),
      createTestApp({ config: looseIp }),
    ]);
  });

  beforeEach(async () => {
    await resetDatabase(a.prisma); // also empties the Redis counters
  });

  afterAll(async () => {
    for (const app of [userA, userB, a, b]) await app.close();
  });

  it('two replicas share one per-IP counter: the limit holds in total, not per replica', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const app = i % 2 === 0 ? a : b; // round robin, like Nginx
      statuses.push((await app.http().get('/api/v1/concerts')).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(6);
    expect(statuses.slice(6)).toEqual([429, 429, 429, 429]);

    const blocked = await b.http().get('/api/v1/concerts').expect(429);
    expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('login is limited harder per IP (10 per minute)', async () => {
    const tries = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 === 0 ? a : b)
          .http()
          .post('/api/v1/auth/login')
          .send({ email: 'nobody@test.local', password: 'wrong-password' }),
      ),
    );
    const statuses = tries.map((r) => r.status);
    // Counters are per route: login's own limit (10) applies, not the
    // general one (6 in this test).
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  it('holds are limited per account (20 per minute), and one account does not use up another', async () => {
    const first = await createUserAndLogin(userA, Role.CUSTOMER);
    const second = await createUserAndLogin(userA, Role.CUSTOMER);
    const hold = (app: TestApp, token: string) =>
      app
        .http()
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ performanceId: randomUUID(), standing: [] });

    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      statuses.push(
        (await hold(i % 2 === 0 ? userA : userB, first.accessToken)).status,
      );
    }
    // 20 reach the handler (and fail validation: empty selection), then 429.
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);

    // Same IP, another account: its own counter.
    expect((await hold(userA, second.accessToken)).status).not.toBe(429);
  });
});
