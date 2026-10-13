import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { AuthUser } from '../../common/auth/auth.decorators.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  ZoneType,
  type PerformanceStatus,
  type SalePhaseType,
  type Prisma,
} from '../../generated/prisma/client.js';
import {
  cancelPerformanceJobId,
  PAYMENTS_QUEUE,
  PaymentJob,
  type CancelPerformanceData,
} from '../../queue/queue.constants.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SeatEventsService } from '../seats/seat-events.service.js';
import { SeatsService } from '../seats/seats.service.js';
import { CatalogCacheService } from './catalog-cache.service.js';
import { ConcertsService, isOwner } from './concerts.service.js';
import type {
  CreatePerformanceDto,
  PerformanceResponseDto,
  SeatMapResponseDto,
  UpdatePerformanceDto,
} from './dto/performance.dto.js';
import { validatePerformanceRules } from './performance-rules.js';
import { PresaleService } from './presale.service.js';

/** What the waiting room needs, read from the catalog cache. */
export interface AdmissionInfo {
  status: PerformanceStatus;
  waitingRoomEnabled: boolean;
  /** The sale phase open right now, if any. */
  openPhase: { id: string; type: SalePhaseType } | null;
  /** Does any sale phase end in the future? */
  saleAhead: boolean;
  /** No phase open now: when the next one starts, if any. */
  opensAt: Date | null;
}

export interface OnSalePerformance {
  id: string;
  maxTicketsPerUser: number;
  zones: { id: string; type: ZoneType; price: number }[];
}

const detailInclude = {
  concert: {
    select: { id: true, name: true, artist: true, organizerId: true },
  },
  zones: {
    select: { id: true, name: true, type: true, price: true, capacity: true },
    orderBy: { price: 'desc' },
  },
  salePhases: {
    select: { id: true, type: true, startsAt: true, endsAt: true },
    orderBy: { startsAt: 'asc' },
  },
} as const;

