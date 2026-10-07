import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class TicketResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'What the QR code encodes; shown at the gate' })
  code: string;

  @ApiProperty({ description: 'QR code of `code`, as an SVG document' })
  qrSvg: string;

  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({ format: 'uuid' })
  performanceId: string;

  @ApiProperty()
  concertName: string;

  @ApiProperty()
  venue: string;

  @ApiProperty()
  startsAt: Date;

  @ApiProperty()
  zoneName: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Row and number, e.g. "B12"; null in a standing zone',
  })
  seatLabel: string | null;

  @ApiProperty()
  issuedAt: Date;

  @ApiProperty({ nullable: true, type: Date })
  checkedInAt: Date | null;

  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'Set when the order left PAID; the ticket is no longer valid',
  })
  voidedAt: Date | null;
}

export class CheckInDto {
  @ApiProperty({ description: 'The code read from the QR' })
  @IsString()
  @Length(10, 64)
  code: string;
}

export class CheckInResponseDto {
  @ApiProperty({ format: 'uuid' })
  ticketId: string;

  @ApiProperty()
  checkedInAt: Date;

  @ApiProperty()
  zoneName: string;

  @ApiProperty({ nullable: true, type: String })
  seatLabel: string | null;
}
