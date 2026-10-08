import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Role } from '../src/generated/prisma/client.js';
import {
  FakePaymentProvider,
  type FakeOutcome,
} from '../src/modules/payments/providers/fake.provider.js';
import { RefundsService } from '../src/modules/payments/refunds.service.js';
import { ReleaseService } from '../src/modules/reservations/release.service.js';
import {
  PAYMENTS_DEAD_LETTER_QUEUE,
  refundJobId,
} from '../src/queue/queue.constants.js';
import { WorkerModule } from '../src/worker.module.js';
import {
  createTestApp,
  createUserAndLogin,
  resetDatabase,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;
const GRACE_SECONDS = 120;
const SEAT_PRICE = 1_000_000;
const GA_PRICE = 500_000;

interface Customer {
  id: string;
  token: string;
}

interface IpnBody {
  RspCode: string;
  Message: string;
}

async function until(
  check: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('condition not met in time');
}

/**
 * Phase 5: flow B (payment and IPN), refunds, performance cancellation and
 * check-in. Proves I2, I4, I6, I8 and I12 (spec, section 7).
 */
describe('Payments, refunds and tickets (e2e)', () => {
  let t: TestApp;
  let fake: FakePaymentProvider;
  let organizerAuth: { Authorization: string };
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

  const reserve = async (c: Customer, body: object): Promise<string> => {
    const res = await t
      .http()
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${c.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ performanceId: perfId, ...body })
      .expect(201);
    return res.body.id as string;
  };

  const pay = (c: Customer, orderId: string) =>
    t
      .http()
      .post(`/api/v1/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ provider: 'fake' });

  /** Starts a payment and returns its gateway reference. */
  const startPayment = async (c: Customer, orderId: string) => {
    const res = await pay(c, orderId).expect(201);
    const url = new URL(res.body.checkoutUrl as string);
    return {
      txnRef: url.searchParams.get('txnRef')!,
      paymentId: res.body.paymentId as string,
    };
  };

  /** Delivers one IPN, signed by the fake gateway, to our endpoint. */
  const ipn = async (query: string): Promise<IpnBody> => {
    const res = await t
      .http()
      .get(`/api/v1/payments/ipn/fake?${query}`)
      .expect(200);
    return res.body as IpnBody;
  };

  const signed = (
    txnRef: string,
    amount: number,
    outcome: FakeOutcome = 'success',
    transactionNo?: string,
  ) => fake.signedCallback(txnRef, amount, outcome, transactionNo);

  const orderStatus = async (id: string) =>
    (await t.prisma.order.findUniqueOrThrow({ where: { id } })).status;
  const seatStatus = async (id: string) =>
    (await t.prisma.seat.findUniqueOrThrow({ where: { id } })).status;
  const ga = () => t.prisma.zone.findUniqueOrThrow({ where: { id: gaZone } });

  /**
   * I2: SOLD seats are exactly the seats of active items of PAID orders.
   * I9 (sold part): sold_count matches the PAID standing items.
   */
  const assertSoldMatchesPaid = async () => {
    const [row] = await t.prisma.$queryRaw<
      { sold: bigint; paidSeats: bigint; mismatched: bigint }[]
    >`
      SELECT
        (SELECT count(*) FROM seats WHERE performance_id = ${perfId}::uuid AND status = 'SOLD') AS sold,
        (SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.performance_id = ${perfId}::uuid AND o.status = 'PAID'
            AND oi.seat_id IS NOT NULL AND oi.released_at IS NULL) AS "paidSeats",
        (SELECT count(*) FROM seats s
          WHERE s.performance_id = ${perfId}::uuid AND s.status = 'SOLD'
            AND NOT EXISTS (
              SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.seat_id = s.id AND o.status = 'PAID' AND oi.released_at IS NULL
            )) AS mismatched
    `;
    expect(row.sold).toBe(row.paidSeats);
    expect(row.mismatched).toBe(0n);
    const paidStanding = await t.prisma.orderItem.count({
      where: {
        zoneId: gaZone,
        releasedAt: null,
        order: { status: 'PAID' },
      },
    });
    expect((await ga()).soldCount).toBe(paidStanding);
  };

  beforeAll(async () => {
    t = await createTestApp();
    fake = t.app.get(FakePaymentProvider);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    const organizer = await createUserAndLogin(t, Role.ORGANIZER);
    organizerAuth = { Authorization: `Bearer ${organizer.accessToken}` };
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(organizerAuth)
      .send({ name: 'Payment night', artist: 'Band' })
      .expect(201);
    const startsAt = new Date(Date.now() + 30 * DAY);
    const res = await t
      .http()
      .post(`/api/v1/concerts/${concert.body.id}/performances`)
      .set(organizerAuth)
      .send({
        venue: 'Hall',
        startsAt,
        zones: [
          {
            name: 'SEATS',
            type: 'SEATED',
            price: SEAT_PRICE,
            rows: 1,
            seatsPerRow: 8,
          },
          { name: 'GA', type: 'STANDING', price: GA_PRICE, capacity: 20 },
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
      .set(organizerAuth)
      .expect(200);
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

  describe('flow B: paying', () => {
    it('a successful IPN sells the seats, moves standing tickets to sold and issues tickets', async () => {
      const c = await customer();
      const orderId = await reserve(c, {
        seatIds: [seatIds[0], seatIds[1]],
        standing: [{ zoneId: gaZone, quantity: 2 }],
      });
      const { txnRef } = await startPayment(c, orderId);
      const total = 2 * SEAT_PRICE + 2 * GA_PRICE;

      expect(await ipn(signed(txnRef, total))).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });

      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await seatStatus(seatIds[0])).toBe('SOLD');
      expect(await seatStatus(seatIds[1])).toBe('SOLD');
      const zone = await ga();
      expect(zone.heldCount).toBe(0);
      expect(zone.soldCount).toBe(2);
      const payment = await t.prisma.payment.findUniqueOrThrow({
        where: { txnRef },
      });
      expect(payment.status).toBe('SUCCEEDED');
      expect(payment.providerTxnId).not.toBeNull();
      await assertSoldMatchesPaid();

      const tickets = await t
        .http()
        .get('/api/v1/tickets')
        .set('Authorization', `Bearer ${c.token}`)
        .expect(200);
      expect(tickets.body).toHaveLength(4);
      const first = tickets.body[0] as { code: string; qrSvg: string };
      expect(first.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(first.qrSvg).toContain('<svg');
      const labels = (tickets.body as { seatLabel: string | null }[])
        .map((x) => String(x.seatLabel))
        .sort((a, b) => a.localeCompare(b));
      expect(labels).toEqual(['A1', 'A2', 'null', 'null']);
    });

    it('pays inside the grace period, after expires_at', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[2]] });
      const { txnRef } = await startPayment(c, orderId);
      await t.prisma.order.update({
        where: { id: orderId },
        data: { expiresAt: new Date(Date.now() - 30_000) },
      });
      expect((await ipn(signed(txnRef, SEAT_PRICE))).RspCode).toBe('00');
      expect(await orderStatus(orderId)).toBe('PAID');
    });

    it('a failed payment leaves the order PENDING and a new attempt can pay', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[3]] });
      const first = await startPayment(c, orderId);
      expect(
        (await ipn(signed(first.txnRef, SEAT_PRICE, 'cancelled'))).RspCode,
      ).toBe('00');
      expect(await orderStatus(orderId)).toBe('PENDING');
      expect(
        (
          await t.prisma.payment.findUniqueOrThrow({
            where: { txnRef: first.txnRef },
          })
        ).status,
      ).toBe('FAILED');

      const second = await startPayment(c, orderId);
      expect((await ipn(signed(second.txnRef, SEAT_PRICE))).RspCode).toBe('00');
      expect(await orderStatus(orderId)).toBe('PAID');
    });

    it('the fake gateway delivers the IPN and returns a display-only return URL', async () => {
      const c = await customer();
      const orderId = await reserve(c, {
        standing: [{ zoneId: gaZone, quantity: 1 }],
      });
      const { txnRef } = await startPayment(c, orderId);
      const page = await t
        .http()
        .get(`/api/v1/payments/fake/checkout?txnRef=${txnRef}`)
        .expect(200);
      expect(page.body).toMatchObject({ amount: GA_PRICE, orderId });

      const done = await t
        .http()
        .post('/api/v1/payments/fake/complete')
        .send({ txnRef, outcome: 'success' })
        .expect(200);
      expect(done.body.ipn.RspCode).toBe('00');
      expect(done.body.deliveries).toBe(1);
      const back = new URL(done.body.returnUrl as string);
      // The browser lands on the web app's result page, which forwards the
      // same signed query to the API's return endpoint.
      expect(back.pathname).toBe('/checkout/result/fake');
      const ret = await t
        .http()
        .get(`/api/v1/payments/return/fake${back.search}`)
        .expect(200);
      expect(ret.body).toMatchObject({
        verified: true,
        gatewaySaysSuccess: true,
        orderId,
        orderStatus: 'PAID',
      });
    });

    it('the return URL never changes the order', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[4]] });
      const { txnRef } = await startPayment(c, orderId);
      const ret = await t
        .http()
        .get(`/api/v1/payments/return/fake?${signed(txnRef, SEAT_PRICE)}`)
        .expect(200);
      expect(ret.body).toMatchObject({
        verified: true,
        orderStatus: 'PENDING',
      });
      expect(await orderStatus(orderId)).toBe('PENDING');
    });

    it('refuses to start a payment for an order that is not payable', async () => {
      const owner = await customer();
      const other = await customer();
      const orderId = await reserve(owner, { seatIds: [seatIds[5]] });
      await pay(other, orderId).expect(404);

      await t.prisma.order.update({
        where: { id: orderId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const late = await pay(owner, orderId).expect(409);
      expect(late.body.code).toBe('PAYMENT_NOT_ALLOWED');

      const cancelled = await reserve(owner, { seatIds: [seatIds[6]] });
      await t
        .http()
        .post(`/api/v1/orders/${cancelled}/cancel`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);
      const closed = await pay(owner, cancelled).expect(409);
      expect(closed.body.message).toContain('CANCELLED');
    });
  });

  describe('IPN verification (I4, I12)', () => {
    it('rejects a tampered signature with 97 and changes nothing', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[0]] });
      const { txnRef } = await startPayment(c, orderId);
      const query = signed(txnRef, SEAT_PRICE).replace(
        'vnp_ResponseCode=00',
        'vnp_ResponseCode=01',
      );
      expect((await ipn(query)).RspCode).toBe('97');
      // Signed with another secret: also 97.
      const forged = new FakePaymentProvider({
        get: (key: string) =>
          key === 'FAKE_PAYMENT_SECRET' ? 'not-the-real-secret-123' : undefined,
      } as never).signedCallback(txnRef, SEAT_PRICE, 'success');
      expect((await ipn(forged)).RspCode).toBe('97');
      expect(await orderStatus(orderId)).toBe('PENDING');
    });

    it('answers 01 for an unknown payment reference', async () => {
      expect((await ipn(signed('f'.repeat(32), SEAT_PRICE))).RspCode).toBe(
        '01',
      );
    });

    it('I12: a wrong amount is refused with 04 and the order stays PENDING', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[1]] });
      const { txnRef } = await startPayment(c, orderId);
      expect((await ipn(signed(txnRef, SEAT_PRICE - 1))).RspCode).toBe('04');
      expect((await ipn(signed(txnRef, SEAT_PRICE * 2))).RspCode).toBe('04');
      expect(await orderStatus(orderId)).toBe('PENDING');
      expect(await seatStatus(seatIds[1])).toBe('HELD');
      const payment = await t.prisma.payment.findUniqueOrThrow({
        where: { txnRef },
      });
      expect(payment.status).toBe('PENDING');
    });

    it('I4: the same IPN delivered 20 times at once is applied exactly once', async () => {
      const c = await customer();
      const orderId = await reserve(c, {
        seatIds: [seatIds[2]],
        standing: [{ zoneId: gaZone, quantity: 3 }],
      });
      const { txnRef } = await startPayment(c, orderId);
      const query = signed(txnRef, SEAT_PRICE + 3 * GA_PRICE);

      const replies = await Promise.all(
        Array.from({ length: 20 }, () => ipn(query)),
      );
      const codes = replies.map((r) => r.RspCode);
      expect(codes.filter((x) => x === '00')).toHaveLength(1);
      expect(codes.filter((x) => x === '02')).toHaveLength(19);

      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await t.prisma.ticket.count()).toBe(4);
      expect((await ga()).soldCount).toBe(3);
      await assertSoldMatchesPaid();
      // And again later: still "already confirmed".
      expect((await ipn(query)).RspCode).toBe('02');
    });

    it('I4: one gateway transaction cannot settle two payments', async () => {
      const c = await customer();
      const a = await reserve(c, { seatIds: [seatIds[3]] });
      const b = await reserve(c, { seatIds: [seatIds[4]] });
      const pa = await startPayment(c, a);
      const pb = await startPayment(c, b);
      expect(
        (await ipn(signed(pa.txnRef, SEAT_PRICE, 'success', '777'))).RspCode,
      ).toBe('00');
      expect(
        (await ipn(signed(pb.txnRef, SEAT_PRICE, 'success', '777'))).RspCode,
      ).toBe('02');
      expect(await orderStatus(b)).toBe('PENDING');
    });
  });

  describe('late money is always refunded (I8)', () => {
    it('an IPN for an expired order refunds and never takes the seat back', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[0]] });
      const { txnRef } = await startPayment(c, orderId);
      await t.prisma.order.update({
        where: { id: orderId },
        data: { expiresAt: new Date(Date.now() - (GRACE_SECONDS + 5) * 1000) },
      });
      await t.app.get(ReleaseService).expire(orderId);
      // Someone else holds the seat now.
      const next = await customer();
      const theirs = await reserve(next, { seatIds: [seatIds[0]] });

      expect((await ipn(signed(txnRef, SEAT_PRICE))).RspCode).toBe('00');
      expect(await orderStatus(orderId)).toBe('REFUND_PENDING');
      expect(await orderStatus(theirs)).toBe('PENDING');
      expect(await seatStatus(seatIds[0])).toBe('HELD');
      expect(await t.prisma.ticket.count()).toBe(0);

      const refund = await t.prisma.refund.findFirstOrThrow({
        include: { payment: true },
      });
      expect(refund.payment.txnRef).toBe(txnRef);
      expect(refund.amount).toBe(SEAT_PRICE);
      expect(refund.status).toBe('PENDING');

      await t.app.get(RefundsService).process(refund.id);
      expect(await orderStatus(orderId)).toBe('REFUNDED');
      expect(
        (await t.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } }))
          .status,
      ).toBe('SUCCEEDED');
    });

    it('an IPN for an overdue order that no job has expired yet closes it, then refunds', async () => {
      const c = await customer();
      const orderId = await reserve(c, {
        seatIds: [seatIds[1]],
        standing: [{ zoneId: gaZone, quantity: 2 }],
      });
      const { txnRef } = await startPayment(c, orderId);
      await t.prisma.order.update({
        where: { id: orderId },
        data: { expiresAt: new Date(Date.now() - (GRACE_SECONDS + 5) * 1000) },
      });
      expect(
        (await ipn(signed(txnRef, SEAT_PRICE + 2 * GA_PRICE))).RspCode,
      ).toBe('00');
      expect(await orderStatus(orderId)).toBe('REFUND_PENDING');
      expect(await seatStatus(seatIds[1])).toBe('AVAILABLE');
      expect((await ga()).heldCount).toBe(0);
      expect(await t.prisma.refund.count()).toBe(1);
      await assertSoldMatchesPaid();
    });

    it('paying twice for one order keeps it PAID and refunds the second payment', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[2]] });
      const first = await startPayment(c, orderId);
      const second = await startPayment(c, orderId);
      expect((await ipn(signed(first.txnRef, SEAT_PRICE))).RspCode).toBe('00');
      expect((await ipn(signed(second.txnRef, SEAT_PRICE))).RspCode).toBe('00');
      expect(await orderStatus(orderId)).toBe('PAID');
      const refund = await t.prisma.refund.findFirstOrThrow({
        include: { payment: true },
      });
      expect(refund.payment.txnRef).toBe(second.txnRef);
      await t.app.get(RefundsService).process(refund.id);
      expect(await orderStatus(orderId)).toBe('PAID');
      expect(await t.prisma.ticket.count()).toBe(1);
    });

    it('cancel and IPN racing: either PAID, or CANCELLED money refunded, never both', async () => {
      const races = 8;
      for (let i = 0; i < races; i += 1) {
        const c = await customer();
        const orderId = await reserve(c, {
          standing: [{ zoneId: gaZone, quantity: 1 }],
        });
        const { txnRef } = await startPayment(c, orderId);
        const [cancel, reply] = await Promise.all([
          t
            .http()
            .post(`/api/v1/orders/${orderId}/cancel`)
            .set('Authorization', `Bearer ${c.token}`),
          ipn(signed(txnRef, GA_PRICE)),
        ]);
        expect(reply.RspCode).toBe('00');
        const status = await orderStatus(orderId);
        if (cancel.status === 204) {
          expect(status).toBe('REFUND_PENDING');
        } else {
          expect(cancel.status).toBe(409);
          expect(status).toBe('PAID');
        }
      }
      await assertSoldMatchesPaid();
      const zone = await ga();
      expect(zone.heldCount).toBe(0);
      const paid = await t.prisma.order.count({ where: { status: 'PAID' } });
      const refunds = await t.prisma.refund.count();
      expect(paid + refunds).toBe(races);
    });
  });

  describe('check-in (I6)', () => {
    const paidTicket = async (): Promise<string> => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[7]] });
      const { txnRef } = await startPayment(c, orderId);
      await ipn(signed(txnRef, SEAT_PRICE));
      return (await t.prisma.ticket.findFirstOrThrow()).code;
    };

    it('20 concurrent scans of one ticket: exactly one is accepted', async () => {
      const code = await paidTicket();
      const staff = await createUserAndLogin(t, Role.STAFF);
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          t
            .http()
            .post('/api/v1/tickets/check-in')
            .set('Authorization', `Bearer ${staff.accessToken}`)
            .send({ code }),
        ),
      );
      const ok = responses.filter((r) => r.status === 200);
      const rejected = responses.filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(rejected).toHaveLength(19);
      expect(ok[0].body.seatLabel).toBe('A8');
      expect(rejected[0].body.code).toBe('TICKET_ALREADY_CHECKED_IN');
      expect(rejected[0].body.details.checkedInBy).toBe(staff.id);
      const ticket = await t.prisma.ticket.findUniqueOrThrow({
        where: { code },
      });
      expect(ticket.checkedInBy).toBe(staff.id);
    });

    it('unknown code is 404; only STAFF can scan', async () => {
      const code = await paidTicket();
      const staff = await createUserAndLogin(t, Role.STAFF);
      const res = await t
        .http()
        .post('/api/v1/tickets/check-in')
        .set('Authorization', `Bearer ${staff.accessToken}`)
        .send({ code: 'A'.repeat(22) })
        .expect(404);
      expect(res.body.code).toBe('TICKET_NOT_FOUND');
      const buyer = await customer();
      await t
        .http()
        .post('/api/v1/tickets/check-in')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ code })
        .expect(403);
    });
  });

  describe('worker: refunds and performance cancellation', () => {
    let worker: INestApplicationContext | undefined;

    const startWorker = async (): Promise<FakePaymentProvider> => {
      const moduleRef = await Test.createTestingModule({
        imports: [WorkerModule],
      }).compile();
      worker = moduleRef.createNestApplication({ logger: false });
      await worker.init();
      return worker.get(FakePaymentProvider);
    };

    afterEach(async () => {
      await worker?.close();
      worker = undefined;
    });

    it('cancelling a performance cancels unpaid orders, refunds paid ones and voids their tickets', async () => {
      const buyer = await customer();
      const paidOrder = await reserve(buyer, {
        seatIds: [seatIds[0]],
        standing: [{ zoneId: gaZone, quantity: 2 }],
      });
      const { txnRef } = await startPayment(buyer, paidOrder);
      await ipn(signed(txnRef, SEAT_PRICE + 2 * GA_PRICE));
      const holder = await customer();
      const pendingOrder = await reserve(holder, { seatIds: [seatIds[1]] });
      const code = (await t.prisma.ticket.findFirstOrThrow()).code;

      await startWorker();
      await t
        .http()
        .post(`/api/v1/performances/${perfId}/cancel`)
        .set(organizerAuth)
        .expect(200);

      await until(async () => (await orderStatus(paidOrder)) === 'REFUNDED');
      expect(await orderStatus(pendingOrder)).toBe('CANCELLED');
      expect(await seatStatus(seatIds[0])).toBe('AVAILABLE');
      expect(await seatStatus(seatIds[1])).toBe('AVAILABLE');
      const zone = await ga();
      expect(zone.soldCount).toBe(0);
      expect(zone.heldCount).toBe(0);
      expect(await t.prisma.ticket.count({ where: { voidedAt: null } })).toBe(
        0,
      );
      await assertSoldMatchesPaid();

      const staff = await createUserAndLogin(t, Role.STAFF);
      const scan = await t
        .http()
        .post('/api/v1/tickets/check-in')
        .set('Authorization', `Bearer ${staff.accessToken}`)
        .send({ code })
        .expect(409);
      expect(scan.body.code).toBe('TICKET_VOIDED');

      // No more sales, no more payments.
      await t
        .http()
        .post('/api/v1/reservations')
        .set('Authorization', `Bearer ${holder.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ performanceId: perfId, seatIds: [seatIds[2]] })
        .expect(409);
      await t
        .http()
        .post(`/api/v1/performances/${perfId}/cancel`)
        .set(organizerAuth)
        .expect(409);
    });

    it('money that arrives after the performance was cancelled is refunded', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[3]] });
      const { txnRef } = await startPayment(c, orderId);
      // Cancel without a worker: the order is still PENDING when the IPN comes.
      await t
        .http()
        .post(`/api/v1/performances/${perfId}/cancel`)
        .set(organizerAuth)
        .expect(200);
      expect((await ipn(signed(txnRef, SEAT_PRICE))).RspCode).toBe('00');
      expect(await orderStatus(orderId)).toBe('REFUND_PENDING');
      expect(await seatStatus(seatIds[3])).toBe('AVAILABLE');
      expect(await t.prisma.ticket.count()).toBe(0);

      await startWorker();
      await until(async () => (await orderStatus(orderId)) === 'REFUNDED');
    });

    it('a refund the gateway keeps refusing is retried, then marked FAILED and dead-lettered', async () => {
      const c = await customer();
      const orderId = await reserve(c, { seatIds: [seatIds[5]] });
      const { txnRef } = await startPayment(c, orderId);
      await t.prisma.order.update({
        where: { id: orderId },
        data: { expiresAt: new Date(Date.now() - (GRACE_SECONDS + 5) * 1000) },
      });
      // The worker's gateway refuses refunds before any job can reach it.
      const workerFake = await startWorker();
      workerFake.failRefunds = true;
      expect((await ipn(signed(txnRef, SEAT_PRICE))).RspCode).toBe('00');
      const refund = await t.prisma.refund.findFirstOrThrow();
      await until(
        async () =>
          (
            await t.prisma.refund.findUniqueOrThrow({
              where: { id: refund.id },
            })
          ).status === 'FAILED',
      );
      const failed = await t.prisma.refund.findUniqueOrThrow({
        where: { id: refund.id },
      });
      expect(failed.attempts).toBe(3);
      expect(failed.lastError).toContain('temporarily unavailable');
      expect(await orderStatus(orderId)).toBe('REFUND_PENDING');

      const dlq = t.app.get<Queue>(getQueueToken(PAYMENTS_DEAD_LETTER_QUEUE));
      const parked = await dlq.getJob(refundJobId(refund.id));
      expect(parked?.data).toMatchObject({ refundId: refund.id });
    });
  });
});
