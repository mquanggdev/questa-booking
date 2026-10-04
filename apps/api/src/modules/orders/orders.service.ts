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

  /** A PENDING order with one row per ticket, inside the caller's transaction. */
  createPending(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      performanceId: string;
      expiresAt: Date;
      items: NewOrderItem[];
    },
  ): Promise<OrderResponseDto> {
    return tx.order.create({
      data: {
        userId: input.userId,
        performanceId: input.performanceId,
        status: 'PENDING',
        expiresAt: input.expiresAt,
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
