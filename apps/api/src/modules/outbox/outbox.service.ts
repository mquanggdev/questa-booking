import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderEventData, OrderEventType } from './order-events.js';

/**
 * Transactional outbox (spec, "Outbox pattern"). Business code never talks
 * to Kafka: it calls add() inside its own transaction, so the change and its
 * event commit together or not at all. The relay (worker) publishes later.
 */
@Injectable()
export class OutboxService {
  async add(
    tx: Prisma.TransactionClient,
    eventType: OrderEventType,
    data: OrderEventData,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateId: data.orderId,
        eventType,
        payload: data as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
