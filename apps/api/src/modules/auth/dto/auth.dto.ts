import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';
import { UserResponseDto } from '../../users/dto/user-response.dto.js';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({ example: 'jane@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @Length(8, 128)
  password: string;

  @ApiProperty({ example: 'Jane Doe' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  fullName: string;
}

export class LoginDto {
  @ApiProperty({ example: 'jane@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  password: string;
}

export class AuthResponseDto {
  @ApiProperty({
    description: 'JWT to send as "Authorization: Bearer <token>"',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Access token lifetime in seconds',
    example: 900,
  })
  expiresIn: number;

  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;
}
