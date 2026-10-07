import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class ZonesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tickets still sellable per STANDING zone, as PostgreSQL sees it now. */
  async standingAvailability(zoneIds: string[]): Promise<Map<string, number>> {
    const zones = await this.prisma.zone.findMany({
      where: { id: { in: zoneIds }, type: 'STANDING' },
      select: { id: true, capacity: true, heldCount: true, soldCount: true },
    });
    return new Map(
      zones.map((z) => [
        z.id,
        Math.max(z.capacity - z.heldCount - z.soldCount, 0),
      ]),
    );
  }

  /** Every STANDING zone id (for the reconcile job). */
  async standingZoneIds(): Promise<string[]> {
    const zones = await this.prisma.zone.findMany({
      where: { type: 'STANDING' },
      select: { id: true },
    });
    return zones.map((z) => z.id);
  }

  /**
   * Gives held standing tickets back when an order is released. The
   * held_count >= quantity condition keeps the counter from going negative
   * if a release were ever applied twice.
   */
  async releaseStanding(
    tx: Prisma.TransactionClient,
    zoneId: string,
    quantity: number,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE zones
      SET held_count = held_count - ${quantity}
      WHERE id = ${zoneId}::uuid AND held_count >= ${quantity}
    `;
  }

  /**
   * Holds standing tickets with one atomic statement: the capacity check and
   * the increment happen together, on the latest committed counters, so two
   * concurrent requests can never both take the last ticket (I9). The CHECK
   * constraint zones_within_capacity backs this up at the database level.
   *
   * Every request for a zone updates the SAME row, and the row lock lasts
   * until commit (hot row). Callers should run this as the last statement of
   * their transaction so the lock is held as briefly as possible.
   */
  async holdStanding(
    tx: Prisma.TransactionClient,
    performanceId: string,
    zoneId: string,
    quantity: number,
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE zones
      SET held_count = held_count + ${quantity}
      WHERE id = ${zoneId}::uuid
        AND performance_id = ${performanceId}::uuid
        AND type = 'STANDING'
        AND held_count + sold_count + ${quantity} <= capacity
    `;
    if (updated === 1) {
      return;
    }
    const zone = await tx.zone.findUnique({
      where: { id: zoneId },
      select: { capacity: true, heldCount: true, soldCount: true },
    });
    const available = zone
      ? zone.capacity - zone.heldCount - zone.soldCount
      : 0;
    throw new AppException(
      HttpStatus.CONFLICT,
      ErrorCode.SOLD_OUT,
      'Not enough standing tickets left in this zone',
      { zoneId, requested: quantity, available: Math.max(available, 0) },
    );
  }
}
