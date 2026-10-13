import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { AppConfigService } from '../config/app-config.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  parseOrderEvent,
  type OrderEvent,
} from '../modules/outbox/order-events.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { KafkaService } from './kafka.service.js';

/** One consumer of orders.events (notifications, analytics, audit). */
export interface OrderEventHandler {
  /** Consumer group and the `consumer` column of processed_events. */
  readonly name: string;
  /**
   * The effect, inside the transaction that records the event as
   * processed: both commit or neither does (I7).
   */
  apply(event: OrderEvent, tx: Prisma.TransactionClient): Promise<void>;
  /** After the commit (e.g. a realtime push). Errors are only logged. */
  afterCommit?(event: OrderEvent): Promise<void>;
}

export const ORDER_EVENT_HANDLERS = Symbol('ORDER_EVENT_HANDLERS');

export type Outcome = 'applied' | 'duplicate' | 'dead-lettered';

/**
 * Runs every handler as its own consumer group on orders.events (worker).
 *
 * Kafka delivers at least once: after a crash, or when the relay sent an
 * event twice, a handler sees it again. Each handler inserts (consumer,
 * eventId) into processed_events in the same transaction as its effect; a
 * duplicate hits the primary key and is skipped. Delivered at least once,
 * applied exactly once (I7).
 *
 * A failing event is retried CONSUMER_MAX_ATTEMPTS times with backoff, then
 * sent to orders.events.dlq so it does not block its partition forever.
 */
@Injectable()
export class EventConsumersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventConsumersService.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
    @Inject(ORDER_EVENT_HANDLERS)
    private readonly handlers: OrderEventHandler[],
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.kafka.ensureTopics();
    for (const handler of this.handlers) {
      const consumer = this.kafka.consumer(handler.name);
      await consumer.connect();
      await consumer.subscribe({ topics: [this.kafka.topics.orders] });
      // One partition per worker slot: events of one order (one key) stay
      // in order, different orders are handled in parallel.
      void consumer.run({
        partitionsConsumedConcurrently: 3,
        eachMessage: (payload) => this.onMessage(handler, payload),
      });
    }
    this.logger.log(
      `Consuming ${this.kafka.topics.orders}: ${this.handlers.map((h) => h.name).join(', ')}`,
    );
  }

  private async onMessage(
    handler: OrderEventHandler,
    { message }: KafkaJS.EachMessagePayload,
  ): Promise<void> {
    const raw = message.value?.toString() ?? '';
    let event: OrderEvent;
    try {
      event = parseOrderEvent(raw);
    } catch (error) {
      await this.deadLetter(handler, raw, message.key?.toString(), error, 0);
      return;
    }
    await this.handle(handler, event, raw);
  }

  /**
   * Applies one event with retries; dead-letters it after the last attempt.
   * If even the dead letter cannot be sent, this throws and the client
   * delivers the message again (its offset is not stored).
   */
  async handle(
    handler: OrderEventHandler,
    event: OrderEvent,
    raw: string = JSON.stringify(event),
  ): Promise<Outcome> {
    const attempts = this.config.get('CONSUMER_MAX_ATTEMPTS');
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const applied = await this.applyOnce(handler, event);
        if (applied && handler.afterCommit) {
          await handler
            .afterCommit(event)
            .catch((error: unknown) =>
              this.logger.warn(
                `${handler.name}: after-commit step failed for ${event.eventId}: ${String(error)}`,
              ),
            );
        }
        if (applied) {
          this.metrics.consumerLag.observe(
            { consumer: handler.name },
            (Date.now() - Date.parse(event.occurredAt)) / 1000,
          );
        }
        return this.count(handler, applied ? 'applied' : 'duplicate');
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await sleep(200 * 2 ** (attempt - 1));
        }
      }
    }
    await this.deadLetter(
      handler,
      raw,
      event.data.orderId,
      lastError,
      attempts,
    );
    return this.count(handler, 'dead-lettered');
  }

  private count(handler: OrderEventHandler, outcome: Outcome): Outcome {
    this.metrics.consumerEvents.inc({ consumer: handler.name, outcome });
    return outcome;
  }

  /** True if applied now, false if this consumer had already applied it. */
  private applyOnce(
    handler: OrderEventHandler,
    event: OrderEvent,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // I7: the first delivery inserts the row; any later one (relay sent
      // it twice, a crash before the offset commit) inserts nothing.
      const inserted = await tx.$executeRaw`
        INSERT INTO processed_events (consumer, event_id)
        VALUES (${handler.name}, ${event.eventId}::uuid)
        ON CONFLICT DO NOTHING
      `;
      if (inserted === 0) return false;
      await handler.apply(event, tx);
      return true;
    });
  }

  private async deadLetter(
    handler: OrderEventHandler,
    raw: string,
    key: string | undefined,
    error: unknown,
    attempts: number,
  ): Promise<void> {
    this.logger.error(
      `${handler.name}: event sent to the dead letter topic after ${attempts} attempt(s): ${String(error)}`,
    );
    await this.kafka.send(this.kafka.topics.deadLetter, [
      {
        key: key ?? '',
        value: raw,
        headers: {
          consumer: handler.name,
          error: String(error).slice(0, 500),
          attempts: String(attempts),
        },
      },
    ]);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