@Injectable()
export class PerformancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly concerts: ConcertsService,
    private readonly seats: SeatsService,
    private readonly seatEvents: SeatEventsService,
    private readonly cache: CatalogCacheService,
    private readonly presale: PresaleService,
    @InjectQueue(PAYMENTS_QUEUE) private readonly payments: Queue,
  ) {}

  /**
   * What a reservation needs to know: zones with prices, and the ticket
   * limit. Read from PostgreSQL, not the cache: this is the authoritative
   * check. Throws unless the performance is published and a sale phase is
   * open right now; during a PRESALE phase the account must have redeemed
   * a code of that phase (I11; redeeming is permanent, so checking before
   * the hold transaction is enough).
   */
  async getOnSale(
    id: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<OnSalePerformance> {
    const performance = await this.prisma.performance.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        maxTicketsPerUser: true,
        zones: { select: { id: true, type: true, price: true } },
        salePhases: {
          select: { id: true, type: true, startsAt: true, endsAt: true },
        },
      },
    });
    if (!performance || performance.status === 'DRAFT') {
      throw performanceNotFound();
    }
    const open = openPhase(performance.salePhases, now);
    if (performance.status !== 'PUBLISHED' || !open) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.SALE_NOT_OPEN,
        'Tickets for this performance are not on sale right now',
      );
    }
    if (
      open.type === 'PRESALE' &&
      !(await this.presale.hasRedeemed(open.id, userId))
    ) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PRESALE_CODE_REQUIRED,
        'This presale is only for accounts that redeemed a presale code',
        { salePhaseId: open.id },
      );
    }
    return {
      id: performance.id,
      maxTicketsPerUser: performance.maxTicketsPerUser,
      zones: performance.zones,
    };
  }

  /** Creates a DRAFT performance with its zones, seats and sale phases, atomically. */
  async create(
    concertId: string,
    organizer: AuthUser,
    dto: CreatePerformanceDto,
  ): Promise<PerformanceResponseDto> {
    const problems = validatePerformanceRules(dto);
    if (problems.length > 0) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        problems,
      );
    }
    await this.concerts.assertOwner(concertId, organizer);

    const id = await this.prisma.$transaction(
      async (tx) => {
        const performance = await tx.performance.create({
          data: {
            concertId,
            venue: dto.venue,
            startsAt: dto.startsAt,
            maxTicketsPerUser: dto.maxTicketsPerUser,
            waitingRoomEnabled: dto.waitingRoomEnabled,
            salePhases: {
              create: dto.salePhases.map((p) => ({
                type: p.type,
                startsAt: p.startsAt,
                endsAt: p.endsAt,
              })),
            },
          },
        });
        const blocks = [];
        for (const zone of dto.zones) {
          const seated = zone.type === ZoneType.SEATED;
          const rows = zone.rows ?? 0;
          const seatsPerRow = zone.seatsPerRow ?? 0;
          const created = await tx.zone.create({
            data: {
              performanceId: performance.id,
              name: zone.name,
              type: zone.type,
              price: zone.price,
              capacity: seated ? rows * seatsPerRow : (zone.capacity ?? 0),
            },
          });
          if (seated) {
            blocks.push({ zoneId: created.id, rows, seatsPerRow });
          }
        }
        await this.seats.createLayout(tx, performance.id, blocks);
        return performance.id;
      },
      // Large layouts insert thousands of seats; the default 5 s is too tight.
      { timeout: 30_000 },
    );

    await this.cache.invalidate({ concertId });
    return this.getVisible(id, organizer);
  }

  /**
   * Status, waiting room flag and open sale phase, from the catalog cache
   * (Redis), for the checks that run before any database query. Null when
   * the performance does not exist.
   */
  async admissionInfo(
    id: string,
    now: Date = new Date(),
  ): Promise<AdmissionInfo | null> {
    const performance = await this.cachedRecord(id);
    if (!performance) return null;
    const open = openPhase(performance.salePhases, now);
    return {
      status: performance.status,
      // Entries cached before phase 7b lack the field: off.
      waitingRoomEnabled: performance.waitingRoomEnabled ?? false,
      openPhase: open ? { id: open.id, type: open.type } : null,
      saleAhead: performance.salePhases.some((p) => now < p.endsAt),
      opensAt: open
        ? null
        : (performance.salePhases.find((p) => now < p.startsAt)?.startsAt ??
          null),
    };
  }

  /**
   * Presale pre-check before the Redis gate: the open phase comes from the
   * cache, and only during a PRESALE phase is the redemption read (one
   * indexed row). getOnSale repeats the check from PostgreSQL.
   */
  async presaleAllows(id: string, userId: string): Promise<boolean> {
    const open = (await this.admissionInfo(id))?.openPhase;
    if (open?.type !== 'PRESALE') return true;
    return this.presale.hasRedeemed(open.id, userId);
  }

  /** What a message to a buyer names: the concert, the venue, the time. */
  async detailsOf(
    id: string,
  ): Promise<{ concertName: string; venue: string; startsAt: Date }> {
    const performance = await this.cachedRecord(id);
    if (!performance) throw performanceNotFound();
    return {
      concertName: performance.concert.name,
      venue: performance.venue,
      startsAt: performance.startsAt,
    };
  }

  /** Zones of a performance, drafts included (callers check access first). */
  async zonesOf(id: string): Promise<PerformanceResponseDto['zones']> {
    const performance = await this.cachedRecord(id);
    if (!performance) throw performanceNotFound();
    return performance.zones;
  }

  /** The raw record (drafts included) from the cache or PostgreSQL. */
  private cachedRecord(id: string) {
    return this.cache.getOrLoad(
      () => CatalogCacheService.performanceKey(id),
      () =>
        this.prisma.performance.findUnique({
          where: { id },
          include: detailInclude,
        }),
    );
  }

  async getVisible(
    id: string,
    viewer: AuthUser | undefined,
  ): Promise<PerformanceResponseDto> {
    // Cached raw record; the draft check below runs on every read.
    const performance = await this.cachedRecord(id);
    if (
      !performance ||
      (performance.status === 'DRAFT' && !isOwner(performance.concert, viewer))
    ) {
      throw performanceNotFound();
    }
    const { organizerId: _organizerId, ...concert } = performance.concert;
    return {
      id: performance.id,
      concert,
      venue: performance.venue,
      startsAt: performance.startsAt,
      status: performance.status,
      maxTicketsPerUser: performance.maxTicketsPerUser,
      waitingRoomEnabled: performance.waitingRoomEnabled ?? false,
      zones: performance.zones,
      salePhases: performance.salePhases,
    };
  }

  async update(
    id: string,
    organizer: AuthUser,
    dto: UpdatePerformanceDto,
  ): Promise<PerformanceResponseDto> {
    const performance = await this.assertOwner(id, organizer);
    if (performance.status === 'CANCELLED') {
      throw invalidState('A cancelled performance cannot be edited');
    }
    if (dto.startsAt && dto.startsAt <= new Date()) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        [{ field: 'startsAt', errors: ['startsAt must be in the future'] }],
      );
    }
    await this.prisma.performance.update({
      where: { id },
      data: {
        venue: dto.venue,
        startsAt: dto.startsAt,
        maxTicketsPerUser: dto.maxTicketsPerUser,
        waitingRoomEnabled: dto.waitingRoomEnabled,
      },
    });
    await this.cache.invalidate({
      performanceId: id,
      concertId: performance.concertId,
    });
    return this.getVisible(id, organizer);
  }

  /**
   * Reads the performance status with a shared row lock (FOR SHARE) that
   * lasts until the caller's transaction ends. Cancelling a performance needs
   * an exclusive lock on the same row, so a payment and a cancellation can
   * never interleave: whichever commits first is seen by the other (flow B
   * vs "hủy đêm diễn").
   */
  async lockStatus(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<PerformanceStatus | null> {
    const rows = await tx.$queryRaw<{ status: PerformanceStatus }[]>`
      SELECT status FROM performances WHERE id = ${id}::uuid FOR SHARE
    `;
    return rows[0]?.status ?? null;
  }

  /** Status of a performance, or null if it does not exist. */
  async statusOf(id: string): Promise<PerformanceStatus | null> {
    const performance = await this.prisma.performance.findUnique({
      where: { id },
      select: { status: true },
    });
    return performance?.status ?? null;
  }

  /**
   * Cancels a performance: no more sales from this instant, then a worker job
   * cancels unpaid orders and refunds paid ones in batches.
   */
  async cancel(
    id: string,
    organizer: AuthUser,
  ): Promise<PerformanceResponseDto> {
    const { concertId } = await this.assertOwner(id, organizer);
    const changed = await this.prisma.$executeRaw`
      UPDATE performances SET status = 'CANCELLED', updated_at = now()
      WHERE id = ${id}::uuid AND status IN ('DRAFT', 'PUBLISHED')
    `;
    if (changed === 0) {
      throw invalidState('This performance is already cancelled');
    }
    await this.cache.invalidate({ performanceId: id, concertId });
    await this.payments.add(
      PaymentJob.CANCEL_PERFORMANCE,
      { performanceId: id } satisfies CancelPerformanceData,
      { jobId: cancelPerformanceJobId(id) },
    );
    return this.getVisible(id, organizer);
  }

  async publish(
    id: string,
    organizer: AuthUser,
  ): Promise<PerformanceResponseDto> {
    const { concertId } = await this.assertOwner(id, organizer);
    // State transition as a conditional UPDATE: only a DRAFT can be
    // published, and of two concurrent publishes exactly one matches.
    const changed = await this.prisma.$executeRaw`
      UPDATE performances
      SET status = 'PUBLISHED', updated_at = now()
      WHERE id = ${id}::uuid AND status = 'DRAFT'
    `;
    if (changed === 0) {
      throw invalidState('Only a DRAFT performance can be published');
    }
    await this.cache.invalidate({ performanceId: id, concertId });
    return this.getVisible(id, organizer);
  }

  async getSeatMap(
    id: string,
    viewer: AuthUser | undefined,
  ): Promise<SeatMapResponseDto> {
    const performance = await this.getVisible(id, viewer);
    // seq BEFORE the seats and counters: every change with a seq up to this
    // one committed before the queries below, so it is in this snapshot.
    // Clients then apply only batches with a greater seq (SeatEventsService).
    const seq = await this.seatEvents.currentSeq(id);
    const zoneCounts = await this.prisma.zone.findMany({
      where: { performanceId: id },
      select: { id: true, heldCount: true, soldCount: true },
    });
    const [seats, availableSeats] = await Promise.all([
      this.seats.listByPerformance(id),
      this.seats.countAvailableByZone(id),
    ]);
    const counts = new Map(zoneCounts.map((z) => [z.id, z]));
    return {
      performanceId: id,
      seq,
      zones: performance.zones.map((zone) => {
        const c = counts.get(zone.id);
        const available =
          zone.type === ZoneType.SEATED
            ? (availableSeats.get(zone.id) ?? 0)
            : zone.capacity - (c?.heldCount ?? 0) - (c?.soldCount ?? 0);
        return {
          id: zone.id,
          name: zone.name,
          type: zone.type,
          price: zone.price,
          capacity: zone.capacity,
          available: Math.max(available, 0),
        };
      }),
      seats,
    };
  }

  /**
   * Tickets left in some zones of a performance, for the realtime flusher:
   * free seats in a seated zone, capacity minus held and sold when standing.
   */
  async zoneAvailability(
    zoneIds: readonly string[],
  ): Promise<{ id: string; available: number }[]> {
    if (zoneIds.length === 0) return [];
    const zones = await this.prisma.zone.findMany({
      where: { id: { in: [...zoneIds] } },
      select: {
        id: true,
        type: true,
        capacity: true,
        heldCount: true,
        soldCount: true,
      },
    });
    const free = await this.seats.countAvailableInZones(
      zones.filter((z) => z.type === ZoneType.SEATED).map((z) => z.id),
    );
    return zones.map((z) => ({
      id: z.id,
      available: Math.max(
        z.type === ZoneType.SEATED
          ? (free.get(z.id) ?? 0)
          : z.capacity - z.heldCount - z.soldCount,
        0,
      ),
    }));
  }

  /** The performance, if `organizer` owns its concert; 404 or 403 otherwise. */
  async assertOwner(id: string, organizer: AuthUser) {
    const performance = await this.prisma.performance.findUnique({
      where: { id },
      select: { id: true, status: true, concertId: true },
    });
    if (!performance) {
      throw performanceNotFound();
    }
    await this.concerts.assertOwner(performance.concertId, organizer);
    return performance;
  }
}

/** The sale phase open at `now` (phases never overlap), or undefined. */
function openPhase<P extends { startsAt: Date; endsAt: Date }>(
  phases: readonly P[],
  now: Date,
): P | undefined {
  return phases.find((p) => p.startsAt <= now && now < p.endsAt);
}

function performanceNotFound(): AppException {
  return new AppException(
    HttpStatus.NOT_FOUND,
    ErrorCode.PERFORMANCE_NOT_FOUND,
    'Performance not found',
  );
}

function invalidState(message: string): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    ErrorCode.INVALID_STATE,
    message,
  );
}
