import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { OrderResponseDto } from './dto/order.dto.js';

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
