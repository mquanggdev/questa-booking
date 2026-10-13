import { ApiProperty } from '@nestjs/swagger';
import { ZoneType } from '../../../generated/prisma/client.js';

export class ZoneSalesDto {
  @ApiProperty({ format: 'uuid' })
  zoneId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: ZoneType })
  type: ZoneType;

  @ApiProperty()
  capacity: number;

  @ApiProperty({ description: 'From order.paid events (analytics consumer)' })
  ticketsSold: number;

  @ApiProperty({ description: 'VND, from order.paid events' })
  revenue: number;

  @ApiProperty({ description: 'Held right now, not yet paid' })
  ticketsHeld: number;
}

export class SalesStatsDto {
  @ApiProperty({ format: 'uuid' })
  performanceId: string;

  @ApiProperty()
  capacity: number;

  @ApiProperty()
  ticketsSold: number;

  @ApiProperty({ description: 'VND' })
  revenue: number;

  @ApiProperty()
  ticketsHeld: number;

  @ApiProperty({ description: 'People in the virtual waiting room now' })
  queueLength: number;

  @ApiProperty({ type: [ZoneSalesDto] })
  zones: ZoneSalesDto[];

  @ApiProperty()
  generatedAt: Date;
}
