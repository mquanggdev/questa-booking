import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { Role } from '../../generated/prisma/client.js';
import { SalesStatsDto } from './dto/sales-stats.dto.js';
import { SalesStatsService } from './sales-stats.service.js';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('performances/:id/stats')
export class SalesController {
  constructor(private readonly stats: SalesStatsService) {}

  /**
   * Tickets sold and revenue per zone (from order events), tickets held and
   * people in the waiting room right now. Live: WebSocket namespace /sales.
   */
  @Roles(Role.ORGANIZER)
  @Get()
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() organizer: AuthUser,
  ): Promise<SalesStatsDto> {
    return this.stats.forOrganizer(id, organizer);
  }
}
