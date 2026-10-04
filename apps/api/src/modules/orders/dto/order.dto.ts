import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../../../generated/prisma/client.js';

export class OrderItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  zoneId: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  seatId: string | null;

  @ApiProperty({ description: 'VND' })
  price: number;
}

export class OrderResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  performanceId: string;

  @ApiProperty({ enum: OrderStatus })
  status: OrderStatus;

  @ApiProperty({ description: 'VND' })
  totalAmount: number;

  @ApiProperty({
    description: 'The hold ends at this time unless the order is paid',
  })
  expiresAt: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: [OrderItemResponseDto] })
  items: OrderItemResponseDto[];
}
