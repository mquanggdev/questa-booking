import type { INestApplicationContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Role } from '../src/generated/prisma/client.js';
import { KafkaService } from '../src/kafka/kafka.service.js';
import { OutboxRelayService } from '../src/modules/outbox/outbox-relay.service.js';
import { OrderEventType } from '../src/modules/outbox/order-events.js';
import { FakePaymentProvider } from '../src/modules/payments/providers/fake.provider.js';
import {
  createTestApp,
  createTestWorker,
  resetDatabase,
  type TestApp,
} from './support/app.js';

const DAY = 24 * 60 * 60 * 1000;
const SEAT_PRICE = 1_000_000;
const GA_PRICE = 500_000;
const CONSUMERS = ['analytics', 'audit', 'notifications'];
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
// Topics and consumer groups of this run only: no event of another run (or
// of another test file) can reach these consumers.
const PREFIX = `e2e-${randomUUID().slice(0, 8)}.`;

interface Customer {
  id: string;
  email: string;
  token: string;
}

async function until(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

/** Emails Mailpit received with this Message-ID. */
async function mailsWithId(eventId: string): Promise<number> {
  const query = encodeURIComponent(`message-id:${eventId}@questa.test`);
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${query}`);
  return ((await res.json()) as { messages_count: number }).messages_count;
}

/** The Kafka container (compose locally, a service container in CI). */
function kafkaContainer(): string {
  const id = execFileSync(
    'docker',
    ['ps', '-q', '--filter', 'ancestor=apache/kafka:4.1.2'],
    {
      encoding: 'utf8',
    },
  ).trim();
  if (!id) throw new Error('No running apache/kafka:4.1.2 container');
  return id.split('\n')[0]!;
}

/**
 * Phase 8, I7: every PAID order has exactly one order.paid event, and every
 * consumer applies it exactly once, even when the relay dies between
 * sending and marking, when Kafka stops for a while, and when the same
 * event arrives twice.
 */
describe('Outbox, Kafka and consumers (e2e, I7)', () => {
  let t: TestApp;
  let worker: INestApplicationContext;
  let kafka: KafkaService;
  let fake: FakePaymentProvider;
  let perfId: string;
  let seatIds: string[];
  let gaZone: string;
  let seatZone: string;
  /** Every message seen on the orders topic, by a probe consumer group. */
  const seen: string[] = [];

  const customer = async (): Promise<Customer> => {
    const email = `${randomUUID()}@test.local`;
    const u = await t.prisma.user.create({
      data: { email, passwordHash: 'x', fullName: 'Khách Kafka' },
    });
    return {
      id: u.id,
      email,
      token: await t.app
        .get(JwtService)
        .signAsync({ sub: u.id, role: Role.CUSTOMER }),
    };
  };

  /** Holds a seat and a standing ticket, and pays through the fake gateway. */
  const buy = async (c: Customer, seat: number): Promise<string> => {
    const order = await t
      .http()
      .post('/api/v1/reservations')
      .set('Authorization', `Bearer ${c.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        performanceId: perfId,
        seatIds: [seatIds[seat]],
        standing: [{ zoneId: gaZone, quantity: 1 }],
      })
      .expect(201);
    const payment = await t
      .http()
      .post(`/api/v1/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ provider: 'fake' })
      .expect(201);
    const txnRef = new URL(payment.body.checkoutUrl as string).searchParams.get(
      'txnRef',
    )!;
    const query = fake.signedCallback(txnRef, SEAT_PRICE + GA_PRICE, 'success');
    // The gateway retries IPNs: deliver this one twice.
    for (let i = 0; i < 2; i++) {
      await t.http().get(`/api/v1/payments/ipn/fake?${query}`).expect(200);
    }
    return order.body.id as string;
  };

  const paidEvent = (orderId: string) =>
    t.prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: orderId, eventType: OrderEventType.PAID },
    });

  /** Each consumer applied the event once, with exactly one effect each. */
  const appliedOnce = async (eventId: string) => {
    const processed = await t.prisma.processedEvent.findMany({
      where: { eventId },
    });
    return (
      processed.length === CONSUMERS.length &&
      (await t.prisma.auditLog.count({ where: { eventId } })) === 1 &&
      (await mailsWithId(eventId)) === 1
    );
  };

  const stats = async () => {
    const rows = await t.prisma.performanceSalesStat.findMany({
      where: { performanceId: perfId },
    });
    return {
      tickets: rows.reduce((a, r) => a + r.ticketsSold, 0),
      revenue: rows.reduce((a, r) => a + Number(r.revenue), 0),
      seat: rows.find((r) => r.zoneId === seatZone)?.ticketsSold ?? 0,
      ga: rows.find((r) => r.zoneId === gaZone)?.ticketsSold ?? 0,
    };
  };

  const countSeen = (eventId: string) =>
    seen.filter((id) => id === eventId).length;

  beforeAll(async () => {
    t = await createTestApp();
    worker = await createTestWorker({ KAFKA_TOPIC_PREFIX: PREFIX });
    kafka = worker.get(KafkaService);
    fake = t.app.get(FakePaymentProvider);
    // A probe group that records every eventId reaching the topic, to see
    // duplicates that the consumers absorb.
    const probe = kafka.consumer(`probe-${randomUUID()}`);
    await probe.connect();
    await probe.subscribe({ topics: [kafka.topics.orders] });
    void probe.run({
      eachMessage: async ({ message }) => {
        seen.push(
          (JSON.parse(message.value!.toString()) as { eventId: string })
            .eventId,
        );
      },
    });
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma, { redis: false });
    const organizer = await t.prisma.user.create({
      data: {
        email: `${randomUUID()}@test.local`,
        passwordHash: 'x',
        fullName: 'O',
        role: Role.ORGANIZER,
      },
    });
    const auth = {
      Authorization: `Bearer ${await t.app
        .get(JwtService)
        .signAsync({ sub: organizer.id, role: Role.ORGANIZER })}`,
    };
    const concert = await t
      .http()
      .post('/api/v1/concerts')
      .set(auth)
      .send({ name: 'Kafka Night', artist: 'Band' })
      .expect(201);
    const startsAt = new Date(Date.now() + 30 * DAY);
    const perf = await t
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
            price: SEAT_PRICE,
            rows: 1,
            seatsPerRow: 10,
          },
          { name: 'GA', type: 'STANDING', price: GA_PRICE, capacity: 50 },
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
    perfId = perf.body.id;
    await t
      .http()
      .post(`/api/v1/performances/${perfId}/publish`)
      .set(auth)
      .expect(200);
    const zones = perf.body.zones as { id: string; name: string }[];
    gaZone = zones.find((z) => z.name === 'GA')!.id;
    seatZone = zones.find((z) => z.name === 'SEATS')!.id;
    seatIds = (
      await t.prisma.seat.findMany({
        where: { performanceId: perfId },
        orderBy: { seatNumber: 'asc' },
      })
    ).map((s) => s.id);
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
  });

  it('a paid order (IPN delivered twice) has one order.paid; each consumer applies it once', async () => {
    const buyer = await customer();
    const orderId = await buy(buyer, 0);

    const events = await t.prisma.outboxEvent.findMany({
      where: { aggregateId: orderId },
    });
    expect(events.map((e) => e.eventType)).toEqual([OrderEventType.PAID]);
    const event = events[0]!;
    expect(event.payload).toMatchObject({
      orderId,
      userId: buyer.id,
      performanceId: perfId,
      totalAmount: SEAT_PRICE + GA_PRICE,
    });

    await until(() => appliedOnce(event.id), 'all three consumers');
    expect(await stats()).toEqual({
      tickets: 2,
      revenue: SEAT_PRICE + GA_PRICE,
      seat: 1,
      ga: 1,
    });
    const audit = await t.prisma.auditLog.findUniqueOrThrow({
      where: { eventId: event.id },
    });
    expect(audit).toMatchObject({
      action: 'order.paid',
      entityId: orderId,
      actorId: buyer.id,
    });
    // The ticket email went to the buyer, with one QR code per ticket.
    const search = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`message-id:${event.id}@questa.test`)}`,
    );
    const mail = (
      (await search.json()) as {
        messages: {
          ID: string;
          To: { Address: string }[];
          Subject: string;
        }[];
      }
    ).messages[0]!;
    expect(mail.To[0]!.Address).toBe(buyer.email);
    expect(mail.Subject).toBe('Vé của bạn: Kafka Night');
    // The QR codes are inline images (cid:), shown in the body.
    const detail = (await (
      await fetch(`${MAILPIT}/api/v1/message/${mail.ID}`)
    ).json()) as { Inline: { ContentID: string }[] };
    expect(detail.Inline.map((i) => i.ContentID).sort()).toEqual([
      'ticket-1@questa',
      'ticket-2@questa',
    ]);
    expect(
      (
        await t.prisma.outboxEvent.findUniqueOrThrow({
          where: { id: event.id },
        })
      ).publishedAt,
    ).not.toBeNull();
  });

  it('I7, the relay dies after Kafka acknowledged and before marking published: Kafka gets it twice, consumers apply it once', async () => {
    const relay = worker.get(OutboxRelayService);
    // The "crash": Kafka has the batch, the transaction never commits.
    const crash = vi
      .spyOn(relay, 'markPublished')
      .mockRejectedValueOnce(new Error('relay process killed'));
    try {
      const orderId = await buy(await customer(), 1);
      const event = await paidEvent(orderId);

      await until(
        async () => countSeen(event.id) === 2,
        'the event on Kafka twice',
      );
      expect(crash).toHaveBeenCalled();
      await until(() => appliedOnce(event.id), 'each consumer once');
      // Give a late duplicate time to be (wrongly) applied, then check again.
      await new Promise((r) => setTimeout(r, 1500));
      expect(await appliedOnce(event.id)).toBe(true);
      expect(await stats()).toMatchObject({
        tickets: 2,
        revenue: SEAT_PRICE + GA_PRICE,
      });
    } finally {
      crash.mockRestore();
    }
  });

  it('I7, Kafka paused: events wait in the outbox; once it is back they are delivered and applied once', async () => {
    const container = kafkaContainer();
    execFileSync('docker', ['pause', container]);
    let orderId: string;
    try {
      orderId = await buy(await customer(), 2);
      const event = await paidEvent(orderId);
      // The relay keeps trying (send timeout 4 s in tests) and fails: the
      // payment itself succeeded, the event waits, unpublished.
      await new Promise((r) => setTimeout(r, 6000));
      expect(
        (
          await t.prisma.outboxEvent.findUniqueOrThrow({
            where: { id: event.id },
          })
        ).publishedAt,
      ).toBeNull();
      expect(
        await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
      ).toMatchObject({ status: 'PAID' });
    } finally {
      execFileSync('docker', ['unpause', container]);
    }
    const event = await paidEvent(orderId);
    await until(
      async () =>
        (
          await t.prisma.outboxEvent.findUniqueOrThrow({
            where: { id: event.id },
          })
        ).publishedAt !== null,
      'published after Kafka is back',
      60_000,
    );
    await until(() => appliedOnce(event.id), 'each consumer once', 60_000);
    expect(await stats()).toMatchObject({
      tickets: 2,
      revenue: SEAT_PRICE + GA_PRICE,
    });
  }, 120_000);

  it('I7, the same event sent to Kafka twice more: still applied once', async () => {
    const orderId = await buy(await customer(), 3);
    const event = await paidEvent(orderId);
    await until(() => appliedOnce(event.id), 'first delivery applied');

    const envelope = {
      eventId: event.id,
      eventType: event.eventType,
      occurredAt: event.createdAt.toISOString(),
      version: 1,
      data: event.payload,
    };
    for (let i = 0; i < 2; i++) {
      await kafka.send(kafka.topics.orders, [
        { key: orderId, value: JSON.stringify(envelope) },
      ]);
    }
    await until(async () => countSeen(event.id) >= 3, 'the copies on Kafka');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await appliedOnce(event.id)).toBe(true);
    expect(await stats()).toMatchObject({
      tickets: 2,
      revenue: SEAT_PRICE + GA_PRICE,
    });
  });

  it('a performance cancelled after payment: order.cancelled reverses the sale, order.refunded follows', async () => {
    const buyer = await customer();
    const orderId = await buy(buyer, 4);
    const paid = await paidEvent(orderId);
    await until(() => appliedOnce(paid.id), 'the sale counted');

    const organizer = await t.prisma.performance.findUniqueOrThrow({
      where: { id: perfId },
      select: { concert: { select: { organizerId: true } } },
    });
    const token = await t.app
      .get(JwtService)
      .signAsync({ sub: organizer.concert.organizerId, role: Role.ORGANIZER });
    await t
      .http()
      .post(`/api/v1/performances/${perfId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The worker cancels the order (order.cancelled, wasPaid) and refunds
    // it through the fake gateway (order.refunded).
    await until(
      async () =>
        (await t.prisma.outboxEvent.count({
          where: { aggregateId: orderId, eventType: OrderEventType.REFUNDED },
        })) === 1,
      'order.refunded written',
      60_000,
    );
    const events = await t.prisma.outboxEvent.findMany({
      where: { aggregateId: orderId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      OrderEventType.PAID,
      OrderEventType.CANCELLED,
      OrderEventType.REFUNDED,
    ]);
    expect(events[1]!.payload).toMatchObject({
      reason: 'PERFORMANCE_CANCELLED',
      wasPaid: true,
    });
    for (const e of events)
      await until(() => appliedOnce(e.id), `${e.eventType} applied`);
    expect(await stats()).toEqual({ tickets: 0, revenue: 0, seat: 0, ga: 0 });
  }, 90_000);

  it('an event a consumer cannot apply goes to the dead letter topic; the other consumers are not held up', async () => {
    // A paid order on a zone that does not exist: analytics fails (foreign
    // key), audit and notifications apply it.
    const eventId = randomUUID();
    const bogus = {
      eventId,
      eventType: OrderEventType.PAID,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {
        orderId: randomUUID(),
        userId: randomUUID(),
        performanceId: perfId,
        totalAmount: 1,
        items: [{ zoneId: randomUUID(), seatId: null, price: 1 }],
      },
    };
    const dead: { consumer: string; value: string }[] = [];
    const dlq = kafka.consumer(`dlq-probe-${randomUUID()}`);
    await dlq.connect();
    await dlq.subscribe({ topics: [kafka.topics.deadLetter] });
    void dlq.run({
      eachMessage: async ({ message }) => {
        dead.push({
          consumer: message.headers?.consumer?.toString() ?? '',
          value: message.value!.toString(),
        });
      },
    });
    await kafka.send(kafka.topics.orders, [
      { key: bogus.data.orderId, value: JSON.stringify(bogus) },
    ]);

    await until(
      async () =>
        dead.some(
          (d) => d.consumer === 'analytics' && d.value.includes(eventId),
        ),
      'analytics dead-letters it',
    );
    const processed = await t.prisma.processedEvent.findMany({
      where: { eventId },
    });
    expect(processed.map((p) => p.consumer).sort()).toEqual([
      'audit',
      'notifications',
    ]);
    // Nothing of the failed attempts stayed behind.
    expect(
      await t.prisma.performanceSalesStat.count({
        where: { performanceId: perfId },
      }),
    ).toBe(0);
    await dlq.disconnect();
  });
});
