import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class StandingSelectionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  zoneId: string;

  @ApiProperty({ minimum: 1, maximum: 20 })
  @IsInt()
  @Min(1)
  @Max(20)
  quantity: number;
}

export class CreateReservationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  performanceId: string;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Numbered seats to hold',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  seatIds?: string[];

  @ApiProperty({
    required: false,
    type: [StandingSelectionDto],
    description: 'Standing tickets per zone',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => StandingSelectionDto)
  standing?: StandingSelectionDto[];
}
