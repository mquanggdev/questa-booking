import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { Role } from '../src/generated/prisma/client.js';
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

interface Perf {
  id: string;
  seatIds: string[];
  presalePhaseId: string;
}

/**
 * Phase 7b, I11: during a PRESALE phase only accounts that redeemed a code
 * of that phase hold tickets, and every code is used at most once.
 */
describe('Presale codes (e2e, I11)', () => {
  let t: TestApp;
  let organizer: Account;

  const as = (a: Account) => ({ Authorization: `Bearer ${a.token}` });

  const account = async (role: Role = Role.CUSTOMER): Promise<Account> => {
    const u = await t.prisma.user.create({
      data: {
        email: `${randomUUID()}@test.local`,
        passwordHash: 'x',
        fullName: 'P',
        role,
      },
    });
    return {
      id: u.id,
      token: await t.app.get(JwtService).signAsync({ sub: u.id, role }),
    };
  };

  /** Presale open now (or already over, then the general sale is open). */
  async function createPerformance(presaleOpen = true): Promise<Perf> {
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(as(organizer))
      .send({ name: 'Presale night', artist: 'Band' })
      .expect(201);
    const startsAt = new Date(Date.now() + 30 * DAY);
    const now = Date.now();
    const salePhases = presaleOpen
      ? [
          {
            type: 'PRESALE',
            startsAt: new Date(now - DAY),
            endsAt: new Date(now + DAY),
          },
          {
            type: 'GENERAL',
            startsAt: new Date(now + DAY),
            endsAt: new Date(now + 20 * DAY),
          },
        ]
      : [
          {
            type: 'PRESALE',
            startsAt: new Date(now - 2 * DAY),
            endsAt: new Date(now - DAY),
          },
          {
            type: 'GENERAL',
            startsAt: new Date(now - DAY),
            endsAt: new Date(now + 20 * DAY),
          },
        ];
    const res = await t
      .http()
      .post(`/api/v1/concerts/${concert.body.id}/performances`)
      .set(as(organizer))
      .send({
        venue: 'Hall',
        startsAt,
        zones: [
          {
            name: 'A',
            type: 'SEATED',
            price: 1_000_000,
            rows: 1,
            seatsPerRow: 10,
          },
        ],
        salePhases,
      })
      .expect(201);
    await t
      .http()
      .post(`/api/v1/performances/${res.body.id}/publish`)
      .set(as(organizer))
      .expect(200);
    const seats = await t.prisma.seat.findMany({
      where: { performanceId: res.body.id },
      orderBy: { seatNumber: 'asc' },
    });
    const phases = res.body.salePhases as { id: string; type: string }[];
    return {
      id: res.body.id,
      seatIds: seats.map((s) => s.id),
      presalePhaseId: phases.find((p) => p.type === 'PRESALE')!.id,
    };
  }

  const generate = async (perf: Perf, count: number): Promise<string[]> =>
    (
      await t
        .http()
        .post(`/api/v1/performances/${perf.id}/presale/codes`)
        .set(as(organizer))
        .send({ salePhaseId: perf.presalePhaseId, count })
        .expect(201)
    ).body.codes as string[];

  const redeem = (perf: Perf, a: Account, code: string) =>
    t
      .http()
      .post(`/api/v1/performances/${perf.id}/presale/redeem`)
      .set(as(a))
      .send({ code });

  const hold = (perf: Perf, a: Account, seat: number, key = randomUUID()) =>
    t
      .http()
      .post('/api/v1/reservations')
      .set(as(a))
      .set('Idempotency-Key', key)
      .send({ performanceId: perf.id, seatIds: [perf.seatIds[seat]] });

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    const o = await createUserAndLogin(t, Role.ORGANIZER);
    organizer = { id: o.id, token: o.accessToken };
  });

  afterAll(async () => {
    await t.close();
  });

  it('only the organizer of the concert generates codes, and only for a PRESALE phase', async () => {
    const perf = await createPerformance();
    const codes = await generate(perf, 5);
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
    for (const code of codes)
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);

    const general = (await t.prisma.salePhase.findFirst({
      where: { performanceId: perf.id, type: 'GENERAL' },
    }))!.id;
    const wrongPhase = await t
      .http()
      .post(`/api/v1/performances/${perf.id}/presale/codes`)
      .set(as(organizer))
      .send({ salePhaseId: general, count: 1 });
    expect(wrongPhase.status).toBe(400);

    const otherOrganizer = await account(Role.ORGANIZER);
    const notOwner = await t
      .http()
      .post(`/api/v1/performances/${perf.id}/presale/codes`)
      .set(as(otherOrganizer))
      .send({ salePhaseId: perf.presalePhaseId, count: 1 });
    expect(notOwner.status).toBe(403);

    const customer = await account();
    const asCustomer = await t
      .http()
      .post(`/api/v1/performances/${perf.id}/presale/codes`)
      .set(as(customer))
      .send({ salePhaseId: perf.presalePhaseId, count: 1 });
    expect(asCustomer.status).toBe(403);
  });

  it('I11: during the presale, holding needs a redeemed code', async () => {
    const perf = await createPerformance();
    const [code] = await generate(perf, 1);
    const customer = await account();

    const refused = await hold(perf, customer, 0);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PRESALE_CODE_REQUIRED');
    // The refusal released the seat in the Redis gate too.
    expect(
      await t.prisma.seat.count({
        where: { performanceId: perf.id, status: 'AVAILABLE' },
      }),
    ).toBe(10);

    // Case, spaces and dashes do not matter.
    const typed = ` ${code!.toLowerCase().replace(/-/g, ' ')} `;
    const redeemed = await redeem(perf, customer, typed).expect(200);
    expect(redeemed.body.salePhaseId).toBe(perf.presalePhaseId);

    await hold(perf, customer, 0).expect(201);
    const mine = await t
      .http()
      .get(`/api/v1/performances/${perf.id}/presale/me`)
      .set(as(customer))
      .expect(200);
    expect(mine.body).toEqual([
      expect.objectContaining({ salePhaseId: perf.presalePhaseId }),
    ]);
  });

  it('a request refused for lack of a code never reaches the Redis gate', async () => {
    // Otherwise it would take the seat in Redis for a moment and turn away
    // a buyer who has a code. MONITOR records every command Redis runs.
    const perf = await createPerformance();
    const customer = await account();
    const monitor = await testRedis.duplicate().monitor();
    const commands: string[] = [];
    monitor.on('monitor', (_time: string, args: string[]) =>
      commands.push(args.join(' ')),
    );
    try {
      const refused = await hold(perf, customer, 0);
      expect(refused.body.code).toBe('PRESALE_CODE_REQUIRED');
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      monitor.disconnect();
    }
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((c) => c.includes('seat:hold:'))).toEqual([]);
    expect(commands.filter((c) => c.includes('hold:req:'))).toEqual([]);
  });

  it('I11: 20 accounts racing for one code: exactly one gets it', async () => {
    const perf = await createPerformance();
    const [code] = await generate(perf, 1);
    const racers = await Promise.all(
      Array.from({ length: 20 }, () => account()),
    );

    const answers = await Promise.all(
      racers.map((a) => redeem(perf, a, code!)),
    );
    const winners = answers.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(
      answers.filter((r) => r.status === 409).map((r) => r.body.code),
    ).toEqual(Array(19).fill('PRESALE_CODE_USED'));

    const row = await t.prisma.presaleCode.findFirstOrThrow({
      where: { salePhaseId: perf.presalePhaseId },
    });
    const winner = racers[answers.indexOf(winners[0]!)]!;
    expect(row.redeemedBy).toBe(winner.id);

    // Only the winner holds tickets.
    const holds = await Promise.all(
      racers.map((a, i) => hold(perf, a, i % 10)),
    );
    expect(holds.filter((r) => r.status === 201)).toHaveLength(1);
    expect(holds[racers.indexOf(winner)]!.status).toBe(201);
  });

  it('one code per account per phase, even with concurrent requests; a second code stays free', async () => {
    const perf = await createPerformance();
    const codes = await generate(perf, 6);
    const greedy = await account();

    const answers = await Promise.all(
      codes.map((c) => redeem(perf, greedy, c)),
    );
    expect(answers.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      answers
        .filter((r) => r.status === 409)
        .every((r) => r.body.code === 'PRESALE_ALREADY_REDEEMED'),
    ).toBe(true);
    expect(
      await t.prisma.presaleCode.count({
        where: { redeemedBy: { not: null } },
      }),
    ).toBe(1);

    // A code the greedy account tried is still usable by someone else.
    const used = codes[answers.findIndex((r) => r.status === 200)];
    const unused = codes.find((c) => c !== used)!;
    await redeem(perf, await account(), unused).expect(200);

    // Redeeming your own code again is a no-op, not an error.
    await redeem(perf, greedy, used!).expect(200);
  });

  it('unknown codes and codes of another performance are refused the same way', async () => {
    const perf = await createPerformance();
    const other = await createPerformance();
    const [otherCode] = await generate(other, 1);
    const customer = await account();

    const wrongPerf = await redeem(perf, customer, otherCode!);
    expect(wrongPerf.status).toBe(404);
    expect(wrongPerf.body.code).toBe('PRESALE_CODE_INVALID');
    const unknown = await redeem(perf, customer, 'ABCD-EFGH-JK');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('PRESALE_CODE_INVALID');
    const malformed = await redeem(perf, customer, 'short');
    expect(malformed.status).toBe(400);
  });

  it('after the presale: everyone holds without a code, and codes can no longer be redeemed', async () => {
    const perf = await createPerformance(false);
    await t.prisma.presaleCode.create({
      data: { salePhaseId: perf.presalePhaseId, code: 'ABCDEFGHJK' },
    });
    const customer = await account();

    await hold(perf, customer, 0).expect(201);
    const late = await redeem(perf, customer, 'ABCDEFGHJK');
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('PRESALE_CLOSED');
  });

  it('I5: a retry with the same Idempotency-Key gets its order back after the sale window closed', async () => {
    const perf = await createPerformance();
    const [code] = await generate(perf, 1);
    const customer = await account();
    await redeem(perf, customer, code!).expect(200);
    const key = randomUUID();
    const first = await hold(perf, customer, 0, key).expect(201);

    // The presale ends and the general sale has not started yet.
    await t.prisma.salePhase.update({
      where: { id: perf.presalePhaseId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    const retry = await hold(perf, customer, 0, key).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotent-replayed']).toBe('true');

    // A new request is refused.
    const fresh = await hold(perf, customer, 1);
    expect(fresh.status).toBe(409);
    expect(fresh.body.code).toBe('SALE_NOT_OPEN');
  });
});
