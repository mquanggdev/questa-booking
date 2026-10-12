import type { INestApplicationContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { Role } from '../src/generated/prisma/client.js';
import type { SeatsBatch } from '../src/modules/seats/seats-realtime.constants.js';
import { WorkerModule } from '../src/worker.module.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;

interface Customer {
  id: string;
  token: string;
}

interface Snapshot {
  seq: number;
  seats: { id: string; status: string }[];
  zones: { id: string; available: number }[];
}

async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

/**
 * Phase 7a: the realtime seat map. Holds, releases and payments in the API
 * are marked after commit; the worker's flusher publishes batches with a
 * seq; clients that start from a snapshot and apply batches with a greater
 * seq always end up with the database's state.
 */
describe('Realtime seat map (e2e)', () => {
  let t: TestApp;
  let worker: INestApplicationContext;
  let url: string;
  let perfId: string;
  let seatIds: string[];
  let gaZone: string;
  const sockets: Socket[] = [];

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

  const snapshot = async (): Promise<Snapshot> =>
    (await t.http().get(`/api/v1/performances/${perfId}/seats`).expect(200))
      .body as Snapshot;

  /** A connected client that joined the performance and records batches. */
  const watch = async () => {
    const socket = io(`${url}/seats`, {
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    const batches: SeatsBatch[] = [];
    socket.on('seats.batch', (b: SeatsBatch) => batches.push(b));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const ack = (await socket.emitWithAck('join', {
      performanceId: perfId,
    })) as { instance: string; seq: number };
    return { socket, batches, ack };
  };

  beforeAll(async () => {
    t = await createTestApp({ websockets: true });
    await t.app.listen(0, '127.0.0.1');
    const server = t.app.getHttpServer() as unknown as {
      address(): AddressInfo;
    };
    url = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    // The worker publishes the batches (every SEAT_BROADCAST_EVERY_MS).
    // Started after the reset: wiping Redis under a running worker breaks
    // its BullMQ schedules.
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    worker = moduleRef.createNestApplication({ logger: false });
    await worker.init();
    const organizer = await createUserAndLogin(t, Role.ORGANIZER);
    const auth = { Authorization: `Bearer ${organizer.accessToken}` };
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(auth)
      .send({ name: 'Realtime night', artist: 'Band' })
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
            rows: 3,
            seatsPerRow: 10,
          },
          { name: 'GA', type: 'STANDING', price: 500_000, capacity: 50 },
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
    perfId = res.body.id;
    await t
      .http()
      .post(`/api/v1/performances/${perfId}/publish`)
      .set(auth)
      .expect(200);
    gaZone = (res.body.zones as { id: string; name: string }[]).find(
      (z) => z.name === 'GA',
    )!.id;
    seatIds = (
      await t.prisma.seat.findMany({
        where: { performanceId: perfId },
        orderBy: [{ rowLabel: 'asc' }, { seatNumber: 'asc' }],
      })
    ).map((s) => s.id);
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    await worker.close();
  });

  afterAll(async () => {
    await t.close();
  });

  it('join answers with this replica and the current seq; the snapshot carries the same seq', async () => {
    const { ack } = await watch();
    expect(typeof ack.instance).toBe('string');
    expect(ack.seq).toBe(0);
    expect((await snapshot()).seq).toBe(0);
  });

  it('a hold is pushed as one batch: seats HELD, zones updated, seq + 1', async () => {
    const { batches } = await watch();
    const before = await snapshot();
    const c = await customer();
    await reserve(c, {
      seatIds: [seatIds[0], seatIds[1]],
      standing: [{ zoneId: gaZone, quantity: 3 }],
    }).expect(201);

    await until(() => batches.length >= 1);
    const [batch] = batches;
    expect(batch.performanceId).toBe(perfId);
    expect(batch.seq).toBe(before.seq + 1);
    expect(batch.seats).toEqual(
      expect.arrayContaining([
        { id: seatIds[0], status: 'HELD' },
        { id: seatIds[1], status: 'HELD' },
      ]),
    );
    expect(batch.zones).toEqual(
      expect.arrayContaining([{ id: gaZone, available: 47 }]),
    );
    expect((await snapshot()).seq).toBe(batch.seq);
  });

  it('cancelling and paying are pushed too (AVAILABLE, then SOLD)', async () => {
    const { batches } = await watch();
    const c = await customer();
    const cancelled = await reserve(c, { seatIds: [seatIds[2]] }).expect(201);
    await t
      .http()
      .post(`/api/v1/orders/${cancelled.body.id}/cancel`)
      .set('Authorization', `Bearer ${c.token}`)
      .expect(204);
    await until(() =>
      batches.some((b) =>
        b.seats.some((s) => s.id === seatIds[2] && s.status === 'AVAILABLE'),
      ),
    );

    const paid = await reserve(c, { seatIds: [seatIds[3]] }).expect(201);
    const pay = await t
      .http()
      .post(`/api/v1/orders/${paid.body.id}/pay`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ provider: 'fake' })
      .expect(201);
    const txnRef = new URL(pay.body.checkoutUrl as string).searchParams.get(
      'txnRef',
    );
    await t
      .http()
      .post('/api/v1/payments/fake/complete')
      .send({ txnRef, outcome: 'success' })
      .expect(200);
    await until(() =>
      batches.some((b) =>
        b.seats.some((s) => s.id === seatIds[3] && s.status === 'SOLD'),
      ),
    );
    // Batches arrive in seq order, one apart.
    const seqs = batches.map((b) => b.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('a client that starts from a snapshot in the middle of a rush converges to the database', async () => {
    // A client joins first (so no batch is missed), then takes its snapshot
    // while 24 customers hold seats and standing tickets concurrently.
    const { batches } = await watch();
    const customers = await Promise.all(
      Array.from({ length: 24 }, () => customer()),
    );
    const rush = Promise.all(
      customers.map((c, i) =>
        reserve(
          c,
          i % 3 === 0
            ? { standing: [{ zoneId: gaZone, quantity: 2 }] }
            : { seatIds: [seatIds[i], seatIds[(i + 7) % 30]] },
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 40));
    const snap = await snapshot();
    await rush;

    // Wait until everything is published: the seq stops moving.
    let last = -1;
    await until(async () => {
      const seq = (await snapshot()).seq;
      const settled = seq === last && batches.at(-1)?.seq === seq;
      last = seq;
      if (!settled) await new Promise((r) => setTimeout(r, 400));
      return settled;
    }, 15_000);

    // The client's view: snapshot + batches with a greater seq, in order.
    const seats = new Map(snap.seats.map((s) => [s.id, s.status]));
    const zones = new Map(snap.zones.map((z) => [z.id, z.available]));
    let seq = snap.seq;
    for (const b of [...batches].sort((a, b) => a.seq - b.seq)) {
      if (b.seq <= seq) continue;
      expect(b.seq).toBe(seq + 1); // no gap
      for (const s of b.seats) seats.set(s.id, s.status);
      for (const z of b.zones) zones.set(z.id, z.available);
      seq = b.seq;
    }

    const truth = await snapshot();
    expect(seq).toBe(truth.seq);
    expect(Object.fromEntries(seats)).toEqual(
      Object.fromEntries(truth.seats.map((s) => [s.id, s.status])),
    );
    expect(Object.fromEntries(zones)).toEqual(
      Object.fromEntries(truth.zones.map((z) => [z.id, z.available])),
    );
  });

  it('rejects a join without a valid performance id', async () => {
    const { socket } = await watch();
    const error = new Promise<unknown>((resolve) =>
      socket.once('exception', resolve),
    );
    socket.emit('join', { performanceId: 'not-a-uuid' });
    await expect(error).resolves.toMatchObject({
      message: 'performanceId must be a UUID',
    });
  });
});
