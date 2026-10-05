import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isPgError, PgCode } from '../../common/errors/pg-error.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PerformancesService } from '../concerts/performances.service.js';
import { ZonesService } from '../concerts/zones.service.js';
import type { OrderResponseDto } from '../orders/dto/order.dto.js';
import { OrdersService, type NewOrderItem } from '../orders/orders.service.js';
import { SeatsService } from '../seats/seats.service.js';
import type { CreateReservationDto } from './dto/create-reservation.dto.js';
import {
  normalizeSelection,
  requestHash,
  ticketCount,
} from './reservation-request.js';

export interface ReservationResult {
  order: OrderResponseDto;
  /** True when an earlier request with the same Idempotency-Key made the order. */
  replayed: boolean;
}

/**
 * Flow A (hold tickets). Every guarantee is enforced by PostgreSQL, inside one
 * transaction, in this order:
 *
 * 1. Advisory lock per (user, performance): this user's requests for this
 *    performance run one at a time (I5 replays, I10 ticket limit).
 * 2. Idempotency-Key already used: return that order (I5).
 * 3. Ticket limit across all of the user's active orders (I10).
 * 4. Hold the numbered seats with a row-level guard (I1).
 * 5. Insert the order and one item per ticket. The partial unique index on
 *    order_items(seat_id) rejects a second active owner of a seat (I1).
 * 6. Increment standing counters with a conditional UPDATE, last, so the
 *    zone's hot row stays locked as briefly as possible (I9).
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
    idempotencyKey: string,
    dto: CreateReservationDto,
  ): Promise<ReservationResult> {
    const selection = normalizeSelection(dto);
    const count = ticketCount(selection);
    if (count === 0) {
      throw invalidSelection('Select at least one seat or standing ticket');
    }

    const performance = await this.performances.getOnSale(dto.performanceId);
    const max = performance.maxTicketsPerUser;
    if (count > max) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.TOO_MANY_TICKETS,
        `At most ${max} tickets per account`,
        { requested: count, max },
      );
    }
    const zones = new Map(performance.zones.map((z) => [z.id, z]));
    for (const s of selection.standing) {
      if (zones.get(s.zoneId)?.type !== 'STANDING') {
        throw invalidSelection('Not a standing zone of this performance', {
          zoneId: s.zoneId,
        });
      }
    }

    const hash = requestHash(selection);
    const expiresAt = new Date(
      Date.now() + this.config.get('HOLD_TTL_SECONDS') * 1000,
    );
    const strategy = this.config.get('SEAT_HOLD_STRATEGY');

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.orders.lockBuyer(tx, userId, performance.id);

        const existing = await this.orders.findByIdempotencyKey(
          tx,
          userId,
          idempotencyKey,
        );
        if (existing) {
          if (existing.requestHash !== hash) {
            throw keyReused();
          }
          const { requestHash: _hash, ...order } = existing;
          return { order, replayed: true };
        }

        const owned = await this.orders.countActiveTickets(
          tx,
          userId,
          performance.id,
        );
        if (owned + count > max) {
          throw new AppException(
            HttpStatus.CONFLICT,
            ErrorCode.TICKET_LIMIT_REACHED,
            `At most ${max} tickets per account for this performance`,
            { alreadyHeld: owned, requested: count, max },
          );
        }

        const items: NewOrderItem[] = [];
        if (selection.seatIds.length > 0) {
          const held = await this.seats.hold(
            tx,
            performance.id,
            selection.seatIds,
            strategy,
          );
          for (const seat of held) {
            items.push({
              zoneId: seat.zoneId,
              seatId: seat.id,
              price: zones.get(seat.zoneId)?.price ?? 0,
            });
          }
        }
        for (const s of selection.standing) {
          const price = zones.get(s.zoneId)?.price ?? 0;
          for (let i = 0; i < s.quantity; i++) {
            items.push({ zoneId: s.zoneId, seatId: null, price });
          }
        }

        const order = await this.orders.createPending(tx, {
          userId,
          performanceId: performance.id,
          expiresAt,
          idempotencyKey,
          requestHash: hash,
          items,
        });

        for (const s of selection.standing) {
          await this.zones.holdStanding(
            tx,
            performance.id,
            s.zoneId,
            s.quantity,
          );
        }
        return { order, replayed: false };
      });
    } catch (error) {
      throw translateConstraintError(error);
    }
  }
}

/**
 * The database guards should never fire when the code above is correct; if
 * they do, the request is still answered with the right business error.
 */
function translateConstraintError(error: unknown): unknown {
  if (
    isPgError(error, PgCode.UNIQUE_VIOLATION, 'order_items_active_seat_key')
  ) {
    return new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.SEAT_UNAVAILABLE,
      'Some seats are no longer available',
    );
  }
  // Same user and key from a different performance: the advisory locks differ,
  // so the unique (user_id, idempotency_key) index is what catches it.
  if (
    isPgError(
      error,
      PgCode.UNIQUE_VIOLATION,
      'orders_user_id_idempotency_key_key',
    )
  ) {
    return keyReused();
  }
  if (isPgError(error, PgCode.CHECK_VIOLATION, 'zones_within_capacity')) {
    return new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.SOLD_OUT,
      'Not enough standing tickets left in this zone',
    );
  }
  return error;
}

function keyReused(): AppException {
  return new AppException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was already used for a different request',
  );
}

function invalidSelection(message: string, details?: unknown): AppException {
  return new AppException(
    HttpStatus.BAD_REQUEST,
    ErrorCode.INVALID_TICKET_SELECTION,
    message,
    details,
  );
}
