import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderEventHandler } from '../../kafka/event-consumers.service.js';
import { ConsumerName } from '../../kafka/kafka.constants.js';
import { OrderEventType, type OrderEvent } from '../outbox/order-events.js';

/**
 * Consumer `audit`: one audit_logs row per order event. The actor is the
 * buyer when the buyer acted (paid, cancelled their own hold), nobody (the
 * system) for expiry, refunds and performance cancellations.
 */
@Injectable()
export class AuditHandler implements OrderEventHandler {
  readonly name = ConsumerName.AUDIT;

  async apply(event: OrderEvent, tx: Prisma.TransactionClient): Promise<void> {
    const byBuyer =
      event.eventType === OrderEventType.PAID ||
      (event.eventType === OrderEventType.CANCELLED &&
        event.data.reason === 'CUSTOMER');
    await tx.auditLog.create({
      data: {
        actorId: byBuyer ? event.data.userId : null,
        action: event.eventType,
        entity: 'order',
        entityId: event.data.orderId,
        metadata: {
          ...event.data,
          occurredAt: event.occurredAt,
        } as unknown as Prisma.InputJsonValue,
        eventId: event.eventId,
      },
    });
  }
}
