import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { Role } from '../../generated/prisma/client.js';
import { OrderResponseDto } from '../orders/dto/order.dto.js';
import { CreateReservationDto } from './dto/create-reservation.dto.js';
import { ReservationsService } from './reservations.service.js';

@ApiTags('reservations')
@ApiBearerAuth()
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  /**
   * Holds numbered seats and/or standing tickets and creates a PENDING order.
   * Phase 2 baseline: not safe under concurrency (see docs/benchmarks.md).
   */
  @Roles(Role.CUSTOMER)
  @Post()
  reserve(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReservationDto,
  ): Promise<OrderResponseDto> {
    return this.reservations.reserve(user.id, dto);
  }
}
