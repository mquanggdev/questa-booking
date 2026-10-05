import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Role } from '../../generated/prisma/client.js';
import { OrderResponseDto } from '../orders/dto/order.dto.js';
import { CreateReservationDto } from './dto/create-reservation.dto.js';
import { isValidIdempotencyKey } from './reservation-request.js';
import { ReservationsService } from './reservations.service.js';

@ApiTags('reservations')
@ApiBearerAuth()
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  /**
   * Holds numbered seats and/or standing tickets and creates a PENDING order.
   * Retrying with the same Idempotency-Key returns the same order (with the
   * header Idempotent-Replayed: true) instead of holding more tickets.
   */
  @Roles(Role.CUSTOMER)
  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per purchase attempt (e.g. a UUID), 1-100 characters of A-Z a-z 0-9 _ . : -',
  })
  async reserve(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateReservationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponseDto> {
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'Header Idempotency-Key is required: 1-100 characters of A-Z a-z 0-9 _ . : -',
      );
    }
    const result = await this.reservations.reserve(
      user.id,
      idempotencyKey,
      dto,
    );
    if (result.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return result.order;
  }
}
