import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { normalizePresaleCode } from '../presale-code.js';

export class GeneratePresaleCodesDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A PRESALE phase of this performance',
  })
  @IsUUID()
  salePhaseId: string;

  @ApiProperty({ minimum: 1, maximum: 1000, example: 100 })
  @IsInt()
  @Min(1)
  @Max(1000)
  count: number;
}

export class PresaleCodesResponseDto {
  @ApiProperty({ format: 'uuid' })
  salePhaseId: string;

  @ApiProperty({ type: [String], example: ['K7QM-2XRP-9D'] })
  codes: string[];
}

export class PresaleCodeDto {
  @ApiProperty({ example: 'K7QM-2XRP-9D' })
  code: string;

  @ApiProperty({ format: 'uuid' })
  salePhaseId: string;

  @ApiProperty({ required: false, nullable: true, type: Date })
  redeemedAt: Date | null;
}

export class RedeemPresaleCodeDto {
  @ApiProperty({
    example: 'K7QM-2XRP-9D',
    description: 'Case, spaces and dashes are ignored',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizePresaleCode(value) : value,
  )
  @IsString()
  @Length(10, 10, { message: 'code must have 10 letters or digits' })
  code: string;
}

export class PresaleRedemptionDto {
  @ApiProperty({ format: 'uuid' })
  salePhaseId: string;

  @ApiProperty()
  redeemedAt: Date;
}
