import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ZonesService } from '../concerts/zones.service.js';
import { OrdersService, type ReleasedItem } from '../orders/orders.service.js';
import { SeatsService } from '../seats/seats.service.js';
import { HoldGateService } from './gate/hold-gate.service.js';
import type { StandingSelection } from './reservation-request.js';

const SWEEP_BATCH = 500;

/**
 * Flow C (release a hold): an unpaid order expires, or its owner cancels it.
 * One transaction: close the order (conditional UPDATE), mark its items
 * released, give seats and standing tickets back. Redis is updated after the
 * commit; if that fails, the gate only becomes more permissive (ADR-0010).
 */
@Injectable()
export class ReleaseService {
  private readonly logger = new Logger(ReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly seats: SeatsService,
    private readonly zones: ZonesService,
    private readonly gate: HoldGateService,
    private readonly config: AppConfigService,
  ) {}

  /** Expiry job and sweep. Returns false when there was nothing to do. */
  expire(orderId: string): Promise<boolean> {
    return this.release(orderId, {
      to: 'EXPIRED',
      graceSeconds: this.config.get('PAYMENT_GRACE_SECONDS'),
    });
  }

  /** POST /orders/:id/cancel by the owner; only a PENDING order can be cancelled. */
  async cancel(userId: string, orderId: string): Promise<void> {
    const released = await this.release(orderId, { to: 'CANCELLED', userId });
    if (released) return;
    const status = await this.orders.statusOf(userId, orderId);
    if (status === null) {
      throw new AppException(
        HttpStatus.NOT_FOUND,
        ErrorCode.ORDER_NOT_FOUND,
        'Order not found',
      );
    }
    throw new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.INVALID_STATE,
      `Only a PENDING order can be cancelled (this one is ${status})`,
    );
  }

  /**
   * Safety net, run every minute by the worker: releases overdue orders whose
   * delayed job never ran (queue down when the order was made, worker
   * stopped, job lost). Keeps I3 true even without BullMQ.
   */
  async sweep(): Promise<number> {
    let released = 0;
    for (;;) {
      const ids = await this.orders.findOverdue(
        this.config.get('PAYMENT_GRACE_SECONDS'),
        SWEEP_BATCH,
      );
      for (const id of ids) {
        if (await this.expire(id)) released += 1;
      }
      if (ids.length < SWEEP_BATCH) break;
    }
    if (released > 0) {
      this.logger.log(`Sweep released ${released} overdue order(s)`);
    }
    return released;
  }

  private async release(
    orderId: string,
    close: Parameters<OrdersService['closePending']>[2],
  ): Promise<boolean> {
    const items = await this.prisma.$transaction(async (tx) => {
      const released = await this.orders.closePending(tx, orderId, close);
      if (!released) return null;
      const { seatIds, standing } = group(released);
      await this.seats.release(tx, seatIds);
      for (const s of standing) {
        await this.zones.releaseStanding(tx, s.zoneId, s.quantity);
      }
      return { seatIds, standing };
    });
    if (!items) return false;
    await this.gate.release(items.seatIds, items.standing);
    return true;
  }
}

function group(items: ReleasedItem[]): {
  seatIds: string[];
  standing: StandingSelection[];
} {
  const seatIds: string[] = [];
  const perZone = new Map<string, number>();
  for (const item of items) {
    if (item.seatId) {
      seatIds.push(item.seatId);
    } else {
      perZone.set(item.zoneId, (perZone.get(item.zoneId) ?? 0) + 1);
    }
  }
  return {
    seatIds,
    standing: [...perZone].map(([zoneId, quantity]) => ({ zoneId, quantity })),
  };
}
