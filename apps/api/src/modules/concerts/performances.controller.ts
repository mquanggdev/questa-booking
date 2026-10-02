import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Public,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { Role } from '../../generated/prisma/client.js';
import {
  PerformanceResponseDto,
  SeatMapResponseDto,
  UpdatePerformanceDto,
} from './dto/performance.dto.js';
import { PerformancesService } from './performances.service.js';

@ApiTags('performances')
@Controller('performances')
export class PerformancesController {
  constructor(private readonly performances: PerformancesService) {}

  /** Performance detail: zones, prices and sale phases */
  @Public()
  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer?: AuthUser,
  ): Promise<PerformanceResponseDto> {
    return this.performances.getVisible(id, viewer);
  }

  @ApiBearerAuth()
  @Roles(Role.ORGANIZER)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() organizer: AuthUser,
    @Body() dto: UpdatePerformanceDto,
  ): Promise<PerformanceResponseDto> {
    return this.performances.update(id, organizer, dto);
  }

  /** DRAFT to PUBLISHED; the performance becomes visible to everyone */
  @ApiBearerAuth()
  @Roles(Role.ORGANIZER)
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() organizer: AuthUser,
  ): Promise<PerformanceResponseDto> {
    return this.performances.publish(id, organizer);
  }

  /** Every seat with its status, and remaining tickets per zone */
  @Public()
  @Get(':id/seats')
  seats(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer?: AuthUser,
  ): Promise<SeatMapResponseDto> {
    return this.performances.getSeatMap(id, viewer);
  }
}
