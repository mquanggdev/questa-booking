import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { Role } from '../src/generated/prisma/client.js';
import { CatalogCacheService } from '../src/modules/concerts/catalog-cache.service.js';
import type {
  QueueAdmittedEvent,
  QueuePositionEvent,
} from '../src/modules/waiting-room/waiting-room.constants.js';
import { WaitingRoomService } from '../src/modules/waiting-room/waiting-room.service.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  testRedis,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;

interface Account {
  id: string;
  token: string;
}

async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

/**
 * Phase 7b, virtual waiting room. Admission is driven by calling the
 * worker's admitBatch() directly, one tick at a time, so every test is
 * deterministic (the worker only adds a timer around the same call).
 */
describe('Virtual waiting room (e2e)', () => {
  let t: TestApp;
  let waitingRoom: WaitingRoomService;
  let organizer: Account;
  let url: string;
  const sockets: Socket[] = [];

  const as = (a: Account) => ({ Authorization: `Bearer ${a.token}` });

  const account = async (): Promise<Account> => {
    const u = await t.prisma.user.create({
      data: {
        email: `${randomUUID()}@test.local`,
        passwordHash: 'x',
        fullName: 'Q',
      },
    });
    return {
      id: u.id,
      token: await t.app
        .get(JwtService)
        .signAsync({ sub: u.id, role: Role.CUSTOMER }),
    };
  };

  async function createPerformance(
    options: { waitingRoom?: boolean; saleOpen?: boolean } = {},
  ): Promise<{ id: string; seatIds: string[]; generalPhaseId: string }> {
    const { waitingRoom: enabled = true, saleOpen = true } = options;
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(as(organizer))
      .send({ name: 'Queue night', artist: 'Band' })
      .expect(201);
    const startsAt = new Date(Date.now() + 30 * DAY);
    const opens = saleOpen ? Date.now() - DAY : Date.now() + DAY;
    const res = await t
      .http()
      .post(`/api/v1/concerts/${concert.body.id}/performances`)
      .set(as(organizer))
      .send({
        venue: 'Hall',
        startsAt,
        waitingRoomEnabled: enabled,
        zones: [
          {
            name: 'A',
            type: 'SEATED',
            price: 1_000_000,
            rows: 1,
            seatsPerRow: 20,
          },
        ],
        salePhases: [
          {
            type: 'GENERAL',
            startsAt: new Date(opens),
            endsAt: new Date(startsAt.getTime() - DAY),
          },
        ],
      })
      .expect(201);
    expect(res.body.waitingRoomEnabled).toBe(enabled);
    await t
      .http()
      .post(`/api/v1/performances/${res.body.id}/publish`)
      .set(as(organizer))
      .expect(200);
    const seats = await t.prisma.seat.findMany({
      where: { performanceId: res.body.id },
      orderBy: { seatNumber: 'asc' },
    });
    return {
      id: res.body.id,
      seatIds: seats.map((s) => s.id),
      generalPhaseId: res.body.salePhases[0].id,
    };
  }

  const join = (perfId: string, a: Account) =>
    t.http().post(`/api/v1/performances/${perfId}/queue`).set(as(a));
  const me = (perfId: string, a: Account) =>
    t.http().get(`/api/v1/performances/${perfId}/queue/me`).set(as(a));
  const hold = (
    perf: { id: string; seatIds: string[] },
    a: Account,
    seat: number,
    key = randomUUID(),
  ) =>
    t
      .http()
      .post('/api/v1/reservations')
      .set(as(a))
      .set('Idempotency-Key', key)
      .send({ performanceId: perf.id, seatIds: [perf.seatIds[seat]] });

  beforeAll(async () => {
    t = await createTestApp({
      websockets: true,
      config: {
        WAITING_ROOM_ADMIT_PER_TICK: 2,
        WAITING_ROOM_PASS_TTL_SECONDS: 2,
      },
    });
    await t.app.listen(0, '127.0.0.1');
    const server = t.app.getHttpServer() as unknown as {
      address(): AddressInfo;
    };
    url = `http://127.0.0.1:${server.address().port}`;
    waitingRoom = t.app.get(WaitingRoomService);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    const o = await createUserAndLogin(t, Role.ORGANIZER);
    organizer = { id: o.id, token: o.accessToken };
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await t.close();
  });

  it('without a waiting room nothing changes: no queue, holds go straight through', async () => {
    const perf = await createPerformance({ waitingRoom: false });
    const c = await account();
    const joined = await join(perf.id, c);
    expect(joined.status).toBe(409);
    expect(joined.body.code).toBe('WAITING_ROOM_DISABLED');
    expect((await me(perf.id, c).expect(200)).body).toEqual({
      status: 'NOT_REQUIRED',
    });
    await hold(perf, c, 0).expect(201);
  });

  it('first come, first served: numbers in arrival order, admitted in batches, holds need the pass', async () => {
    const perf = await createPerformance();
    const people = await Promise.all(
      Array.from({ length: 5 }, () => account()),
    );

    const refused = await hold(perf, people[0]!, 0);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('QUEUE_PASS_REQUIRED');

    for (const [i, p] of people.entries()) {
      const r = await join(perf.id, p).expect(200);
      expect(r.body).toEqual({
        status: 'WAITING',
        number: i + 1,
        position: i + 1,
        admittedThrough: 0,
        waiting: i + 1,
      });
    }
    // Joining again keeps your place.
    expect((await join(perf.id, people[2]!).expect(200)).body.number).toBe(3);

    // One tick admits 2 (WAITING_ROOM_ADMIT_PER_TICK in this test).
    const [tick] = await waitingRoom.admitBatch();
    expect(tick).toEqual({
      performanceId: perf.id,
      admitted: 2,
      admittedThrough: 2,
      waiting: 3,
    });
    const first = await me(perf.id, people[0]!).expect(200);
    expect(first.body.status).toBe('ADMITTED');
    expect(new Date(first.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect((await me(perf.id, people[2]!).expect(200)).body).toMatchObject({
      status: 'WAITING',
      number: 3,
      position: 1,
      admittedThrough: 2,
    });

    await hold(perf, people[0]!, 0).expect(201);
    await hold(perf, people[1]!, 1).expect(201);
    expect((await hold(perf, people[2]!, 2)).status).toBe(403);

    await waitingRoom.admitBatch();
    await waitingRoom.admitBatch();
    for (const p of people) {
      expect((await me(perf.id, p).expect(200)).body.status).toBe('ADMITTED');
    }
    // The line is empty: the admitter stops visiting this performance.
    expect(await testRedis.sismember('wr:active', perf.id)).toBe(0);
  });

  it('100 people joining at once get 100 different numbers; one person joining 10 times gets one', async () => {
    const perf = await createPerformance();
    const people = await Promise.all(
      Array.from({ length: 100 }, () => account()),
    );
    const answers = await Promise.all(people.map((p) => join(perf.id, p)));
    const numbers = answers.map((r) => r.body.number as number);
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );

    const eager = await account();
    const again = await Promise.all(
      Array.from({ length: 10 }, () => join(perf.id, eager)),
    );
    expect(new Set(again.map((r) => r.body.number)).size).toBe(1);
    expect(again[0]!.body.number).toBe(101);
  });

  it('before the sale opens people can queue, but nobody is admitted until it does', async () => {
    const perf = await createPerformance({ saleOpen: false });
    const c = await account();
    await join(perf.id, c).expect(200);

    const [tick] = await waitingRoom.admitBatch();
    expect(tick).toMatchObject({ admitted: 0, waiting: 1 });

    // The sale opens (phases have no API to edit; change the row and drop
    // the cached performance, as an edit through the API would).
    await t.prisma.salePhase.update({
      where: { id: perf.generalPhaseId },
      data: { startsAt: new Date(Date.now() - 1000) },
    });
    await testRedis.del(CatalogCacheService.performanceKey(perf.id));
    const [open] = await waitingRoom.admitBatch();
    expect(open).toMatchObject({ admitted: 1, waiting: 0 });
    await hold(perf, c, 0).expect(201);
  });

  it('a pass expires: holds are refused again and joining puts you at the back', async () => {
    const perf = await createPerformance();
    const [a, b] = await Promise.all([account(), account()]);
    await join(perf.id, a).expect(200);
    await waitingRoom.admitBatch();
    await join(perf.id, b).expect(200);

    const key = randomUUID();
    const first = await hold(perf, a, 0, key).expect(201);
    await new Promise((r) => setTimeout(r, 2100)); // pass TTL 2 s in this test

    expect((await me(perf.id, a).expect(200)).body.status).toBe('NONE');
    // I5: the retry of the hold that succeeded still gets its order back.
    const retry = await hold(perf, a, 0, key).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    // A new hold is refused.
    expect((await hold(perf, a, 1)).body.code).toBe('QUEUE_PASS_REQUIRED');

    const back = await join(perf.id, a).expect(200);
    expect(back.body).toMatchObject({
      status: 'WAITING',
      number: 3,
      position: 2,
    });
  });

  it('WebSocket /queue: the line hears its position, the admitted person hears the pass', async () => {
    const perf = await createPerformance();
    const [a, b, c] = await Promise.all([account(), account(), account()]);
    for (const p of [a, b, c]) await join(perf.id, p!).expect(200);

    const follow = async (p: Account) => {
      const socket = io(`${url}/queue`, {
        transports: ['websocket'],
        auth: { token: p.token },
        forceNew: true,
      });
      sockets.push(socket);
      const positions: QueuePositionEvent[] = [];
      const admitted: QueueAdmittedEvent[] = [];
      socket.on('queue.position', (e: QueuePositionEvent) => positions.push(e));
      socket.on('queue.admitted', (e: QueueAdmittedEvent) => admitted.push(e));
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      const ack = await socket.emitWithAck('join', { performanceId: perf.id });
      return { ack, positions, admitted };
    };
    const watchA = await follow(a!);
    const watchC = await follow(c!);
    expect(watchC.ack).toMatchObject({
      status: 'WAITING',
      number: 3,
      position: 3,
    });

    await waitingRoom.admitBatch(); // admits a and b
    await until(
      () => watchA.admitted.length === 1 && watchC.positions.length === 1,
    );
    expect(watchA.admitted[0]!.performanceId).toBe(perf.id);
    expect(new Date(watchA.admitted[0]!.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(watchC.positions[0]).toEqual({
      performanceId: perf.id,
      admittedThrough: 2,
      waiting: 1,
    });
    // c computes its own position from its number: 3 - 2 = 1. Nobody else
    // was told c was admitted.
    expect(watchC.admitted).toEqual([]);

    // Without a token the namespace answers with an error, not a status.
    const stranger = io(`${url}/queue`, {
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(stranger);
    await new Promise<void>((resolve) =>
      stranger.once('connect', () => resolve()),
    );
    const errors: unknown[] = [];
    stranger.on('exception', (e: unknown) => errors.push(e));
    stranger.emit('join', { performanceId: perf.id });
    await until(() => errors.length === 1);
  });
});
