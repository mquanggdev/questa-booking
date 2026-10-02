import { Role } from '../src/generated/prisma/client.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;

function performanceBody(overrides: object = {}) {
  const startsAt = new Date(Date.now() + 30 * DAY);
  return {
    venue: 'Test Arena',
    startsAt: startsAt.toISOString(),
    zones: [
      {
        name: 'VIP',
        type: 'SEATED',
        price: 3_000_000,
        rows: 2,
        seatsPerRow: 5,
      },
      {
        name: 'CAT 1',
        type: 'SEATED',
        price: 1_500_000,
        rows: 27,
        seatsPerRow: 2,
      },
      { name: 'GA', type: 'STANDING', price: 800_000, capacity: 100 },
    ],
    salePhases: [
      {
        type: 'GENERAL',
        startsAt: new Date(Date.now() - DAY).toISOString(),
        endsAt: new Date(startsAt.getTime() - DAY).toISOString(),
      },
    ],
    ...overrides,
  };
}

describe('Concerts and performances (e2e)', () => {
  let t: TestApp;
  let organizer: Awaited<ReturnType<typeof createUserAndLogin>>;
  let otherOrganizer: Awaited<ReturnType<typeof createUserAndLogin>>;
  let customer: Awaited<ReturnType<typeof createUserAndLogin>>;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    organizer = await createUserAndLogin(t, Role.ORGANIZER);
    otherOrganizer = await createUserAndLogin(t, Role.ORGANIZER);
    customer = await createUserAndLogin(t, Role.CUSTOMER);
  });

  afterAll(async () => {
    await t.close();
  });

  async function createConcert(token = organizer.accessToken) {
    const res = await t
      .http()
      .post('/api/v1/concerts')
      .set(as(token))
      .send({ name: 'Questa Fest', artist: 'The Band' })
      .expect(201);
    return res.body as { id: string };
  }

  async function createPerformance(
    concertId: string,
    body = performanceBody(),
  ) {
    const res = await t
      .http()
      .post(`/api/v1/concerts/${concertId}/performances`)
      .set(as(organizer.accessToken))
      .send(body)
      .expect(201);
    return res.body as {
      id: string;
      status: string;
      zones: { id: string; name: string; capacity: number }[];
    };
  }

  describe('permissions', () => {
    it('only organizers can create concerts', async () => {
      const res = await t
        .http()
        .post('/api/v1/concerts')
        .set(as(customer.accessToken))
        .send({ name: 'X', artist: 'Y' })
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      await t
        .http()
        .post('/api/v1/concerts')
        .send({ name: 'X', artist: 'Y' })
        .expect(401);
    });

    it("an organizer cannot add performances to another organizer's concert", async () => {
      const concert = await createConcert(otherOrganizer.accessToken);
      const res = await t
        .http()
        .post(`/api/v1/concerts/${concert.id}/performances`)
        .set(as(organizer.accessToken))
        .send(performanceBody())
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  describe('creating a performance', () => {
    it('creates zones, the seat layout and sale phases as a DRAFT', async () => {
      const concert = await createConcert();
      const perf = await createPerformance(concert.id);

      expect(perf.status).toBe('DRAFT');
      expect(perf.zones.map((z) => [z.name, z.capacity])).toEqual([
        ['VIP', 10],
        ['CAT 1', 54],
        ['GA', 100],
      ]);
      expect(
        await t.prisma.seat.count({ where: { performanceId: perf.id } }),
      ).toBe(64);
    });

    it('reports cross-field problems all at once', async () => {
      const concert = await createConcert();
      const startsAt = new Date(Date.now() + 10 * DAY);
      const res = await t
        .http()
        .post(`/api/v1/concerts/${concert.id}/performances`)
        .set(as(organizer.accessToken))
        .send(
          performanceBody({
            startsAt: startsAt.toISOString(),
            zones: [
              { name: 'A', type: 'SEATED', price: 1, rows: 1, seatsPerRow: 1 },
              { name: 'a', type: 'STANDING', price: 1, capacity: 1 },
            ],
            salePhases: [
              {
                type: 'PRESALE',
                startsAt: new Date(Date.now() + DAY).toISOString(),
                endsAt: new Date(Date.now() + 3 * DAY).toISOString(),
              },
              {
                type: 'GENERAL',
                startsAt: new Date(Date.now() + 2 * DAY).toISOString(),
                endsAt: new Date(Date.now() + 20 * DAY).toISOString(),
              },
            ],
          }),
        )
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
      const fields = (res.body.details as { field: string }[]).map(
        (d) => d.field,
      );
      expect(fields).toEqual(
        expect.arrayContaining([
          'zones.1.name',
          'salePhases.1',
          'salePhases.1.endsAt',
        ]),
      );
    });

    it('requires rows and seatsPerRow for SEATED zones', async () => {
      const concert = await createConcert();
      const res = await t
        .http()
        .post(`/api/v1/concerts/${concert.id}/performances`)
        .set(as(organizer.accessToken))
        .send(
          performanceBody({ zones: [{ name: 'A', type: 'SEATED', price: 1 }] }),
        )
        .expect(400);
      const fields = (res.body.details as { field: string }[]).map(
        (d) => d.field,
      );
      expect(fields).toEqual(
        expect.arrayContaining(['zones.0.rows', 'zones.0.seatsPerRow']),
      );
    });
  });

  describe('visibility and publishing', () => {
    it('hides drafts from the public but shows them to the owner', async () => {
      const concert = await createConcert();
      const perf = await createPerformance(concert.id);

      await t.http().get(`/api/v1/performances/${perf.id}`).expect(404);
      await t
        .http()
        .get(`/api/v1/performances/${perf.id}`)
        .set(as(otherOrganizer.accessToken))
        .expect(404);
      await t
        .http()
        .get(`/api/v1/performances/${perf.id}`)
        .set(as(organizer.accessToken))
        .expect(200);

      const list = await t.http().get('/api/v1/concerts').expect(200);
      expect(list.body.total).toBe(0);
      await t.http().get(`/api/v1/concerts/${concert.id}`).expect(404);
    });

    it('publishing makes the performance public, exactly once', async () => {
      const concert = await createConcert();
      const perf = await createPerformance(concert.id);

      const published = await t
        .http()
        .post(`/api/v1/performances/${perf.id}/publish`)
        .set(as(organizer.accessToken))
        .expect(200);
      expect(published.body.status).toBe('PUBLISHED');

      const again = await t
        .http()
        .post(`/api/v1/performances/${perf.id}/publish`)
        .set(as(organizer.accessToken))
        .expect(409);
      expect(again.body.code).toBe('INVALID_STATE');

      const list = await t.http().get('/api/v1/concerts').expect(200);
      expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(list.body.items[0].performances).toHaveLength(1);
    });

    it('only the owner can publish or edit', async () => {
      const concert = await createConcert();
      const perf = await createPerformance(concert.id);
      await t
        .http()
        .post(`/api/v1/performances/${perf.id}/publish`)
        .set(as(otherOrganizer.accessToken))
        .expect(403);
      await t
        .http()
        .patch(`/api/v1/performances/${perf.id}`)
        .set(as(otherOrganizer.accessToken))
        .send({ venue: 'Elsewhere' })
        .expect(403);
    });

    it('the owner can edit venue and ticket limit', async () => {
      const concert = await createConcert();
      const perf = await createPerformance(concert.id);
      const res = await t
        .http()
        .patch(`/api/v1/performances/${perf.id}`)
        .set(as(organizer.accessToken))
        .send({ venue: 'New Arena', maxTicketsPerUser: 4 })
        .expect(200);
      expect(res.body).toMatchObject({
        venue: 'New Arena',
        maxTicketsPerUser: 4,
      });
    });
  });

  describe('seat map', () => {
    it('lists every seat in theatre row order and availability per zone', async () => {
      const concert = await createConcert();
      const perf = await createPerformance(concert.id);
      await t
        .http()
        .post(`/api/v1/performances/${perf.id}/publish`)
        .set(as(organizer.accessToken))
        .expect(200);

      const res = await t
        .http()
        .get(`/api/v1/performances/${perf.id}/seats`)
        .expect(200);
      const body = res.body as {
        zones: { name: string; available: number }[];
        seats: {
          zoneId: string;
          row: string;
          number: number;
          status: string;
        }[];
      };

      expect(body.seats).toHaveLength(64);
      expect(body.seats.every((s) => s.status === 'AVAILABLE')).toBe(true);
      expect(body.zones.map((z) => [z.name, z.available])).toEqual([
        ['VIP', 10],
        ['CAT 1', 54],
        ['GA', 100],
      ]);

      // CAT 1 has 27 rows: "Z" must come before "AA".
      const cat1 = perf.zones.find((z) => z.name === 'CAT 1');
      const rows = [
        ...new Set(
          body.seats.filter((s) => s.zoneId === cat1?.id).map((s) => s.row),
        ),
      ];
      expect(rows.slice(-3)).toEqual(['Y', 'Z', 'AA']);
    });

    it('rejects a malformed id with 400', async () => {
      const res = await t
        .http()
        .get('/api/v1/performances/not-a-uuid/seats')
        .expect(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });
  });
});
