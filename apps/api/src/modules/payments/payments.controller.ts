import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/auth.decorators.js';
import {
  FakeCheckoutResponseDto,
  FakeCompleteDto,
  FakeCompleteResponseDto,
  IpnResponseDto,
  PaymentReturnResponseDto,
} from './dto/payment.dto.js';
import { PaymentsService } from './payments.service.js';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Instant Payment Notification, called by the gateway (VNPay uses GET).
   * Authenticated by its HMAC-SHA512 signature, not by a token. Always
   * answers 200 with a VNPay RspCode.
   */
  @Public()
  @Get('ipn/:provider')
  ipn(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
  ): Promise<IpnResponseDto> {
    return this.payments.handleIpn(provider, query);
  }

  /** Where the gateway sends the browser back. Display only: changes nothing */
  @Public()
  @Get('return/:provider')
  returnUrl(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PaymentReturnResponseDto> {
    return this.payments.describeReturn(provider, query);
  }

  /** Fake gateway (dev and tests only): the payment page, as data */
  @Public()
  @Get('fake/checkout')
  fakeCheckout(
    @Query('txnRef') txnRef: string,
  ): Promise<FakeCheckoutResponseDto> {
    return this.payments.fakeCheckout(txnRef);
  }

  /** Fake gateway (dev and tests only): pay or give up, then the IPN is sent */
  @Public()
  @Post('fake/complete')
  @HttpCode(HttpStatus.OK)
  fakeComplete(@Body() dto: FakeCompleteDto): Promise<FakeCompleteResponseDto> {
    return this.payments.fakeComplete(dto.txnRef, dto.outcome, dto.amount);
  }
}
