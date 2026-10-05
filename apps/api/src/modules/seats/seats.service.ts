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

export type SeatHoldStrategy = 'conditional' | 'pessimistic' | 'optimistic';

export interface HeldSeat {
  id: string;
  zoneId: string;
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
   * Holds AVAILABLE seats for a reservation, inside the caller's transaction.
   * Throws (so the transaction rolls back) unless every seat could be held.
   *
   * Three correct strategies, kept side by side for the phase 3 benchmark
   * (ADR-0008). Whatever the strategy, the partial unique index
   * order_items_active_seat_key is the last line of defence (I1).
   */
  async hold(
    tx: Prisma.TransactionClient,
    performanceId: string,
    seatIds: string[],
    strategy: SeatHoldStrategy,
  ): Promise<HeldSeat[]> {
    const ids = [...seatIds].sort();
    switch (strategy) {
      case 'conditional':
        return this.holdConditional(tx, performanceId, ids);
      case 'pessimistic':
        return this.holdPessimistic(tx, performanceId, ids);
      case 'optimistic':
        return this.holdOptimistic(tx, performanceId, ids);
    }
  }

  /** One statement: the WHERE clause is the check and the row lock is the guard. */
  private async holdConditional(
    tx: Prisma.TransactionClient,
    performanceId: string,
    ids: string[],
  ): Promise<HeldSeat[]> {
    // "AND status = 'AVAILABLE'" is re-evaluated on the latest committed row
    // version after waiting for any concurrent writer's lock (READ COMMITTED
    // re-check), so of two requests for one seat exactly one matches.
    const held = await tx.$queryRaw<{ id: string; zone_id: string }[]>`
      UPDATE seats
      SET status = 'HELD'
      WHERE performance_id = ${performanceId}::uuid
        AND id = ANY(${ids}::uuid[])
        AND status = 'AVAILABLE'
      RETURNING id, zone_id
    `;
    if (held.length !== ids.length) {
      await this.explainMiss(
        tx,
        performanceId,
        ids,
        held.map((h) => h.id),
      );
    }
    return held.map((h) => ({ id: h.id, zoneId: h.zone_id }));
  }

  /** Lock the rows first, check in code, then write. */
  private async holdPessimistic(
    tx: Prisma.TransactionClient,
    performanceId: string,
    ids: string[],
  ): Promise<HeldSeat[]> {
    // FOR UPDATE takes the row locks before reading. ORDER BY id makes every
    // request lock overlapping seats in the same order, so two requests can
    // never wait on each other in a cycle (no deadlock).
    const rows = await tx.$queryRaw<
      { id: string; zone_id: string; status: SeatStatus }[]
    >`
      SELECT id, zone_id, status
      FROM seats
      WHERE performance_id = ${performanceId}::uuid
        AND id = ANY(${ids}::uuid[])
      ORDER BY id
      FOR UPDATE
    `;
    const available = rows.filter((r) => r.status === 'AVAILABLE');
    if (available.length !== ids.length) {
      await this.explainMiss(
        tx,
        performanceId,
        ids,
        available.map((r) => r.id),
      );
    }
    // Safe without re-checking the status: we hold the locks since the read.
    await tx.$executeRaw`
      UPDATE seats SET status = 'HELD' WHERE id = ANY(${ids}::uuid[])
    `;
    return rows.map((r) => ({ id: r.id, zoneId: r.zone_id }));
  }

  /** Read without locking, then write only if nobody changed the row since. */
  private async holdOptimistic(
    tx: Prisma.TransactionClient,
    performanceId: string,
    ids: string[],
  ): Promise<HeldSeat[]> {
    // xmin is PostgreSQL's built-in row version: the id of the transaction
    // that last wrote the row. It changes on every UPDATE, so it works as a
    // version column without adding one to the schema.
    const rows = await tx.$queryRaw<
      { id: string; zone_id: string; status: SeatStatus; version: string }[]
    >`
      SELECT id, zone_id, status, xmin::text AS version
      FROM seats
      WHERE performance_id = ${performanceId}::uuid
        AND id = ANY(${ids}::uuid[])
    `;
    const available = rows.filter((r) => r.status === 'AVAILABLE');
    if (available.length !== ids.length) {
      await this.explainMiss(
        tx,
        performanceId,
        ids,
        available.map((r) => r.id),
      );
    }
    // Compare-and-set: a row whose version moved since the read was taken by
    // someone else; it does not match and the hold fails (no retry: the seat
    // is gone).
    const held = await tx.$queryRaw<{ id: string }[]>`
      UPDATE seats AS s
      SET status = 'HELD'
      FROM unnest(${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.version)}::text[]) AS v(id, version)
      WHERE s.id = v.id AND s.xmin::text = v.version
      RETURNING s.id
    `;
    if (held.length !== ids.length) {
      await this.explainMiss(
        tx,
        performanceId,
        ids,
        held.map((h) => h.id),
      );
    }
    return rows.map((r) => ({ id: r.id, zoneId: r.zone_id }));
  }

  /** Throws the right error for the seats that could not be held. */
  private async explainMiss(
    tx: Prisma.TransactionClient,
    performanceId: string,
    ids: string[],
    heldIds: string[],
  ): Promise<never> {
    const missed = ids.filter((id) => !heldIds.includes(id));
    const existing = await tx.seat.findMany({
      where: { id: { in: missed }, performanceId },
      select: { id: true },
    });
    const known = new Set(existing.map((s) => s.id));
    const foreign = missed.filter((id) => !known.has(id));
    if (foreign.length > 0) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_TICKET_SELECTION,
        'Some seats do not belong to this performance',
        { seatIds: foreign },
      );
    }
    throw new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.SEAT_UNAVAILABLE,
      'Some seats are no longer available',
      { seatIds: missed },
    );
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
