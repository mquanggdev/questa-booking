import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Public,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { Role } from '../../generated/prisma/client.js';
import { ConcertsService } from './concerts.service.js';
import {
  ConcertPageDto,
  ConcertResponseDto,
  CreateConcertDto,
} from './dto/concert.dto.js';
import {
  CreatePerformanceDto,
  PerformanceResponseDto,
} from './dto/performance.dto.js';
import { PerformancesService } from './performances.service.js';

@ApiTags('concerts')
@Controller('concerts')
export class ConcertsController {
  constructor(
    private readonly concerts: ConcertsService,
    private readonly performances: PerformancesService,
  ) {}

  /** Public catalog: concerts that have at least one published performance */
  @Public()
  @Get()
  list(@Query() query: PaginationQueryDto): Promise<ConcertPageDto> {
    return this.concerts.listPublished(query);
  }

  /** Concert with its published performances (the owner also sees drafts) */
  @Public()
  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer?: AuthUser,
  ): Promise<ConcertResponseDto> {
    return this.concerts.getVisible(id, viewer);
  }

  @ApiBearerAuth()
  @Roles(Role.ORGANIZER)
  @Post()
  create(
    @CurrentUser() organizer: AuthUser,
    @Body() dto: CreateConcertDto,
  ): Promise<ConcertResponseDto> {
    return this.concerts.create(organizer, dto);
  }

  /** Creates a DRAFT performance with zones, a generated seat layout and sale phases */
  @ApiBearerAuth()
  @Roles(Role.ORGANIZER)
  @Post(':id/performances')
  createPerformance(
    @Param('id', ParseUUIDPipe) concertId: string,
    @CurrentUser() organizer: AuthUser,
    @Body() dto: CreatePerformanceDto,
  ): Promise<PerformanceResponseDto> {
    return this.performances.create(concertId, organizer, dto);
  }
}
