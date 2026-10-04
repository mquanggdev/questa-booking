import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { type Prisma, type SeatStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { rowLabel } from './row-label.js';

export interface SeatBlock {
  zoneId: string;
  rows: number;
  seatsPerRow: number;
}

export interface SeatView {
  id: string;
  zoneId: string;
  row: string;
  number: number;
  status: SeatStatus;
}

// Insert in chunks so one statement never carries tens of thousands of rows.
const INSERT_CHUNK = 5000;

@Injectable()
export class SeatsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Generates a rectangular block of seats per zone, inside the caller's transaction. */
  async createLayout(
    tx: Prisma.TransactionClient,
    performanceId: string,
    blocks: SeatBlock[],
  ): Promise<number> {
    const data = blocks.flatMap((block) =>
      Array.from({ length: block.rows }, (_, r) =>
        Array.from({ length: block.seatsPerRow }, (_, s) => ({
          performanceId,
          zoneId: block.zoneId,
          rowLabel: rowLabel(r),
          seatNumber: s + 1,
        })),
      ).flat(),
    );
    for (let i = 0; i < data.length; i += INSERT_CHUNK) {
      await tx.seat.createMany({ data: data.slice(i, i + INSERT_CHUNK) });
    }
    return data.length;
  }

  async listByPerformance(performanceId: string): Promise<SeatView[]> {
    const seats = await this.prisma.seat.findMany({
      where: { performanceId },
      select: {
        id: true,
        zoneId: true,
        rowLabel: true,
        seatNumber: true,
        status: true,
      },
    });
    // Sorted here, not in SQL: "AA" must come after "Z", which plain text
    // ordering gets wrong.
    seats.sort(
      (a, b) =>
        a.zoneId.localeCompare(b.zoneId) ||
        a.rowLabel.length - b.rowLabel.length ||
        a.rowLabel.localeCompare(b.rowLabel) ||
        a.seatNumber - b.seatNumber,
    );
    return seats.map((s) => ({
      id: s.id,
      zoneId: s.zoneId,
      row: s.rowLabel,
      number: s.seatNumber,
      status: s.status,
    }));
  }

  /**
   * PHASE 2 BASELINE: DELIBERATELY NAIVE. Do not copy.
   *
   * Check-then-act: read the seats, see they are AVAILABLE, then mark them
   * HELD with an UPDATE that does not re-check the status. Between the read
   * and the write another request can read the same seats as AVAILABLE too,
   * and both "win". Running inside a transaction does not help: at READ
   * COMMITTED, plain reads take no locks. Phase 3 fixes this.
   */
  async holdNaive(
    tx: Prisma.TransactionClient,
    performanceId: string,
    seatIds: string[],
  ): Promise<{ id: string; zoneId: string }[]> {
    const seats = await tx.seat.findMany({
      where: { id: { in: seatIds }, performanceId },
      select: { id: true, zoneId: true, status: true },
    });
    if (seats.length !== seatIds.length) {
      const found = new Set(seats.map((s) => s.id));
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_TICKET_SELECTION,
        'Some seats do not belong to this performance',
        { seatIds: seatIds.filter((id) => !found.has(id)) },
      );
    }
    const taken = seats.filter((s) => s.status !== 'AVAILABLE');
    if (taken.length > 0) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.SEAT_UNAVAILABLE,
        'Some seats are no longer available',
        { seatIds: taken.map((s) => s.id) },
      );
    }
    // No "AND status = 'AVAILABLE'" here: that missing condition is the bug.
    await tx.seat.updateMany({
      where: { id: { in: seatIds } },
      data: { status: 'HELD' },
    });
    return seats.map((s) => ({ id: s.id, zoneId: s.zoneId }));
  }

  /** AVAILABLE seat count per zone. */
  async countAvailableByZone(
    performanceId: string,
  ): Promise<Map<string, number>> {
    const groups = await this.prisma.seat.groupBy({
      by: ['zoneId'],
      where: { performanceId, status: 'AVAILABLE' },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.zoneId, g._count._all]));
  }
}
