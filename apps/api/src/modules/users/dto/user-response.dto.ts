import { Role } from '../../../generated/prisma/client.js';
import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'jane@example.com' })
  email: string;

  @ApiProperty({ example: 'Jane Doe' })
  fullName: string;

  @ApiProperty({ enum: Role })
  role: Role;

  @ApiProperty({
    description:
      'The read-only demo account of the online demo: can read, cannot change anything',
  })
  isDemo: boolean;
}
