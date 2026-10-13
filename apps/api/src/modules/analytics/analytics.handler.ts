import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderEventHandler } from '../../kafka/event-consumers.service.js';
import { ConsumerName } from '../../kafka/kafka.constants.js';
import { RedisEventPublisher } from '../../redis/redis-event-publisher.js';
import { REDIS } from '../../redis/redis.module.js';
import { OrderEventType, type OrderEvent } from '../outbox/order-events.js';
import {
  SALES_NAMESPACE,
  SalesEvent,
  salesRoom,
} from './analytics.constants.js';
import { SalesStatsService } from './sales-stats.service.js';

/**
 * Consumer `analytics`: keeps performance_sales_stats from order events and
 * pushes `sales.updated` to the organizer's dashboard.
 *
 * - order.paid: + the order's tickets and revenue.
 * - order.cancelled with wasPaid (performance cancelled): - the same.
 * - anything else: no change to sales (an unpaid hold never counted).
 */
@Injectable()
export class AnalyticsHandler implements OrderEventHandler {
  readonly name = ConsumerName.ANALYTICS;
  private readonly publisher: RedisEventPublisher;

  constructor(
    private readonly stats: SalesStatsService,
    @Inject(REDIS) redis: Redis,
  ) {
    this.publisher = new RedisEventPublisher(redis, SALES_NAMESPACE);
  }

  async apply(event: OrderEvent, tx: Prisma.TransactionClient): Promise<void> {
    const sign = this.signOf(event);
    if (sign !== 0) {
      await this.stats.apply(
        tx,
        event.data.performanceId,
        event.data.items,
        sign,
      );
    }
  }

  async afterCommit(event: OrderEvent): Promise<void> {
    if (this.signOf(event) === 0) return;
    const perf = event.data.performanceId;
    await this.publisher.emit(
      salesRoom(perf),
      SalesEvent.UPDATED,
      await this.stats.snapshot(perf),
    );
  }

  private signOf(event: OrderEvent): 1 | -1 | 0 {
    if (event.eventType === OrderEventType.PAID) return 1;
    if (event.eventType === OrderEventType.CANCELLED && event.data.wasPaid) {
      return -1;
    }
    return 0;
  }
}
