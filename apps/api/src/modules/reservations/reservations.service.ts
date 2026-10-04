import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PerformancesService } from '../concerts/performances.service.js';
import { ZonesService } from '../concerts/zones.service.js';
import type { OrderResponseDto } from '../orders/dto/order.dto.js';
import { OrdersService, type NewOrderItem } from '../orders/orders.service.js';
import { SeatsService } from '../seats/seats.service.js';
import type { CreateReservationDto } from './dto/create-reservation.dto.js';

/**
 * Flow A (hold tickets), PHASE 2 BASELINE.
 *
 * Everything runs in one transaction, so a failure never leaves a half-made
 * order. But a transaction is not a lock: two concurrent requests still read
 * the same seats as AVAILABLE and both succeed. Phase 2 measures exactly
 * that; phase 3 adds row locks, conditional updates, a unique index, the
 * per-account limit across orders and the Idempotency-Key.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly performances: PerformancesService,
    private readonly seats: SeatsService,
    private readonly zones: ZonesService,
    private readonly orders: OrdersService,
    private readonly config: AppConfigService,
  ) {}

  async reserve(
    userId: string,
    dto: CreateReservationDto,
  ): Promise<OrderResponseDto> {
    const seatIds = dto.seatIds ?? [];
    const standing = mergeStanding(dto.standing ?? []);
    const ticketCount =
      seatIds.length + standing.reduce((sum, s) => sum + s.quantity, 0);
    if (ticketCount === 0) {
      throw invalidSelection('Select at least one seat or standing ticket');
    }

    const performance = await this.performances.getOnSale(dto.performanceId);
    // Per request only. Across several orders the limit is not enforced yet:
    // that needs a lock per (user, performance), added in phase 3.
    if (ticketCount > performance.maxTicketsPerUser) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.TOO_MANY_TICKETS,
        `At most ${performance.maxTicketsPerUser} tickets per account`,
        { requested: ticketCount, max: performance.maxTicketsPerUser },
      );
    }
    const zones = new Map(performance.zones.map((z) => [z.id, z]));
    for (const s of standing) {
      if (zones.get(s.zoneId)?.type !== 'STANDING') {
        throw invalidSelection('Not a standing zone of this performance', {
          zoneId: s.zoneId,
        });
      }
    }

    const expiresAt = new Date(
      Date.now() + this.config.get('HOLD_TTL_SECONDS') * 1000,
    );
    return this.prisma.$transaction(async (tx) => {
      const items: NewOrderItem[] = [];
      if (seatIds.length > 0) {
        const held = await this.seats.holdNaive(tx, performance.id, seatIds);
        for (const seat of held) {
          items.push({
            zoneId: seat.zoneId,
            seatId: seat.id,
            price: zones.get(seat.zoneId)?.price ?? 0,
          });
        }
      }
      for (const s of standing) {
        await this.zones.holdStandingNaive(tx, s.zoneId, s.quantity);
        const price = zones.get(s.zoneId)?.price ?? 0;
        for (let i = 0; i < s.quantity; i++) {
          items.push({ zoneId: s.zoneId, seatId: null, price });
        }
      }
      return this.orders.createPending(tx, {
        userId,
        performanceId: performance.id,
        expiresAt,
        items,
      });
    });
  }
}

/** Two entries for the same zone become one, so a zone is held once. */
function mergeStanding(
  selections: { zoneId: string; quantity: number }[],
): { zoneId: string; quantity: number }[] {
  const totals = new Map<string, number>();
  for (const s of selections) {
    totals.set(s.zoneId, (totals.get(s.zoneId) ?? 0) + s.quantity);
  }
  return [...totals].map(([zoneId, quantity]) => ({ zoneId, quantity }));
}

function invalidSelection(message: string, details?: unknown): AppException {
  return new AppException(
    HttpStatus.BAD_REQUEST,
    ErrorCode.INVALID_TICKET_SELECTION,
    message,
    details,
  );
}
