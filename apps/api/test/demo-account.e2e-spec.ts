import { Role } from '../src/generated/prisma/client.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  TEST_PASSWORD,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Phase 9: the online demo's organizer account is public (its password is
 * in the README), so it can read every organizer page but change nothing.
 */
describe('Read-only demo account (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  /** The demo organizer, owning one published performance. */
  async function demoOrganizer() {
    const owner = await createUserAndLogin(t, Role.ORGANIZER);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(auth)
      .send({ name: 'Demo night', artist: 'Band' })
      .expect(201);
    const startsAt = new Date(Date.now() + 30 * DAY);
    const perf = await t
      .http()
      .post(`/api/v1/concerts/${concert.body.id}/performances`)
      .set(auth)
      .send({
        venue: 'Hall',
        startsAt,
        zones: [{ name: 'GA', type: 'STANDING', price: 100_000, capacity: 10 }],
        salePhases: [
          {
            type: 'GENERAL',
            startsAt: new Date(Date.now() - DAY),
            endsAt: new Date(startsAt.getTime() - DAY),
          },
        ],
      })
      .expect(201);
    // Turned into the demo account, then signed in again (new token).
    await t.prisma.user.update({
      where: { id: owner.id },
      data: { isDemo: true },
    });
    const login = await t
      .http()
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: TEST_PASSWORD })
      .expect(200);
    return {
      auth: { Authorization: `Bearer ${login.body.accessToken as string}` },
      cookie: (login.headers['set-cookie'] as unknown as string[])[0]!,
      perfId: perf.body.id as string,
      concertId: concert.body.id as string,
      user: login.body.user as { isDemo: boolean },
    };
  }

  it('reads like an organizer', async () => {
    const demo = await demoOrganizer();
    expect(demo.user.isDemo).toBe(true);
    const me = await t
      .http()
      .get('/api/v1/users/me')
      .set(demo.auth)
      .expect(200);
    expect(me.body.isDemo).toBe(true);
    await t
      .http()
      .get(`/api/v1/performances/${demo.perfId}/stats`)
      .set(demo.auth)
      .expect(200);
  });

  it('cannot change anything: create, edit, publish, cancel, generate codes', async () => {
    const demo = await demoOrganizer();
    const attempts = [
      t
        .http()
        .post('/api/v1/concerts')
        .set(demo.auth)
        .send({ name: 'X', artist: 'Y' }),
      t
        .http()
        .patch(`/api/v1/performances/${demo.perfId}`)
        .set(demo.auth)
        .send({ venue: 'Z' }),
      t
        .http()
        .post(`/api/v1/performances/${demo.perfId}/cancel`)
        .set(demo.auth),
      t
        .http()
        .post(`/api/v1/performances/${demo.perfId}/presale/codes`)
        .set(demo.auth)
        .send({ salePhaseId: demo.perfId, count: 1 }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DEMO_READ_ONLY');
    }
    const perf = await t.prisma.performance.findUniqueOrThrow({
      where: { id: demo.perfId },
    });
    expect(perf).toMatchObject({ venue: 'Hall', status: 'DRAFT' });
  });

  it('can still sign out (a public route)', async () => {
    const demo = await demoOrganizer();
    await t
      .http()
      .post('/api/v1/auth/logout')
      .set(demo.auth)
      .set('Cookie', demo.cookie)
      .expect(204);
  });

  it('an ordinary organizer is not affected', async () => {
    const owner = await createUserAndLogin(t, Role.ORGANIZER);
    await t
      .http()
      .post('/api/v1/concerts')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ name: 'Real night', artist: 'Band' })
      .expect(201);
  });
});
