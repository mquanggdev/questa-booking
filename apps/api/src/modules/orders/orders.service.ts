import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { OrderResponseDto } from './dto/order.dto.js';

export interface LockedOrder {
  id: string;
  userId: string;
  performanceId: string;
  status: string;
  totalAmount: number;
  expiresAt: Date;
}

export interface PaidItem {
  id: string;
  zoneId: string;
  seatId: string | null;
}

export interface ReleasedItem {
  zoneId: string;
  seatId: string | null;
}

export interface NewOrderItem {
  zoneId: string;
  seatId: string | null;
  price: number;
}

const orderSelect = {
  id: true,
  performanceId: true,
  status: true,
  totalAmount: true,
  expiresAt: true,
  createdAt: true,
  items: {
    select: { id: true, zoneId: true, seatId: true, price: true },
    orderBy: { id: 'asc' },
  },
} as const;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Serializes the transactions of one user for one performance until they
   * commit or roll back. Needed for two rules that span several orders:
   * the per-account ticket limit (I10) and replaying an Idempotency-Key that
   * two concurrent requests share (I5). Requests of different users never
   * wait on each other.
   */
  async lockBuyer(
    tx: Prisma.TransactionClient,
    userId: string,
    performanceId: string,
  ): Promise<void> {
    // Transaction-scoped advisory lock on a 64-bit hash of the pair. A rare
    // hash collision only makes two unrelated buyers wait briefly.
    // $executeRaw, not $queryRaw: the function returns `void`, which Prisma
    // cannot deserialize as a result column.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${performanceId}`}, 0))
    `;
  }

  /** The order this user already created with this Idempotency-Key, if any. */
  findByIdempotencyKey(
    tx: Prisma.TransactionClient,
    userId: string,
    idempotencyKey: string,
  ): Promise<(OrderResponseDto & { requestHash: string }) | null> {
    return tx.order.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: { ...orderSelect, requestHash: true },
    });
  }

  /** Tickets the user holds or bought for a performance (active items only). */
  countActiveTickets(
    tx: Prisma.TransactionClient,
    userId: string,
    performanceId: string,
  ): Promise<number> {
    return tx.orderItem.count({
      where: {
        releasedAt: null,
        order: {
          userId,
          performanceId,
          status: { in: ['PENDING', 'PAID'] },
        },
      },
    });
  }

  /** A PENDING order with one row per ticket, inside the caller's transaction. */
  createPending(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      performanceId: string;
      expiresAt: Date;
      idempotencyKey: string;
      requestHash: string;
      items: NewOrderItem[];
    },
  ): Promise<OrderResponseDto> {
    return tx.order.create({
      data: {
        userId: input.userId,
        performanceId: input.performanceId,
        status: 'PENDING',
        expiresAt: input.expiresAt,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        totalAmount: input.items.reduce((sum, item) => sum + item.price, 0),
        items: { create: input.items },
      },
      select: orderSelect,
    });
  }

  /**
   * PENDING -> EXPIRED or CANCELLED, and releases every ticket of the order.
   * The transition is a conditional UPDATE: of an expiry job, the sweep, a
   * cancel and (phase 5) a payment racing on one order, exactly one wins;
   * the others match no row and get null.
   *
   * - expire: only once expires_at + graceSeconds has passed.
   * - cancel: only by the owner (userId).
   */
  async closePending(
    tx: Prisma.TransactionClient,
    orderId: string,
    close:
      | { to: 'EXPIRED'; graceSeconds: number }
      // userId: the owner cancels; absent: the system cancels (performance cancelled).
      | { to: 'CANCELLED'; userId?: string },
  ): Promise<ReleasedItem[] | null> {
    const changed =
      close.to === 'EXPIRED'
        ? await tx.$executeRaw`
            UPDATE orders SET status = 'EXPIRED', updated_at = now()
            WHERE id = ${orderId}::uuid
              AND status = 'PENDING'
              AND expires_at + ${close.graceSeconds} * interval '1 second' <= now()
          `
        : close.userId
          ? await tx.$executeRaw`
              UPDATE orders SET status = 'CANCELLED', updated_at = now()
              WHERE id = ${orderId}::uuid
                AND status = 'PENDING'
                AND user_id = ${close.userId}::uuid
            `
          : await tx.$executeRaw`
              UPDATE orders SET status = 'CANCELLED', updated_at = now()
              WHERE id = ${orderId}::uuid AND status = 'PENDING'
            `;
    if (changed === 0) {
      return null;
    }
    // released_at frees the seat for the partial unique index (I1).
    return tx.$queryRaw<ReleasedItem[]>`
      UPDATE order_items SET released_at = now()
      WHERE order_id = ${orderId}::uuid AND released_at IS NULL
      RETURNING zone_id AS "zoneId", seat_id AS "seatId"
    `;
  }

  /**
   * Locks one order row for the rest of the transaction and returns what the
   * payment flow needs to decide. Concurrent expiry, cancellation and other
   * payments for the same order wait on this lock, so the decision cannot be
   * overtaken.
   */
  async lockForPayment(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<LockedOrder | null> {
    const rows = await tx.$queryRaw<LockedOrder[]>`
      SELECT id, user_id AS "userId", performance_id AS "performanceId",
             status, total_amount AS "totalAmount", expires_at AS "expiresAt"
      FROM orders
      WHERE id = ${orderId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /**
   * PENDING -> PAID (flow B, step 5). Only if the hold has not run out,
   * grace included. Returns the order's active items, or null if the
   * transition did not apply.
   */
  async markPaid(
    tx: Prisma.TransactionClient,
    orderId: string,
    graceSeconds: number,
  ): Promise<PaidItem[] | null> {
    const changed = await tx.$executeRaw`
      UPDATE orders SET status = 'PAID', updated_at = now()
      WHERE id = ${orderId}::uuid
        AND status = 'PENDING'
        AND expires_at + ${graceSeconds} * interval '1 second' > now()
    `;
    if (changed === 0) return null;
    return tx.$queryRaw<PaidItem[]>`
      SELECT id, zone_id AS "zoneId", seat_id AS "seatId"
      FROM order_items
      WHERE order_id = ${orderId}::uuid AND released_at IS NULL
    `;
  }

  /**
   * Money arrived for an order that was already closed (flow B, step 6):
   * EXPIRED/CANCELLED -> REFUND_PENDING. The seats stay with whoever has
   * them now; the money goes back (I8).
   */
  async markRefundPending(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<boolean> {
    const changed = await tx.$executeRaw`
      UPDATE orders SET status = 'REFUND_PENDING', updated_at = now()
      WHERE id = ${orderId}::uuid AND status IN ('EXPIRED', 'CANCELLED')
    `;
    return changed === 1;
  }

  /**
   * PAID -> REFUND_PENDING because the performance was cancelled. The order
   * stops occupying anything right away: its items are released and
   * returned, so the caller can give back seats and standing counters.
   * Returns null if the order was not PAID.
   */
  async unpay(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<PaidItem[] | null> {
    const changed = await tx.$executeRaw`
      UPDATE orders SET status = 'REFUND_PENDING', updated_at = now()
      WHERE id = ${orderId}::uuid AND status = 'PAID'
    `;
    if (changed === 0) return null;
    return tx.$queryRaw<PaidItem[]>`
      UPDATE order_items SET released_at = now()
      WHERE order_id = ${orderId}::uuid AND released_at IS NULL
      RETURNING id, zone_id AS "zoneId", seat_id AS "seatId"
    `;
  }

  /** REFUND_PENDING -> REFUNDED once the gateway confirmed every refund. */
  async markRefunded(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<boolean> {
    const changed = await tx.$executeRaw`
      UPDATE orders SET status = 'REFUNDED', updated_at = now()
      WHERE id = ${orderId}::uuid AND status = 'REFUND_PENDING'
    `;
    return changed === 1;
  }

  /** Ids of the order items of one order (to void its tickets). */
  async itemIds(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<string[]> {
    const rows = await tx.orderItem.findMany({
      where: { orderId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Cancelled performances that still have PENDING or PAID orders: their
   * cancellation job did not finish (or never ran). The worker resumes them.
   */
  async performancesLeftOpen(limit: number): Promise<string[]> {
    const rows = await this.prisma.order.findMany({
      where: {
        status: { in: ['PENDING', 'PAID'] },
        performance: { status: 'CANCELLED' },
      },
      distinct: ['performanceId'],
      select: { performanceId: true },
      take: limit,
    });
    return rows.map((r) => r.performanceId);
  }

  /** Order ids of a performance in one status, a page at a time. */
  async idsByPerformance(
    performanceId: string,
    status: 'PENDING' | 'PAID',
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.order.findMany({
      where: { performanceId, status },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((r) => r.id);
  }

  /** The order a customer wants to pay for, if it is theirs. */
  findOwned(userId: string, orderId: string) {
    return this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: {
        id: true,
        performanceId: true,
        status: true,
        totalAmount: true,
        expiresAt: true,
      },
    });
  }

  /** PENDING orders past expires_at + grace, oldest first. */
  async findOverdue(graceSeconds: number, limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders
      WHERE status = 'PENDING'
        AND expires_at + ${graceSeconds} * interval '1 second' <= now()
      ORDER BY expires_at
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  /** Status of one order, or null (used to explain why a cancel did nothing). */
  async statusOf(userId: string, orderId: string): Promise<string | null> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { status: true },
    });
    return order?.status ?? null;
  }

  listForUser(userId: string): Promise<OrderResponseDto[]> {
    return this.prisma.order.findMany({
      where: { userId },
      select: orderSelect,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getForUser(userId: string, id: string): Promise<OrderResponseDto> {
    // Filtering by owner in the query: another user's order is simply "not found".
    const order = await this.prisma.order.findFirst({
      where: { id, userId },
      select: orderSelect,
    });
    if (!order) {
      throw new AppException(
        HttpStatus.NOT_FOUND,
        ErrorCode.ORDER_NOT_FOUND,
        'Order not found',
      );
    }
    return order;
  }
}
