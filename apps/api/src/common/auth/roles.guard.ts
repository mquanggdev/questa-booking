import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../../generated/prisma/client.js';
import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-codes.js';
import { ROLES_KEY, type AuthenticatedRequest } from './auth.decorators.js';

// Runs after JwtAuthGuard. Routes without @Roles() accept any signed-in user.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!roles?.length) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (user && roles.includes(user.role)) {
      return true;
    }
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.FORBIDDEN,
      'You do not have permission to perform this action',
    );
  }
}
