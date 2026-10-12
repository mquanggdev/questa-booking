import { Role } from '../src/generated/prisma/client.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  testRedis,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Phase 7a: catalog reads are cached in Redis and every write through the
 * API invalidates what it changed. The cache holds raw records; visibility
 * (drafts for their organizer only) is applied on every read.
 */
describe('Catalog cache (e2e)', () => {
  let t: TestApp;
  let auth: { Authorization: string };
  let concertId: string;

  const createPerformance = async (venue: string) => {
    const startsAt = new Date(Date.now() + 30 * DAY);
    const res = await t
      .http()
      .post(`/api/v1/concerts/${concertId}/performances`)
      .set(auth)
      .send({
        venue,
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
    return res.body.id as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    const organizer = await createUserAndLogin(t, Role.ORGANIZER);
    auth = { Authorization: `Bearer ${organizer.accessToken}` };
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(auth)
      .send({ name: 'Cached night', artist: 'Band' })
      .expect(201);
    concertId = concert.body.id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('serves repeated reads from Redis and shows an edit immediately', async () => {
    const id = await createPerformance('Old Hall');
    await t
      .http()
      .post(`/api/v1/performances/${id}/publish`)
      .set(auth)
      .expect(200);

    await t.http().get(`/api/v1/performances/${id}`).expect(200);
    expect(await testRedis.exists(`cache:performance:${id}`)).toBe(1);
    // Proof the second read comes from the cache: change the row behind the
    // API's back; the cached value is still served.
    await t.prisma.performance.update({
      where: { id },
      data: { venue: 'Sneaky' },
    });
    const cached = await t.http().get(`/api/v1/performances/${id}`).expect(200);
    expect(cached.body.venue).toBe('Old Hall');
    expect(new Date(cached.body.startsAt).getTime()).not.toBeNaN();

    // An edit through the API invalidates: the next read is fresh.
    await t
      .http()
      .patch(`/api/v1/performances/${id}`)
      .set(auth)
      .send({ venue: 'New Hall' })
      .expect(200);
    const fresh = await t.http().get(`/api/v1/performances/${id}`).expect(200);
    expect(fresh.body.venue).toBe('New Hall');
  });

  it('publishing shows up in the cached list and the concert detail', async () => {
    const id = await createPerformance('Hall');
    // Cache the list and the detail while the performance is still a draft.
    const empty = await t.http().get('/api/v1/concerts').expect(200);
    expect(empty.body.items).toHaveLength(0);
    await t.http().get(`/api/v1/concerts/${concertId}`).expect(404);

    await t
      .http()
      .post(`/api/v1/performances/${id}/publish`)
      .set(auth)
      .expect(200);

    const list = await t.http().get('/api/v1/concerts').expect(200);
    expect(list.body.items).toHaveLength(1);
    const detail = await t
      .http()
      .get(`/api/v1/concerts/${concertId}`)
      .expect(200);
    expect(detail.body.performances.map((p: { id: string }) => p.id)).toEqual([
      id,
    ]);
  });

  it('a draft cached by its organizer is never shown to anyone else', async () => {
    const published = await createPerformance('Public');
    await t
      .http()
      .post(`/api/v1/performances/${published}/publish`)
      .set(auth)
      .expect(200);
    const draft = await createPerformance('Secret');

    // The organizer reads first: the raw record with the draft is cached.
    const own = await t
      .http()
      .get(`/api/v1/concerts/${concertId}`)
      .set(auth)
      .expect(200);
    expect(own.body.performances).toHaveLength(2);
    await t.http().get(`/api/v1/performances/${draft}`).set(auth).expect(200);
    expect(await testRedis.exists(`cache:concert:${concertId}`)).toBe(1);

    // Then a visitor, served from the same cache entries.
    const visitor = await t
      .http()
      .get(`/api/v1/concerts/${concertId}`)
      .expect(200);
    expect(visitor.body.performances.map((p: { id: string }) => p.id)).toEqual([
      published,
    ]);
    await t.http().get(`/api/v1/performances/${draft}`).expect(404);
  });

  it('cancelling a performance invalidates its cached detail', async () => {
    const id = await createPerformance('Hall');
    await t
      .http()
      .post(`/api/v1/performances/${id}/publish`)
      .set(auth)
      .expect(200);
    await t.http().get(`/api/v1/performances/${id}`).expect(200);
    await t
      .http()
      .post(`/api/v1/performances/${id}/cancel`)
      .set(auth)
      .expect(200);
    const after = await t.http().get(`/api/v1/performances/${id}`).expect(200);
    expect(after.body.status).toBe('CANCELLED');
  });
});
