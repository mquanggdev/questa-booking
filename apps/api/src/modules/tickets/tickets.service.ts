import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  CheckInResponseDto,
  TicketResponseDto,
} from './dto/ticket.dto.js';

const seatSelect = { select: { rowLabel: true, seatNumber: true } } as const;

const ticketView = {
  id: true,
  code: true,
  issuedAt: true,
  checkedInAt: true,
  voidedAt: true,
  orderItem: {
    select: {
      orderId: true,
      zone: { select: { name: true } },
      seat: seatSelect,
      order: {
        select: {
          performance: {
            select: {
              id: true,
              venue: true,
              startsAt: true,
              concert: { select: { name: true } },
            },
          },
        },
      },
    },
  },
} as const;

function seatLabel(
  seat: { rowLabel: string; seatNumber: number } | null,
): string | null {
  return seat ? `${seat.rowLabel}${seat.seatNumber}` : null;
}

/**
 * Tickets: issued in the payment transaction, one per paid order item;
 * voided when the order leaves PAID; checked in once at the gate (flow D).
 */
@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One ticket per order item, inside the payment transaction. The code is
   * 128 random bits (base64url): it is the only thing the gate checks, so it
   * must be impossible to guess, not merely unique.
   */
  async issue(
    tx: Prisma.TransactionClient,
    orderItemIds: string[],
  ): Promise<void> {
    if (orderItemIds.length === 0) return;
    await tx.ticket.createMany({
      data: orderItemIds.map((orderItemId) => ({
        orderItemId,
        code: randomBytes(16).toString('base64url'),
      })),
    });
  }

  /** Invalidates the tickets of order items whose order is no longer PAID. */
  async voidForItems(
    tx: Prisma.TransactionClient,
    orderItemIds: string[],
  ): Promise<number> {
    if (orderItemIds.length === 0) return 0;
    return tx.$executeRaw`
      UPDATE tickets SET voided_at = now()
      WHERE order_item_id = ANY(${orderItemIds}::uuid[]) AND voided_at IS NULL
    `;
  }

  /** My tickets, newest first, each with its QR code. */
  async listForUser(userId: string): Promise<TicketResponseDto[]> {
    const tickets = await this.prisma.ticket.findMany({
      where: { orderItem: { order: { userId } } },
      select: ticketView,
      orderBy: { issuedAt: 'desc' },
      take: 200,
    });
    return Promise.all(
      tickets.map(async (t) => {
        const item = t.orderItem;
        const performance = item.order.performance;
        return {
          id: t.id,
          code: t.code,
          qrSvg: await QRCode.toString(t.code, { type: 'svg', margin: 1 }),
          orderId: item.orderId,
          performanceId: performance.id,
          concertName: performance.concert.name,
          venue: performance.venue,
          startsAt: performance.startsAt,
          zoneName: item.zone.name,
          seatLabel: seatLabel(item.seat),
          issuedAt: t.issuedAt,
          checkedInAt: t.checkedInAt,
          voidedAt: t.voidedAt,
        };
      }),
    );
  }

  /**
   * Flow D. One conditional UPDATE: of any number of concurrent scans of the
   * same code, exactly one matches `checked_in_at IS NULL` (I6). A voided
   * ticket never matches either.
   */
  async checkIn(code: string, staffId: string): Promise<CheckInResponseDto> {
    const rows = await this.prisma.$queryRaw<
      { id: string; checkedInAt: Date }[]
    >`
      UPDATE tickets SET checked_in_at = now(), checked_in_by = ${staffId}::uuid
      WHERE code = ${code} AND checked_in_at IS NULL AND voided_at IS NULL
      RETURNING id, checked_in_at AS "checkedInAt"
    `;
    const ticket = await this.prisma.ticket.findUnique({
      where: { code },
      select: {
        id: true,
        checkedInAt: true,
        checkedInBy: true,
        voidedAt: true,
        orderItem: {
          select: { zone: { select: { name: true } }, seat: seatSelect },
        },
      },
    });
    if (!ticket) {
      throw new AppException(
        HttpStatus.NOT_FOUND,
        ErrorCode.TICKET_NOT_FOUND,
        'No ticket has this code',
      );
    }
    if (rows[0]) {
      return {
        ticketId: ticket.id,
        checkedInAt: rows[0].checkedInAt,
        zoneName: ticket.orderItem.zone.name,
        seatLabel: seatLabel(ticket.orderItem.seat),
      };
    }
    // The UPDATE matched nothing: say exactly why.
    if (ticket.voidedAt) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.TICKET_VOIDED,
        'This ticket is void: its order was cancelled or refunded',
        { voidedAt: ticket.voidedAt },
      );
    }
    throw new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.TICKET_ALREADY_CHECKED_IN,
      `Already checked in at ${ticket.checkedInAt?.toISOString()}`,
      { checkedInAt: ticket.checkedInAt, checkedInBy: ticket.checkedInBy },
    );
  }
}
