import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';

@Injectable()
export class ZonesService {
  /**
   * PHASE 2 BASELINE: DELIBERATELY NAIVE. Do not copy.
   *
   * Read the counters, check in application code, then write back an
   * absolute value. Two requests that read at the same moment both pass the
   * check, and the second write overwrites the first ("lost update"): the
   * zone ends up oversold AND held_count undercounts the tickets sold.
   * Phase 3 replaces this with one conditional UPDATE.
   */
  async holdStandingNaive(
    tx: Prisma.TransactionClient,
    zoneId: string,
    quantity: number,
  ): Promise<void> {
    const zone = await tx.zone.findUniqueOrThrow({
      where: { id: zoneId },
      select: { capacity: true, heldCount: true, soldCount: true },
    });
    const available = zone.capacity - zone.heldCount - zone.soldCount;
    if (available < quantity) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.SOLD_OUT,
        'Not enough standing tickets left in this zone',
        { zoneId, requested: quantity, available: Math.max(available, 0) },
      );
    }
    await tx.zone.update({
      where: { id: zoneId },
      data: { heldCount: zone.heldCount + quantity },
    });
  }
}
