import {
  Body,
  Controller,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { Role } from '../../generated/prisma/client.js';
import { CheckoutResponseDto, PayOrderDto } from './dto/payment.dto.js';
import { PaymentsService } from './payments.service.js';

// Under /orders because paying is an action on an order; lives in the
// payments module because it creates a payment.
@ApiTags('orders')
@ApiBearerAuth()
@Roles(Role.CUSTOMER)
@Controller('orders')
export class OrderPaymentController {
  constructor(private readonly payments: PaymentsService) {}

  /** Starts paying for my PENDING order; returns the gateway URL */
  @Post(':id/pay')
  pay(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayOrderDto,
    @Ip() ip: string,
  ): Promise<CheckoutResponseDto> {
    return this.payments.checkout(user.id, id, dto.provider, ip);
  }
}
