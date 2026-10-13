import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.decorators.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PerformancesService } from '../concerts/performances.service.js';
import { ZonesService } from '../concerts/zones.service.js';
import type { OrderEventItem } from '../outbox/order-events.js';
import { SeatsService } from '../seats/seats.service.js';
import { WaitingRoomService } from '../waiting-room/waiting-room.service.js';
import type { SalesStatsDto } from './dto/sales-stats.dto.js';

/**
 * performance_sales_stats: tickets sold and revenue per zone, kept by the
 * analytics consumer from order events (eventually consistent: a sale shows
 * up once its event went through the outbox and Kafka). Held tickets and the
 * queue length are read live, they change with every hold.
 */
@Injectable()
export class SalesStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly performances: PerformancesService,
    private readonly zones: ZonesService,
    private readonly seats: SeatsService,
    private readonly waitingRoom: WaitingRoomService,
  ) {}

  /**
   * Adds (sign 1) or removes (sign -1) the tickets of one order, per zone.
   * The check constraint keeps the counters >= 0.
   */
  async apply(
    tx: Prisma.TransactionClient,
    performanceId: string,
    items: OrderEventItem[],
    sign: 1 | -1,
  ): Promise<void> {
    const perZone = new Map<string, { tickets: number; revenue: number }>();
    for (const item of items) {
      const zone = perZone.get(item.zoneId) ?? { tickets: 0, revenue: 0 };
      zone.tickets += 1;
      zone.revenue += item.price;
      perZone.set(item.zoneId, zone);
    }
    for (const [zoneId, { tickets, revenue }] of perZone) {
      if (sign === 1) {
        await tx.$executeRaw`
          INSERT INTO performance_sales_stats
            (performance_id, zone_id, tickets_sold, revenue, updated_at)
          VALUES (${performanceId}::uuid, ${zoneId}::uuid,
                  ${tickets}, ${BigInt(revenue)}, now())
          ON CONFLICT (performance_id, zone_id) DO UPDATE
          SET tickets_sold = performance_sales_stats.tickets_sold + EXCLUDED.tickets_sold,
              revenue = performance_sales_stats.revenue + EXCLUDED.revenue,
              updated_at = now()
        `;
        continue;
      }
      // Not an upsert with negative values: PostgreSQL checks constraints
      // on the proposed row before it detects the conflict, so the >= 0
      // check would reject it even though the result is >= 0.
      const changed = await tx.$executeRaw`
        UPDATE performance_sales_stats
        SET tickets_sold = tickets_sold - ${tickets},
            revenue = revenue - ${BigInt(revenue)},
            updated_at = now()
        WHERE performance_id = ${performanceId}::uuid AND zone_id = ${zoneId}::uuid
      `;
      if (changed === 0) {
        // Reversing a sale that was never counted: the data is wrong
        // somewhere. Fail, so the event ends up in the dead letter topic.
        throw new Error(
          `No sales to reverse in zone ${zoneId} of performance ${performanceId}`,
        );
      }
    }
  }

  /** GET /performances/:id/stats: the organizer of the concert only. */
  async forOrganizer(
    performanceId: string,
    organizer: AuthUser,
  ): Promise<SalesStatsDto> {
    await this.performances.assertOwner(performanceId, organizer);
    return this.snapshot(performanceId);
  }

  async snapshot(performanceId: string): Promise<SalesStatsDto> {
    const [zoneList, rows, heldSeats, heldStanding, queueLength] =
      await Promise.all([
        this.performances.zonesOf(performanceId),
        this.prisma.performanceSalesStat.findMany({ where: { performanceId } }),
        this.seats.countHeldByZone(performanceId),
        this.zones.standingHeld(performanceId),
        this.waitingRoom.lineLength(performanceId),
      ]);
    const sold = new Map(rows.map((r) => [r.zoneId, r]));
    const zones = zoneList.map((zone) => ({
      zoneId: zone.id,
      name: zone.name,
      type: zone.type,
      capacity: zone.capacity,
      ticketsSold: sold.get(zone.id)?.ticketsSold ?? 0,
      revenue: Number(sold.get(zone.id)?.revenue ?? 0),
      ticketsHeld: heldSeats.get(zone.id) ?? heldStanding.get(zone.id) ?? 0,
    }));
    const sum = (key: 'capacity' | 'ticketsSold' | 'revenue' | 'ticketsHeld') =>
      zones.reduce((total, z) => total + z[key], 0);
    return {
      performanceId,
      capacity: sum('capacity'),
      ticketsSold: sum('ticketsSold'),
      revenue: sum('revenue'),
      ticketsHeld: sum('ticketsHeld'),
      queueLength,
      zones,
      generatedAt: new Date(),
    };
  }
}
