import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.decorators.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { ZoneType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SeatsService } from '../seats/seats.service.js';
import { ConcertsService, isOwner } from './concerts.service.js';
import type {
  CreatePerformanceDto,
  PerformanceResponseDto,
  SeatMapResponseDto,
  UpdatePerformanceDto,
} from './dto/performance.dto.js';
import { validatePerformanceRules } from './performance-rules.js';

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
  ) {}

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

    return this.getVisible(id, organizer);
  }

  async getVisible(
    id: string,
    viewer: AuthUser | undefined,
  ): Promise<PerformanceResponseDto> {
    const performance = await this.prisma.performance.findUnique({
      where: { id },
      include: detailInclude,
    });
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
      },
    });
    return this.getVisible(id, organizer);
  }

  async publish(
    id: string,
    organizer: AuthUser,
  ): Promise<PerformanceResponseDto> {
    await this.assertOwner(id, organizer);
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
    return this.getVisible(id, organizer);
  }

  async getSeatMap(
    id: string,
    viewer: AuthUser | undefined,
  ): Promise<SeatMapResponseDto> {
    const performance = await this.getVisible(id, viewer);
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

  private async assertOwner(id: string, organizer: AuthUser) {
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
