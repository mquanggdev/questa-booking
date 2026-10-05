import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { Role } from '../src/generated/prisma/client.js';
import {
  SeatsService,
  type SeatHoldStrategy,
} from '../src/modules/seats/seats.service.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;

interface Perf {
  id: string;
  zones: { id: string; name: string }[];
}
interface Customer {
  id: string;
  token: string;
}

/**
 * Phase 3: the double-sell guards, proven with truly concurrent requests.
 * Every test fires requests together (Promise.all) and then checks the
 * database itself, not just the HTTP answers.
 */
describe('Invariants under concurrency (e2e)', () => {
  let t: TestApp;
  let perf: Perf;
  let seatIds: string[];

  const zoneId = (name: string) => {
    const z = perf.zones.find((x) => x.name === name);
    if (!z) throw new Error(`zone ${name}`);
    return z.id;
  };

  /** Many customers fast: insert directly and sign tokens, skipping argon2 logins. */
  async function customers(n: number): Promise<Customer[]> {
    const jwt = t.app.get(JwtService);
    const rows = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        t.prisma.user.create({
          data: {
            email: `c${i}-${randomUUID()}@test.local`,
            passwordHash: 'x',
            fullName: `C${i}`,
          },
        }),
      ),
    );
    return Promise.all(
      rows.map(async (u) => ({
        id: u.id,
        token: await jwt.signAsync({ sub: u.id, role: Role.CUSTOMER }),
      })),
    );
  }

  const reserve = (c: Customer, body: object, key: string = randomUUID()) =>
    t
      .http()
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${c.token}`)
      .set('Idempotency-Key', key)
      .send({ performanceId: perf.id, ...body });

  /** Active (not released) items of PENDING or PAID orders. */
  const activeItems = (where: {
    seatId?: string;
    zoneId?: string;
    userId?: string;
  }) =>
    t.prisma.orderItem.count({
      where: {
        releasedAt: null,
        seatId: where.seatId,
        zoneId: where.zoneId,
        order: { status: { in: ['PENDING', 'PAID'] }, userId: where.userId },
      },
    });

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    const organizer = await createUserAndLogin(t, Role.ORGANIZER);
    const auth = { Authorization: `Bearer ${organizer.accessToken}` };
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(auth)
      .send({ name: 'Race night', artist: 'Band' })
      .expect(201);
    const startsAt = new Date(Date.now() + 30 * DAY);
    const res = await t
      .http()
      .post(`/api/v1/concerts/${concert.body.id}/performances`)
      .set(auth)
      .send({
        venue: 'Hall',
        startsAt,
        maxTicketsPerUser: 4,
        zones: [
          {
            name: 'SEATS',
            type: 'SEATED',
            price: 1_000_000,
            rows: 1,
            seatsPerRow: 10,
          },
          { name: 'GA', type: 'STANDING', price: 500_000, capacity: 5 },
          { name: 'BIG GA', type: 'STANDING', price: 300_000, capacity: 1000 },
        ],
        salePhases: [
          {
            type: 'GENERAL',
            startsAt: new Date(Date.now() - DAY),
            endsAt: new Date(startsAt.getTime() - DAY),
          },
        ],
      })
      .expect(201);
    await t
      .http()
      .post(`/api/v1/performances/${res.body.id}/publish`)
      .set(auth)
      .expect(200);
    perf = res.body as Perf;
    const seats = await t.prisma.seat.findMany({
      where: { performanceId: perf.id },
      orderBy: { seatNumber: 'asc' },
    });
    seatIds = seats.map((s) => s.id);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('I1: a seat belongs to at most one active order', () => {
    it('20 customers race for one seat over HTTP: exactly one wins', async () => {
      const buyers = await customers(20);
      const results = await Promise.all(
        buyers.map((c) => reserve(c, { seatIds: [seatIds[0]] })),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(
        statuses.filter((s) => s !== 201 && s !== 409 && s !== 503),
      ).toEqual([]);
      expect(await activeItems({ seatId: seatIds[0] })).toBe(1);
    });

    it.each<SeatHoldStrategy>(['conditional', 'pessimistic', 'optimistic'])(
      '%s strategy: overlapping multi-seat holds never share a seat',
      async (strategy) => {
        const seats = t.app.get(SeatsService);
        const pool = seatIds.slice(0, 4);
        // 12 transactions, each wanting 3 of the same 4 seats, in random order.
        const wanted = Array.from({ length: 12 }, () =>
          [...pool].sort(() => Math.random() - 0.5).slice(0, 3),
        );
        const results = await Promise.allSettled(
          wanted.map((ids) =>
            t.prisma.$transaction((tx) =>
              seats.hold(tx, perf.id, ids, strategy),
            ),
          ),
        );
        const won = results.flatMap((r) =>
          r.status === 'fulfilled' ? r.value.map((s) => s.id) : [],
        );
        // No seat may appear in two successful holds.
        expect(new Set(won).size).toBe(won.length);
        expect(won.length).toBeGreaterThan(0);
        const held = await t.prisma.seat.count({
          where: { id: { in: pool }, status: 'HELD' },
        });
        expect(held).toBe(won.length);
      },
    );

    it.each<SeatHoldStrategy>(['conditional', 'pessimistic', 'optimistic'])(
      '%s strategy: 15 transactions for one seat, exactly one holds it',
      async (strategy) => {
        const seats = t.app.get(SeatsService);
        const results = await Promise.allSettled(
          Array.from({ length: 15 }, () =>
            t.prisma.$transaction((tx) =>
              seats.hold(tx, perf.id, [seatIds[1]], strategy),
            ),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      },
    );

    it('the partial unique index rejects a second active owner, but not a released one', async () => {
      const [a, b] = await customers(2);
      const first = await reserve(a, { seatIds: [seatIds[2]] }).expect(201);
      const order = await t.prisma.order.create({
        data: {
          userId: b.id,
          performanceId: perf.id,
          totalAmount: 0,
          expiresAt: new Date(Date.now() + DAY),
          idempotencyKey: randomUUID(),
          requestHash: '',
        },
      });
      const zone = zoneId('SEATS');
      const duplicate = () =>
        t.prisma.orderItem.create({
          data: {
            orderId: order.id,
            zoneId: zone,
            seatId: seatIds[2],
            price: 0,
          },
        });
      await expect(duplicate()).rejects.toMatchObject({ code: 'P2002' });

      // Once the first order's item is released, the seat can be sold again.
      await t.prisma.orderItem.updateMany({
        where: { orderId: first.body.id },
        data: { releasedAt: new Date() },
      });
      await expect(duplicate()).resolves.toBeDefined();
    });
  });

  describe('I9: standing tickets never exceed capacity', () => {
    it('12 customers race for 5 places: exactly 5 tickets and the counter agrees', async () => {
      const buyers = await customers(12);
      const results = await Promise.all(
        buyers.map((c) =>
          reserve(c, { standing: [{ zoneId: zoneId('GA'), quantity: 1 }] }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      const zone = await t.prisma.zone.findUniqueOrThrow({
        where: { id: zoneId('GA') },
      });
      expect(zone.heldCount + zone.soldCount).toBe(5);
      expect(await activeItems({ zoneId: zoneId('GA') })).toBe(5);
    });

    it('the CHECK constraint refuses counters above capacity', async () => {
      await expect(
        t.prisma
          .$executeRaw`UPDATE zones SET held_count = capacity + 1 WHERE id = ${zoneId('GA')}::uuid`,
      ).rejects.toMatchObject({ code: 'P2010' });
    });
  });

  describe('I10: one account never exceeds the ticket limit', () => {
    it('8 parallel requests of 1 ticket from one account: exactly 4 succeed', async () => {
      const [c] = await customers(1);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          reserve(c, { standing: [{ zoneId: zoneId('BIG GA'), quantity: 1 }] }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(4);
      for (const r of results.filter((x) => x.status !== 201)) {
        expect(r.body.code).toBe('TICKET_LIMIT_REACHED');
      }
      expect(await activeItems({ userId: c.id })).toBe(4);
    });

    it('the limit counts every active order, seats and standing together', async () => {
      const [c] = await customers(1);
      await reserve(c, { seatIds: [seatIds[3], seatIds[4]] }).expect(201);
      await reserve(c, {
        standing: [{ zoneId: zoneId('BIG GA'), quantity: 2 }],
      }).expect(201);
      const over = await reserve(c, { seatIds: [seatIds[5]] }).expect(409);
      expect(over.body).toMatchObject({
        code: 'TICKET_LIMIT_REACHED',
        details: { alreadyHeld: 4, requested: 1, max: 4 },
      });
    });
  });

  describe('I5: one Idempotency-Key, one order', () => {
    it('a retry returns the same order and holds nothing new', async () => {
      const [c] = await customers(1);
      const key = randomUUID();
      const first = await reserve(c, { seatIds: [seatIds[6]] }, key).expect(
        201,
      );
      const retry = await reserve(c, { seatIds: [seatIds[6]] }, key).expect(
        201,
      );

      expect(retry.body.id).toBe(first.body.id);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await t.prisma.order.count({ where: { userId: c.id } })).toBe(1);
    });

    it('6 concurrent requests with one key create exactly one order', async () => {
      const [c] = await customers(1);
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          reserve(
            c,
            { standing: [{ zoneId: zoneId('BIG GA'), quantity: 2 }] },
            key,
          ),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await t.prisma.order.count({ where: { userId: c.id } })).toBe(1);
      const zone = await t.prisma.zone.findUniqueOrThrow({
        where: { id: zoneId('BIG GA') },
      });
      expect(zone.heldCount).toBe(2);
    });

    it('rejects a key reused for a different request, and a missing key', async () => {
      const [c] = await customers(1);
      const key = randomUUID();
      await reserve(c, { seatIds: [seatIds[7]] }, key).expect(201);
      const reused = await reserve(c, { seatIds: [seatIds[8]] }, key).expect(
        422,
      );
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const missing = await t
        .http()
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${c.token}`)
        .send({ performanceId: perf.id, seatIds: [seatIds[9]] })
        .expect(400);
      expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });
});
