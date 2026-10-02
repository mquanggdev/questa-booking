import { ApiProperty, PartialType, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  PerformanceStatus,
  SalePhaseType,
  SeatStatus,
  ZoneType,
} from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateZoneDto {
  @ApiProperty({ example: 'VIP' })
  @Transform(trim)
  @IsString()
  @Length(1, 50)
  name: string;

  @ApiProperty({ enum: ZoneType })
  @IsEnum(ZoneType)
  type: ZoneType;

  @ApiProperty({ description: 'Ticket price in VND', example: 3_000_000 })
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  price: number;

  @ApiProperty({ required: false, description: 'SEATED only: number of rows' })
  @ValidateIf((zone: CreateZoneDto) => zone.type === ZoneType.SEATED)
  @IsInt()
  @Min(1)
  @Max(200)
  rows?: number;

  @ApiProperty({
    required: false,
    description: 'SEATED only: seats in each row',
  })
  @ValidateIf((zone: CreateZoneDto) => zone.type === ZoneType.SEATED)
  @IsInt()
  @Min(1)
  @Max(200)
  seatsPerRow?: number;

  @ApiProperty({ required: false, description: 'STANDING only: ticket count' })
  @ValidateIf((zone: CreateZoneDto) => zone.type === ZoneType.STANDING)
  @IsInt()
  @Min(1)
  @Max(100_000)
  capacity?: number;
}

export class CreateSalePhaseDto {
  @ApiProperty({ enum: SalePhaseType })
  @IsEnum(SalePhaseType)
  type: SalePhaseType;

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  endsAt: Date;
}

export class CreatePerformanceDto {
  @ApiProperty({ example: 'My Dinh National Stadium' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  venue: string;

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty({ required: false, default: 6, minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxTicketsPerUser?: number;

  @ApiProperty({ type: [CreateZoneDto] })
  @ValidateNested({ each: true })
  @Type(() => CreateZoneDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  zones: CreateZoneDto[];

  @ApiProperty({ type: [CreateSalePhaseDto] })
  @ValidateNested({ each: true })
  @Type(() => CreateSalePhaseDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  salePhases: CreateSalePhaseDto[];
}

export class UpdatePerformanceDto extends PartialType(
  PickType(CreatePerformanceDto, ['venue', 'startsAt', 'maxTicketsPerUser']),
) {}

export class ZoneResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: ZoneType })
  type: ZoneType;

  @ApiProperty({ description: 'VND' })
  price: number;

  @ApiProperty()
  capacity: number;
}

export class SalePhaseResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: SalePhaseType })
  type: SalePhaseType;

  @ApiProperty()
  startsAt: Date;

  @ApiProperty()
  endsAt: Date;
}

export class ConcertRefDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  artist: string;
}

export class PerformanceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: ConcertRefDto })
  concert: ConcertRefDto;

  @ApiProperty()
  venue: string;

  @ApiProperty()
  startsAt: Date;

  @ApiProperty({ enum: PerformanceStatus })
  status: PerformanceStatus;

  @ApiProperty()
  maxTicketsPerUser: number;

  @ApiProperty({ type: [ZoneResponseDto] })
  zones: ZoneResponseDto[];

  @ApiProperty({ type: [SalePhaseResponseDto] })
  salePhases: SalePhaseResponseDto[];
}

export class ZoneAvailabilityDto extends ZoneResponseDto {
  @ApiProperty({ description: 'Tickets that can still be held right now' })
  available: number;
}

export class SeatResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  zoneId: string;

  @ApiProperty({ example: 'A' })
  row: string;

  @ApiProperty({ example: 1 })
  number: number;

  @ApiProperty({ enum: SeatStatus })
  status: SeatStatus;
}

export class SeatMapResponseDto {
  @ApiProperty({ format: 'uuid' })
  performanceId: string;

  @ApiProperty({ type: [ZoneAvailabilityDto] })
  zones: ZoneAvailabilityDto[];

  @ApiProperty({ type: [SeatResponseDto] })
  seats: SeatResponseDto[];
}
