import { Role } from '../src/generated/prisma/client.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;

type User = Awaited<ReturnType<typeof createUserAndLogin>>;
interface Perf {
  id: string;
  zones: { id: string; name: string; type: string; price: number }[];
}

describe('Reservations (e2e), phase 2 baseline', () => {
  let t: TestApp;
  let organizer: User;
  let customer: User;
  let perf: Perf;
  let seatIds: string[];

  const as = (u: User) => ({ Authorization: `Bearer ${u.accessToken}` });
  const zone = (name: string) => {
    const z = perf.zones.find((x) => x.name === name);
    if (!z) throw new Error(`zone ${name}`);
    return z;
  };
  const reserve = (u: User, body: object) =>
    t.http().post('/api/v1/reservations').set(as(u)).send(body);

  async function createPerformance(saleOpen = true): Promise<Perf> {
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(as(organizer))
      .send({ name: 'Night', artist: 'Band' })
      .expect(201);
    const startsAt = new Date(Date.now() + 30 * DAY);
    const res = await t
      .http()
      .post(`/api/v1/concerts/${concert.body.id}/performances`)
      .set(as(organizer))
      .send({
        venue: 'Hall',
        startsAt,
        maxTicketsPerUser: 4,
        zones: [
          {
            name: 'VIP',
            type: 'SEATED',
            price: 2_000_000,
            rows: 1,
            seatsPerRow: 4,
          },
          { name: 'GA', type: 'STANDING', price: 500_000, capacity: 3 },
        ],
        salePhases: [
          saleOpen
            ? {
                type: 'GENERAL',
                startsAt: new Date(Date.now() - DAY),
                endsAt: new Date(startsAt.getTime() - DAY),
              }
            : {
                type: 'GENERAL',
                startsAt: new Date(Date.now() + DAY),
                endsAt: new Date(startsAt.getTime() - DAY),
              },
        ],
      })
      .expect(201);
    await t
      .http()
      .post(`/api/v1/performances/${res.body.id}/publish`)
      .set(as(organizer))
      .expect(200);
    return res.body as Perf;
  }

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    organizer = await createUserAndLogin(t, Role.ORGANIZER);
    customer = await createUserAndLogin(t, Role.CUSTOMER);
    perf = await createPerformance();
    const seats = await t.prisma.seat.findMany({
      where: { performanceId: perf.id },
      orderBy: { seatNumber: 'asc' },
    });
    seatIds = seats.map((s) => s.id);
  });

  afterAll(async () => {
    await t.close();
  });

  it('holds seats and standing tickets in one PENDING order', async () => {
    const before = Date.now();
    const res = await reserve(customer, {
      performanceId: perf.id,
      seatIds: seatIds.slice(0, 2),
      standing: [{ zoneId: zone('GA').id, quantity: 1 }],
    }).expect(201);

    expect(res.body).toMatchObject({
      performanceId: perf.id,
      status: 'PENDING',
      totalAmount: 2 * 2_000_000 + 500_000,
    });
    expect(res.body.items).toHaveLength(3);
    const expiresIn = new Date(res.body.expiresAt).getTime() - before;
    expect(expiresIn).toBeGreaterThan(590_000);
    expect(expiresIn).toBeLessThan(610_000);

    const held = await t.prisma.seat.count({
      where: { id: { in: seatIds.slice(0, 2) }, status: 'HELD' },
    });
    expect(held).toBe(2);
    const ga = await t.prisma.zone.findUniqueOrThrow({
      where: { id: zone('GA').id },
    });
    expect(ga.heldCount).toBe(1);
  });

  it('rejects a seat that is already held (requests one after another)', async () => {
    await reserve(customer, {
      performanceId: perf.id,
      seatIds: [seatIds[0]],
    }).expect(201);
    const other = await createUserAndLogin(t);
    const res = await reserve(other, {
      performanceId: perf.id,
      seatIds: [seatIds[0], seatIds[1]],
    }).expect(409);
    expect(res.body).toMatchObject({
      code: 'SEAT_UNAVAILABLE',
      details: { seatIds: [seatIds[0]] },
    });
    // The whole request failed, so seat 1 must not stay held.
    const seat1 = await t.prisma.seat.findUniqueOrThrow({
      where: { id: seatIds[1] },
    });
    expect(seat1.status).toBe('AVAILABLE');
    expect(await t.prisma.order.count()).toBe(1);
  });

  it('rejects standing tickets beyond capacity', async () => {
    await reserve(customer, {
      performanceId: perf.id,
      standing: [{ zoneId: zone('GA').id, quantity: 3 }],
    }).expect(201);
    const other = await createUserAndLogin(t);
    const res = await reserve(other, {
      performanceId: perf.id,
      standing: [{ zoneId: zone('GA').id, quantity: 1 }],
    }).expect(409);
    expect(res.body).toMatchObject({
      code: 'SOLD_OUT',
      details: { available: 0, requested: 1 },
    });
  });

  it('enforces the per-request ticket limit', async () => {
    const res = await reserve(customer, {
      performanceId: perf.id,
      seatIds,
      standing: [{ zoneId: zone('GA').id, quantity: 1 }],
    }).expect(400);
    expect(res.body).toMatchObject({
      code: 'TOO_MANY_TICKETS',
      details: { requested: 5, max: 4 },
    });
  });

  it('rejects empty selections, seats of another performance and seated zones as standing', async () => {
    const empty = await reserve(customer, { performanceId: perf.id }).expect(
      400,
    );
    expect(empty.body.code).toBe('INVALID_TICKET_SELECTION');

    const otherPerf = await createPerformance();
    const foreignSeat = await t.prisma.seat.findFirstOrThrow({
      where: { performanceId: otherPerf.id },
    });
    const foreign = await reserve(customer, {
      performanceId: perf.id,
      seatIds: [foreignSeat.id],
    }).expect(400);
    expect(foreign.body.code).toBe('INVALID_TICKET_SELECTION');

    const seatedAsStanding = await reserve(customer, {
      performanceId: perf.id,
      standing: [{ zoneId: zone('VIP').id, quantity: 1 }],
    }).expect(400);
    expect(seatedAsStanding.body.code).toBe('INVALID_TICKET_SELECTION');
  });

  it('refuses when no sale phase is open', async () => {
    const later = await createPerformance(false);
    const seat = await t.prisma.seat.findFirstOrThrow({
      where: { performanceId: later.id },
    });
    const res = await reserve(customer, {
      performanceId: later.id,
      seatIds: [seat.id],
    }).expect(409);
    expect(res.body.code).toBe('SALE_NOT_OPEN');
  });

  it('only customers can reserve', async () => {
    await reserve(organizer, {
      performanceId: perf.id,
      seatIds: [seatIds[0]],
    }).expect(403);
    await t
      .http()
      .post('/api/v1/reservations')
      .send({ performanceId: perf.id, seatIds: [seatIds[0]] })
      .expect(401);
  });

  it('shows the order to its owner only', async () => {
    const order = await reserve(customer, {
      performanceId: perf.id,
      seatIds: [seatIds[0]],
    }).expect(201);

    const mine = await t
      .http()
      .get('/api/v1/orders')
      .set(as(customer))
      .expect(200);
    expect(mine.body.map((o: { id: string }) => o.id)).toEqual([order.body.id]);
    await t
      .http()
      .get(`/api/v1/orders/${order.body.id}`)
      .set(as(customer))
      .expect(200);

    const other = await createUserAndLogin(t);
    const res = await t
      .http()
      .get(`/api/v1/orders/${order.body.id}`)
      .set(as(other))
      .expect(404);
    expect(res.body.code).toBe('ORDER_NOT_FOUND');
  });

  it('seat map reflects held seats and standing availability', async () => {
    await reserve(customer, {
      performanceId: perf.id,
      seatIds: [seatIds[0]],
      standing: [{ zoneId: zone('GA').id, quantity: 2 }],
    }).expect(201);
    const map = await t
      .http()
      .get(`/api/v1/performances/${perf.id}/seats`)
      .expect(200);
    const zones = Object.fromEntries(
      (map.body.zones as { name: string; available: number }[]).map((z) => [
        z.name,
        z.available,
      ]),
    );
    expect(zones).toEqual({ VIP: 3, GA: 1 });
  });
});
