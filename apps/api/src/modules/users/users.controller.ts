import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/auth/auth.decorators.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { toPublicUser, UsersService } from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** The signed-in user's profile */
  @Get('me')
  async me(@CurrentUser() auth: AuthUser): Promise<UserResponseDto> {
    const user = await this.users.findById(auth.id);
    if (!user) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'User no longer exists',
      );
    }
    return toPublicUser(user);
  }
}
