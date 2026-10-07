import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Role } from '../src/generated/prisma/client.js';
import { HoldGateService } from '../src/modules/reservations/gate/hold-gate.service.js';
import { ReleaseService } from '../src/modules/reservations/release.service.js';
import {
  expireJobId,
  RESERVATIONS_QUEUE,
} from '../src/queue/queue.constants.js';
import { WorkerModule } from '../src/worker.module.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  testRedis,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;
const GRACE_SECONDS = 120;

interface Customer {
  id: string;
  token: string;
}

async function until(
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('condition not met in time');
}

/**
 * Phase 4: holds expire (flow C), owners can cancel, a worker started late
 * still releases everything (I3), and the Redis gate never decides alone.
 */
describe('Expiry, cancellation and the Redis gate (e2e)', () => {
  let t: TestApp;
  let perfId: string;
  let seatIds: string[];
  let gaZone: string;

  const customer = async (): Promise<Customer> => {
    const u = await t.prisma.user.create({
      data: {
        email: `${randomUUID()}@test.local`,
        passwordHash: 'x',
        fullName: 'C',
      },
    });
    return {
      id: u.id,
      token: await t.app
        .get(JwtService)
        .signAsync({ sub: u.id, role: Role.CUSTOMER }),
    };
  };

  const reserve = (c: Customer, body: object) =>
    t
      .http()
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${c.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ performanceId: perfId, ...body });

  /** Moves an order's expires_at so it is overdue by `seconds` past the grace. */
  const makeOverdue = (orderId: string, seconds = 1) =>
    t.prisma.order.update({
      where: { id: orderId },
      data: {
        expiresAt: new Date(Date.now() - (GRACE_SECONDS + seconds) * 1000),
      },
    });

  const seatStatus = async (id: string) =>
    (await t.prisma.seat.findUniqueOrThrow({ where: { id } })).status;
  const gaHeld = async () =>
    (await t.prisma.zone.findUniqueOrThrow({ where: { id: gaZone } }))
      .heldCount;
  const orderStatus = async (id: string) =>
    (await t.prisma.order.findUniqueOrThrow({ where: { id } })).status;

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
      .send({ name: 'Expiry night', artist: 'Band' })
      .expect(201);
    const startsAt = new Date(Date.now() + 30 * DAY);
    const res = await t
      .http()
      .post(`/api/v1/concerts/${concert.body.id}/performances`)
      .set(auth)
      .send({
        venue: 'Hall',
        startsAt,
        zones: [
          {
            name: 'SEATS',
            type: 'SEATED',
            price: 1_000_000,
            rows: 1,
            seatsPerRow: 6,
          },
          { name: 'GA', type: 'STANDING', price: 500_000, capacity: 10 },
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
    perfId = res.body.id;
    gaZone = (res.body.zones as { id: string; name: string }[]).find(
      (z) => z.name === 'GA',
    )!.id;
    seatIds = (
      await t.prisma.seat.findMany({
        where: { performanceId: perfId },
        orderBy: { seatNumber: 'asc' },
      })
    ).map((s) => s.id);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('flow C: expiry', () => {
    it('releases seats, standing tickets and Redis keys exactly once', async () => {
      const c = await customer();
      const order = await reserve(c, {
        seatIds: [seatIds[0]],
        standing: [{ zoneId: gaZone, quantity: 2 }],
      }).expect(201);
      expect(await testRedis.get(`seat:hold:${seatIds[0]}`)).not.toBeNull();
      expect(await testRedis.get(`zone:avail:${gaZone}`)).toBe('8');

      await makeOverdue(order.body.id);
      const release = t.app.get(ReleaseService);
      await expect(release.expire(order.body.id)).resolves.toBe(true);

      expect(await orderStatus(order.body.id)).toBe('EXPIRED');
      expect(await seatStatus(seatIds[0])).toBe('AVAILABLE');
      expect(await gaHeld()).toBe(0);
      const released = await t.prisma.orderItem.count({
        where: { orderId: order.body.id, releasedAt: { not: null } },
      });
      expect(released).toBe(3);
      expect(await testRedis.get(`seat:hold:${seatIds[0]}`)).toBeNull();
      expect(await testRedis.get(`zone:avail:${gaZone}`)).toBe('10');

      // A second expiry (duplicate job, sweep) changes nothing.
      await expect(release.expire(order.body.id)).resolves.toBe(false);
      expect(await gaHeld()).toBe(0);
      expect(await testRedis.get(`zone:avail:${gaZone}`)).toBe('10');
    });

    it('waits for the payment grace period before releasing', async () => {
      const c = await customer();
      const order = await reserve(c, { seatIds: [seatIds[1]] }).expect(201);
      // Past expires_at, but still inside the grace window.
      await t.prisma.order.update({
        where: { id: order.body.id },
        data: { expiresAt: new Date(Date.now() - 30_000) },
      });
      await expect(
        t.app.get(ReleaseService).expire(order.body.id),
      ).resolves.toBe(false);
      expect(await seatStatus(seatIds[1])).toBe('HELD');
    });

    it('never releases an order that is no longer PENDING (e.g. paid)', async () => {
      const c = await customer();
      const order = await reserve(c, { seatIds: [seatIds[2]] }).expect(201);
      await makeOverdue(order.body.id);
      await t.prisma.order.update({
        where: { id: order.body.id },
        data: { status: 'PAID' },
      });
      await expect(
        t.app.get(ReleaseService).expire(order.body.id),
      ).resolves.toBe(false);
      expect(await seatStatus(seatIds[2])).toBe('HELD');
    });

    it('a released seat can be sold again', async () => {
      const [a, b] = [await customer(), await customer()];
      const first = await reserve(a, { seatIds: [seatIds[3]] }).expect(201);
      await reserve(b, { seatIds: [seatIds[3]] }).expect(409);
      await makeOverdue(first.body.id);
      await t.app.get(ReleaseService).expire(first.body.id);
      await reserve(b, { seatIds: [seatIds[3]] }).expect(201);
    });
  });

  describe('I3: no seat stays HELD after its hold, even if the worker was down', () => {
    let worker: INestApplicationContext | undefined;

    afterEach(async () => {
      await worker?.close();
      worker = undefined;
    });

    async function startWorker(): Promise<void> {
      const moduleRef = await Test.createTestingModule({
        imports: [WorkerModule],
      }).compile();
      worker = moduleRef.createNestApplication({ logger: false });
      await worker.init();
    }

    it('a job that came due while no worker ran is processed when one starts', async () => {
      const c = await customer();
      const order = await reserve(c, { seatIds: [seatIds[4]] }).expect(201);
      const queue = t.app.get<Queue>(getQueueToken(RESERVATIONS_QUEUE));
      const job = await queue.getJob(expireJobId(order.body.id));
      expect(job).toBeDefined();

      // The hold ends while no worker is running: the job becomes due and waits.
      await makeOverdue(order.body.id);
      await job!.changeDelay(0);
      await new Promise((r) => setTimeout(r, 500));
      expect(await seatStatus(seatIds[4])).toBe('HELD');

      await startWorker();
      await until(async () => (await orderStatus(order.body.id)) === 'EXPIRED');
      expect(await seatStatus(seatIds[4])).toBe('AVAILABLE');
    });

    it('the sweep releases overdue orders whose job was lost', async () => {
      const c = await customer();
      const orders = await Promise.all([
        reserve(c, { seatIds: [seatIds[0]] }).expect(201),
        reserve(c, { standing: [{ zoneId: gaZone, quantity: 3 }] }).expect(201),
      ]);
      const queue = t.app.get<Queue>(getQueueToken(RESERVATIONS_QUEUE));
      for (const o of orders) {
        await makeOverdue(o.body.id);
        await (await queue.getJob(expireJobId(o.body.id)))?.remove();
      }

      await startWorker();
      await until(async () => {
        const statuses = await Promise.all(
          orders.map((o) => orderStatus(o.body.id)),
        );
        return statuses.every((s) => s === 'EXPIRED');
      });
      expect(await seatStatus(seatIds[0])).toBe('AVAILABLE');
      expect(await gaHeld()).toBe(0);
    });
  });

  describe('cancel', () => {
    it('the owner cancels a PENDING order and its tickets are freed at once', async () => {
      const [owner, other] = [await customer(), await customer()];
      const order = await reserve(owner, {
        seatIds: [seatIds[5]],
        standing: [{ zoneId: gaZone, quantity: 1 }],
      }).expect(201);
      const cancel = (c: Customer) =>
        t
          .http()
          .post(`/api/v1/orders/${order.body.id}/cancel`)
          .set('Authorization', `Bearer ${c.token}`);

      expect((await cancel(other).expect(404)).body.code).toBe(
        'ORDER_NOT_FOUND',
      );
      await cancel(owner).expect(204);
      expect(await orderStatus(order.body.id)).toBe('CANCELLED');
      expect(await seatStatus(seatIds[5])).toBe('AVAILABLE');
      expect(await gaHeld()).toBe(0);
      expect((await cancel(owner).expect(409)).body.code).toBe('INVALID_STATE');
      await reserve(other, { seatIds: [seatIds[5]] }).expect(201);
    });
  });

  describe('the Redis gate filters, PostgreSQL decides', () => {
    it('rejects a seat already held in Redis without touching the database', async () => {
      const c = await customer();
      // A key the database knows nothing about: only the gate can refuse.
      await testRedis.set(
        `seat:hold:${seatIds[0]}`,
        'someone-else',
        'PX',
        60_000,
      );
      const res = await reserve(c, { seatIds: [seatIds[0]] }).expect(409);
      expect(res.body.code).toBe('SEAT_UNAVAILABLE');
      expect(await t.prisma.order.count()).toBe(0);
      await testRedis.del(`seat:hold:${seatIds[0]}`);
      await reserve(c, { seatIds: [seatIds[0]] }).expect(201);
    });

    it('with Redis wiped, the database still refuses a double sale (I1)', async () => {
      const [a, b] = [await customer(), await customer()];
      await reserve(a, { seatIds: [seatIds[1]] }).expect(201);
      await testRedis.flushdb();
      const res = await reserve(b, { seatIds: [seatIds[1]] }).expect(409);
      expect(res.body.code).toBe('SEAT_UNAVAILABLE');
      const active = await t.prisma.orderItem.count({
        where: { seatId: seatIds[1], releasedAt: null },
      });
      expect(active).toBe(1);
    });

    it('rolls Redis back when the database refuses, so other seats stay sellable', async () => {
      const [a, b] = [await customer(), await customer()];
      await reserve(a, { seatIds: [seatIds[2]] }).expect(201);
      await testRedis.del(`seat:hold:${seatIds[2]}`); // Redis lost this key
      // The gate takes seats 2 and 3, then the database refuses seat 2.
      await reserve(b, { seatIds: [seatIds[2], seatIds[3]] }).expect(409);
      expect(await testRedis.get(`seat:hold:${seatIds[3]}`)).toBeNull();
      await reserve(b, { seatIds: [seatIds[3]] }).expect(201);
    });

    it('a retry of a committed request is replayed, not counted twice', async () => {
      const c = await customer();
      const key = randomUUID();
      const send = () =>
        t
          .http()
          .post('/api/v1/reservations')
          .set('Authorization', `Bearer ${c.token}`)
          .set('Idempotency-Key', key)
          .send({
            performanceId: perfId,
            standing: [{ zoneId: gaZone, quantity: 2 }],
          });
      const first = await send().expect(201);
      const retry = await send().expect(201);
      expect(retry.body.id).toBe(first.body.id);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(await testRedis.get(`zone:avail:${gaZone}`)).toBe('8');
      expect(await gaHeld()).toBe(2);
    });

    it('builds a missing standing counter from PostgreSQL and repairs drift', async () => {
      const c = await customer();
      await reserve(c, { standing: [{ zoneId: gaZone, quantity: 4 }] }).expect(
        201,
      );
      expect(await testRedis.get(`zone:avail:${gaZone}`)).toBe('6');

      const gate = t.app.get(HoldGateService);
      // Simulate a crash that left the counter too low and a stale marker.
      await testRedis.set(`zone:avail:${gaZone}`, '0');
      await testRedis.zadd(
        `zone:inflight:${gaZone}`,
        Date.now() - 120_000,
        'crashed',
      );
      const report = await gate.reconcile();
      expect(report.corrected).toEqual([{ zoneId: gaZone, from: '0', to: 6 }]);
      expect(await testRedis.get(`zone:avail:${gaZone}`)).toBe('6');

      // A fresh in-flight hold means the database is about to change: wait.
      await testRedis.set(`zone:avail:${gaZone}`, '1');
      await testRedis.zadd(`zone:inflight:${gaZone}`, Date.now(), 'running');
      expect((await gate.reconcile()).busy).toBe(1);
      expect(await testRedis.get(`zone:avail:${gaZone}`)).toBe('1');
    });
  });
});
