import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Length,
} from 'class-validator';
import {
  OrderStatus,
  PaymentStatus,
} from '../../../generated/prisma/client.js';

const PROVIDERS = ['vnpay', 'fake'] as const;
const OUTCOMES = ['success', 'cancelled', 'failed'] as const;

export class PayOrderDto {
  @ApiPropertyOptional({
    enum: PROVIDERS,
    description: 'Defaults to PAYMENT_PROVIDER',
  })
  @IsOptional()
  @IsIn(PROVIDERS)
  provider?: (typeof PROVIDERS)[number];
}

export class CheckoutResponseDto {
  @ApiProperty({ format: 'uuid' })
  paymentId: string;

  @ApiProperty({ enum: PROVIDERS })
  provider: string;

  @ApiProperty({ description: "Send the customer's browser here to pay" })
  checkoutUrl: string;

  @ApiProperty({ description: 'The gateway refuses payment after this time' })
  expiresAt: Date;
}

export class IpnResponseDto {
  @ApiProperty({
    description:
      '00 confirmed, 01 order not found, 02 already confirmed, 04 invalid amount, 97 invalid signature, 99 unknown error',
  })
  RspCode: string;

  @ApiProperty()
  Message: string;
}

export class PaymentReturnResponseDto {
  @ApiProperty({ description: 'The signature of the redirect is valid' })
  verified: boolean;

  @ApiProperty({
    description:
      'What the redirect claims; the order changes only through the IPN',
  })
  gatewaySaysSuccess: boolean;

  @ApiProperty({ nullable: true, type: String })
  responseCode: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  orderId: string | null;

  @ApiProperty({ nullable: true, enum: OrderStatus })
  orderStatus: OrderStatus | null;

  @ApiProperty({ nullable: true, enum: PaymentStatus })
  paymentStatus: PaymentStatus | null;
}

export class FakeCheckoutResponseDto {
  @ApiProperty()
  txnRef: string;

  @ApiProperty({ description: 'VND' })
  amount: number;

  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({ enum: PaymentStatus })
  paymentStatus: string;

  @ApiProperty({ enum: OUTCOMES, isArray: true })
  outcomes: string[];
}

export class FakeCompleteDto {
  @ApiProperty()
  @IsString()
  @Length(32, 32)
  txnRef: string;

  @ApiProperty({ enum: OUTCOMES })
  @IsIn(OUTCOMES)
  outcome: (typeof OUTCOMES)[number];

  @ApiPropertyOptional({
    description: 'Amount the gateway reports (VND); defaults to the right one',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  amount?: number;
}

export class FakeCompleteResponseDto {
  @ApiProperty({ type: IpnResponseDto, description: 'What our IPN answered' })
  ipn: IpnResponseDto;

  @ApiProperty({
    description: 'How many times the gateway delivered the IPN (retries on 99)',
  })
  deliveries: number;

  @ApiProperty({ description: 'Where the gateway sends the browser back' })
  returnUrl: string;
}
