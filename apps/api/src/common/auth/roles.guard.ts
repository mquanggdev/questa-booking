import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import type { Role } from '../../generated/prisma/client.js';
import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-codes.js';
import { ROLES_KEY, type AuthenticatedRequest } from './auth.decorators.js';
import type { WsClient } from './jwt-auth.guard.js';

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
    const user =
      context.getType() === 'ws'
        ? context.switchToWs().getClient<WsClient>().data?.user
        : context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (user && roles.includes(user.role)) {
      return true;
    }
    if (context.getType() === 'ws') {
      throw new WsException(
        'You do not have permission to perform this action',
      );
    }
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.FORBIDDEN,
      'You do not have permission to perform this action',
    );
  }
}
