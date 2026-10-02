import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { PerformanceStatus } from '../../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateConcertDto {
  @ApiProperty({ example: 'Questa Fest 2026' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name: string;

  @ApiProperty({ example: 'The Questa Band' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  artist: string;

  @ApiProperty({ required: false, maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;
}

export class PerformanceSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  venue: string;

  @ApiProperty()
  startsAt: Date;

  @ApiProperty({ enum: PerformanceStatus })
  status: PerformanceStatus;
}

export class ConcertResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  artist: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ type: [PerformanceSummaryDto] })
  performances: PerformanceSummaryDto[];
}

export class ConcertPageDto {
  @ApiProperty({ type: [ConcertResponseDto] })
  items: ConcertResponseDto[];

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;

  @ApiProperty()
  total: number;
}
