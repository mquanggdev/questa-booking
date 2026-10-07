import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  cancelPerformanceJobId,
  PAYMENTS_QUEUE,
  PaymentJob,
  type CancelPerformanceData,
} from '../../queue/queue.constants.js';
import { PerformancesService } from '../concerts/performances.service.js';
import { ZonesService } from '../concerts/zones.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { ReleaseService } from '../reservations/release.service.js';
import { SeatsService } from '../seats/seats.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { RefundsService } from './refunds.service.js';

const BATCH = 200;

/**
 * Cancelling a performance (spec, "Hủy đêm diễn"), run by the worker after
 * the performance row became CANCELLED. Order by order, each in its own short
 * transaction, so a performance with thousands of orders never holds locks
 * for long. Safe to run again: every step is a conditional UPDATE.
 */
@Injectable()
export class PerformanceCancellationService {
  private readonly logger = new Logger(PerformanceCancellationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly performances: PerformancesService,
    private readonly orders: OrdersService,
    private readonly release: ReleaseService,
    private readonly seats: SeatsService,
    private readonly zones: ZonesService,
    private readonly tickets: TicketsService,
    private readonly refunds: RefundsService,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
  ) {}

  async run(
    performanceId: string,
  ): Promise<{ cancelled: number; refunded: number }> {
    if ((await this.performances.statusOf(performanceId)) !== 'CANCELLED') {
      return { cancelled: 0, refunded: 0 };
    }
    let cancelled = 0;
    let refunded = 0;

    // Step 2: unpaid orders are cancelled and their tickets released.
    for (;;) {
      const ids = await this.orders.idsByPerformance(
        performanceId,
        'PENDING',
        BATCH,
      );
      let progress = 0;
      for (const id of ids) {
        const set = await this.prisma.$transaction((tx) =>
          this.release.releaseInTx(tx, id, { to: 'CANCELLED' }),
        );
        await this.release.afterCommit(set);
        if (set) progress += 1;
      }
      cancelled += progress;
      if (ids.length < BATCH || progress === 0) break;
    }

    // Step 3: paid orders go to REFUND_PENDING, one refund job per payment.
    for (;;) {
      const ids = await this.orders.idsByPerformance(
        performanceId,
        'PAID',
        BATCH,
      );
      let progress = 0;
      for (const id of ids) {
        const refundIds = await this.prisma.$transaction((tx) =>
          this.refundPaidOrder(tx, id),
        );
        await this.refunds.enqueue(refundIds);
        if (refundIds.length > 0) progress += 1;
      }
      refunded += progress;
      if (ids.length < BATCH || progress === 0) break;
    }

    this.logger.log(
      `Performance ${performanceId} cancelled: ${cancelled} unpaid order(s) cancelled, ${refunded} paid order(s) to refund`,
    );
    return { cancelled, refunded };
  }

  /**
   * PAID -> REFUND_PENDING. The tickets are voided immediately (the show
   * will not happen), and the order stops counting as sold: seats and
   * standing counters go back so I2 and I9 stay exact.
   */
  private async refundPaidOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<string[]> {
    const items = await this.orders.unpay(tx, orderId);
    if (!items) return [];
    await this.seats.unsell(
      tx,
      items.flatMap((i) => (i.seatId ? [i.seatId] : [])),
    );
    const perZone = new Map<string, number>();
    for (const item of items) {
      if (!item.seatId) {
        perZone.set(item.zoneId, (perZone.get(item.zoneId) ?? 0) + 1);
      }
    }
    for (const [zoneId, quantity] of perZone) {
      await this.zones.unsellStanding(tx, zoneId, quantity);
    }
    await this.tickets.voidForItems(
      tx,
      items.map((i) => i.id),
    );
    const payments = await tx.payment.findMany({
      where: { orderId, status: 'SUCCEEDED', refund: null },
      select: { id: true, amount: true },
    });
    const refundIds: string[] = [];
    for (const payment of payments) {
      refundIds.push(
        await this.refunds.create(
          tx,
          payment.id,
          payment.amount,
          'Performance cancelled',
        ),
      );
    }
    return refundIds;
  }

  /**
   * Safety net: a cancelled performance that still has PENDING or PAID
   * orders gets its job again (lost enqueue, or a worker that died).
   */
  async resumeUnfinished(): Promise<number> {
    const ids = await this.orders.performancesLeftOpen(50);
    for (const performanceId of ids) {
      await this.queue.add(
        PaymentJob.CANCEL_PERFORMANCE,
        { performanceId } satisfies CancelPerformanceData,
        { jobId: cancelPerformanceJobId(performanceId) },
      );
    }
    return ids.length;
  }
}
