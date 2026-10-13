import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { KafkaService } from '../../kafka/kafka.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ORDER_EVENT_VERSION,
  type OrderEvent,
  type OrderEventData,
  type OrderEventType,
} from './order-events.js';

interface OutboxRow {
  id: string;
  eventType: OrderEventType;
  payload: OrderEventData;
  createdAt: Date;
}

/**
 * Outbox relay (worker only, spec "Outbox pattern"). Every
 * OUTBOX_RELAY_EVERY_MS: lock a batch of unpublished events, send them to
 * Kafka and wait for the acknowledgement, then mark them published, all in
 * one transaction.
 *
 * If the relay dies after Kafka acknowledged but before the commit, the
 * rows are still unpublished and are sent again: Kafka may get an event
 * twice (at least once), and consumers deduplicate on eventId (I7).
 */
@Injectable()
export class OutboxRelayService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.get('OUTBOX_RELAY_EVERY_MS');
    this.timer = setInterval(() => void this.tick(), every);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Publishes until the outbox is empty. A slow round is never overlapped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const size = this.config.get('OUTBOX_BATCH_SIZE');
      while ((await this.publishBatch()) === size) {
        // a full batch: there may be more right away
      }
    } catch (error) {
      // Kafka down, or the database: the rows stay unpublished; next tick.
      this.logger.warn(`Outbox relay round failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** One batch. Returns how many events were published. */
  async publishBatch(): Promise<number> {
    const timeout = this.config.get('KAFKA_SEND_TIMEOUT_MS') + 5000;
    return this.prisma.$transaction(
      async (tx) => {
        // Oldest unpublished events first, locked until this transaction
        // ends. SKIP LOCKED: a second relay (another worker) takes the next
        // rows instead of waiting, and never sends the same rows at the
        // same time as this one.
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, event_type AS "eventType", payload, created_at AS "createdAt"
          FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY created_at, id
          LIMIT ${this.config.get('OUTBOX_BATCH_SIZE')}
          FOR UPDATE SKIP LOCKED
        `;
        if (rows.length === 0) return 0;

        // Key = orderId: all events of one order go to one partition, in
        // the order they were sent.
        await this.kafka.send(
          this.kafka.topics.orders,
          rows.map((row) => ({
            key: row.payload.orderId,
            value: JSON.stringify(envelope(row)),
            headers: { eventType: row.eventType },
          })),
        );
        await this.markPublished(
          tx,
          rows.map((r) => r.id),
        );
        return rows.length;
      },
      { timeout, maxWait: 5000 },
    );
  }

  /** Separate so tests can make the relay "die" between send and commit. */
  async markPublished(
    tx: Prisma.TransactionClient,
    ids: string[],
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE outbox_events SET published_at = now()
      WHERE id = ANY(${ids}::uuid[])
    `;
  }
}

function envelope(row: OutboxRow): OrderEvent {
  return {
    eventId: row.id,
    eventType: row.eventType,
    occurredAt: row.createdAt.toISOString(),
    version: ORDER_EVENT_VERSION,
    data: row.payload,
  };
}
