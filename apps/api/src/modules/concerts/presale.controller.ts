import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { PRESALE_REDEEMS_PER_MINUTE_PER_USER } from '../../common/throttle/limits.js';
import { Role } from '../../generated/prisma/client.js';
import {
  GeneratePresaleCodesDto,
  PresaleCodeDto,
  PresaleCodesResponseDto,
  PresaleRedemptionDto,
  RedeemPresaleCodeDto,
} from './dto/presale.dto.js';
import { PresaleService } from './presale.service.js';

@ApiTags('presale')
@ApiBearerAuth()
@Controller('performances/:id/presale')
export class PresaleController {
  constructor(private readonly presale: PresaleService) {}

  /** Generate single-use codes for a PRESALE phase (shown in full only here and in the list) */
  @Roles(Role.ORGANIZER)
  @Post('codes')
  generate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() organizer: AuthUser,
    @Body() dto: GeneratePresaleCodesDto,
  ): Promise<PresaleCodesResponseDto> {
    return this.presale.generate(id, organizer, dto);
  }

  /** Every code of this performance and whether it was used */
  @Roles(Role.ORGANIZER)
  @Get('codes')
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() organizer: AuthUser,
  ): Promise<PresaleCodeDto[]> {
    return this.presale.list(id, organizer);
  }

  /**
   * Redeem a presale code: during its phase this account may hold tickets.
   * One code per account per phase; redeeming your own code again is a no-op.
   */
  @Roles(Role.CUSTOMER)
  @Throttle({
    user: { limit: PRESALE_REDEEMS_PER_MINUTE_PER_USER, ttl: 60_000 },
  })
  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  redeem(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RedeemPresaleCodeDto,
  ): Promise<PresaleRedemptionDto> {
    return this.presale.redeem(id, user.id, dto.code);
  }

  /** Presale phases of this performance this account redeemed a code for */
  @Roles(Role.CUSTOMER)
  @Get('me')
  mine(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PresaleRedemptionDto[]> {
    return this.presale.redemptionsOf(id, user.id);
  }
}
