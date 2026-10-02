import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.decorators.js';
import type {
  Paginated,
  PaginationQueryDto,
} from '../../common/dto/pagination.dto.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { type Concert, Role } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  ConcertResponseDto,
  CreateConcertDto,
} from './dto/concert.dto.js';

const performanceSummary = {
  select: { id: true, venue: true, startsAt: true, status: true },
  orderBy: { startsAt: 'asc' },
} as const;

@Injectable()
export class ConcertsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizer: AuthUser,
    dto: CreateConcertDto,
  ): Promise<ConcertResponseDto> {
    return this.prisma.concert.create({
      data: {
        organizerId: organizer.id,
        name: dto.name,
        artist: dto.artist,
        description: dto.description ?? '',
      },
      include: { performances: performanceSummary },
    });
  }

  /** Public catalog: concerts with at least one published performance. */
  async listPublished(
    query: PaginationQueryDto,
  ): Promise<Paginated<ConcertResponseDto>> {
    const where = { performances: { some: { status: 'PUBLISHED' as const } } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.concert.findMany({
        where,
        include: {
          performances: {
            ...performanceSummary,
            where: { status: 'PUBLISHED' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.concert.count({ where }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  /**
   * The owning organizer sees every performance, including drafts. Everyone
   * else sees published ones only, and a concert with none does not exist.
   */
  async getVisible(
    id: string,
    viewer: AuthUser | undefined,
  ): Promise<ConcertResponseDto> {
    const concert = await this.prisma.concert.findUnique({
      where: { id },
      include: { performances: performanceSummary },
    });
    if (!concert) {
      throw concertNotFound();
    }
    if (isOwner(concert, viewer)) {
      return concert;
    }
    const performances = concert.performances.filter(
      (p) => p.status === 'PUBLISHED',
    );
    if (performances.length === 0) {
      throw concertNotFound();
    }
    return { ...concert, performances };
  }

  /** Throws unless the concert exists and belongs to this organizer. */
  async assertOwner(concertId: string, user: AuthUser): Promise<Concert> {
    const concert = await this.prisma.concert.findUnique({
      where: { id: concertId },
    });
    if (!concert) {
      throw concertNotFound();
    }
    if (!isOwner(concert, user)) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Only the organizer of this concert can change it',
      );
    }
    return concert;
  }
}

export function isOwner(
  concert: Pick<Concert, 'organizerId'>,
  viewer: AuthUser | undefined,
): boolean {
  return viewer?.role === Role.ORGANIZER && viewer.id === concert.organizerId;
}

function concertNotFound(): AppException {
  return new AppException(
    HttpStatus.NOT_FOUND,
    ErrorCode.CONCERT_NOT_FOUND,
    'Concert not found',
  );
}
